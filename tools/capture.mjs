#!/usr/bin/env node
// capture.mjs — samemind capture: read-only import of a live engine's own session store
// into inbox/<engine>.md.
//   npx samemind capture --engine <id> [--source <path>] [--since <ts>] [--dry-run]
//
// Closes the last custom bridge in dogfooding (gbrain adapters/import-*.mjs bespoke per
// engine): a small adapter registry (ADAPTERS) reads an engine's native transcript/diary
// format read-only, distills each new session/file into a short note, masks obvious
// secrets, runs the same injection-quarantine as memory_write_inbox (tools/lib/mcp.mjs),
// and appends to inbox/<engine>.md — the one writable tier, same contract everywhere else
// in this package. Idempotent across runs via .samemind-capture-state.json (captured keys
// per engine) living in the bundle root next to inbox/.
//
// MVP adapters:
//   claude-code       — ~/.claude/projects/**/*.jsonl transcripts (final assistant text
//                        per session + light meta: session id, cwd/project, message count).
//   generic-markdown  — any directory of *.md diaries (covers e.g. OpenClaw's memory/*.md):
//                        new files (by --since / not-yet-captured) → a pointer note
//                        (title + first lines + path).
// Adding a third engine = one more ADAPTERS entry ({ locate, extract }).
import {
  existsSync, readdirSync, readFileSync, statSync, mkdirSync,
} from 'node:fs';
import {
  join, resolve, dirname, sep, basename,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { ROOT } from './lib/okf.mjs';
import { scanForInjection } from './lib/injection.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { withFileLock } from '../lib/file-lock.mjs';

const STATE_FILE = '.samemind-capture-state.json';
const MAX_DISTILL_CHARS = 1500;

// ---------------------------------------------------------------------------
// Secret hygiene — we are reading live transcripts; mask obvious secret shapes
// before anything is written to inbox/. Not a substitute for real secret
// scanning, but catches the common accidental-paste shapes.
// ---------------------------------------------------------------------------

const SECRET_PATTERN_SOURCES = [
  String.raw`\bnpm_[A-Za-z0-9]{20,}\b`,
  String.raw`\bsk-[A-Za-z0-9_-]{16,}\b`,
  String.raw`\bghp_[A-Za-z0-9]{20,}\b`,
  String.raw`\bAKIA[0-9A-Z]{12,}\b`,
];

/** Masks obvious secret shapes (npm_/sk-/ghp_/AKIA…) with a fixed placeholder. */
export function maskSecrets(text) {
  let masked = String(text ?? '');
  let count = 0;
  for (const src of SECRET_PATTERN_SOURCES) {
    const re = new RegExp(src, 'g'); // fresh instance per call — no shared lastIndex state
    masked = masked.replace(re, () => { count++; return '•••masked•••'; });
  }
  return { text: masked, masked: count > 0, count };
}

// ---------------------------------------------------------------------------
// Shared fs helpers
// ---------------------------------------------------------------------------

function walkFiles(dir, predicate, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, predicate, acc);
    else if (ent.isFile() && predicate(ent.name)) acc.push(full);
  }
  return acc;
}

function truncate(text, max = MAX_DISTILL_CHARS) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Adapter: claude-code — ~/.claude/projects/**/*.jsonl
// ---------------------------------------------------------------------------

function defaultClaudeCodeSource() {
  return join(os.homedir(), '.claude', 'projects');
}

function locateClaudeCode(source) {
  const root = source || defaultClaudeCodeSource();
  if (!existsSync(root)) return [];
  const st = statSync(root);
  if (st.isFile()) return root.endsWith('.jsonl') ? [root] : [];
  return walkFiles(root, name => name.endsWith('.jsonl')).sort();
}

/**
 * Extract the final assistant text block + light meta from one Claude Code JSONL
 * transcript (one JSON event per line; types include user/assistant/system/attachment/
 * queue-operation/…). Returns null if the transcript has no assistant text block at all
 * (e.g. a queue-only or aborted session — nothing worth distilling).
 */
export function extractClaudeCodeSession(raw, fallbackSessionId) {
  const lines = String(raw ?? '').split('\n').filter(Boolean);
  let sessionId = fallbackSessionId;
  let cwd = null;
  let lastTimestamp = null;
  let finalText = null;
  let messageCount = 0;

  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.sessionId) sessionId = evt.sessionId;
    if (evt.timestamp) lastTimestamp = evt.timestamp;
    if (evt.cwd) cwd = evt.cwd;
    if (evt.type === 'user' || evt.type === 'assistant') messageCount++;
    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      const textBlocks = evt.message.content.filter(b => b?.type === 'text' && b.text);
      if (textBlocks.length) finalText = textBlocks[textBlocks.length - 1].text;
    }
  }

  if (!finalText) return null;
  return {
    sessionId, cwd, timestamp: lastTimestamp, messageCount, finalText,
  };
}

function extractClaudeCode(files) {
  const items = [];
  for (const file of files) {
    const fallbackId = basename(file).replace(/\.jsonl$/, '');
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const d = extractClaudeCodeSession(raw, fallbackId);
    if (!d) continue;
    const date = d.timestamp || statSync(file).mtime.toISOString();
    const project = d.cwd || dirname(file).split(sep).pop();
    const body = [
      `- session: \`${d.sessionId}\``,
      `- project: \`${project}\``,
      `- messages: ${d.messageCount}`,
      '',
      truncate(d.finalText),
    ].join('\n');
    items.push({
      key: d.sessionId,
      date,
      heading: `claude-code session ${d.sessionId.slice(0, 8)}`,
      body,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Adapter: generic-markdown — any directory of *.md diaries
// ---------------------------------------------------------------------------

function locateGenericMarkdown(source) {
  if (!source || !existsSync(source)) return [];
  const st = statSync(source);
  if (st.isFile()) return source.endsWith('.md') ? [source] : [];
  return walkFiles(source, name => name.endsWith('.md')).sort();
}

function extractGenericMarkdown(files, { sourceRoot } = {}) {
  const items = [];
  for (const file of files) {
    let raw;
    let st;
    try {
      raw = readFileSync(file, 'utf8');
      st = statSync(file);
    } catch { continue; }
    const lines = raw.split('\n');
    const h1 = lines.find(l => /^#\s+/.test(l));
    const title = h1 ? h1.replace(/^#\s+/, '').trim() : basename(file, '.md');
    const preview = lines
      .filter(l => l.trim() && !/^#\s+/.test(l))
      .slice(0, 3)
      .join('\n');
    const rel = sourceRoot
      ? file.slice(resolve(sourceRoot).length).replace(/^[/\\]/, '')
      : file;
    const body = [
      `- path: \`${rel || basename(file)}\``,
      '',
      `**${title}**`,
      '',
      preview,
    ].join('\n');
    items.push({
      key: resolve(file),
      date: st.mtime.toISOString(),
      heading: title,
      body,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Adapter registry — one more engine = one more entry.
// ---------------------------------------------------------------------------

export const ADAPTERS = {
  'claude-code': {
    requiresSource: false,
    locate: source => locateClaudeCode(source),
    extract: files => extractClaudeCode(files),
  },
  'generic-markdown': {
    requiresSource: true,
    locate: source => locateGenericMarkdown(source),
    extract: (files, { source } = {}) => extractGenericMarkdown(files, { sourceRoot: source }),
  },
};

// ---------------------------------------------------------------------------
// State (idempotency) — .samemind-capture-state.json in the bundle root.
// ---------------------------------------------------------------------------

export function loadState(root) {
  const p = join(root, STATE_FILE);
  if (!existsSync(p)) return { engines: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { engines: {} };
    if (!parsed.engines) parsed.engines = {};
    return parsed;
  } catch {
    return { engines: {} };
  }
}

export function saveState(root, state) {
  atomicWriteFileSync(join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// inbox/<engine>.md append — same shape as memory_write_inbox (tools/lib/mcp.mjs):
// atomic write, append-only, injection-quarantine wraps flagged content rather than
// dropping it.
// ---------------------------------------------------------------------------

function appendInbox(root, engine, blocks) {
  const inboxDir = join(root, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const target = join(inboxDir, `${engine}.md`);
  // Same lock key (the target path) as memoryWriteInbox (tools/lib/mcp.mjs) — both write
  // inbox/<name>.md via read-modify-write, so they must mutually exclude each other too, not
  // just other `capture` invocations.
  withFileLock(target, () => {
    const existing = existsSync(target)
      ? readFileSync(target, 'utf8')
      : `---\nokf_version: "0.1"\n---\n\n# Inbox — ${engine}\n\nAppend-only notes captured via \`samemind capture --engine ${engine}\`.\n\n`;
    const next = `${existing.replace(/\n*$/, '\n\n')}${blocks.join('\n')}\n`;
    atomicWriteFileSync(target, next);
  });
  return target;
}

function formatBlock({ heading, date, body }, quarantine) {
  const header = `## ${date} — ${heading}`;
  if (!quarantine.flagged) {
    return [header, '', body.trim(), ''].join('\n');
  }
  return [
    header,
    `quarantine: true  <!-- patterns: ${quarantine.matches.join(', ')} -->`,
    '',
    '```quarantine',
    body.trim(),
    '```',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   ok: boolean, reason?: string, engine?: string, source?: string|null, sinceIso?: string|null,
 *   dryRun?: boolean, captured?: Array<{key,date,heading,masked,quarantined}>, skipped?: number,
 *   masked?: number, quarantined?: number, inboxFile?: string|null,
 * }}
 */
export function runCapture({
  engine,
  source = null,
  since = null,
  dryRun = false,
  root = ROOT,
} = {}) {
  const adapter = ADAPTERS[engine];
  if (!adapter) {
    return { ok: false, reason: `unknown engine "${engine}" — known: ${Object.keys(ADAPTERS).join(', ')}` };
  }
  if (adapter.requiresSource && !source) {
    return { ok: false, reason: `--source <path> is required for engine "${engine}"` };
  }

  let sinceMs = null;
  if (since) {
    sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) return { ok: false, reason: `--since: unparseable date "${since}"` };
  }

  const files = adapter.locate(source);
  const items = adapter.extract(files, { source, since });

  const state = loadState(root);
  const capturedKeys = new Set(state.engines[engine]?.captured || []);

  // Read-only rule: never re-derive from source order — dedupe by key regardless of
  // --since, so a session already captured never resurfaces just because --since widened.
  const candidates = items.filter(item => {
    if (capturedKeys.has(item.key)) return false;
    if (sinceMs !== null) {
      const t = Date.parse(item.date);
      if (!Number.isNaN(t) && t < sinceMs) return false;
    }
    return true;
  });

  const captured = [];
  const blocks = [];
  let maskedTotal = 0;
  let quarantinedTotal = 0;

  for (const item of candidates) {
    const { text: maskedBody, masked, count } = maskSecrets(item.body);
    if (masked) maskedTotal += count;
    const quarantine = scanForInjection(maskedBody);
    if (quarantine.flagged) quarantinedTotal++;
    blocks.push(formatBlock({ heading: item.heading, date: item.date, body: maskedBody }, quarantine));
    captured.push({
      key: item.key, date: item.date, heading: item.heading, masked, quarantined: quarantine.flagged,
    });
  }

  const result = {
    ok: true,
    engine,
    source: source || null,
    sinceIso: since || null,
    dryRun,
    captured,
    skipped: items.length - candidates.length,
    masked: maskedTotal,
    quarantined: quarantinedTotal,
    inboxFile: null,
  };

  if (dryRun || captured.length === 0) return result;

  result.inboxFile = appendInbox(root, engine, blocks);
  saveState(root, {
    ...state,
    engines: {
      ...state.engines,
      [engine]: { captured: [...capturedKeys, ...captured.map(c => c.key)].sort() },
    },
  });
  return result;
}

export function formatCaptureReport(result) {
  if (!result.ok) return `✗ ${result.reason}`;
  const lines = [];
  const flags = [
    result.source ? `--source ${result.source}` : null,
    result.sinceIso ? `--since ${result.sinceIso}` : null,
  ].filter(Boolean).join(' ');
  lines.push(`${result.dryRun ? '[dry-run] ' : ''}CAPTURE --engine ${result.engine}${flags ? ` ${flags}` : ''}`);
  lines.push(`new: ${result.captured.length}`);
  for (const c of result.captured) {
    const tags = [c.masked ? 'masked' : null, c.quarantined ? 'quarantined' : null].filter(Boolean);
    lines.push(`  + ${c.key} (${c.date})${tags.length ? ` [${tags.join(', ')}]` : ''}`);
  }
  lines.push(`skipped (already captured / before --since): ${result.skipped}`);
  if (result.masked) lines.push(`secrets masked: ${result.masked}`);
  if (result.quarantined) lines.push(`quarantined (injection-like): ${result.quarantined}`);
  if (result.inboxFile) lines.push(`inbox file: ${result.inboxFile}`);
  else if (result.dryRun && result.captured.length) lines.push('(dry-run — nothing written)');
  return lines.join('\n');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    engine: null, source: null, since: null, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') out.engine = argv[++i] || null;
    else if (a.startsWith('--engine=')) out.engine = a.slice('--engine='.length);
    else if (a === '--source') out.source = argv[++i] || null;
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
    else if (a === '--since') out.since = argv[++i] || null;
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.engine) {
    console.log('Usage: samemind capture --engine <id> [--source <path>] [--since <ts>] [--dry-run]');
    console.log('');
    console.log(`  Known engines: ${Object.keys(ADAPTERS).join(', ')}`);
    console.log('  Read-only import of a live engine session store into inbox/<engine>.md.');
    console.log('  See docs/session-capture.md.');
    return 0;
  }
  const result = runCapture(opts);
  console.log(formatCaptureReport(result));
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  }).then(code => {
    if (typeof code === 'number') process.exit(code);
  });
}

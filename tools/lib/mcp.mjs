// mcp.mjs — логика MCP-инструментов samemind (транспорт-агностичная; см. ../mcp-server.mjs).
// 8 инструментов: memory_search | memory_get | memory_list | memory_write_inbox | memory_handoff
// | memory_health | memory_ledger_append | memory_ledger_status.
//
// Безопасность (см. наряд N3):
//  - visibility: secret НИКОГДА не попадает в docs, которые видят инструменты (load({includeSecret:false}))
//    — ни search, ни get, ни list; без флагов и без исключений.
//  - memory_get принимает id снаружи → assertSafeConceptId (lib/safe-path.mjs) отклоняет любой
//    path traversal (.., абсолютные пути вне bundle) до похода в файловую систему.
//  - memory_write_inbox пишет ТОЛЬКО в inbox/<agent>.md (имя агента санитизируется);
//    атомарная запись (lib/atomic-write.mjs), append-only; контент с признаками prompt-injection
//    не отклоняется, а оборачивается в quarantine fence (tools/lib/injection.mjs).
//  - memory_ledger_append: тот же контракт, что write_inbox — actor из env SAMEMIND_AGENT
//    (санитизируется), пишет ТОЛЬКО в ledger/events.jsonl, `action` сканируется на
//    prompt-injection (issue #3, docs/event-ledger.md); события никогда не удаляются.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, load, findById } from './okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, recallSearch, extractSnippet,
} from './recall.mjs';
import { scanForInjection } from './injection.mjs';
import { loadIdx } from '../okf-recall.mjs';
import { buildHandoff, DEFAULT_DAYS as HANDOFF_DEFAULT_DAYS } from '../handoff.mjs';
import { appendEvent, readEvents, summarizeLedger, PHASES, STATUSES } from './ledger.mjs';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { withFileLock } from '../../lib/file-lock.mjs';
import { safeMdPath, assertSafeConceptId, sanitizeAgentName } from '../../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

export const SERVER_NAME = 'samemind';
export const SERVER_VERSION = PKG.version;
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const EMBED_MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: EMBED_MODEL });

// Документы, которые вообще видны MCP-инструментам: НИКОГДА secret, mirror включён (единая
// база памяти агента может законно содержать зеркало живой памяти — не блокируем).
// inbox тоже НИКОГДА (default includeInbox: false, не передаём) — это сырьё, ждущее курации
// (см. issue #4): memory_search/get/list не должны его отдавать. memory_write_inbox — единственный
// путь, который его касается, и это чистая запись в файл, в load() не ходит.
function readableDocs() {
  return load({ includeSecret: false, includeMirror: true }).filter(d => !d.reserved);
}

export const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search the memory bundle (semantic if an index exists and answers, BM25 fallback otherwise). Never returns secret-visibility concepts. Pass exclude_source (an engine id like "claude-code") to filter out concepts authored by that source — anti-echo, so an engine does not get back what it just wrote.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        k: { type: 'integer', minimum: 1, description: 'Max results (default 5)' },
        mode: { type: 'string', enum: ['bm25', 'semantic', 'auto'], description: 'Search mode (default auto)' },
        exclude_source: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'Drop concepts whose frontmatter `source` is this id (anti-echo). Lowercase letters, digits, hyphens only.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one concept (full frontmatter + body) by id. Refuses secret-visibility concepts and any id outside the bundle (path traversal).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Concept id, e.g. "projects/lumen"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description: 'List concepts in the bundle, optionally filtered by type or tag. Never lists secret-visibility concepts.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by frontmatter type (e.g. Project, Concept)' },
        tag: { type: 'string', description: 'Filter by tag' },
      },
    },
  },
  {
    name: 'memory_write_inbox',
    description: 'Append a note to inbox/<agent>.md — the only writable path. Agent name comes from env SAMEMIND_AGENT (default "mcp"), sanitized to [a-z0-9-]. Content resembling prompt injection is never dropped, only wrapped and flagged quarantine:true.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note body to append' },
        title: { type: 'string', description: 'Optional short heading for the entry' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_handoff',
    description: 'Work-state handoff brief: active tasks, recent decisions, plans in force, last session, open questions. Call at session start after /compact or engine switch. Never includes secret-visibility concepts. Not the identity brief (use samemind brief / identity layer for that).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project filter (e.g. "lumen" or "/projects/lumen.md")' },
        days: { type: 'integer', minimum: 1, description: 'Decision lookback window in days (default 14)' },
      },
    },
  },
  {
    name: 'memory_health',
    description: 'Bundle root, concept count, active search mode, samemind version.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_ledger_append',
    description: 'Append one event to the append-only event ledger (ledger/events.jsonl) — fine-grained "who did what step, when", complementing (not replacing) the coarser Task.status. Actor comes from env SAMEMIND_AGENT (default "mcp"), same as memory_write_inbox. `action` is scanned for prompt-injection heuristics; flagged text is still recorded (quarantine:true), never dropped. See docs/event-ledger.md.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Naryad/work-item id this event belongs to' },
        phase: { type: 'string', enum: [...PHASES], description: 'Lifecycle phase of this event' },
        status: { type: 'string', enum: [...STATUSES], description: 'Outcome of this event (default "ok")' },
        action: { type: 'string', description: 'What happened, one line' },
        artifact: { type: 'string', description: 'Optional artifact reference (branch, commit, file, URL)' },
        ref: { type: 'string', description: 'Optional external reference (issue id, PR, ticket)' },
      },
      required: ['topic', 'phase', 'action'],
    },
  },
  {
    name: 'memory_ledger_status',
    description: 'Read-only summary of the event ledger: current stage per topic (last event) and open failures — fail/block-phase events not yet closed by a later done-phase or ok-status event of the same topic — freshest first. See docs/event-ledger.md.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function memorySearch({ query, k = 5, mode = 'auto', exclude_source } = {}) {
  if (!query || !String(query).trim()) throw new Error('memory_search: "query" is required');
  const kk = Number.isFinite(Number(k)) && Number(k) > 0 ? Math.floor(Number(k)) : 5;
  let excludeSource = null;
  if (exclude_source !== undefined && exclude_source !== null && String(exclude_source).trim()) {
    excludeSource = String(exclude_source);
    if (!/^[a-z0-9-]+$/.test(excludeSource)) {
      throw new Error(`memory_search: "exclude_source" must match [a-z0-9-] (got "${excludeSource}")`);
    }
  }
  const docs = readableDocs();
  const docById = new Map(docs.map(d => [d.id, d]));
  const idx = loadIdx();
  const { hits, mode: used, warning } = await recallSearch({
    docs, query, mode, embed, idx, k: kk, includeSecret: false, includeMirror: true, excludeSource,
  });
  const results = hits.map(h => {
    const doc = docById.get(h.id);
    return {
      id: h.id,
      type: h.type || doc?.fm.type || null,
      title: h.title || doc?.fm.title || null,
      score: Number.isFinite(h.score) ? Number(h.score.toFixed(4)) : 0,
      snippet: extractSnippet(doc?.body || '', query, { contextLines: 1 }),
      hygiene: h.label || null, // e.g. "[superseded by /concepts/new.md]" — see docs/memory-hygiene.md
    };
  });
  return { query, mode: used, warning: warning || null, count: results.length, results };
}

async function memoryGet({ id } = {}) {
  const rel = assertSafeConceptId(id, ROOT); // throws on traversal/empty id — before touching docs
  const docs = readableDocs(); // secret already excluded at the load() level
  const hits = findById(docs, rel);
  if (!hits.length) return { found: false, id: rel };
  if (hits.length > 1) {
    throw new Error(`memory_get: ambiguous — ${hits.length} matches for "${rel}": ${hits.map(d => d.id).join(', ')}`);
  }
  const doc = hits[0];
  if ((doc.fm.visibility || 'internal') === 'secret') return { found: false, id: rel }; // defense-in-depth
  const raw = readFileSync(doc.file, 'utf8');
  return {
    found: true,
    id: doc.id,
    type: doc.fm.type || null,
    title: doc.fm.title || null,
    visibility: doc.fm.visibility || 'internal',
    tags: doc.fm.tags || [],
    content: raw,
  };
}

async function memoryList({ type, tag } = {}) {
  let docs = readableDocs();
  if (type) docs = docs.filter(d => (d.fm.type || '').toLowerCase() === String(type).toLowerCase());
  if (tag) docs = docs.filter(d => (d.fm.tags || []).map(t => String(t).toLowerCase()).includes(String(tag).toLowerCase()));
  return {
    count: docs.length,
    items: docs
      .map(d => ({ id: d.id, type: d.fm.type || null, title: d.fm.title || null, visibility: d.fm.visibility || 'internal' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function memoryWriteInbox({ content, title } = {}) {
  if (content === undefined || content === null || !String(content).trim()) {
    throw new Error('memory_write_inbox: "content" is required and cannot be empty');
  }
  const agent = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const inboxDir = join(ROOT, 'inbox');
  mkdirSync(inboxDir, { recursive: true }); // must exist before acquireLock's mkdir(`${target}.lock`)
  const target = safeMdPath(inboxDir, agent);

  const text = String(content);
  const scan = scanForInjection(text);
  const timestamp = new Date().toISOString();
  const heading = title && String(title).trim() ? String(title).trim() : '(untitled)';

  const block = scan.flagged
    ? [
      `## ${timestamp} — ${heading}`,
      `quarantine: true  <!-- patterns: ${scan.matches.join(', ')} -->`,
      '',
      '```quarantine',
      text,
      '```',
      '',
    ].join('\n')
    : [
      `## ${timestamp} — ${heading}`,
      '',
      text.trim(),
      '',
    ].join('\n');

  // withFileLock: read-modify-write guarded against concurrent writers of the SAME inbox file
  // (the fleet all writing as one agent name, or `capture.mjs`'s appendInbox racing this same
  // path — both key the lock off `target`, so they mutually exclude each other too).
  const next = withFileLock(target, () => {
    const existing = existsSync(target)
      ? readFileSync(target, 'utf8')
      : `---\nokf_version: "0.1"\n---\n\n# Inbox — ${agent}\n\nAppend-only notes written via samemind MCP (memory_write_inbox).\n\n`;

    const body = `${existing.replace(/\n*$/, '\n\n')}${block}\n`;
    atomicWriteFileSync(target, body);
    return body;
  });

  return {
    ok: true,
    agent,
    file: relative(ROOT, target),
    quarantined: scan.flagged,
    matches: scan.matches,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
  };
}

async function memoryHandoff({ project, days } = {}) {
  const docs = readableDocs(); // secret already excluded
  const dayWindow = Number.isFinite(Number(days)) && Number(days) > 0
    ? Math.floor(Number(days))
    : HANDOFF_DEFAULT_DAYS;
  const { markdown, sections, warnings, project: projectKey } = buildHandoff(docs, {
    project: project || null,
    days: dayWindow,
  });
  return {
    markdown,
    project: projectKey,
    days: dayWindow,
    sections,
    warnings,
  };
}

async function memoryHealth() {
  const docs = readableDocs();
  const idx = loadIdx();
  const hasIndex = !!(idx && idx.items && Object.keys(idx.items).length > 0);
  return {
    root: ROOT,
    concepts: docs.length,
    searchMode: hasIndex ? 'semantic (index present; BM25 fallback if endpoint unavailable)' : 'bm25 (no semantic index — set OKF_EMBED_URL + run recall index)',
    embedUrl: process.env.OKF_EMBED_URL || null,
    version: SERVER_VERSION,
  };
}

async function memoryLedgerAppend({ topic, phase, status, action, artifact, ref } = {}) {
  const actor = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const rec = appendEvent(ROOT, { actor, topic, phase, status, action, artifact, ref });
  return {
    ok: true,
    actor: rec.actor,
    topic: rec.topic,
    phase: rec.phase,
    status: rec.status,
    quarantine: rec.quarantine,
    matches: rec.matches,
  };
}

async function memoryLedgerStatus() {
  const { topics, openFailures } = summarizeLedger(readEvents(ROOT));
  return {
    topics: topics.map(t => ({ topic: t.topic, count: t.count, open: !!t.openFail, last: t.last })),
    openFailures,
  };
}

const HANDLERS = {
  memory_search: memorySearch,
  memory_get: memoryGet,
  memory_list: memoryList,
  memory_write_inbox: memoryWriteInbox,
  memory_handoff: memoryHandoff,
  memory_health: memoryHealth,
  memory_ledger_append: memoryLedgerAppend,
  memory_ledger_status: memoryLedgerStatus,
};

/** Выполняет вызов инструмента, никогда не бросает — ошибки → { isError: true }. */
export async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

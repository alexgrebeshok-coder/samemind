#!/usr/bin/env node
// import.mjs — samemind import: accept a foreign OKF-bundle into this bundle.
//   node tools/import.mjs <source-dir> [--into inbox|concepts]
//
// Default --into inbox: curated path — each concept becomes a block in
// inbox/import-<YYYY-MM-DD>.md with a source citation (never auto-promotes).
// --into concepts: direct tree copy + source: import:<dir-name>; path collisions
// refuse that file (never overwrite). Path safety (no ../). Atomic writes.
import {
  existsSync, readdirSync, readFileSync, statSync, lstatSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, parseFrontmatter } from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { assertSafeConceptId } from '../lib/safe-path.mjs';

/** Top-level dirs we never pull from a foreign bundle as concepts. */
export const SKIP_IMPORT_TOP = Object.freeze(new Set([
  'secret', 'mirror', 'inbox', 'tools', 'demo', 'node_modules', 'lib', 'bin', 'docs',
]));

const RESERVED_BASENAMES = new Set([
  'index.md', 'log.md', 'readme.md', 'dashboard.md', 'license.md', 'changelog.md', 'contributing.md',
]);

/**
 * Walk a foreign source dir for .md files (no secret/mirror/inbox, no symlink escape).
 * Returns absolute paths.
 */
export function walkSource(sourceDir, acc = []) {
  const root = resolve(sourceDir);
  const rootPrefix = root + sep;
  let entries;
  try { entries = readdirSync(sourceDir); } catch { return acc; }
  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const full = join(sourceDir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      try {
        const target = resolve(full);
        if (!target.startsWith(rootPrefix)) continue;
      } catch { continue; }
    }
    const rel = relative(root, full);
    const top = rel.split(/[/\\]/)[0];
    if (SKIP_IMPORT_TOP.has(top)) continue;
    try {
      if (statSync(full).isDirectory()) walkSource(full, acc);
      else if (name.endsWith('.md')) acc.push(full);
    } catch { continue; }
  }
  return acc;
}

/**
 * Validate one file as OKF-shaped concept.
 * @returns {{ ok: true, id, rel, fm, body, raw, hasFM } | { ok: false, rel, reason }}
 */
export function validateOkfFile(file, sourceRoot) {
  const root = resolve(sourceRoot);
  const rel = relative(root, file).split(sep).join('/');
  // path safety: reject any relative path that escapes or has ..
  if (rel.startsWith('..') || rel.split('/').some(s => s === '..' || s === '')) {
    return { ok: false, rel, reason: 'path traversal / unsafe segments' };
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, rel, reason: `read error: ${e.message}` };
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return { ok: false, rel, reason: 'no parseable frontmatter' };
  }
  const fm = parseFrontmatter(m[1]);
  const body = m[2];
  const base = basename(file);
  if (RESERVED_BASENAMES.has(base.toLowerCase())) {
    return { ok: false, rel, reason: 'reserved basename (index/log/…) — not a concept', skip: true };
  }
  if (!fm.type || !String(fm.type).trim()) {
    return { ok: false, rel, reason: 'missing frontmatter field `type`' };
  }
  const id = rel.replace(/\.md$/, '');
  try {
    assertSafeConceptId(id, root);
  } catch (e) {
    return { ok: false, rel, reason: e.message };
  }
  return { ok: true, id, rel, fm, body, raw, hasFM: true };
}

/** Insert or replace `source:` in an existing frontmatter block (minimal text edit). */
export function setSourceField(raw, sourceValue) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('import: file has no frontmatter');
  const [, fmBlock, rest] = m;
  const lines = fmBlock.split('\n');
  const out = [];
  let saw = false;
  for (const line of lines) {
    if (/^source:\s*/.test(line)) {
      saw = true;
      out.push(`source: ${sourceValue}`);
      continue;
    }
    out.push(line);
  }
  if (!saw) out.push(`source: ${sourceValue}`);
  return `---\n${out.join('\n')}\n---\n${rest}`;
}

/**
 * Build (or append to) an inbox import day-file body.
 * Each concept = one ## block with source citation + full original markdown.
 */
export function formatInboxBlocks(concepts, { date, sourceLabel }) {
  const header = [
    '---',
    'type: Inbox',
    `title: Import ${date}`,
    'description: Curated import queue — promote into concepts/entities/projects manually.',
    'visibility: internal',
    `tags: [import, ${sourceLabel}]`,
    `timestamp: ${date}T00:00:00Z`,
    `source: import:${sourceLabel}`,
    '---',
    '',
    `# Import ${date}`,
    '',
    `Source bundle: \`${sourceLabel}\`. Each block is a curation candidate (not canon).`,
    '',
  ].join('\n');

  const blocks = concepts.map(c => {
    const title = c.fm?.title || c.id;
    return [
      `## ${title}`,
      '',
      `- **id:** \`${c.id}\``,
      `- **source:** \`${sourceLabel}/${c.rel}\``,
      `- **type:** \`${c.fm?.type || '?'}\``,
      '',
      '```markdown',
      c.raw.replace(/\n+$/, ''),
      '```',
      '',
    ].join('\n');
  });

  return header + blocks.join('\n');
}

/**
 * Run import.
 * @returns {{ ok, into, sourceDir, imported, refused, nonConformant, inboxFile?, reason? }}
 */
export function runImport({
  sourceDir,
  into = 'inbox',
  root = ROOT,
  now = new Date(),
} = {}) {
  if (!sourceDir) {
    return {
      ok: false,
      reason: 'source-dir required: samemind import <dir> [--into inbox|concepts]',
      imported: [],
      refused: [],
      nonConformant: [],
    };
  }
  const intoKey = String(into || 'inbox').toLowerCase();
  if (intoKey !== 'inbox' && intoKey !== 'concepts') {
    return {
      ok: false,
      reason: `--into must be inbox|concepts (got "${into}")`,
      imported: [],
      refused: [],
      nonConformant: [],
    };
  }

  const src = resolve(sourceDir);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    return {
      ok: false,
      reason: `source "${src}" not found or not a directory`,
      imported: [],
      refused: [],
      nonConformant: [],
    };
  }

  // Refuse importing FROM our own root blindly? Allowed — user choice.
  const files = walkSource(src);
  const valid = [];
  const nonConformant = [];
  for (const f of files) {
    const v = validateOkfFile(f, src);
    if (v.ok) valid.push(v);
    else if (!v.skip) nonConformant.push(v);
    // reserved basenames (skip:true) are silent non-concepts, not reported as non-conformant noise
    // — but we still surface them lightly as skipped
  }

  const sourceLabel = basename(src);
  // sanitize source label for frontmatter (no path separators)
  const safeLabel = sourceLabel.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'import';
  const date = now.toISOString().slice(0, 10);

  const imported = [];
  const refused = [];

  if (intoKey === 'inbox') {
    if (valid.length === 0) {
      return {
        ok: true,
        into: intoKey,
        sourceDir: src,
        imported: [],
        refused: [],
        nonConformant,
        inboxFile: null,
      };
    }
    const inboxDir = join(root, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const inboxName = `import-${date}.md`;
    const inboxPath = join(inboxDir, inboxName);
    // path safety for the inbox file itself
    const rootPrefix = resolve(root) + sep;
    if (!resolve(inboxPath).startsWith(rootPrefix)) {
      return {
        ok: false,
        reason: 'path traversal: inbox target outside bundle root',
        imported: [],
        refused: [],
        nonConformant,
      };
    }

    let content = formatInboxBlocks(valid, { date, sourceLabel: safeLabel });
    // If same-day file already exists, append new ## blocks (do not wipe prior imports)
    if (existsSync(inboxPath)) {
      const prev = readFileSync(inboxPath, 'utf8');
      const onlyBlocks = valid.map(c => {
        const title = c.fm?.title || c.id;
        return [
          `## ${title}`,
          '',
          `- **id:** \`${c.id}\``,
          `- **source:** \`${safeLabel}/${c.rel}\``,
          `- **type:** \`${c.fm?.type || '?'}\``,
          '',
          '```markdown',
          c.raw.replace(/\n+$/, ''),
          '```',
          '',
        ].join('\n');
      }).join('\n');
      content = prev.replace(/\s*$/, '\n\n') + onlyBlocks;
    }
    atomicWriteFileSync(inboxPath, content);
    for (const c of valid) {
      imported.push({ id: c.id, rel: c.rel, dest: `inbox/${inboxName}` });
    }
    return {
      ok: true,
      into: intoKey,
      sourceDir: src,
      imported,
      refused,
      nonConformant,
      inboxFile: inboxPath,
    };
  }

  // --into concepts: direct copy into tree
  for (const c of valid) {
    let safeId;
    try {
      safeId = assertSafeConceptId(c.id, root);
    } catch (e) {
      refused.push({ id: c.id, rel: c.rel, reason: e.message });
      continue;
    }
    const dest = join(root, `${safeId}.md`);
    const rootPrefix = resolve(root) + sep;
    if (!resolve(dest).startsWith(rootPrefix)) {
      refused.push({ id: c.id, rel: c.rel, reason: 'path traversal outside bundle root' });
      continue;
    }
    if (existsSync(dest)) {
      refused.push({ id: c.id, rel: c.rel, reason: `collision — already exists: ${safeId}.md (not overwritten)` });
      continue;
    }
    const next = setSourceField(c.raw, `import:${safeLabel}`);
    atomicWriteFileSync(dest, next);
    imported.push({ id: safeId, rel: c.rel, dest: `${safeId}.md` });
  }

  return {
    ok: true,
    into: intoKey,
    sourceDir: src,
    imported,
    refused,
    nonConformant,
    inboxFile: null,
  };
}

export function formatImportReport(result) {
  const lines = [];
  lines.push(`IMPORT --into ${result.into} ← ${result.sourceDir}`);
  lines.push(`imported: ${result.imported.length}`);
  for (const i of result.imported) {
    lines.push(`  + ${i.id} → ${i.dest}`);
  }
  lines.push(`refused: ${result.refused.length}`);
  for (const r of result.refused) {
    lines.push(`  × ${r.id || r.rel}: ${r.reason}`);
  }
  lines.push(`non-conformant: ${result.nonConformant.length}`);
  for (const n of result.nonConformant) {
    lines.push(`  ? ${n.rel}: ${n.reason}`);
  }
  if (result.inboxFile) lines.push(`inbox file: ${result.inboxFile}`);
  return lines.join('\n');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { sourceDir: null, into: 'inbox' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--into') out.into = argv[++i] || 'inbox';
    else if (a.startsWith('--into=')) out.into = a.slice('--into='.length);
    else if (!a.startsWith('--') && !out.sourceDir) out.sourceDir = a;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.sourceDir) {
    console.log('Usage: samemind import <source-dir> [--into inbox|concepts]');
    console.log('');
    console.log('  Accepts a foreign OKF-bundle. Default --into inbox (curated path).');
    console.log('  --into concepts — direct copy with source: import:<dir>; collisions → refuse that file.');
    return 0;
  }
  const result = runImport(opts);
  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    return 1;
  }
  console.log(formatImportReport(result));
  if (result.imported.length) {
    console.log(`✓ imported ${result.imported.length}`);
  } else if (!result.refused.length && !result.nonConformant.length) {
    console.log('✓ nothing to import');
  }
  // non-zero only on hard failure; partial (collisions) is still ok=true with report
  return 0;
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

#!/usr/bin/env node
// review.mjs — Э7.4a / Ф7.4 weekly memory review (MVP).
//
//   samemind review [--stale-days N] [--json] [--root <dir>]
//   samemind review apply --plan <file> [--root <dir>]
//
// Collects hygiene candidates (stale, conflicts, unarchived superseded/deprecated, orphans) from
// already-computed bundle signals — no new storage. NEVER writes to concepts unless `apply` is
// invoked with an explicit plan file (or interactive choices). `forget` delegates to forget.mjs
// (soft-deprecate only). `archive` moves a concept file under archive/ preserving relative path.
// `merge` sets superseded_by on the source toward the target (human-gate, explicit plan line).
//
// Product DNA: no auto-deletions. See docs/memory-hygiene.md § Weekly review.
import { readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ROOT, load, findLiveById } from './lib/okf.mjs';
import { readEvents } from './lib/ledger.mjs';
import { buildHeatIndex } from './lib/hygiene.mjs';
import { resolveBundleRoot } from './lib/bundle-root.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { withFileLock } from '../lib/file-lock.mjs';
import { forget } from './forget.mjs';
import {
  DEFAULT_STALE_DAYS, buildReviewCandidates, renderReviewText, renderReviewJson,
  parseReviewPlan,
} from './lib/review.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    sub: null, plan: null, staleDays: DEFAULT_STALE_DAYS, json: false, root: null,
    interactive: false,
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stale-days') out.staleDays = Number(value(++i, '--stale-days'));
    else if (a === '--plan') out.plan = value(++i, '--plan');
    else if (a === '--root') out.root = value(++i, '--root');
    else if (a === '--json') out.json = true;
    else if (a === '--interactive' || a === '-i') out.interactive = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag "${a}"`);
    else rest.push(a);
  }
  out.sub = rest[0] || null;
  if (!Number.isFinite(out.staleDays) || out.staleDays < 1) {
    throw new Error('--stale-days must be a positive number');
  }
  return out;
}

function setSupersededBy(raw, targetPath) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('review merge: file has no frontmatter');
  const [, fmBlock, body] = m;
  const lines = fmBlock.split('\n');
  const out = [];
  let saw = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^superseded_by:\s*/.test(line)) {
      saw = true;
      out.push(`superseded_by: ${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`);
      continue;
    }
    out.push(line);
  }
  if (!saw) {
    const p = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
    out.push(`superseded_by: ${p}`);
  }
  return `---\n${out.join('\n')}\n---\n${body}`;
}

function archiveDoc(doc, root) {
  const rel = `${doc.id}.md`;
  const destRel = join('archive', rel);
  const dest = join(root, destRel);
  if (existsSync(dest)) throw new Error(`archive target already exists: ${destRel}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(doc.file, dest);
  return { id: doc.id, archivedTo: destRel.replace(/\.md$/, '').replace(/\\/g, '/') };
}

function planIdPath(id) {
  return String(id).replace(/^archive\//, '');
}

function liveConceptFile(root, id) {
  return join(root, `${planIdPath(id)}.md`);
}

function archivedConceptFile(root, id) {
  return join(root, 'archive', `${planIdPath(id)}.md`);
}

function isAlreadyArchived(root, id) {
  return !existsSync(liveConceptFile(root, id)) && existsSync(archivedConceptFile(root, id));
}

function resolveLive(all, id) {
  const hits = findLiveById(all, id);
  if (!hits.length) return null;
  if (hits.length > 1) {
    throw new Error(`ambiguous: ${hits.length} matches for "${id}":\n${hits.map(d => d.id).join('\n')}`);
  }
  return hits[0];
}

function mergeAlreadyApplied(doc, targetDoc) {
  const want = `/${targetDoc.id}`.replace(/\.md$/, '');
  return doc.supersededBy.some(p => {
    const norm = (p.startsWith('/') ? p : `/${p}`).replace(/\.md$/, '');
    return norm === want;
  });
}

function applyDecision(decision, { root, docs }) {
  const { id, action, target } = decision;
  if (action === 'keep') return { id, action, status: 'skipped' };

  if (action === 'archive') {
    const doc = resolveLive(docs, id);
    if (!doc) {
      if (isAlreadyArchived(root, id)) return { id, action, status: 'skip: already archived' };
      throw new Error(`not found: ${id}`);
    }
    const r = archiveDoc(doc, root);
    return { id, action, status: 'ok', ...r };
  }

  const doc = resolveLive(docs, id);
  if (!doc) {
    if (isAlreadyArchived(root, id)) return { id, action, status: 'skip: already archived' };
    throw new Error(`not found: ${id}`);
  }

  if (action === 'forget') {
    const raw = readFileSync(doc.file, 'utf8');
    if (/^deprecated:\s*true\s*$/m.test(raw)) {
      return { id, action, status: 'skip: already deprecated' };
    }
    const r = forget(id, { docs });
    return { id, action, status: 'ok', deprecatedOn: r.deprecatedOn };
  }
  if (action === 'merge') {
    const targetDoc = resolveLive(docs, target);
    if (!targetDoc) throw new Error(`not found: ${target}`);
    if (mergeAlreadyApplied(doc, targetDoc)) {
      return { id, action, status: 'skip: already merged', target: targetDoc.id };
    }
    const targetPath = `/${targetDoc.id}.md`;
    withFileLock(doc.file, () => {
      const raw = readFileSync(doc.file, 'utf8');
      const next = setSupersededBy(raw, targetPath);
      atomicWriteFileSync(doc.file, next);
    });
    return { id, action, status: 'ok', target: targetDoc.id };
  }
  throw new Error(`unsupported action: ${action}`);
}

export async function applyReviewPlan(decisions, { root = ROOT } = {}) {
  const docs = load({ includeSecret: true }, root).filter(d => !d.reserved);
  const results = [];
  for (const d of decisions) results.push(applyDecision(d, { root, docs }));
  return results;
}

async function runInteractive(candidates, { root, staleDays }) {
  const rl = createInterface({ input, output });
  const decisions = [];
  try {
    for (const c of candidates) {
      process.stdout.write(`\n${c.id}\n  ${renderReviewText([c], { staleDays }).split('\n').slice(4).join('\n')}\n`);
      const def = c.suggested;
      const ans = (await rl.question(`Action [keep|merge|archive|forget] (default ${def}): `)).trim() || def;
      const action = ans.toLowerCase().split(/\s+/)[0];
      let target = null;
      if (action === 'merge') {
        target = (await rl.question(`Merge target id (default ${c.conflictWith || ''}): `)).trim()
          || c.conflictWith;
      }
      decisions.push({ id: c.id, action, target });
    }
  } finally {
    rl.close();
  }
  return applyReviewPlan(decisions, { root });
}

async function runReview(argv = process.argv.slice(2)) {
  const { sub, plan, staleDays, json, root: rootArg, interactive } = parseArgs(argv);
  const root = resolveBundleRoot(rootArg);

  if (sub === 'apply') {
    if (!plan) throw new Error('review apply requires --plan <file>');
    const raw = readFileSync(plan, 'utf8');
    const decisions = parseReviewPlan(raw);
    const results = await applyReviewPlan(decisions, { root });
    if (json) {
      process.stdout.write(JSON.stringify({ kind: 'review-apply', results }, null, 2) + '\n');
    } else {
      for (const r of results) {
        process.stdout.write(`${r.id}: ${r.action} → ${r.status}${r.archivedTo ? ` (${r.archivedTo})` : ''}${r.target ? ` → ${r.target}` : ''}\n`);
      }
    }
    return;
  }

  if (sub === 'apply' || sub) throw new Error(`unknown review subcommand: ${sub}`);

  const docs = load({ includeSecret: true }, root).filter(d => !d.reserved);
  const heatIndex = buildHeatIndex(readEvents(root));
  const candidates = buildReviewCandidates(docs, { staleDays, heatIndex, root });

  if (interactive && candidates.length) {
    const results = await runInteractive(candidates, { root, staleDays });
    if (json) process.stdout.write(JSON.stringify({ kind: 'review-apply', results }, null, 2) + '\n');
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(renderReviewJson(candidates, { staleDays }), null, 2) + '\n');
  } else {
    process.stdout.write(renderReviewText(candidates, { staleDays }) + '\n');
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runReview().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// reflect.test.mjs — tools/reflect.mjs (Ф5: reconcile + consolidate + heat, ONE proposal report).
// Human-gate is the whole point, same as reconcile.test.mjs: reflect must never touch a concept's
// frontmatter, only print (or --write a report of) proposals. Run: node --test tools/reflect.test.mjs
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { coolingCandidates, renderReflectReport } from './reflect.mjs';
import { buildHeatIndex, HEAT_WINDOW_DAYS } from './lib/hygiene.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLECT_CLI = join(HERE, 'reflect.mjs');
const NOW_MS = new Date('2026-07-18T00:00:00Z').getTime();

function writeConcept(root, relPath, frontmatter, body = '# x\n', mtime = null) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).flatMap(([k, v]) => {
    if (Array.isArray(v)) return [`${k}: [${v.join(', ')}]`];
    return [`${k}: ${v}`];
  });
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  if (mtime) utimesSync(full, mtime, mtime);
  return full;
}

function runCli(root, args) {
  const r = spawnSync(process.execPath, [REFLECT_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

let roots = [];
function tmpRoot(prefix) {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  return r;
}

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// coolingCandidates (pure) — cooled-off facts, never the never-touched majority
// ---------------------------------------------------------------------------

describe('reflect — coolingCandidates (pure)', () => {
  it('a doc touched once, now outside HEAT_WINDOW_DAYS, is a cooling candidate', () => {
    const oldTs = new Date(NOW_MS - (HEAT_WINDOW_DAYS + 5) * 86_400_000).toISOString();
    const heatIndex = buildHeatIndex([{ topic: 'concepts/old-touch', ts: oldTs }]);
    const docs = [{ id: 'concepts/old-touch', fm: { title: 'Old touch' } }];
    const cooling = coolingCandidates(docs, heatIndex, NOW_MS);
    assert.equal(cooling.length, 1);
    assert.equal(cooling[0].id, 'concepts/old-touch');
    assert.equal(cooling[0].touches, 1);
  });

  it('a doc touched right now is NOT a cooling candidate (still hot/warm)', () => {
    const heatIndex = buildHeatIndex([{ topic: 'concepts/fresh', ts: new Date(NOW_MS).toISOString() }]);
    const docs = [{ id: 'concepts/fresh', fm: { title: 'Fresh' } }];
    assert.deepEqual(coolingCandidates(docs, heatIndex, NOW_MS), []);
  });

  it('a doc the ledger never touched at all is NOT a cooling candidate (never was hot)', () => {
    const heatIndex = buildHeatIndex([{ topic: 'concepts/other', ts: new Date(NOW_MS).toISOString() }]);
    const docs = [{ id: 'concepts/never-touched', fm: { title: 'Never touched' } }];
    assert.deepEqual(coolingCandidates(docs, heatIndex, NOW_MS), []);
  });
});

describe('reflect — renderReflectReport (pure)', () => {
  it('renders all three sections, "_none_" when empty', () => {
    const out = renderReflectReport({ proposals: [], consolidation: { strong: [], single: [] }, cooling: [] });
    assert.match(out, /## 1\. Supersede proposals \(reconcile\): 0/);
    assert.match(out, /## 2\. Merge candidates \(consolidate\)/);
    assert.match(out, /## 3\. Cooled facts \(heat, Ф5\): 0/);
    assert.equal((out.match(/_none_/g) || []).length, 3);
  });

  it('renders a supersede proposal, a merge candidate, and a cooled fact when present', () => {
    const out = renderReflectReport({
      proposals: [{ older: 'concepts/old', newer: 'concepts/new', type: 'Concept', score: 0.5 }],
      consolidation: { strong: [{ key: 'gap', engines: ['claude-code', 'openclaw'], title: 'Gap' }], single: [] },
      cooling: [{ id: 'concepts/cooled', title: 'Cooled', touches: 2, lastTs: '2026-06-01T00:00:00Z' }],
    });
    assert.match(out, /предлагаю пометить \*\*concepts\/old\*\*/);
    assert.match(out, /superseded_by: \/concepts\/new\.md/);
    assert.match(out, /🔴 \*\*gap\*\*/);
    assert.match(out, /\*\*concepts\/cooled\*\* — 2 ledger touch\(es\), last 2026-06-01/);
  });
});

// ---------------------------------------------------------------------------
// CLI + human-gate: reflect prints a combined report but never edits concept files
// ---------------------------------------------------------------------------

describe('reflect — CLI (subprocess), human-gate', () => {
  it('exits 0, prints all three sections, and does not touch any concept file byte-for-byte', () => {
    const root = tmpRoot('samemind-reflect-cli-');
    const oldFile = writeConcept(root, 'concepts/old-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] });
    utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));
    const newFile = writeConcept(root, 'concepts/new-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] });
    utimesSync(newFile, new Date('2026-06-01'), new Date('2026-06-01'));
    const before = { old: readFileSync(oldFile, 'utf8'), new: readFileSync(newFile, 'utf8') };

    const { code, out } = runCli(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /# Reflect proposals — reconcile \+ consolidate \+ heat \(Ф5\)/);
    assert.match(out, /## 1\. Supersede proposals \(reconcile\)/);
    assert.match(out, /## 2\. Merge candidates \(consolidate\)/);
    assert.match(out, /## 3\. Cooled facts \(heat, Ф5\)/);
    assert.match(out, /предлагаю пометить \*\*concepts\/old-idea\*\*/);
    assert.match(out, /superseded_by: \/concepts\/new-idea\.md/);

    // human-gate: files on disk are byte-for-byte unchanged — reflect only prints/writes its
    // OWN report, never a concept's frontmatter (same proof reconcile.test.mjs uses for Ф2).
    assert.equal(readFileSync(oldFile, 'utf8'), before.old);
    assert.equal(readFileSync(newFile, 'utf8'), before.new);
  });

  it('--write saves the combined report under inbox/, still without touching concept files', () => {
    const root = tmpRoot('samemind-reflect-write-');
    const f1 = writeConcept(root, 'concepts/old-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] }, '# x\n', new Date('2026-01-01'));
    const f2 = writeConcept(root, 'concepts/new-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] }, '# x\n', new Date('2026-06-01'));
    const before = { f1: readFileSync(f1, 'utf8'), f2: readFileSync(f2, 'utf8') };

    const { code, out } = runCli(root, ['--write']);
    assert.equal(code, 0, out);
    const reportPath = join(root, 'inbox', '_reflect-report.md');
    assert.ok(existsSync(reportPath));
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Reflect proposals/);
    assert.match(report, /superseded_by/);

    assert.equal(readFileSync(f1, 'utf8'), before.f1);
    assert.equal(readFileSync(f2, 'utf8'), before.f2);
  });

  it('a fact touched via the ledger, then cooled off, surfaces in section 3 — and is never hidden from list', () => {
    const root = tmpRoot('samemind-reflect-heat-');
    const conceptFile = writeConcept(root, 'concepts/runbook.md', { type: 'Concept', title: 'Runbook alpha' });
    const before = readFileSync(conceptFile, 'utf8');

    // Ledger event far outside HEAT_WINDOW_DAYS — a cooled-off touch, not a never-touched fact.
    const oldTs = new Date(Date.now() - (HEAT_WINDOW_DAYS + 10) * 86_400_000).toISOString();
    mkdirSync(join(root, 'ledger'), { recursive: true });
    writeFileSync(join(root, 'ledger', 'events.jsonl'), JSON.stringify({
      ts: oldTs, actor: 'test', topic: 'concepts/runbook', phase: 'step', status: 'ok',
      action: 'touched it', artifact: null, ref: null, quarantine: false, matches: [],
    }) + '\n');

    const { code, out } = runCli(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /## 3\. Cooled facts \(heat, Ф5\): 1/);
    assert.match(out, /\*\*concepts\/runbook\*\* — 1 ledger touch\(es\)/);

    // human-gate holds here too — concept file untouched despite being named in the report.
    assert.equal(readFileSync(conceptFile, 'utf8'), before);
  });

  it('no proposals anywhere → all three sections report zero/none, exit 0', () => {
    const root = tmpRoot('samemind-reflect-none-');
    writeConcept(root, 'concepts/unrelated-one.md', { type: 'Concept', title: 'Completely unrelated topic alpha', tags: [] });
    const { code, out } = runCli(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /## 1\. Supersede proposals \(reconcile\): 0/);
    assert.match(out, /## 3\. Cooled facts \(heat, Ф5\): 0/);
  });
});

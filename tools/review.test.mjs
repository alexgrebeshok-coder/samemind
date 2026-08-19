#!/usr/bin/env node
// review.test.mjs — tools/review.mjs (Э7.4a weekly hygiene review).
// Human-gate: review without apply must not change any concept file byte-for-byte.
// Run: node --test tools/review.test.mjs
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runInit } from './init.mjs';
import { load } from './lib/okf.mjs';
import { buildHeatIndex } from './lib/hygiene.mjs';
import {
  collectStaleCandidates, collectConflictCandidates, collectUnarchivedStale,
  collectOrphanCandidates, parseReviewPlan,
} from './lib/review.mjs';
import { buildLinksModel } from './okf-query.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW_CLI = join(HERE, 'review.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');
const NOW_MS = new Date('2026-07-18T00:00:00Z').getTime();
const OLD_TS = '2024-01-01T00:00:00Z';

let roots = [];
function tmpRoot(prefix) {
  const r = mkdtempSync(join(tmpdir(), prefix));
  roots.push(r);
  runInit({ targetDir: r });
  return r;
}

function writeConcept(root, relPath, frontmatter, body = '# x\n', mtime = null) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).flatMap(([k, v]) => {
    if (Array.isArray(v)) return [`${k}: [${v.join(', ')}]`];
    if (v === true || v === false) return [`${k}: ${v}`];
    return [`${k}: ${v}`];
  });
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  if (mtime) utimesSync(full, mtime, mtime);
  return full;
}

function runCli(root, args) {
  const r = spawnSync(process.execPath, [REVIEW_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function snapshotFiles(root, paths) {
  const snap = {};
  for (const p of paths) snap[p] = readFileSync(join(root, p), 'utf8');
  return snap;
}

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('review — collectStaleCandidates', () => {
  it('flags old concepts with decay penalty and no heat', () => {
    const root = tmpRoot('samemind-review-stale-');
    writeConcept(root, 'concepts/old-fact.md', {
      type: 'Concept', title: 'Old fact', timestamp: OLD_TS,
    }, '# x\n', new Date(OLD_TS));
    const docs = load({}, root);
    const candidates = collectStaleCandidates(docs, { now: NOW_MS, staleDays: 60, heatIndex: buildHeatIndex([]) });
    assert.ok(candidates.some(c => c.id === 'concepts/old-fact'));
    assert.equal(candidates.find(c => c.id === 'concepts/old-fact').suggested, 'forget');
  });

  it('skips timeless Identity/User/EngineRule types', () => {
    const root = tmpRoot('samemind-review-stale-skip-');
    writeConcept(root, 'identity/me.md', { type: 'Identity', name: 'me', timestamp: OLD_TS });
    const docs = load({}, root);
    const candidates = collectStaleCandidates(docs, { now: NOW_MS, staleDays: 60, heatIndex: buildHeatIndex([]) });
    assert.equal(candidates.some(c => c.id === 'identity/me'), false);
  });
});

describe('review — collectConflictCandidates', () => {
  it('surfaces unresolved contradiction pairs with merge suggestion', () => {
    const older = {
      id: 'concepts/retrieval-idea', file: '/tmp/a', fm: { type: 'Concept', title: 'Retrieval idea', tags: ['memory'] },
      supersedes: [], supersededBy: [],
    };
    const newer = {
      id: 'concepts/retrieval-approach', file: '/tmp/b', fm: { type: 'Concept', title: 'Retrieval approach', tags: ['memory'] },
      supersedes: [], supersededBy: [],
    };
    const out = collectConflictCandidates([older, newer]);
    assert.equal(out.length, 2);
    assert.ok(out.every(c => c.suggested === 'merge'));
    assert.ok(out.some(c => c.id === 'concepts/retrieval-idea' && c.conflictWith === 'concepts/retrieval-approach'));
  });
});

describe('review — collectUnarchivedStale', () => {
  it('lists deprecated concepts outside archive/', () => {
    const doc = {
      id: 'concepts/ghost', file: '/tmp/g', fm: { type: 'Concept', deprecated: true, timestamp: OLD_TS },
      supersedes: [], supersededBy: [],
    };
    const out = collectUnarchivedStale([doc], { now: NOW_MS });
    assert.equal(out.length, 1);
    assert.equal(out[0].reasons[0], 'deprecated');
    assert.equal(out[0].suggested, 'archive');
  });

  it('lists superseded-by-map concepts not yet under archive/', () => {
    const old = { id: 'concepts/old', fm: { type: 'Concept' }, supersedes: [], supersededBy: [] };
    const neu = { id: 'concepts/new', fm: { type: 'Concept' }, supersedes: ['/concepts/old.md'], supersededBy: [] };
    const out = collectUnarchivedStale([old, neu], { now: NOW_MS });
    assert.ok(out.some(c => c.id === 'concepts/old' && c.reasons.includes('superseded')));
  });
});

describe('review — collectOrphanCandidates', () => {
  it('flags concepts with no inbound edges', () => {
    const root = tmpRoot('samemind-review-orphan-');
    writeConcept(root, 'concepts/parent.md', { type: 'Concept', title: 'Parent' });
    writeConcept(root, 'concepts/orphan.md', { type: 'Concept', title: 'Orphan' });
    writeConcept(root, 'concepts/linker.md', { type: 'Concept', title: 'Linker' }, '[[orphan]]\n');
    const docs = load({}, root);
    const model = buildLinksModel(docs, { root });
    const out = collectOrphanCandidates(docs, model);
    assert.ok(out.some(c => c.id === 'concepts/orphan'));
    assert.equal(out.find(c => c.id === 'concepts/orphan').suggested, 'archive');
  });
});

describe('review — CLI human-gate', () => {
  it('review without apply leaves all concept files byte-for-byte unchanged', () => {
    const root = tmpRoot('samemind-review-noapply-');
    const f1 = writeConcept(root, 'concepts/old-idea.md', {
      type: 'Concept', title: 'Retrieval idea', tags: ['memory'], timestamp: OLD_TS,
    }, '# x\n', new Date('2026-01-01'));
    const f2 = writeConcept(root, 'concepts/new-idea.md', {
      type: 'Concept', title: 'Retrieval approach', tags: ['memory'], timestamp: '2026-06-01T00:00:00Z',
    }, '# x\n', new Date('2026-06-01'));
    const f3 = writeConcept(root, 'concepts/deprecated-one.md', {
      type: 'Concept', title: 'Deprecated', deprecated: true, timestamp: OLD_TS,
    });
    const before = snapshotFiles(root, [
      'concepts/old-idea.md', 'concepts/new-idea.md', 'concepts/deprecated-one.md',
    ]);

    const { code, out } = runCli(root, ['--json']);
    assert.equal(code, 0, out);
    const payload = JSON.parse(out.trim());
    assert.ok(payload.candidateCount >= 1);

    assert.deepEqual(snapshotFiles(root, [
      'concepts/old-idea.md', 'concepts/new-idea.md', 'concepts/deprecated-one.md',
    ]), before);
    assert.equal(readFileSync(f1, 'utf8'), before['concepts/old-idea.md']);
    assert.equal(readFileSync(f2, 'utf8'), before['concepts/new-idea.md']);
    assert.equal(readFileSync(f3, 'utf8'), before['concepts/deprecated-one.md']);
  });

  it('apply --plan forget soft-deprecates only the named id', () => {
    const root = tmpRoot('samemind-review-apply-forget-');
    writeConcept(root, 'concepts/to-forget.md', { type: 'Concept', title: 'To forget' });
    writeConcept(root, 'concepts/keep-me.md', { type: 'Concept', title: 'Keep' });
    const plan = join(root, 'plan.txt');
    writeFileSync(plan, 'concepts/to-forget forget\nconcepts/keep-me keep\n');

    const { code, out } = runCli(root, ['apply', '--plan', plan]);
    assert.equal(code, 0, out);

    const forgot = readFileSync(join(root, 'concepts/to-forget.md'), 'utf8');
    assert.match(forgot, /deprecated: true/);
    const kept = readFileSync(join(root, 'concepts/keep-me.md'), 'utf8');
    assert.doesNotMatch(kept, /deprecated: true/);
  });

  it('apply --plan archive moves file under archive/', () => {
    const root = tmpRoot('samemind-review-apply-archive-');
    writeConcept(root, 'concepts/move-me.md', { type: 'Concept', title: 'Move' });
    const plan = join(root, 'plan.txt');
    writeFileSync(plan, 'concepts/move-me archive\n');

    const { code } = runCli(root, ['apply', '--plan', plan]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(root, 'concepts/move-me.md')), false);
    assert.ok(existsSync(join(root, 'archive/concepts/move-me.md')));
  });

  it('apply --plan archive twice is idempotent (no archive/archive/, second run skips)', () => {
    const root = tmpRoot('samemind-review-apply-archive-idem-');
    writeConcept(root, 'concepts/move-me.md', { type: 'Concept', title: 'Move' });
    const plan = join(root, 'plan.txt');
    writeFileSync(plan, 'concepts/move-me archive\n');

    const first = runCli(root, ['apply', '--plan', plan]);
    assert.equal(first.code, 0, first.out);
    assert.ok(existsSync(join(root, 'archive/concepts/move-me.md')));

    const second = runCli(root, ['apply', '--plan', plan]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /skip: already archived/);
    assert.equal(existsSync(join(root, 'archive/archive/concepts/move-me.md')), false);
    assert.ok(existsSync(join(root, 'archive/concepts/move-me.md')));
  });

  it('apply --plan full plan is byte-for-byte idempotent on second run', () => {
    const root = tmpRoot('samemind-review-apply-idem-full-');
    writeConcept(root, 'concepts/to-archive.md', { type: 'Concept', title: 'Archive me' });
    writeConcept(root, 'concepts/to-forget.md', { type: 'Concept', title: 'Forget me' });
    writeConcept(root, 'concepts/merge-src.md', {
      type: 'Concept', title: 'Retrieval idea', tags: ['memory'],
    });
    writeConcept(root, 'concepts/merge-dst.md', {
      type: 'Concept', title: 'Retrieval approach', tags: ['memory'],
    });
    writeConcept(root, 'concepts/untouched.md', { type: 'Concept', title: 'Keep' });
    const plan = join(root, 'plan.txt');
    writeFileSync(plan, [
      'concepts/to-archive archive',
      'concepts/to-forget forget',
      'concepts/merge-src merge concepts/merge-dst',
      'concepts/untouched keep',
    ].join('\n') + '\n');

    const paths = [
      'concepts/to-forget.md',
      'concepts/merge-src.md',
      'concepts/merge-dst.md',
      'concepts/untouched.md',
      'archive/concepts/to-archive.md',
    ];
    const snap = () => snapshotFiles(root, paths.filter(p => existsSync(join(root, p))));

    const first = runCli(root, ['apply', '--plan', plan]);
    assert.equal(first.code, 0, first.out);
    const afterFirst = snap();

    const second = runCli(root, ['apply', '--plan', plan]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /skip: already archived/);
    assert.match(second.out, /skip: already deprecated/);
    assert.match(second.out, /skip: already merged/);
    assert.deepEqual(snap(), afterFirst);
    assert.equal(existsSync(join(root, 'archive/archive/concepts/to-archive.md')), false);
  });

  it('bin/samemind.mjs routes review to tools/review.mjs', () => {
    const root = tmpRoot('samemind-review-bin-');
    const r = spawnSync(process.execPath, [BIN, 'review'], {
      env: { ...process.env, OKF_ROOT: root },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Memory review/);
  });
});

describe('review — parseReviewPlan', () => {
  it('parses tab/space separated decisions and skips comments', () => {
    const raw = '# plan\nconcepts/a\tforget\nconcepts/b merge concepts/c\n';
    assert.deepEqual(parseReviewPlan(raw), [
      { id: 'concepts/a', action: 'forget', target: null },
      { id: 'concepts/b', action: 'merge', target: 'concepts/c' },
    ]);
  });
});

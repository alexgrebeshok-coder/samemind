#!/usr/bin/env node
// reconcile.test.mjs — tools/reconcile.mjs (Ф2 bi-temporal supersede proposals).
// Human-gate is the whole point: reconcile must never touch a concept's frontmatter, only print
// (or --write a report of) proposals. Run: node --test tools/reconcile.test.mjs
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildProposals, renderReport } from './reconcile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECONCILE_CLI = join(HERE, 'reconcile.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');

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
  const r = spawnSync(process.execPath, [RECONCILE_CLI, ...args], {
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
// buildProposals (pure) — direction by mtime, skips already-resolved pairs
// ---------------------------------------------------------------------------

describe('reconcile — buildProposals (pure)', () => {
  it('finds a known duplicate pair and proposes the newer file as the replacement', () => {
    // tags: ['memory'] shared, same as the known-good fixture in hygiene.test.mjs's own
    // findContradictions test — title alone ("idea" vs "approach") sits just under the 0.34
    // Jaccard threshold, the shared tag is what pushes this pair over it.
    const older = { id: 'concepts/retrieval-idea', file: '/tmp/older.md', fm: { type: 'Concept', title: 'Retrieval idea', tags: ['memory'] }, supersedes: [], supersededBy: [] };
    const newer = { id: 'concepts/retrieval-approach', file: '/tmp/newer.md', fm: { type: 'Concept', title: 'Retrieval approach', tags: ['memory'] }, supersedes: [], supersededBy: [] };
    const root = tmpRoot('samemind-reconcile-mtime-');
    const olderFile = writeConcept(root, 'a.md', { x: 1 });
    const newerFile = writeConcept(root, 'b.md', { x: 1 });
    older.file = olderFile;
    newer.file = newerFile;
    utimesSync(olderFile, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(newerFile, new Date('2026-06-01'), new Date('2026-06-01'));

    const proposals = buildProposals([older, newer]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].older, 'concepts/retrieval-idea');
    assert.equal(proposals[0].newer, 'concepts/retrieval-approach');
  });

  it('does not propose a pair already linked via supersedes or superseded_by', () => {
    const root = tmpRoot('samemind-reconcile-resolved-');
    const a = { id: 'concepts/old', file: writeConcept(root, 'old.md', { x: 1 }), fm: { type: 'Concept', title: 'Retrieval idea', tags: [] }, supersedes: [], supersededBy: ['/concepts/new.md'] };
    const b = { id: 'concepts/new', file: writeConcept(root, 'new.md', { x: 1 }), fm: { type: 'Concept', title: 'Retrieval idea', tags: [] }, supersedes: [], supersededBy: [] };
    assert.deepEqual(buildProposals([a, b]), []);
  });

  it('--dir scoping: only pairs inside the given subdir are proposed', () => {
    const root = tmpRoot('samemind-reconcile-dir-');
    const a = { id: 'concepts/retrieval-idea', file: writeConcept(root, 'concepts/a.md', { x: 1 }), fm: { type: 'Concept', title: 'Retrieval idea', tags: ['memory'] }, supersedes: [], supersededBy: [] };
    const b = { id: 'concepts/retrieval-approach', file: writeConcept(root, 'concepts/b.md', { x: 1 }), fm: { type: 'Concept', title: 'Retrieval approach', tags: ['memory'] }, supersedes: [], supersededBy: [] };
    const c = { id: 'projects/retrieval-idea', file: writeConcept(root, 'projects/c.md', { x: 1 }), fm: { type: 'Concept', title: 'Retrieval idea', tags: ['memory'] }, supersedes: [], supersededBy: [] };
    const inConcepts = buildProposals([a, b, c], { dir: 'concepts' });
    assert.equal(inConcepts.length, 1);
    assert.ok(inConcepts.every(p => p.older.startsWith('concepts/') || p.newer.startsWith('concepts/')));

    const inProjects = buildProposals([a, b, c], { dir: 'projects' });
    assert.equal(inProjects.length, 0); // only one doc in projects/, no pair to compare
  });

  it('renderReport: human-readable proposal line names both facts and mentions the field to set', () => {
    const out = renderReport([{ older: 'concepts/old', newer: 'concepts/new', type: 'Concept', score: 0.5 }]);
    assert.match(out, /предлагаю пометить \*\*concepts\/old\*\*/);
    assert.match(out, /superseded_by: \/concepts\/new\.md/);
    assert.match(out, /concepts\/new/);
  });

  it('renderReport: no proposals → explicit "none"', () => {
    assert.match(renderReport([]), /_none_/);
  });
});

// ---------------------------------------------------------------------------
// CLI + human-gate: reconcile prints proposals but never edits the concept files
// ---------------------------------------------------------------------------

describe('reconcile — CLI (subprocess), human-gate', () => {
  it('finds the fixture duplicate, exits 0, and does not touch either file on disk', () => {
    const root = tmpRoot('samemind-reconcile-cli-');
    const oldFile = writeConcept(root, 'concepts/old-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] });
    utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));
    const newFile = writeConcept(root, 'concepts/new-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] });
    utimesSync(newFile, new Date('2026-06-01'), new Date('2026-06-01'));
    const before = { old: readFileSync(oldFile, 'utf8'), new: readFileSync(newFile, 'utf8') };

    const { code, out } = runCli(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /предлагаю пометить \*\*concepts\/old-idea\*\*/);
    assert.match(out, /superseded_by: \/concepts\/new-idea\.md/);

    // human-gate: files on disk are byte-for-byte unchanged — reconcile only prints/writes its
    // OWN report, never a concept's frontmatter.
    assert.equal(readFileSync(oldFile, 'utf8'), before.old);
    assert.equal(readFileSync(newFile, 'utf8'), before.new);
  });

  it('--write saves the report under inbox/, still without touching the concept files', () => {
    const root = tmpRoot('samemind-reconcile-write-');
    writeConcept(root, 'concepts/old-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] }, '# x\n', new Date('2026-01-01'));
    writeConcept(root, 'concepts/new-idea.md', { type: 'Concept', title: 'Retrieval idea one', tags: [] }, '# x\n', new Date('2026-06-01'));

    const { code, out } = runCli(root, ['--write']);
    assert.equal(code, 0, out);
    const reportPath = join(root, 'inbox', '_reconcile-report.md');
    assert.ok(existsSync(reportPath));
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Reconcile proposals/);
    assert.match(report, /superseded_by/);
  });

  it('no contradictions → "Proposals: 0" / none, exit 0', () => {
    const root = tmpRoot('samemind-reconcile-none-');
    writeConcept(root, 'concepts/unrelated-one.md', { type: 'Concept', title: 'Completely unrelated topic alpha', tags: [] });
    writeConcept(root, 'concepts/unrelated-two.md', { type: 'Concept', title: 'Something else entirely beta', tags: [] });
    const { code, out } = runCli(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /Proposals: 0/);
    assert.match(out, /_none_/);
  });

  it('bin/samemind.mjs routes "reconcile" to tools/reconcile.mjs (UAT: was missing from ROUTES)', () => {
    const root = tmpRoot('samemind-reconcile-bin-');
    const r = spawnSync(process.execPath, [BIN, 'reconcile'], {
      env: { ...process.env, OKF_ROOT: root },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Reconcile proposals/);
  });
});

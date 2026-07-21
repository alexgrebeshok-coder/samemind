#!/usr/bin/env node
// compose-roots.test.mjs — U5/G-B: multi-root recall ("Same mind"). Unit tests for
// tools/lib/compose-roots.mjs against synthetic project+global fixtures (node --test).
// Everything here calls the lib functions directly with explicit `root` arguments (load()/
// searchRoot() are root-parameterized, see lib/okf.mjs), so — unlike gde-sqlite.test.mjs/
// okf-cache.test.mjs — there is no need for the "set env before first dynamic import" dance:
// no function under test here reads the module-level ROOT constant.
// Run: node --test tools/compose-roots.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from './lib/okf.mjs';
import {
  resolveGlobalRoot, searchGlobalHalf, mergeWithGlobal, searchRoot, idxDirFor,
} from './lib/compose-roots.mjs';

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  return full;
}

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('compose-roots — resolveGlobalRoot', () => {
  const saved = process.env.OKF_GLOBAL_ROOT;
  it('no env, no --no-global → defaults to $HOME/.samemind/bundle', () => {
    delete process.env.OKF_GLOBAL_ROOT;
    assert.match(resolveGlobalRoot(), /\.samemind[/\\]bundle$/);
  });
  it('OKF_GLOBAL_ROOT set → overrides the default (test isolation escape hatch)', () => {
    process.env.OKF_GLOBAL_ROOT = '/tmp/fake-global';
    assert.equal(resolveGlobalRoot(), '/tmp/fake-global');
  });
  it('OKF_GLOBAL_ROOT="" → explicitly disabled (null)', () => {
    process.env.OKF_GLOBAL_ROOT = '';
    assert.equal(resolveGlobalRoot(), null);
  });
  it('--no-global (noGlobal:true) wins even when OKF_GLOBAL_ROOT is set', () => {
    process.env.OKF_GLOBAL_ROOT = '/tmp/fake-global';
    assert.equal(resolveGlobalRoot({ noGlobal: true }), null);
  });
  it('cleanup', () => {
    if (saved === undefined) delete process.env.OKF_GLOBAL_ROOT; else process.env.OKF_GLOBAL_ROOT = saved;
  });
});

describe('compose-roots — searchGlobalHalf: no-op cases (regression guarantee)', () => {
  it('globalRoot null → returns null', async () => {
    const half = await searchGlobalHalf(null, [], { query: 'x', mode: 'bm25' });
    assert.equal(half, null);
  });

  it('globalRoot does not exist on disk → returns null (never throws)', async () => {
    const half = await searchGlobalHalf('/definitely/not/a/real/path/xyz', [], { query: 'x', mode: 'bm25' });
    assert.equal(half, null);
  });
});

describe('compose-roots — project + global fixtures: dedup, merge, global: provenance', () => {
  let projectRoot, globalRoot;

  it('setup fixtures', () => {
    projectRoot = tmpRoot('samemind-cr-proj-');
    globalRoot = tmpRoot('samemind-cr-glob-');
    writeConcept(projectRoot, 'entities/alpha.md', { type: 'Concept', title: 'Alpha Project Note' },
      'Project-local note about widgets and gears.\n');
    writeConcept(projectRoot, 'entities/shared.md', { type: 'Concept', title: 'Shared PROJECT version' },
      'Project version of widgets shared doc.\n');
    writeConcept(globalRoot, 'entities/beta.md', { type: 'Concept', title: 'Beta Global Note' },
      'Global personal note about widgets and rockets.\n');
    // same id as projectRoot's entities/shared.md — must be dropped, project wins
    writeConcept(globalRoot, 'entities/shared.md', { type: 'Concept', title: 'Shared GLOBAL version' },
      'Global version of widgets shared doc — should be dropped.\n');
  });

  it('id collision: global doc dropped, project wins, warning reported', async () => {
    const projectDocs = load({}, projectRoot).filter(d => !d.reserved);
    const half = await searchGlobalHalf(globalRoot, projectDocs, { query: 'widgets', mode: 'bm25', k: 10 });
    assert.ok(half, 'expected a global half result');
    assert.ok(!half.docs.some(d => d.id === 'entities/shared'), 'colliding global doc must be dropped');
    assert.ok(half.docs.some(d => d.id === 'entities/beta'), 'non-colliding global doc kept');
    assert.equal(half.dedupWarnings.length, 1);
    assert.match(half.dedupWarnings[0], /entities\/shared.*dropped/);
  });

  it('merge: both roots present → union sorted by score, tagged with source, global: provenance', async () => {
    const projectDocs = load({}, projectRoot).filter(d => !d.reserved);
    const projectResult = await searchRoot(projectRoot, projectDocs, { query: 'widgets', mode: 'bm25', k: 10 });
    const globalHalf = await searchGlobalHalf(globalRoot, projectDocs, { query: 'widgets', mode: 'bm25', k: 10 });
    const composed = mergeWithGlobal(projectResult, globalHalf, 10);

    const ids = composed.hits.map(h => h.id);
    assert.ok(ids.includes('entities/alpha'));
    assert.ok(ids.includes('entities/beta'));
    assert.ok(ids.includes('entities/shared'));
    assert.equal(ids.filter(id => id === 'entities/shared').length, 1, 'no duplicate — global copy was deduped away');

    // sorted by score, descending
    for (let i = 1; i < composed.hits.length; i++) {
      assert.ok(composed.hits[i - 1].score >= composed.hits[i].score, 'hits must be sorted by score desc');
    }
    const beta = composed.hits.find(h => h.id === 'entities/beta');
    assert.equal(beta.source, 'global');
    const alpha = composed.hits.find(h => h.id === 'entities/alpha');
    assert.equal(alpha.source, 'project');
    assert.equal(composed.dedupWarnings.length, 1);
  });

  it('cleanup fixtures', () => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  });
});

describe('compose-roots — mergeWithGlobal passthrough (byte-identical no-global regression)', () => {
  it('globalResult null → returns the SAME object reference, untouched', () => {
    const projectResult = { hits: [{ id: 'a', score: 1 }], mode: 'bm25', warning: null };
    const merged = mergeWithGlobal(projectResult, null, 5);
    assert.equal(merged, projectResult, 'must be the exact same object — no copy, no source field added');
  });

  it('globalResult with zero hits → same passthrough (e.g. global bundle exists but every doc was deduped away)', () => {
    const projectResult = { hits: [{ id: 'a', score: 1 }], mode: 'bm25', warning: null };
    const globalResult = { hits: [], mode: null, warning: null, dedupWarnings: ['dropped one'] };
    const merged = mergeWithGlobal(projectResult, globalResult, 5);
    assert.equal(merged, projectResult);
  });
});

describe('compose-roots — mergeWithGlobal per-root score normalization (UAT: "омега-уникум")', () => {
  it('a unique exact global hit with a lower raw score than unrelated local hits now lands in the top 3', () => {
    // Reproduces the UAT symptom: local corpus's raw BM25 scores run higher (different IDF/length
    // stats) than the global corpus's, even though the global hit is the only truly relevant one.
    // Without normalization this hit would rank #5 (below all 4 local hits, by raw score below).
    const projectResult = {
      hits: [
        { id: 'local/a', score: 0.56 },
        { id: 'local/b', score: 0.50 },
        { id: 'local/c', score: 0.45 },
        { id: 'local/d', score: 0.40 },
      ],
      mode: 'bm25', warning: null,
    };
    const globalResult = {
      hits: [{ id: 'global/omega-unikum', score: 0.396 }],
      mode: 'bm25', warning: null, dedupWarnings: [],
    };
    const merged = mergeWithGlobal(projectResult, globalResult, 10);
    const rank = merged.hits.findIndex(h => h.id === 'global/omega-unikum');
    assert.ok(rank >= 0 && rank < 3, `expected global/omega-unikum in top 3, got rank ${rank}`);
    assert.equal(merged.hits.find(h => h.id === 'global/omega-unikum').source, 'global');
  });

  it('normalization preserves within-corpus order (a lazy /max, not a reshuffle)', () => {
    const projectResult = { hits: [{ id: 'p1', score: 0.8 }, { id: 'p2', score: 0.2 }], mode: 'bm25', warning: null };
    const globalResult = { hits: [{ id: 'g1', score: 0.9 }, { id: 'g2', score: 0.1 }], mode: 'bm25', warning: null, dedupWarnings: [] };
    const merged = mergeWithGlobal(projectResult, globalResult, 10);
    const rankOf = id => merged.hits.findIndex(h => h.id === id);
    assert.ok(rankOf('p1') < rankOf('p2'), 'p1 (higher local score) must still rank above p2');
    assert.ok(rankOf('g1') < rankOf('g2'), 'g1 (higher global score) must still rank above g2');
  });

  it('all-zero scores in a corpus pass through unchanged (no NaN)', () => {
    const projectResult = { hits: [{ id: 'p1', score: 0 }], mode: 'bm25', warning: null };
    const globalResult = { hits: [{ id: 'g1', score: 0 }], mode: 'bm25', warning: null, dedupWarnings: [] };
    const merged = mergeWithGlobal(projectResult, globalResult, 10);
    assert.ok(merged.hits.every(h => Number.isFinite(h.score)));
  });
});

describe('compose-roots — per-root index isolation (searchRoot reads <root>/tools/.index/, not the other root\'s)', () => {
  let rootA, rootB;

  it('setup: two roots, each with its OWN embeddings.json pointing different docs to the top', () => {
    rootA = tmpRoot('samemind-cr-idxA-');
    rootB = tmpRoot('samemind-cr-idxB-');
    writeConcept(rootA, 'entities/only-a.md', { type: 'Concept', title: 'Only in A' }, 'content a\n');
    writeConcept(rootB, 'entities/only-b.md', { type: 'Concept', title: 'Only in B' }, 'content b\n');

    mkdirSync(idxDirFor(rootA), { recursive: true });
    mkdirSync(idxDirFor(rootB), { recursive: true });
    writeFileSync(join(idxDirFor(rootA), 'embeddings.json'), JSON.stringify({
      model: 'mock', items: { 'entities/only-a': { title: 'Only in A', type: 'Concept', visibility: 'internal', vector: [1, 0] } },
    }));
    writeFileSync(join(idxDirFor(rootB), 'embeddings.json'), JSON.stringify({
      model: 'mock', items: { 'entities/only-b': { title: 'Only in B', type: 'Concept', visibility: 'internal', vector: [0, 1] } },
    }));
  });

  it('searchRoot(rootA) semantic hit comes from rootA\'s own index, not rootB\'s', async () => {
    const embed = async () => [1, 0]; // matches rootA's stored vector exactly
    const docsA = load({}, rootA).filter(d => !d.reserved);
    const result = await searchRoot(rootA, docsA, {
      query: 'anything', mode: 'semantic', embed, k: 5, indexBackend: 'json',
    });
    assert.equal(result.mode, 'semantic');
    assert.equal(result.hits[0].id, 'entities/only-a');
  });

  it('searchRoot(rootB) with the same query vector picks up rootB\'s own index', async () => {
    const embed = async () => [0, 1]; // matches rootB's stored vector exactly
    const docsB = load({}, rootB).filter(d => !d.reserved);
    const result = await searchRoot(rootB, docsB, {
      query: 'anything', mode: 'semantic', embed, k: 5, indexBackend: 'json',
    });
    assert.equal(result.mode, 'semantic');
    assert.equal(result.hits[0].id, 'entities/only-b');
  });

  it('cleanup', () => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });
});

describe('compose-roots — perf-smoke: two roots costs ~2x one root, not quadratic', () => {
  function buildRoot(n) {
    const root = tmpRoot('samemind-cr-perf-');
    for (let i = 0; i < n; i++) {
      writeConcept(root, `entities/doc-${i}.md`, { type: 'Concept', title: `Doc ${i}` },
        `This is synthetic content number ${i} about widgets, gears, and rockets for perf smoke testing.\n`);
    }
    return root;
  }

  it('composing two N-doc roots takes roughly 2x one N-doc root (linear, not N^2)', async () => {
    const N = 400;
    const TRIALS = 5;
    const single = buildRoot(N);
    const projectRoot = buildRoot(N);
    const globalRoot = buildRoot(N);
    try {
      const singleDocs = load({}, single).filter(d => !d.reserved);
      const projectDocs = load({}, projectRoot).filter(d => !d.reserved);

      // node --test runs many files concurrently (this whole suite is 170+ files) — a single
      // wall-clock sample is at the mercy of scheduler/CPU contention from unrelated test
      // processes. Taking the MIN over several trials filters that noise out: the fastest trial
      // is the one least interrupted, closest to true CPU cost — a quadratic blowup would still
      // show up (it wouldn't get faster with more tries), ordinary contention would not.
      let oneRootMs = Infinity;
      let twoRootMs = Infinity;
      for (let i = 0; i < TRIALS; i++) {
        const t0 = process.hrtime.bigint();
        await searchRoot(single, singleDocs, { query: 'widgets gears', mode: 'bm25', k: 5 });
        const t1 = process.hrtime.bigint();
        oneRootMs = Math.min(oneRootMs, Number(t1 - t0) / 1e6);

        const t2 = process.hrtime.bigint();
        const projectResult = await searchRoot(projectRoot, projectDocs, { query: 'widgets gears', mode: 'bm25', k: 5 });
        const globalHalf = await searchGlobalHalf(globalRoot, projectDocs, { query: 'widgets gears', mode: 'bm25', k: 5 });
        mergeWithGlobal(projectResult, globalHalf, 5);
        const t3 = process.hrtime.bigint();
        twoRootMs = Math.min(twoRootMs, Number(t3 - t2) / 1e6);
      }

      // Generous bound: two independent linear searches ≈ 2x one, nowhere near quadratic (a
      // real O(N²) bug at N=400 would blow up by orders of magnitude, not by a small multiple —
      // this bound is loose specifically to survive CI/parallel-suite CPU contention noise).
      // A floor on oneRootMs avoids a flaky ratio when the single-root run is too fast to time
      // reliably (sub-millisecond noise dominates the ratio otherwise).
      const safeOneRootMs = Math.max(oneRootMs, 1);
      const ratio = twoRootMs / safeOneRootMs;
      assert.ok(ratio < 6, `expected ~2x cost for 2 roots vs 1, got ${ratio.toFixed(2)}x (one=${oneRootMs.toFixed(1)}ms, two=${twoRootMs.toFixed(1)}ms)`);
    } finally {
      rmSync(single, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});

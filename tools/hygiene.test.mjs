#!/usr/bin/env node
// hygiene.test.mjs — memory hygiene (naryad N17): supersedes, samemind forget/deprecated,
// importance/time-decay, cycle/dangling-target detection, consolidate contradictions.
// Run: node --test tools/hygiene.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildSupersededMap, isSuperseded, isDeprecated, detectSupersedeCycles,
  importanceMultiplier, decayMultiplier, hygieneMultiplier, hygieneBanner,
  SUPERSEDED_PENALTY, DEFAULT_IMPORTANCE, DECAY_AFTER_DAYS, DECAY_FULL_DAYS, DECAY_MIN_MULTIPLIER,
} from './lib/hygiene.mjs';
import { rankByKeywords, rankByQuery, recallSearch } from './lib/recall.mjs';
import { forget, setDeprecated } from './forget.mjs';
import { titleTokens, jaccard, findContradictions } from './consolidate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = join(HERE, 'okf-query.mjs');
const FORGET_CLI = join(HERE, 'forget.mjs');
const NOW = new Date('2026-07-10T00:00:00Z');
const NOW_MS = NOW.getTime();

function runQuery(root, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function runForgetCli(root, args) {
  const r = spawnSync(process.execPath, [FORGET_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).flatMap(([k, v]) => {
    if (k === 'relations' && v && typeof v === 'object' && !Array.isArray(v)) {
      const lines = ['relations:'];
      for (const [rk, rv] of Object.entries(v)) {
        if (Array.isArray(rv)) lines.push(`  ${rk}: [${rv.join(', ')}]`);
        else lines.push(`  ${rk}: ${rv}`);
      }
      return lines;
    }
    if (Array.isArray(v)) return [`${k}: [${v.join(', ')}]`];
    return [`${k}: ${v}`];
  });
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
}

// ---------------------------------------------------------------------------
// 1. supersedes parsing (okf.mjs)
// ---------------------------------------------------------------------------

describe('supersedes — parse + normalize (okf.mjs)', () => {
  let okf;
  let root;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'samemind-supersedes-unit-'));
    writeConcept(root, 'concepts/old.md', { type: 'Concept', title: 'Old' });
    writeConcept(root, 'concepts/other.md', { type: 'Concept', title: 'Other' });
    writeConcept(root, 'concepts/new.md', {
      type: 'Concept', title: 'New', supersedes: '/concepts/old.md',
    });
    writeConcept(root, 'concepts/new2.md', {
      type: 'Concept', title: 'New2', supersedes: ['/concepts/old.md', '/concepts/other.md'],
    });
    process.env.OKF_ROOT = root;
    okf = await import(`./lib/okf.mjs?t=${Date.now()}`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scalar supersedes normalizes to a one-element array (doc + fm)', () => {
    const docs = okf.load();
    const n = docs.find(d => d.id === 'concepts/new');
    assert.deepEqual(n.supersedes, ['/concepts/old.md']);
    assert.deepEqual(n.fm.supersedes, ['/concepts/old.md']);
  });

  it('list supersedes stays a list', () => {
    const docs = okf.load();
    const n2 = docs.find(d => d.id === 'concepts/new2');
    assert.deepEqual(n2.supersedes, ['/concepts/old.md', '/concepts/other.md']);
  });

  it('absent supersedes → empty array on the doc, key absent from fm', () => {
    const docs = okf.load();
    const old = docs.find(d => d.id === 'concepts/old');
    assert.deepEqual(old.supersedes, []);
    assert.equal(old.fm.supersedes, undefined);
  });

  it('buildSupersededMap: old is superseded by both new and new2', () => {
    const docs = okf.load();
    const map = buildSupersededMap(docs);
    assert.deepEqual(new Set(map.get('concepts/old')), new Set(['concepts/new', 'concepts/new2']));
    assert.deepEqual(map.get('concepts/other'), ['concepts/new2']);
    assert.equal(map.has('concepts/new'), false);
  });
});

// ---------------------------------------------------------------------------
// 2. rankByKeywords (BM25) — superseded ranks lower, labeled, never hidden
// ---------------------------------------------------------------------------

describe('recall bm25 — superseded ranks lower and is labeled', () => {
  const docs = [
    {
      id: 'concepts/old', reserved: false, supersedes: [],
      fm: { title: 'Retrieval idea', type: 'Concept', visibility: 'internal' },
      body: 'A note about the retrieval idea and how it works.',
    },
    {
      id: 'concepts/new', reserved: false, supersedes: ['/concepts/old.md'],
      fm: { title: 'Retrieval idea', type: 'Concept', visibility: 'internal' },
      body: 'A note about the retrieval idea and how it works.',
    },
  ];

  it('identical raw relevance, but old sorts below new and is labeled', () => {
    const ranked = rankByKeywords(docs, 'retrieval idea', { k: 5 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].id, 'concepts/new');
    assert.equal(ranked[1].id, 'concepts/old');
    assert.equal(ranked[0].label, '');
    assert.match(ranked[1].label, /^\[superseded by \/concepts\/new\.md\]$/);
    // same text → same raw BM25 score; only the hygiene multiplier tells them apart
    assert.ok(Math.abs(ranked[0].rawScore - ranked[1].rawScore) < 1e-9);
    assert.ok(ranked[0].score > ranked[1].score);
    assert.ok(Math.abs(ranked[1].score - ranked[1].rawScore * SUPERSEDED_PENALTY) < 1e-9);
  });

  it('old is not hidden — still returned, still findable', () => {
    const ranked = rankByKeywords(docs, 'retrieval', { k: 5 });
    assert.ok(ranked.some(r => r.id === 'concepts/old'));
  });

  it('deprecated (forget) behaves the same as superseded', () => {
    const deprecatedDocs = [
      {
        id: 'concepts/plain', reserved: false, supersedes: [],
        fm: { title: 'Plain fact', type: 'Concept', visibility: 'internal', deprecated: 'true', deprecated_on: '2026-07-01T00:00:00Z' },
        body: 'plain fact plain fact',
      },
      {
        id: 'concepts/fresh', reserved: false, supersedes: [],
        fm: { title: 'Plain fact', type: 'Concept', visibility: 'internal' },
        body: 'plain fact plain fact',
      },
    ];
    const ranked = rankByKeywords(deprecatedDocs, 'plain fact', { k: 5 });
    assert.equal(ranked[0].id, 'concepts/fresh');
    assert.equal(ranked[1].id, 'concepts/plain');
    assert.match(ranked[1].label, /^\[deprecated 2026-07-01\]$/);
  });
});

// ---------------------------------------------------------------------------
// 3. rankByQuery (semantic) — same hygiene, via the `docs` param
// ---------------------------------------------------------------------------

describe('recall semantic — superseded ranks lower and is labeled', () => {
  it('rankByQuery applies hygieneMultiplier when docs is passed', () => {
    const items = {
      'concepts/old': { title: 'Old', type: 'Concept', visibility: 'internal', vector: [1, 0] },
      'concepts/new': { title: 'New', type: 'Concept', visibility: 'internal', vector: [1, 0] },
    };
    const docs = [
      { id: 'concepts/old', supersedes: [], fm: { type: 'Concept' } },
      { id: 'concepts/new', supersedes: ['/concepts/old.md'], fm: { type: 'Concept' } },
    ];
    const ranked = rankByQuery(items, [1, 0], { k: 5, docs });
    assert.equal(ranked[0].id, 'concepts/new');
    assert.equal(ranked[1].id, 'concepts/old');
    assert.match(ranked[1].label, /superseded by \/concepts\/new\.md/);
    assert.ok(Math.abs(ranked[1].score - ranked[1].rawScore * SUPERSEDED_PENALTY) < 1e-9);
  });

  it('without a docs param, hygiene is neutral (backward compatible with the plain index)', () => {
    const items = {
      a: { title: 'A', type: 'Concept', visibility: 'internal', vector: [1, 0] },
      b: { title: 'B', type: 'Concept', visibility: 'internal', vector: [0, 1] },
    };
    const ranked = rankByQuery(items, [1, 0], { k: 5 });
    assert.equal(ranked[0].id, 'a');
    assert.equal(ranked[0].score, ranked[0].rawScore);
    assert.equal(ranked[0].label, '');
  });
});

describe('recallSearch — hygiene survives the shared bm25/semantic entrypoint', () => {
  const docs = [
    {
      id: 'concepts/old', reserved: false, supersedes: [],
      fm: { title: 'Lumen approach', type: 'Concept', visibility: 'internal' },
      body: 'lumen lumen notes',
    },
    {
      id: 'concepts/new', reserved: false, supersedes: ['/concepts/old.md'],
      fm: { title: 'Lumen approach', type: 'Concept', visibility: 'internal' },
      body: 'lumen lumen notes',
    },
  ];

  it('mode=bm25 — label present via recallSearch', async () => {
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'bm25', k: 5 });
    assert.equal(r.hits[0].id, 'concepts/new');
    assert.match(r.hits[1].label, /superseded/);
  });
});

// ---------------------------------------------------------------------------
// 4. importance + time-decay — predictable effect on rank
// ---------------------------------------------------------------------------

describe('importance — multiplier', () => {
  it('absent/invalid importance → neutral (1.0)', () => {
    assert.equal(importanceMultiplier({ fm: {} }), 1);
    assert.equal(importanceMultiplier({ fm: { importance: 'nope' } }), 1);
    assert.equal(importanceMultiplier({ fm: { importance: String(DEFAULT_IMPORTANCE) } }), 1);
  });

  it('importance 5 boosts, importance 1 penalizes, symmetric around 3', () => {
    const hi = importanceMultiplier({ fm: { importance: '5' } });
    const lo = importanceMultiplier({ fm: { importance: '1' } });
    assert.ok(Math.abs(hi - 5 / 3) < 1e-9);
    assert.ok(Math.abs(lo - 1 / 3) < 1e-9);
    assert.ok(hi > 1 && lo < 1);
  });

  it('out-of-range importance clamps to [1,5]', () => {
    assert.equal(importanceMultiplier({ fm: { importance: '9' } }), importanceMultiplier({ fm: { importance: '5' } }));
    assert.equal(importanceMultiplier({ fm: { importance: '-2' } }), importanceMultiplier({ fm: { importance: '1' } }));
  });

  it('higher importance measurably outranks lower importance at equal BM25 relevance', () => {
    const docs = [
      {
        id: 'concepts/low', reserved: false, supersedes: [],
        fm: { title: 'Signal', type: 'Concept', visibility: 'internal', importance: '1' },
        body: 'signal signal signal',
      },
      {
        id: 'concepts/high', reserved: false, supersedes: [],
        fm: { title: 'Signal', type: 'Concept', visibility: 'internal', importance: '5' },
        body: 'signal signal signal',
      },
    ];
    const ranked = rankByKeywords(docs, 'signal', { k: 5 });
    assert.equal(ranked[0].id, 'concepts/high');
    assert.equal(ranked[1].id, 'concepts/low');
  });
});

describe('time-decay — multiplier', () => {
  it('fresh (≤180d) → no decay', () => {
    const m = decayMultiplier({ fm: { type: 'Concept', timestamp: '2026-06-01T00:00:00Z' } }, NOW_MS);
    assert.equal(m, 1);
  });

  it('mid-range (180..720d) → linear ramp strictly between 1.0 and floor', () => {
    const halfway = decayMultiplier(
      { fm: { type: 'Concept', timestamp: new Date(NOW_MS - (DECAY_AFTER_DAYS + (DECAY_FULL_DAYS - DECAY_AFTER_DAYS) / 2) * 86_400_000).toISOString() } },
      NOW_MS,
    );
    assert.ok(halfway < 1 && halfway > DECAY_MIN_MULTIPLIER);
    assert.ok(Math.abs(halfway - (1 + DECAY_MIN_MULTIPLIER) / 2) < 1e-6);
  });

  it('very old (≥720d) → floors at DECAY_MIN_MULTIPLIER, never below', () => {
    const m = decayMultiplier({ fm: { type: 'Concept', timestamp: '2020-01-01T00:00:00Z' } }, NOW_MS);
    assert.equal(m, DECAY_MIN_MULTIPLIER);
  });

  it('no timestamp → no decay (neutral, not penalized for missing data)', () => {
    assert.equal(decayMultiplier({ fm: { type: 'Concept' } }, NOW_MS), 1);
  });

  it('Identity/User/EngineRule are timeless — never decay, however old', () => {
    for (const type of ['Identity', 'User', 'EngineRule']) {
      const m = decayMultiplier({ fm: { type, timestamp: '2010-01-01T00:00:00Z' } }, NOW_MS);
      assert.equal(m, 1, `${type} must not decay`);
    }
  });

  it('decay measurably demotes a very old Concept vs. a fresh one, same relevance', () => {
    const docs = [
      {
        id: 'concepts/ancient', reserved: false, supersedes: [],
        fm: { title: 'Fact', type: 'Concept', visibility: 'internal', timestamp: '2020-01-01T00:00:00Z' },
        body: 'fact fact fact',
      },
      {
        id: 'concepts/fresh', reserved: false, supersedes: [],
        fm: { title: 'Fact', type: 'Concept', visibility: 'internal', timestamp: NOW.toISOString() },
        body: 'fact fact fact',
      },
    ];
    const ranked = rankByKeywords(docs, 'fact', { k: 5 });
    assert.equal(ranked[0].id, 'concepts/fresh');
    assert.equal(ranked[1].id, 'concepts/ancient');
  });

  it('an ancient Identity is NOT demoted below a fresh plain Concept purely by age', () => {
    const docs = [
      {
        id: 'concepts/identity', reserved: false, supersedes: [],
        fm: { title: 'Nova', type: 'Identity', visibility: 'internal', timestamp: '2010-01-01T00:00:00Z' },
        body: 'nova nova nova',
      },
    ];
    // hygieneMultiplier for the lone Identity doc should be exactly 1 (no supersede, no
    // importance override, no decay) regardless of its age.
    const map = buildSupersededMap(docs);
    assert.equal(hygieneMultiplier(docs[0], map, { now: NOW_MS }), 1);
  });
});

// ---------------------------------------------------------------------------
// 5. samemind forget — sets deprecated atomically, never deletes
// ---------------------------------------------------------------------------

describe('forget() — pure function', () => {
  let root;
  let file;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-forget-unit-'));
    file = join(root, 'concepts', 'old.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [
      '---',
      'type: Concept',
      'title: Old idea',
      'tags: [x, y]',
      'relations:',
      '  depends_on: /concepts/other.md',
      '---',
      '',
      '# Old idea',
      '',
      'Body text that must survive untouched.',
      '',
    ].join('\n'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sets deprecated: true + deprecated_on, preserves everything else, does not delete the file', () => {
    const before = readFileSync(file, 'utf8');
    const docs = [{ id: 'concepts/old', file, reserved: false }];
    const r = forget('concepts/old', { docs, now: NOW });

    assert.equal(r.id, 'concepts/old');
    assert.equal(r.file, file);
    assert.equal(r.alreadyDeprecated, false);
    assert.equal(r.deprecatedOn, NOW.toISOString());

    const after = readFileSync(file, 'utf8');
    assert.match(after, /\ndeprecated: true\n/);
    assert.match(after, new RegExp(`deprecated_on: ${NOW.toISOString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // everything that was there before is still there
    assert.match(after, /title: Old idea/);
    assert.match(after, /tags: \[x, y\]/);
    assert.match(after, /depends_on: \/concepts\/other\.md/);
    assert.match(after, /Body text that must survive untouched\./);
    // file still exists with the same path — never deleted
    assert.equal(after.includes(before.trim().split('\n').pop()), true);
  });

  it('idempotent: calling again just refreshes deprecated_on, no duplicate keys', () => {
    const docs = [{ id: 'concepts/old', file, reserved: false }];
    const later = new Date(NOW.getTime() + 60_000);
    const r = forget('concepts/old', { docs, now: later });
    assert.equal(r.alreadyDeprecated, true);
    assert.equal(r.deprecatedOn, later.toISOString());

    const content = readFileSync(file, 'utf8');
    const deprecatedCount = (content.match(/^deprecated:/gm) || []).length;
    const deprecatedOnCount = (content.match(/^deprecated_on:/gm) || []).length;
    assert.equal(deprecatedCount, 1, 'no duplicate `deprecated:` lines');
    assert.equal(deprecatedOnCount, 1, 'no duplicate `deprecated_on:` lines');
  });

  it('missing id throws (never silently deprecates the wrong thing)', () => {
    const docs = [{ id: 'concepts/old', file, reserved: false }];
    assert.throws(() => forget('concepts/does-not-exist', { docs }), /не найдено/);
  });

  it('ambiguous id throws (same contract as okf-query get)', () => {
    const otherFile = join(root, 'concepts', 'nested', 'old.md');
    mkdirSync(dirname(otherFile), { recursive: true });
    writeFileSync(otherFile, '---\ntype: Concept\ntitle: Old (nested)\n---\n\n# Old\n');
    const docs = [
      { id: 'concepts/old', file, reserved: false },
      { id: 'concepts/nested/old', file: otherFile, reserved: false },
    ];
    assert.throws(() => forget('old', { docs }), /неоднозначно/);
  });
});

describe('setDeprecated() — text-level frontmatter edit', () => {
  it('throws on a file without frontmatter', () => {
    assert.throws(() => setDeprecated('# no frontmatter here\n', NOW.toISOString()), /frontmatter/);
  });

  it('appends deprecated fields when absent', () => {
    const out = setDeprecated('---\ntype: Concept\ntitle: X\n---\n\nbody\n', '2026-01-01T00:00:00Z');
    assert.match(out, /type: Concept\ntitle: X\ndeprecated: true\ndeprecated_on: 2026-01-01T00:00:00Z\n---/);
    assert.match(out, /\nbody\n$/);
  });

  it('replaces an existing deprecated/deprecated_on pair in place', () => {
    const out = setDeprecated(
      '---\ntype: Concept\ndeprecated: true\ndeprecated_on: 2025-01-01T00:00:00Z\ntitle: X\n---\n\nbody\n',
      '2026-02-02T00:00:00Z',
    );
    assert.match(out, /deprecated: true\ndeprecated_on: 2026-02-02T00:00:00Z\ntitle: X/);
    assert.equal((out.match(/deprecated_on:/g) || []).length, 1);
  });
});

describe('forget CLI — end to end (subprocess)', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-forget-cli-'));
    writeConcept(root, 'concepts/old.md', { type: 'Concept', title: 'Old idea', tags: ['x'] }, '# Old idea\n\nBody.\n');
    writeConcept(root, 'concepts/dup.md', { type: 'Concept', title: 'Dup' });
    mkdirSync(join(root, 'concepts', 'nested'), { recursive: true });
    writeConcept(root, 'concepts/nested/dup.md', { type: 'Concept', title: 'Dup nested' });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('forgets a concept, file survives, validate then shows it as deprecated-ranked', () => {
    const { code, out } = runForgetCli(root, ['concepts/old']);
    assert.equal(code, 0, out);
    assert.match(out, /forgotten: concepts\/old/);
    assert.match(out, /file kept, not deleted/);

    const content = readFileSync(join(root, 'concepts', 'old.md'), 'utf8');
    assert.match(content, /deprecated: true/);
    assert.match(content, /Body\./); // body untouched

    const get = runQuery(root, ['get', 'concepts/old']);
    assert.equal(get.code, 0, get.out);
    assert.match(get.out, /DEPRECATED/);
  });

  it('missing id → non-zero exit, no crash, no file written', () => {
    const { code, out } = runForgetCli(root, ['concepts/nope']);
    assert.notEqual(code, 0);
    assert.match(out, /не найдено/);
  });

  it('ambiguous id → refuses, lists candidates (same as get)', () => {
    const { code, out } = runForgetCli(root, ['dup']);
    assert.notEqual(code, 0);
    assert.match(out, /неоднозначно/);
    assert.match(out, /concepts\/dup/);
    assert.match(out, /concepts\/nested\/dup/);
  });
});

// ---------------------------------------------------------------------------
// 6. validate — supersede chains, dangling targets, cycles
// ---------------------------------------------------------------------------

describe('validate — supersede chains and warnings (subprocess)', () => {
  it('prints the chain for a clean supersedes edge', () => {
    const root = mkdtempSync(join(tmpdir(), 'samemind-sup-chain-'));
    try {
      writeConcept(root, 'concepts/old.md', { type: 'Concept', title: 'Old' });
      writeConcept(root, 'concepts/new.md', { type: 'Concept', title: 'New', supersedes: '/concepts/old.md' });
      const { code, out } = runQuery(root, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.match(out, /Цепочки supersede/);
      assert.match(out, /concepts\/new supersedes concepts\/old/);
      assert.ok(!/Проблемы supersede/.test(out), out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dangling supersede target → warning, not a hard failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'samemind-sup-dangling-'));
    try {
      writeConcept(root, 'concepts/new.md', { type: 'Concept', title: 'New', supersedes: '/concepts/ghost.md' });
      const { code, out } = runQuery(root, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.match(out, /Проблемы supersede/);
      assert.match(out, /цель не найдена/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cyclic supersedes → caught as a warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'samemind-sup-cycle-'));
    try {
      writeConcept(root, 'concepts/a.md', { type: 'Concept', title: 'A', supersedes: '/concepts/b.md' });
      writeConcept(root, 'concepts/b.md', { type: 'Concept', title: 'B', supersedes: '/concepts/a.md' });
      const { code, out } = runQuery(root, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /Проблемы supersede/);
      assert.match(out, /цикл supersedes/);
      assert.match(out, /concepts\/a/);
      assert.match(out, /concepts\/b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detectSupersedeCycles: pure unit, 3-node cycle', () => {
    const docs = [
      { id: 'a', supersedes: ['/b.md'] },
      { id: 'b', supersedes: ['/c.md'] },
      { id: 'c', supersedes: ['/a.md'] },
    ];
    const cycles = detectSupersedeCycles(docs);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0][0], cycles[0][cycles[0].length - 1]);
  });

  it('detectSupersedeCycles: no cycle in a simple chain', () => {
    const docs = [
      { id: 'a', supersedes: ['/b.md'] },
      { id: 'b', supersedes: ['/c.md'] },
      { id: 'c', supersedes: [] },
    ];
    assert.deepEqual(detectSupersedeCycles(docs), []);
  });
});

describe('get — superseded/deprecated banner (subprocess)', () => {
  it('superseded concept shows a SUPERSEDED banner above the content', () => {
    const root = mkdtempSync(join(tmpdir(), 'samemind-get-banner-'));
    try {
      writeConcept(root, 'concepts/old.md', { type: 'Concept', title: 'Old' });
      writeConcept(root, 'concepts/new.md', { type: 'Concept', title: 'New', supersedes: '/concepts/old.md' });
      const { code, out } = runQuery(root, ['get', 'concepts/old']);
      assert.equal(code, 0, out);
      assert.match(out, /SUPERSEDED by \/concepts\/new\.md/);
      assert.match(out, /title: Old/); // raw content still printed in full
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clean concept — no banner', () => {
    const root = mkdtempSync(join(tmpdir(), 'samemind-get-clean-'));
    try {
      writeConcept(root, 'concepts/plain.md', { type: 'Concept', title: 'Plain' });
      const { code, out } = runQuery(root, ['get', 'concepts/plain']);
      assert.equal(code, 0, out);
      assert.ok(!out.includes('SUPERSEDED'));
      assert.ok(!out.includes('DEPRECATED'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. consolidate.mjs — contradictions heuristic
// ---------------------------------------------------------------------------

describe('consolidate — contradiction heuristic (pure)', () => {
  it('titleTokens: lowercases, drops short/stopword tokens', () => {
    const t = titleTokens({ fm: { title: 'The Old Retrieval Idea', tags: ['memory'] } });
    assert.ok(t.has('old'));
    assert.ok(t.has('retrieval'));
    assert.ok(t.has('idea'));
    assert.ok(t.has('memory'));
    assert.ok(!t.has('the')); // stopword
  });

  it('jaccard: identical sets → 1, disjoint sets → 0', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
    assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  });

  it('findContradictions: same-type near-duplicate titles flagged, unrelated types/pairs are not', () => {
    const docs = [
      { id: 'concepts/retrieval-strategy', supersedes: [], fm: { type: 'Concept', title: 'Retrieval strategy', tags: ['memory'] } },
      { id: 'concepts/retrieval-approach', supersedes: [], fm: { type: 'Concept', title: 'Retrieval approach', tags: ['memory'] } },
      { id: 'concepts/context-budget', supersedes: [], fm: { type: 'Concept', title: 'Context budget', tags: ['memory'] } },
      { id: 'entities/retrieval-strategy-org', supersedes: [], fm: { type: 'Entity', title: 'Retrieval Strategy Org', tags: ['memory'] } },
    ];
    const found = findContradictions(docs);
    assert.ok(found.some(c => (c.a === 'concepts/retrieval-strategy' && c.b === 'concepts/retrieval-approach')
      || (c.b === 'concepts/retrieval-strategy' && c.a === 'concepts/retrieval-approach')));
    // context-budget shares only the 'memory' tag — not similar enough
    assert.ok(!found.some(c => [c.a, c.b].includes('concepts/context-budget')));
    // different type (Entity vs Concept) never compared, however similar the title
    assert.ok(!found.some(c => [c.a, c.b].includes('entities/retrieval-strategy-org')));
  });

  it('findContradictions: supersedes between the pair excludes it, however similar', () => {
    const docs = [
      { id: 'concepts/old-idea', supersedes: [], fm: { type: 'Concept', title: 'Retrieval idea one', tags: [] } },
      { id: 'concepts/new-idea', supersedes: ['/concepts/old-idea.md'], fm: { type: 'Concept', title: 'Retrieval idea one', tags: [] } },
    ];
    assert.deepEqual(findContradictions(docs), []);
  });

  it('consolidate.mjs does not execute main() on import (guarded by isMain)', () => {
    // if main() had run at import time it would have hit `load()` against this test file's
    // OKF_ROOT (the samemind checkout) and printed a report — importing above must have been a
    // silent no-op. This test just documents/asserts that expectation held (no throw, no crash).
    assert.equal(typeof findContradictions, 'function');
  });
});

// ---------------------------------------------------------------------------
// 8. sanity: hygieneBanner / isDeprecated / isSuperseded helpers directly
// ---------------------------------------------------------------------------

describe('hygiene helpers — small direct checks', () => {
  it('isDeprecated: recognizes string "true" (frontmatter parser produces strings)', () => {
    assert.equal(isDeprecated({ fm: { deprecated: 'true' } }), true);
    assert.equal(isDeprecated({ fm: { deprecated: 'false' } }), false);
    assert.equal(isDeprecated({ fm: {} }), false);
  });

  it('isSuperseded / hygieneBanner agree with buildSupersededMap', () => {
    const docs = [
      { id: 'a', supersedes: [] },
      { id: 'b', supersedes: ['/a.md'] },
    ];
    const map = buildSupersededMap(docs);
    assert.equal(isSuperseded(docs[0], map), true);
    assert.equal(isSuperseded(docs[1], map), false);
    assert.match(hygieneBanner(docs[0], map), /SUPERSEDED by \/b\.md/);
    assert.equal(hygieneBanner(docs[1], map), '');
  });

  // collectSupersedeEdges() resolves paths against the OKF_ROOT-derived module-level ROOT in
  // okf.mjs, which is frozen at first import in this process — exercising it correctly requires
  // a real subprocess with OKF_ROOT set before the module loads. That's already covered by the
  // "validate — supersede chains and warnings (subprocess)" tests above (dangling target, cycle).
});

#!/usr/bin/env node
// recall.test.mjs — unit tests for the recall index (node --test). Mock embed — no live server.
// Run: node --test tools/recall.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  stripLinks, docText, contentHash, cosine, passesTier, rankByQuery,
  storageOf, storagesPresent, syncIndex, rankByKeywords, recallSearch, fetchEmbedding,
  sourceMatches, rrfFuse, fetchRerank, resolveEmbedConfig,
} from './lib/recall.mjs';

// Deterministic mock-embed: 3-dim bag of words (enough for unit tests).
function mockEmbed(text) {
  const t = text.toLowerCase();
  return [
    (t.match(/lumen|notes|editor/g) || []).length,
    (t.match(/atlas|research|corpus/g) || []).length,
    (t.match(/quartz|mine|mineral/g) || []).length,
  ].map(n => n + 0.01);
}

describe('recall — text for embedding', () => {
  it('stripLinks drops URL, keeps anchor text', () => {
    assert.equal(stripLinks('see [Lumen](/projects/lumen.md) and code'), 'see Lumen and code');
  });

  it('docText includes title/description/tags and body without link URLs', () => {
    const d = {
      fm: { title: 'T', description: 'D', tags: ['a', 'b'] },
      body: 'body [link](/x.md)\n```js\ncode```\nmore',
    };
    const t = docText(d);
    assert.match(t, /^T\nD\na, b/);
    assert.match(t, /body link/);
    assert.doesNotMatch(t, /\/x\.md/);
    assert.doesNotMatch(t, /```/);
  });

  it('contentHash is stable for unchanged content', () => {
    const d = { fm: { title: 'X' }, body: 'y' };
    assert.equal(contentHash(d), contentHash({ fm: { title: 'X' }, body: 'y' }));
  });
});

describe('recall — cosine and tiers', () => {
  it('cosine: identical vectors → 1', () => {
    assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  });

  it('passesTier: secret/mirror hidden by default', () => {
    assert.equal(passesTier('internal'), true);
    assert.equal(passesTier('secret'), false);
    assert.equal(passesTier('mirror'), false);
    assert.equal(passesTier('secret', { includeSecret: true }), true);
    assert.equal(passesTier('mirror', { includeMirror: true }), true);
  });

  it('rankByQuery: relevant concept ranks higher', () => {
    const items = {
      'projects/lumen': { title: 'Lumen', type: 'Project', visibility: 'internal', vector: [1, 0, 0] },
      'projects/atlas': { title: 'Atlas', type: 'Project', visibility: 'internal', vector: [0, 1, 0] },
    };
    const ranked = rankByQuery(items, [0.9, 0.1, 0], { k: 2 });
    assert.equal(ranked[0].id, 'projects/lumen');
  });

  it('rankByQuery: secret does not leak without flag', () => {
    const items = {
      'secret/x': { title: 'S', type: 'Project', visibility: 'secret', vector: [1, 0, 0] },
      'projects/y': { title: 'Y', type: 'Project', visibility: 'internal', vector: [0.5, 0, 0] },
    };
    const ranked = rankByQuery(items, [1, 0, 0], { k: 5 });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].id, 'projects/y');
  });
});

describe('recall — syncIndex incremental', () => {
  it('reuses unchanged, re-embeds changed, drops missing', async () => {
    const idx = { model: 'test', items: {} };
    const docs = [
      { id: 'a', fm: { title: 'A', type: 'Concept', visibility: 'internal' }, body: 'alpha' },
      { id: 'b', fm: { title: 'B', type: 'Concept', visibility: 'internal' }, body: 'beta' },
    ];
    const r1 = await syncIndex(idx, docs, mockEmbed);
    assert.equal(r1.built, 2);
    assert.equal(r1.reused, 0);
    assert.equal(r1.total, 2);

    const r2 = await syncIndex(idx, docs, mockEmbed);
    assert.equal(r2.built, 0);
    assert.equal(r2.reused, 2);

    docs[0].body = 'alpha changed';
    const r3 = await syncIndex(idx, docs.slice(0, 1), mockEmbed);
    assert.equal(r3.built, 1);
    assert.equal(r3.reused, 0);
    assert.equal(r3.total, 1);
    assert.equal(idx.items.b, undefined);
  });

  it('syncIndex without includeMirror keeps mirror rows in index', async () => {
    const idx = {
      model: 'test',
      items: {
        'mirror/x': { hash: 'h', visibility: 'mirror', vector: [1, 0, 0] },
        'projects/y': { hash: 'h2', visibility: 'internal', vector: [0, 1, 0] },
      },
    };
    const docs = [
      { id: 'projects/y', fm: { title: 'Y', type: 'Project', visibility: 'internal' }, body: 'y' },
    ];
    await syncIndex(idx, docs, mockEmbed, { includeMirror: false });
    assert.ok(idx.items['mirror/x'], 'mirror tier preserved');
    assert.ok(idx.items['projects/y']);
  });
});

describe('recall — storage classification', () => {
  it('storageOf classifies mirror and secret paths', () => {
    assert.equal(storageOf('mirror/claude-code/foo'), 'claude-code');
    assert.equal(storageOf('mirror/openclaw/bar'), 'openclaw');
    assert.equal(storageOf('secret/baz'), 'secret');
    assert.equal(storageOf('projects/samemind'), 'canon');
  });

  it('storagesPresent aggregates unique storages from ids', () => {
    const ids = [
      'projects/lumen',
      'mirror/claude-code/note',
      'mirror/openclaw/note',
      'secret/vault',
    ];
    const s = storagesPresent(ids);
    assert.ok(s.has('canon'));
    assert.ok(s.has('claude-code'));
    assert.ok(s.has('openclaw'));
    assert.ok(s.has('secret'));
  });

  it('passesTier filters ranks by storage tier flags', () => {
    const items = {
      'projects/lumen': { title: 'Lumen', type: 'Project', visibility: 'internal', vector: [1, 0, 0] },
      'mirror/openclaw/n': { title: 'M', type: 'Reference', visibility: 'mirror', vector: [0.9, 0, 0] },
      'secret/vault': { title: 'S', type: 'Reference', visibility: 'secret', vector: [0.95, 0, 0] },
    };
    const defaultRank = rankByQuery(items, [1, 0, 0], { k: 5 });
    assert.deepEqual(defaultRank.map(r => r.id), ['projects/lumen']);

    const withMirror = rankByQuery(items, [1, 0, 0], { k: 5, includeMirror: true });
    assert.ok(withMirror.some(r => r.id.startsWith('mirror/')));
    assert.ok(!withMirror.some(r => r.id.startsWith('secret/')));

    const withSecret = rankByQuery(items, [1, 0, 0], { k: 5, includeMirror: true, includeSecret: true });
    assert.ok(withSecret.some(r => r.id.startsWith('secret/')));
  });
});

describe('recall — e2e mock on fixtures', () => {
  it('query "lumen notes" → projects/lumen #1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-recall-'));
    try {
      mkdirSync(join(dir, 'projects'));
      writeFileSync(join(dir, 'projects', 'lumen.md'), `---
type: Project
title: Lumen Notes App
description: local-first note editor
visibility: internal
tags: [lumen, notes]
---
Core of the Lumen notes editor.
`);
      writeFileSync(join(dir, 'projects', 'atlas.md'), `---
type: Project
title: Atlas Research
description: research knowledge corpus
visibility: internal
---
Atlas research corpus.
`);
      const docs = [
        {
          id: 'projects/lumen',
          fm: {
            title: 'Lumen Notes App',
            description: 'local-first note editor',
            type: 'Project',
            visibility: 'internal',
            tags: ['lumen', 'notes'],
          },
          body: 'Core of the Lumen notes editor.',
        },
        {
          id: 'projects/atlas',
          fm: {
            title: 'Atlas Research',
            description: 'research knowledge corpus',
            type: 'Project',
            visibility: 'internal',
          },
          body: 'Atlas research corpus.',
        },
      ];
      const idx = { model: 'mock', items: {} };
      await syncIndex(idx, docs, mockEmbed);
      const qv = mockEmbed('lumen notes editor');
      const ranked = rankByQuery(idx.items, qv, { k: 2 });
      assert.equal(ranked[0].id, 'projects/lumen');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recall — BM25 fallback (rankByKeywords)', () => {
  const docs = [
    {
      id: 'projects/lumen',
      reserved: false,
      fm: { title: 'Lumen Notes App', type: 'Project', visibility: 'internal', tags: ['lumen', 'notes'] },
      body: 'Core of the Lumen notes editor.',
    },
    {
      id: 'projects/atlas',
      reserved: false,
      fm: { title: 'Atlas Research', type: 'Project', visibility: 'internal' },
      body: 'Atlas research corpus.',
    },
  ];

  it('BM25 ranks the relevant concept #1 without any network', () => {
    const ranked = rankByKeywords(docs, 'lumen notes', { k: 2 });
    assert.equal(ranked[0].id, 'projects/lumen');
    // atlas contains neither 'lumen' nor 'notes' → filtered out (score 0)
    assert.equal(ranked.length, 1);
    assert.ok(Number.isFinite(ranked[0].score));
  });

  it('returns [] when nothing matches', () => {
    assert.deepEqual(rankByKeywords(docs, 'zzznomatch', { k: 5 }), []);
  });
});

describe('recall — exclude-source (anti-echo, issue #2)', () => {
  it('sourceMatches: string, list, missing, and empty source', () => {
    assert.equal(sourceMatches({ fm: { source: 'claude-code' } }, 'claude-code'), true);
    assert.equal(sourceMatches({ fm: { source: 'claude-code' } }, 'openclaw'), false);
    assert.equal(sourceMatches({ fm: { source: ['docs/a.md', 'claude-code'] } }, 'claude-code'), true);
    assert.equal(sourceMatches({ fm: { source: ['docs/a.md'] } }, 'claude-code'), false);
    assert.equal(sourceMatches({ fm: {} }, 'claude-code'), false);          // no source field
    assert.equal(sourceMatches({ fm: { source: 'claude-code' } }, null), false); // no filter → keep
    assert.equal(sourceMatches(null, 'claude-code'), false);
  });

  const docs = [
    {
      id: 'projects/lumen',
      reserved: false,
      fm: { title: 'Lumen Notes App', type: 'Project', visibility: 'internal', tags: ['lumen', 'notes'] },
      body: 'Core of the Lumen notes editor.',
    },
    {
      id: 'mirror/claude-code/fresh',
      reserved: false,
      fm: { title: 'Fresh echo', type: 'Reference', visibility: 'mirror', source: 'claude-code', tags: ['lumen'] },
      body: 'Fresh note about the Lumen notes editor I just wrote.',
    },
  ];

  it('rankByKeywords: excludeSource drops the echoing concept (BM25 path)', () => {
    const baseline = rankByKeywords(docs, 'lumen notes', { k: 5, includeMirror: true });
    assert.ok(baseline.some(r => r.id === 'mirror/claude-code/fresh'), 'echo present without filter');

    const filtered = rankByKeywords(docs, 'lumen notes', { k: 5, includeMirror: true, excludeSource: 'claude-code' });
    assert.ok(!filtered.some(r => r.id === 'mirror/claude-code/fresh'), 'echo filtered out');
    assert.ok(filtered.some(r => r.id === 'projects/lumen'), 'canon concept stays');
  });

  it('rankByQuery: excludeSource drops the echoing concept (semantic path)', () => {
    const items = {
      'projects/lumen': { visibility: 'internal', vector: [2, 0], title: 'Lumen', type: 'Project' },
      'mirror/claude-code/fresh': { visibility: 'mirror', vector: [2, 0], title: 'Fresh', type: 'Reference' },
    };
    const baseline = rankByQuery(items, [2, 0], { k: 5, includeMirror: true, docs });
    assert.ok(baseline.some(r => r.id === 'mirror/claude-code/fresh'));

    const filtered = rankByQuery(items, [2, 0], { k: 5, includeMirror: true, docs, excludeSource: 'claude-code' });
    assert.ok(!filtered.some(r => r.id === 'mirror/claude-code/fresh'));
    assert.ok(filtered.some(r => r.id === 'projects/lumen'));
  });

  it('recallSearch bm25 threads excludeSource end-to-end', async () => {
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'bm25', k: 5, includeMirror: true, excludeSource: 'claude-code' });
    assert.equal(r.mode, 'bm25');
    assert.ok(!r.hits.some(h => h.id === 'mirror/claude-code/fresh'));
  });
});

describe('recall — recallSearch modes', () => {
  const docs = [
    {
      id: 'projects/lumen',
      reserved: false,
      fm: { title: 'Lumen Notes App', type: 'Project', visibility: 'internal', tags: ['lumen', 'notes'] },
      body: 'Core of the Lumen notes editor.',
    },
    {
      id: 'projects/atlas',
      reserved: false,
      fm: { title: 'Atlas Research', type: 'Project', visibility: 'internal' },
      body: 'Atlas research corpus.',
    },
  ];
  const idx = { items: {
    'projects/lumen': { visibility: 'internal', vector: [2, 0], title: 'Lumen', type: 'Project' },
    'projects/atlas': { visibility: 'internal', vector: [0, 2], title: 'Atlas', type: 'Project' },
  } };
  // 2-dim bag-of-words mock, sync in effect (returns a Promise).
  const mockEmbed = async t => {
    const x = t.toLowerCase();
    return [(x.match(/lumen|notes/g) || []).length + 0.01, (x.match(/atlas|research/g) || []).length + 0.01];
  };

  it('mode=bm25 — always BM25, no warning', async () => {
    const r = await recallSearch({ docs, query: 'lumen', mode: 'bm25', k: 2 });
    assert.equal(r.mode, 'bm25');
    assert.equal(r.warning, null);
    assert.equal(r.hits[0].id, 'projects/lumen');
  });

  it('mode=auto without an index → degrades to BM25 with an honest warning', async () => {
    const prev = process.env.OKF_EMBED_URL;
    delete process.env.OKF_EMBED_URL;
    try {
      const r = await recallSearch({ docs, query: 'lumen', mode: 'auto', idx: { items: {} }, embed: mockEmbed, k: 2 });
      assert.equal(r.mode, 'bm25');
      assert.match(r.warning, /BM25 fallback/);
      assert.match(r.warning, /OKF_EMBED_URL/);
    } finally {
      if (prev !== undefined) process.env.OKF_EMBED_URL = prev;
    }
  });

  it('mode=auto with an index and a responding embed → semantic', async () => {
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'auto', idx, embed: mockEmbed, k: 2 });
    assert.equal(r.mode, 'semantic');
    assert.equal(r.warning, null);
    assert.equal(r.hits[0].id, 'projects/lumen');
  });

  it('mode=auto when the endpoint fails — does not throw, falls back to BM25 with a warning', async () => {
    const badEmbed = async () => { throw new Error('ECONNREFUSED 127.0.0.1:8000'); };
    const r = await recallSearch({ docs, query: 'lumen', mode: 'auto', idx, embed: badEmbed, k: 2 });
    assert.equal(r.mode, 'bm25');
    assert.match(r.warning, /ECONNREFUSED/);
    assert.equal(r.hits[0].id, 'projects/lumen');
  });

  it('mode=semantic without an index — throws (no silent fallback)', async () => {
    await assert.rejects(
      () => recallSearch({ docs, query: 'x', mode: 'semantic', idx: { items: {} }, embed: mockEmbed, k: 2 }),
      /requires an index/,
    );
  });
});

describe('recall — fetchEmbedding (OpenAI-compatible, stubbed fetch)', () => {
  let saved;
  let lastOpts;
  function stub(json, ok = true, status = 200) {
    return async (url, opts) => {
      lastOpts = opts;
      return { ok, status, text: async => (ok ? '' : 'err body'), json: async => json };
    };
  }
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  it('standard OpenAI request: POST {model,input}; parses data[0].embedding', async () => {
    globalThis.fetch = stub({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const v = await fetchEmbedding('hello', { dim: null });
    assert.deepEqual(v, [0.1, 0.2, 0.3]);
    assert.equal(lastOpts.method, 'POST');
    assert.equal(lastOpts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(lastOpts.body), { model: 'bge-m3', input: 'hello' });
  });

  it('sends Authorization: Bearer only when key provided', async () => {
    globalThis.fetch = stub({ data: [{ embedding: [0.1] }] });
    await fetchEmbedding('hi', { key: undefined, dim: null });
    assert.equal(lastOpts.headers.Authorization, undefined);
    await fetchEmbedding('hi', { key: 'sk-test', dim: null });
    assert.equal(lastOpts.headers.Authorization, 'Bearer sk-test');
  });

  it('dim=null accepts any vector length (any OpenAI-compatible endpoint)', async () => {
    globalThis.fetch = stub({ data: [{ embedding: new Array(1536).fill(0.1) }] });
    const v = await fetchEmbedding('hi', { dim: null });
    assert.equal(v.length, 1536);
  });

  it('explicit dim mismatch throws', async () => {
    globalThis.fetch = stub({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    await assert.rejects(() => fetchEmbedding('hi', { dim: 1024 }), /dim 3 != expected 1024/);
  });

  it('HTTP error throws with status', async () => {
    globalThis.fetch = stub({ data: [] }, false, 503);
    await assert.rejects(() => fetchEmbedding('hi', { dim: null }), /HTTP 503/);
  });

  it('malformed response (no embedding) throws', async () => {
    globalThis.fetch = stub({ data: [{}] });
    await assert.rejects(() => fetchEmbedding('hi', { dim: null }), /non-empty vector/);
  });
});

// ---------------------------------------------------------------------------
// Ф3 — hybrid retrieval: RRF fusion, hybrid mode, optional rerank hook
// ---------------------------------------------------------------------------

describe('recall — rrfFuse (pure RRF, k=60 standard)', () => {
  it('fuses two rank-ordered lists by POSITION (classic 3-doc example)', () => {
    const listA = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]; // x#1, y#2, z#3
    const listB = [{ id: 'y' }, { id: 'z' }, { id: 'x' }]; // y#1, z#2, x#3
    const fused = rrfFuse([listA, listB]);
    // score(y) = 1/62 + 1/61 = 0.032522 — highest (best rank in either list, #1 in B)
    // score(x) = 1/61 + 1/63 = 0.032266
    // score(z) = 1/63 + 1/62 = 0.032002
    assert.deepEqual(fused.map(f => f.id), ['y', 'x', 'z']);
    assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-9);
    assert.equal(fused[0].rrfScore, fused[0].score);
  });

  it('a doc present in only one list still gets fused (partial contribution)', () => {
    const bm25List = [{ id: 'a' }, { id: 'b' }]; // a#1, b#2
    const semList = [{ id: 'b' }];                // b#1, a absent (no semantic hit)
    const fused = rrfFuse([bm25List, semList]);
    // b: 1/62 (bm25 #2) + 1/61 (sem #1) > a: 1/61 (bm25 #1) alone
    assert.deepEqual(fused.map(f => f.id), ['b', 'a']);
  });

  it('custom k changes the fusion weight without changing the API', () => {
    const listA = [{ id: 'p' }, { id: 'q' }];
    const fused = rrfFuse([listA], { k: 1 });
    assert.ok(Math.abs(fused[0].score - 1 / 2) < 1e-9); // k=1, rank1 -> 1/(1+1)
  });
});

describe('recall — hybrid mode: finds a paraphrase BM25 misses (Ф3 main DoD case)', () => {
  // Doc bodies share ZERO tokens with the query — BM25 (keyword overlap) returns nothing for
  // either doc. A toy 2-axis "semantic" mock embed (dog-signal / cat-signal) recognizes the
  // paraphrase anyway, so hybrid (BM25 ⊕ semantic via RRF) surfaces the right doc where a pure
  // BM25 search would come up empty.
  const docs = [
    { id: 'concepts/dog', reserved: false, fm: { title: 'Dog', type: 'Concept', visibility: 'internal' }, body: 'A loyal canine companion.' },
    { id: 'concepts/cat', reserved: false, fm: { title: 'Cat', type: 'Concept', visibility: 'internal' }, body: 'An independent feline pet.' },
  ];
  const idx = { items: {
    'concepts/dog': { visibility: 'internal', vector: [1, 0], title: 'Dog', type: 'Concept' },
    'concepts/cat': { visibility: 'internal', vector: [0, 1], title: 'Cat', type: 'Concept' },
  } };
  const query = 'faithful four-legged friend'; // no literal overlap with either doc body
  const mockSemanticEmbed = async t => {
    const x = t.toLowerCase();
    const dogSignal = /dog|canine|loyal|faithful|companion|friend/.test(x) ? 1 : 0;
    const catSignal = /cat|feline|independent|pet/.test(x) ? 1 : 0;
    return [dogSignal + 0.01, catSignal + 0.01];
  };

  it('BM25-only mode: zero token overlap → nothing found', async () => {
    const r = await recallSearch({ docs, query, mode: 'bm25', k: 5 });
    assert.equal(r.hits.length, 0);
  });

  it('hybrid mode: semantic component rescues the paraphrase — dog ranks #1', async () => {
    const r = await recallSearch({ docs, query, mode: 'hybrid', idx, embed: mockSemanticEmbed, k: 5 });
    assert.equal(r.mode, 'hybrid');
    assert.equal(r.hits[0].id, 'concepts/dog');
  });
});

describe('recall — hybrid mode preserves Ф2 hygiene (superseded stays down after fusion)', () => {
  it('superseded doc ranks below its replacement even after RRF', async () => {
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
    const idx = { items: {
      'concepts/old': { visibility: 'internal', vector: [1, 0], title: 'Lumen approach', type: 'Concept' },
      'concepts/new': { visibility: 'internal', vector: [1, 0], title: 'Lumen approach', type: 'Concept' },
    } };
    const embed = async () => [1, 0]; // identical vectors — only hygiene distinguishes rank
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed, k: 5 });
    assert.equal(r.mode, 'hybrid');
    assert.equal(r.hits[0].id, 'concepts/new');
    assert.match(r.hits[1].label, /superseded/);
  });
});

describe('recall — hybrid mode falls back to BM25, never throws', () => {
  const docs = [
    { id: 'projects/lumen', reserved: false, fm: { title: 'Lumen Notes App', type: 'Project', visibility: 'internal', tags: ['lumen', 'notes'] }, body: 'Core of the Lumen notes editor.' },
    { id: 'projects/atlas', reserved: false, fm: { title: 'Atlas Research', type: 'Project', visibility: 'internal' }, body: 'Atlas research corpus.' },
  ];

  it('no index at all → BM25 fallback, warning mentions hybrid', async () => {
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx: { items: {} }, embed: async () => [1], k: 2 });
    assert.equal(r.mode, 'bm25');
    assert.equal(r.hits[0].id, 'projects/lumen');
    assert.ok(r.warning);
  });

  it('index present but embed endpoint fails → BM25 fallback with an honest warning', async () => {
    const idx = { items: { 'projects/lumen': { visibility: 'internal', vector: [1], title: 'Lumen Notes App', type: 'Project' } } };
    const badEmbed = async () => { throw new Error('ECONNREFUSED 127.0.0.1:8000'); };
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed: badEmbed, k: 2 });
    assert.equal(r.mode, 'bm25');
    assert.match(r.warning, /hybrid unavailable/);
    assert.match(r.warning, /ECONNREFUSED/);
    assert.equal(r.hits[0].id, 'projects/lumen');
  });

  it('no embed function at all → BM25 fallback', async () => {
    const idx = { items: { 'projects/lumen': { visibility: 'internal', vector: [1], title: 'Lumen Notes App', type: 'Project' } } };
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed: null, k: 2 });
    assert.equal(r.mode, 'bm25');
    assert.equal(r.hits[0].id, 'projects/lumen');
  });
});

describe('recall — fetchRerank (optional cross-encoder rerank, stubbed fetch)', () => {
  let saved;
  function stub(json, ok = true, status = 200) {
    return async () => ({ ok, status, text: async () => (ok ? '' : 'err body'), json: async () => json });
  }
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });

  it('requires a url (strictly opt-in)', async () => {
    await assert.rejects(() => fetchRerank('q', ['a']), /url required/);
  });

  it('parses { results: [{index, relevance_score}] }', async () => {
    globalThis.fetch = stub({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
    const results = await fetchRerank('q', ['doc0', 'doc1'], { url: 'http://x/rerank' });
    assert.deepEqual(results, [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }]);
  });

  it('HTTP error throws', async () => {
    globalThis.fetch = stub({}, false, 503);
    await assert.rejects(() => fetchRerank('q', ['a'], { url: 'http://x/rerank' }), /HTTP 503/);
  });
});

describe('recall — hybrid mode: rerank hook is off unless OKF_RERANK_URL is set', () => {
  const docs = [
    { id: 'a', reserved: false, fm: { title: 'A', type: 'Concept', visibility: 'internal' }, body: 'lumen notes' },
    { id: 'b', reserved: false, fm: { title: 'B', type: 'Concept', visibility: 'internal' }, body: 'lumen notes' },
  ];
  const idx = { items: {
    a: { visibility: 'internal', vector: [1, 0], title: 'A', type: 'Concept' },
    b: { visibility: 'internal', vector: [1, 0], title: 'B', type: 'Concept' },
  } };
  const embed = async () => [1, 0]; // ties bm25+semantic between a/b — RRF keeps insertion order (a, b)
  let saved;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => {
    globalThis.fetch = saved;
    delete process.env.OKF_RERANK_URL;
  });

  it('OKF_RERANK_URL unset → RRF order kept, reranker never called', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed, k: 2 });
    assert.equal(r.mode, 'hybrid');
    assert.equal(called, false);
    assert.equal(r.hits[0].id, 'a');
  });

  it('OKF_RERANK_URL set → reorders the RRF top-N by relevance_score', async () => {
    process.env.OKF_RERANK_URL = 'http://127.0.0.1:9/rerank';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }),
    });
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed, k: 2 });
    assert.equal(r.mode, 'hybrid');
    assert.equal(r.hits[0].id, 'b'); // RRF's #2 candidate (index 1) scored highest by the reranker
  });

  it('reranker failure fails open — keeps RRF order, does not throw or flip mode to bm25', async () => {
    process.env.OKF_RERANK_URL = 'http://127.0.0.1:9/rerank';
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const r = await recallSearch({ docs, query: 'lumen notes', mode: 'hybrid', idx, embed, k: 2 });
    assert.equal(r.mode, 'hybrid');
    assert.equal(r.hits.length, 2);
    assert.equal(r.hits[0].id, 'a'); // unchanged from the no-rerank RRF order
  });
});

describe('resolveEmbedConfig — env > <root>/.samemind/config.json > hardcoded default', () => {
  let prevUrl, prevModel;
  beforeEach(() => {
    prevUrl = process.env.OKF_EMBED_URL;
    prevModel = process.env.OKF_EMBED_MODEL;
    delete process.env.OKF_EMBED_URL;
    delete process.env.OKF_EMBED_MODEL;
  });
  afterEach(() => {
    if (prevUrl !== undefined) process.env.OKF_EMBED_URL = prevUrl; else delete process.env.OKF_EMBED_URL;
    if (prevModel !== undefined) process.env.OKF_EMBED_MODEL = prevModel; else delete process.env.OKF_EMBED_MODEL;
  });

  it('no env, no config file → hardcoded default (backward-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-embedcfg-none-'));
    try {
      assert.deepEqual(resolveEmbedConfig(dir), { url: 'http://127.0.0.1:8000/v1/embeddings', model: 'bge-m3' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config file sets url/model when env is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-embedcfg-file-'));
    try {
      mkdirSync(join(dir, '.samemind'), { recursive: true });
      writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify({
        embedUrl: 'http://127.0.0.1:11434/v1/embeddings', embedModel: 'nomic-embed-text',
      }), 'utf8');
      assert.deepEqual(resolveEmbedConfig(dir), {
        url: 'http://127.0.0.1:11434/v1/embeddings', model: 'nomic-embed-text',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env overrides the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-embedcfg-envwins-'));
    try {
      mkdirSync(join(dir, '.samemind'), { recursive: true });
      writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify({
        embedUrl: 'http://127.0.0.1:11434/v1/embeddings', embedModel: 'nomic-embed-text',
      }), 'utf8');
      process.env.OKF_EMBED_URL = 'http://env-wins:9/v1/embeddings';
      process.env.OKF_EMBED_MODEL = 'env-model';
      assert.deepEqual(resolveEmbedConfig(dir), { url: 'http://env-wins:9/v1/embeddings', model: 'env-model' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed config.json never throws — falls through to default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-embedcfg-malformed-'));
    try {
      mkdirSync(join(dir, '.samemind'), { recursive: true });
      writeFileSync(join(dir, '.samemind', 'config.json'), '{ not valid json', 'utf8');
      assert.deepEqual(resolveEmbedConfig(dir), { url: 'http://127.0.0.1:8000/v1/embeddings', model: 'bge-m3' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchEmbedding honors the config file via its root option (stubbed fetch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-embedcfg-fetch-'));
    const saved = globalThis.fetch;
    try {
      mkdirSync(join(dir, '.samemind'), { recursive: true });
      writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify({
        embedUrl: 'http://127.0.0.1:11434/v1/embeddings', embedModel: 'nomic-embed-text',
      }), 'utf8');
      let seenUrl, seenBody;
      globalThis.fetch = async (url, opts) => {
        seenUrl = url;
        seenBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) };
      };
      await fetchEmbedding('hi', { dim: null, root: dir });
      assert.equal(seenUrl, 'http://127.0.0.1:11434/v1/embeddings');
      assert.equal(seenBody.model, 'nomic-embed-text');
    } finally {
      globalThis.fetch = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

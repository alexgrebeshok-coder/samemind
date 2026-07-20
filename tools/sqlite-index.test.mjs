#!/usr/bin/env node
// sqlite-index.test.mjs — Ф4: sqlite-vec-backed index (node --test). Mock embed — no live server.
// Run: node --test tools/sqlite-index.test.mjs
//
// The whole sqlite-vec suite self-skips (with an honest reason) if the native module or
// node:sqlite isn't usable in this environment — mirrors the production contract (openBackend()
// in okf-recall.mjs falls back to JSON the same way). The fallback-contract tests below don't
// need sqlite-vec to be present at all.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openVecStore, closeVecStore, syncVecStore, searchVecStore, vecStoreCount, migrateJsonIndex,
} from './lib/sqlite-index.mjs';
import { rankByQuery, recallSearch } from './lib/recall.mjs';

const dir = mkdtempSync(join(tmpdir(), 'samemind-sqlite-index-'));
after(() => { rmSync(dir, { recursive: true, force: true }); });

// describe()'s own `skip` option must be a plain value at REGISTRATION time (describe bodies run
// synchronously, before any `before()` hook does) — so the availability probe has to happen here,
// via top-level await, not inside a hook. Mirrors the production contract (openBackend() in
// okf-recall.mjs) without needing the native module to be present for the suite to load cleanly.
const probe = await openVecStore({ dbPath: join(dir, 'probe.db') });
const dbAvailable = probe.ok;
const skipReason = probe.ok ? false : probe.reason;
if (probe.ok) closeVecStore(probe);

function mockEmbed(text) {
  const t = text.toLowerCase();
  return [
    (t.match(/park|industrial/g) || []).length,
    (t.match(/quartz|mine|mineral/g) || []).length,
    (t.match(/secret/g) || []).length,
  ].map(n => n + 0.01);
}

function fixtureDocs() {
  return [
    {
      id: 'projects/industrial-park', reserved: false, supersedes: [],
      fm: { title: 'Industrial Park', type: 'Project', visibility: 'internal' },
      body: 'General context.\nPlanning an industrial park on 50 ha.\nInfrastructure and logistics.',
    },
    {
      id: 'projects/quartz-mine', reserved: false, supersedes: [],
      fm: { title: 'Quartz Mine', type: 'Project', visibility: 'internal' },
      body: 'Quartz mining project in the north.',
    },
    {
      id: 'mirror/openclaw/memory', reserved: false, supersedes: [],
      fm: { title: 'Mirror note', type: 'Reference', visibility: 'mirror' },
      body: 'Mirror note from openclaw about the park.',
    },
    {
      id: 'secret/vault', reserved: false, supersedes: [],
      fm: { title: 'Secret vault', type: 'Reference', visibility: 'secret' },
      body: 'Secret industrial park — confidential.',
    },
  ];
}

describe('sqlite-index — fallback contract (no sqlite-vec needed)', () => {
  it('openVecStore never throws on a bad path — returns { ok: false, reason }', async () => {
    // A path whose parent segment is a FILE (not a directory) can't be mkdir'd into — a real,
    // deterministic failure mode, no module-mocking required.
    const badParent = join(dir, 'not-a-directory');
    writeFileSync(badParent, 'i am a file, not a directory');
    const store = await openVecStore({ dbPath: join(badParent, 'index.db') });
    assert.equal(store.ok, false);
    assert.ok(store.reason && typeof store.reason === 'string');
  });

  it('openVecStore requires dbPath', async () => {
    const store = await openVecStore({});
    assert.equal(store.ok, false);
    assert.match(store.reason, /dbPath required/);
  });

  it('vecStoreCount(0) on a not-ok store — never throws', () => {
    assert.equal(vecStoreCount({ ok: false }), 0);
  });

  it('searchVecStore on a not-ok/empty store returns [] — never throws', () => {
    assert.deepEqual(searchVecStore({ ok: false }, [1, 0, 0], { k: 5 }), []);
  });
});

describe('sqlite-index — index, search, incremental sync, migration', { skip: skipReason }, () => {
  it('syncVecStore: builds new, reuses unchanged, drops removed (same contract as syncIndex)', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'sync.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = [
        { id: 'a', fm: { title: 'A', type: 'Concept', visibility: 'internal' }, body: 'alpha' },
        { id: 'b', fm: { title: 'B', type: 'Concept', visibility: 'internal' }, body: 'beta' },
      ];
      const r1 = await syncVecStore(store, docs, mockEmbed);
      assert.equal(r1.built, 2);
      assert.equal(r1.reused, 0);
      assert.equal(r1.total, 2);

      const r2 = await syncVecStore(store, docs, mockEmbed);
      assert.equal(r2.built, 0);
      assert.equal(r2.reused, 2);

      docs[0].body = 'alpha changed';
      const r3 = await syncVecStore(store, docs.slice(0, 1), mockEmbed);
      assert.equal(r3.built, 1);
      assert.equal(r3.reused, 0);
      assert.equal(r3.total, 1, 'doc b dropped — no longer in the walked set');
    } finally {
      closeVecStore(store);
    }
  });

  it('syncVecStore without includeMirror keeps mirror rows (tier-aware prune)', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'tier.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = fixtureDocs();
      await syncVecStore(store, docs, mockEmbed, { includeSecret: true, includeMirror: true });
      assert.equal(vecStoreCount(store), 4);
      // Now sync with only the two non-tiered docs walked — mirror/secret rows must survive.
      await syncVecStore(store, docs.filter(d => d.fm.visibility === 'internal'), mockEmbed, { includeMirror: false, includeSecret: false });
      assert.equal(vecStoreCount(store), 4, 'mirror + secret rows preserved without their include flag');
    } finally {
      closeVecStore(store);
    }
  });

  it('searchVecStore: relevant doc ranks first, matches rankByQuery on the same vectors', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'search.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = fixtureDocs();
      await syncVecStore(store, docs, mockEmbed, { includeSecret: true, includeMirror: true });
      const qv = mockEmbed('industrial park');
      const vecRanked = searchVecStore(store, qv, { k: 5, includeSecret: false, includeMirror: true, docs });

      // Same vectors, same query, through the JSON linear-cosine path — must agree on the winner.
      const items = Object.fromEntries(docs.map(d => [d.id, {
        title: d.fm.title, type: d.fm.type, visibility: d.fm.visibility, vector: mockEmbed(`${d.fm.title}\n${d.body}`),
      }]));
      const jsonRanked = rankByQuery(items, qv, { k: 5, includeSecret: false, includeMirror: true, docs });

      assert.equal(vecRanked[0].id, 'projects/industrial-park');
      assert.equal(vecRanked[0].id, jsonRanked[0].id);
    } finally {
      closeVecStore(store);
    }
  });

  it('searchVecStore: secret hidden by default, visible with includeSecret', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'tiers.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = fixtureDocs();
      await syncVecStore(store, docs, mockEmbed, { includeSecret: true, includeMirror: true });
      const qv = mockEmbed('secret industrial park');
      const hidden = searchVecStore(store, qv, { k: 10, includeSecret: false, includeMirror: true, docs });
      assert.ok(!hidden.some(r => r.id === 'secret/vault'));
      const shown = searchVecStore(store, qv, { k: 10, includeSecret: true, includeMirror: true, docs });
      assert.ok(shown.some(r => r.id === 'secret/vault'));
    } finally {
      closeVecStore(store);
    }
  });

  it('searchVecStore: excludeSource drops the echoing concept (anti-echo, same contract as rankByQuery)', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'echo.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = [
        { id: 'projects/lumen', reserved: false, fm: { title: 'Lumen', type: 'Project', visibility: 'internal' }, body: 'lumen notes' },
        { id: 'mirror/claude-code/fresh', reserved: false, fm: { title: 'Fresh', type: 'Reference', visibility: 'mirror', source: 'claude-code' }, body: 'lumen notes fresh' },
      ];
      const embed2 = () => [1, 0]; // identical vectors — only excludeSource distinguishes
      await syncVecStore(store, docs, embed2, { includeMirror: true });
      const baseline = searchVecStore(store, [1, 0], { k: 5, includeMirror: true, docs });
      assert.ok(baseline.some(r => r.id === 'mirror/claude-code/fresh'));
      const filtered = searchVecStore(store, [1, 0], { k: 5, includeMirror: true, docs, excludeSource: 'claude-code' });
      assert.ok(!filtered.some(r => r.id === 'mirror/claude-code/fresh'));
    } finally {
      closeVecStore(store);
    }
  });

  it('migrateJsonIndex: existing embeddings.json items land in the store with no re-embed, findable by search', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'migrate.db') });
    assert.ok(store.ok, store.reason);
    try {
      const jsonIdx = {
        model: 'mock',
        items: {
          'projects/industrial-park': { hash: 'h1', type: 'Project', title: 'Industrial Park', visibility: 'internal', vector: [2, 0, 0] },
          'projects/quartz-mine': { hash: 'h2', type: 'Project', title: 'Quartz Mine', visibility: 'internal', vector: [0, 2, 0] },
        },
      };
      const { migrated } = migrateJsonIndex(store, jsonIdx);
      assert.equal(migrated, 2);
      assert.equal(vecStoreCount(store), 2);
      const hits = searchVecStore(store, [1, 0, 0], { k: 2 });
      assert.equal(hits[0].id, 'projects/industrial-park');
      // No content-hash change afterwards → syncVecStore treats migrated rows as already current.
      const docs = [
        { id: 'projects/industrial-park', fm: { title: 'Industrial Park', type: 'Project', visibility: 'internal' }, body: 'x' },
      ];
      // contentHash of this doc won't match 'h1' (fabricated) — proves migration didn't invent a
      // false match; the migrated hash is whatever the JSON carried, not a proxy for "always reused".
      const r = await syncVecStore(store, docs, mockEmbed);
      assert.equal(r.built, 1, 'fabricated migrated hash does not spuriously match new content');
    } finally {
      closeVecStore(store);
    }
  });

  it('migrateJsonIndex: undefined type/title (older JSON index, pre-displayType/displayTitle) binds as NULL, not a crash', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'migrate-undefined.db') });
    assert.ok(store.ok, store.reason);
    try {
      const jsonIdx = {
        model: 'mock',
        items: {
          'memory/agent-permission-hygiene': { hash: 'h1', type: undefined, title: undefined, visibility: 'internal', vector: [1, 0, 0] },
        },
      };
      const { migrated } = migrateJsonIndex(store, jsonIdx);
      assert.equal(migrated, 1);
      const hits = searchVecStore(store, [1, 0, 0], { k: 1 });
      assert.equal(hits[0].id, 'memory/agent-permission-hygiene');
      assert.equal(hits[0].title, '');
      assert.equal(hits[0].type, '');
    } finally {
      closeVecStore(store);
    }
  });

  it('recallSearch: sqlite-vec backend (vecStore/vecSearch/vecCount) — semantic mode, same winner as JSON path', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'recallsearch.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = fixtureDocs().filter(d => d.fm.visibility === 'internal');
      await syncVecStore(store, docs, mockEmbed);
      const r = await recallSearch({
        docs, query: 'industrial park', mode: 'semantic', embed: async t => mockEmbed(t), k: 2,
        vecStore: store, vecSearch: searchVecStore, vecCount: vecStoreCount,
      });
      assert.equal(r.mode, 'semantic');
      assert.equal(r.hits[0].id, 'projects/industrial-park');
    } finally {
      closeVecStore(store);
    }
  });

  it('recallSearch: auto mode with an empty sqlite store degrades to BM25 (hasIndex via vecCount)', async () => {
    const store = await openVecStore({ dbPath: join(dir, 'empty.db') });
    assert.ok(store.ok, store.reason);
    try {
      const docs = fixtureDocs().filter(d => d.fm.visibility === 'internal');
      const r = await recallSearch({
        docs, query: 'industrial park', mode: 'auto', embed: async t => mockEmbed(t), k: 2,
        vecStore: store, vecSearch: searchVecStore, vecCount: vecStoreCount,
      });
      assert.equal(r.mode, 'bm25');
    } finally {
      closeVecStore(store);
    }
  });
});

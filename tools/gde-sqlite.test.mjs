#!/usr/bin/env node
// gde-sqlite.test.mjs — gde.mjs now shares the sqlite-vec/flat-JSON backend-selection DI-pattern
// with okf-recall.mjs (tail 3, memory-tails-0720): buildIndex()/search() try sqlite-vec
// (tools/.index/index.db) first, falling back to embeddings.json when unavailable.
//
// This lives in its OWN file (not gde.test.mjs) because it needs an isolated OKF_ROOT set BEFORE
// gde.mjs's first import: gde.mjs's internal `import { ROOT } from './lib/okf.mjs'` binds ROOT at
// first module evaluation, and gde.test.mjs already statically imports gde.mjs/okf.mjs at the top
// under the package's own ROOT — too late to redirect. `node --test` isolates each matched file in
// its own process (verified empirically), so this file gets a clean module graph to work with.
// Run: node --test tools/gde-sqlite.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  return full;
}

function stubEmbedFetch(embedding) {
  return async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ embedding }] }) });
}

describe('gde.mjs — sqlite-vec backend with JSON fallback (tail 3)', () => {
  let root, gde, si, savedFetch, savedRoot, skipReason;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'samemind-gde-sqlite-'));
    writeConcept(root, 'projects/industrial-park.md', { type: 'Project', title: 'Industrial Park', visibility: 'internal' },
      'Planning an industrial park on 50 ha.\nInfrastructure and logistics.\n');
    writeConcept(root, 'projects/quartz-mine.md', { type: 'Project', title: 'Quartz Mine', visibility: 'internal' },
      'Quartz mining project in the north.\n');
    savedRoot = process.env.OKF_ROOT;
    process.env.OKF_ROOT = root;
    // Fresh module graph bound to the temp ROOT — every module gde.mjs pulls in via its own
    // (unparameterized) import specifiers gets evaluated for the first time right here.
    const tag = Date.now();
    gde = await import(`./gde.mjs?t=${tag}`);
    si = await import(`./lib/sqlite-index.mjs?t=${tag}-si`);
    const probe = await si.openVecStore({ dbPath: join(root, 'probe.db') });
    skipReason = probe.ok ? false : probe.reason;
    if (probe.ok) si.closeVecStore(probe);
    savedFetch = globalThis.fetch;
    globalThis.fetch = stubEmbedFetch([1, 0, 0]);
  });

  after(() => {
    globalThis.fetch = savedFetch;
    if (savedRoot === undefined) delete process.env.OKF_ROOT; else process.env.OKF_ROOT = savedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('buildIndex() writes to sqlite-vec (index.db), not embeddings.json', { skip: skipReason }, async () => {
    const stats = await gde.buildIndex({ includeSecret: false, includeMirror: true });
    assert.equal(stats.total, 2);
    assert.ok(!existsSync(join(root, 'tools', '.index', 'embeddings.json')), 'sqlite path must not also write JSON');
    const store = await si.openVecStore({ dbPath: join(root, 'tools', '.index', 'index.db') });
    assert.ok(store.ok, store.reason);
    assert.equal(si.vecStoreCount(store), 2);
    si.closeVecStore(store);
  });

  it('search() returns semantic hits via the sqlite-vec path, title/type intact', { skip: skipReason }, async () => {
    const { results, mode, staleWarning } = await gde.search('industrial park', {
      k: 3, includeSecret: false, includeMirror: true, reindex: false,
    });
    assert.equal(mode, 'semantic');
    assert.equal(staleWarning, null, 'checkIndexStale (JSON-only check) must not fire once sqlite-vec is the active backend');
    const hit = results.find(r => r.id === 'projects/industrial-park');
    assert.ok(hit, 'expected the industrial-park doc among the hits');
    assert.equal(hit.title, 'Industrial Park');
    assert.equal(hit.type, 'Project');
  });

  it('OKF_INDEX_BACKEND=json forces the flat-JSON fallback path (embeddings.json, not index.db)', async () => {
    const savedBackend = process.env.OKF_INDEX_BACKEND;
    process.env.OKF_INDEX_BACKEND = 'json';
    try {
      const gdeJson = await import(`./gde.mjs?t=${Date.now()}-json`);
      const stats = await gdeJson.buildIndex({ includeSecret: false, includeMirror: true });
      assert.equal(stats.total, 2);
      assert.ok(existsSync(join(root, 'tools', '.index', 'embeddings.json')));
    } finally {
      if (savedBackend === undefined) delete process.env.OKF_INDEX_BACKEND; else process.env.OKF_INDEX_BACKEND = savedBackend;
    }
  });
});

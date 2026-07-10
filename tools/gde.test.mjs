#!/usr/bin/env node
// gde.test.mjs — unit tests for personal search gde (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  queryTerms, extractSnippet, keywordScore, rankByKeywords,
  checkIndexStale, contentHash, passesTier, rankByQuery, syncIndex,
} from './lib/recall.mjs';
import {
  enrichResults, formatResults, parseArgs, search, saveIdx, IDX, IDX_DIR,
} from './gde.mjs';
import { ROOT } from './lib/okf.mjs';

function mockEmbed(text) {
  const t = text.toLowerCase();
  return [
    (t.match(/park|industrial|индустриальн/g) || []).length,
    (t.match(/quartz|mine|mineral/g) || []).length,
    (t.match(/secret|секрет/g) || []).length,
  ].map(n => n + 0.01);
}

function fixtureDocs() {
  return [
    {
      id: 'projects/industrial-park',
      file: '/tmp/fix/projects/industrial-park.md',
      reserved: false,
      fm: { title: 'Industrial Park', type: 'Project', visibility: 'internal' },
      body: 'General context.\nPlanning an industrial park on 50 ha.\nInfrastructure and logistics.',
    },
    {
      id: 'projects/quartz-mine',
      file: '/tmp/fix/projects/quartz-mine.md',
      reserved: false,
      fm: { title: 'Quartz Mine', type: 'Project', visibility: 'internal' },
      body: 'Quartz mining project in the north.',
    },
    {
      id: 'mirror/openclaw/memory',
      file: '/tmp/fix/mirror/openclaw/memory.md',
      reserved: false,
      fm: { title: 'Mirror note', type: 'Reference', visibility: 'mirror' },
      body: 'Mirror note from openclaw about the park.',
    },
    {
      id: 'secret/vault',
      file: '/tmp/fix/secret/vault.md',
      reserved: false,
      fm: { title: 'Secret vault', type: 'Reference', visibility: 'secret' },
      body: 'Secret industrial park — confidential.',
    },
  ];
}

describe('gde — queryTerms and snippet', () => {
  it('queryTerms filters short tokens', () => {
    assert.deepEqual(queryTerms('where did I write about park'), ['where', 'did', 'write', 'about', 'park']);
  });

  it('extractSnippet — 2–3 lines around best match', () => {
    const body = 'Intro.\nPlanning an industrial park on 50 ha.\nInfrastructure.\nOutro.';
    const snip = extractSnippet(body, 'industrial park', { contextLines: 1 });
    assert.match(snip, /industrial park/);
    assert.match(snip, /Infrastructure/);
    assert.equal(snip.split('\n').length, 3);
  });
});

describe('gde — keyword fallback', () => {
  it('rankByKeywords: relevant doc ranks higher', () => {
    const docs = fixtureDocs();
    const ranked = rankByKeywords(docs, 'industrial park', { k: 3, includeMirror: true });
    assert.equal(ranked[0].id, 'projects/industrial-park');
    assert.ok(ranked[0].score > ranked[1]?.score);
  });

  it('keywordScore = 0 with no matches', () => {
    assert.equal(keywordScore('hello world', 'quartz'), 0);
  });
});

describe('gde — tier filters', () => {
  it('mirror visible by default in rankByKeywords', () => {
    const docs = fixtureDocs();
    const ranked = rankByKeywords(docs, 'park', { k: 10, includeMirror: true });
    assert.ok(ranked.some(r => r.id === 'mirror/openclaw/memory'));
  });

  it('secret hidden without --secret', () => {
    const docs = fixtureDocs();
    const ranked = rankByKeywords(docs, 'industrial park', { k: 10, includeSecret: false });
    assert.ok(!ranked.some(r => r.id === 'secret/vault'));
  });

  it('secret visible with includeSecret', () => {
    const docs = fixtureDocs();
    const ranked = rankByKeywords(docs, 'industrial park', { k: 10, includeSecret: true, includeMirror: true });
    assert.ok(ranked.some(r => r.id === 'secret/vault'));
  });

  it('rankByQuery: secret does not leak into semantic', () => {
    const items = {
      'secret/vault': { title: 'S', type: 'Ref', visibility: 'secret', vector: [0, 0, 1] },
      'projects/x': { title: 'X', type: 'Project', visibility: 'internal', vector: [0.1, 0, 0] },
    };
    const ranked = rankByQuery(items, [0, 0, 1], { k: 5, includeSecret: false, includeMirror: true });
    assert.ok(!ranked.some(r => r.id === 'secret/vault'));
  });
});

describe('gde — stale index', () => {
  it('checkIndexStale: missing index', () => {
    const docs = fixtureDocs();
    const r = checkIndexStale({ items: {} }, docs, { idxPath: '/nonexistent/embeddings.json' });
    assert.equal(r.stale, true);
    assert.match(r.reasons[0], /отсутствует/);
  });

  it('checkIndexStale: hash mismatch in sample', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-gde-stale-'));
    try {
      const idxPath = join(dir, 'embeddings.json');
      writeFileSync(idxPath, '{}');
      const now = Date.now() / 1000;
      utimesSync(idxPath, now, now);
      const docs = fixtureDocs();
      const idx = { items: { 'projects/industrial-park': { hash: 'deadbeef00000000' } } };
      const r = checkIndexStale(idx, docs, { idxPath, maxAgeMs: 999_999_999, sampleSize: 1 });
      assert.equal(r.stale, true);
      assert.ok(r.reasons.some(x => x.includes('изменились')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gde — enrichResults and format', () => {
  it('enrichResults adds snippet and absolute file', () => {
    const docs = fixtureDocs();
    const docById = new Map(docs.map(d => [d.id, d]));
    const hits = [{ id: 'projects/industrial-park', title: 'IP', type: 'Project', score: 0.9 }];
    const enriched = enrichResults(hits, docById, 'industrial park');
    assert.match(enriched[0].snippet, /industrial park/);
    assert.ok(enriched[0].file.endsWith('industrial-park.md'));
  });

  it('formatResults marks keyword mode', () => {
    const out = formatResults('park', [{ id: 'x', title: 'T', type: 'P', score: 0.5, file: '/a/b.md', snippet: 'line' }], {
      k: 1, mode: 'keyword', staleWarning: 'index stale, add --reindex',
    });
    assert.match(out, /\[keyword\]/);
    assert.match(out, /index stale/);
    assert.match(out, /\/a\/b\.md/);
  });
});

describe('gde — parseArgs', () => {
  it('defaults: k=7, mirror implicit, secret off', () => {
    const a = parseArgs(['where', 'park']);
    assert.equal(a.k, 7);
    assert.equal(a.includeMirror, true);
    assert.equal(a.includeSecret, false);
    assert.equal(a.query, 'where park');
  });

  it('--secret and -k', () => {
    const a = parseArgs(['-k', '3', '--secret', 'query']);
    assert.equal(a.k, 3);
    assert.equal(a.includeSecret, true);
  });
});

describe('gde — e2e mock on fixtures', () => {
  it('semantic rank + snippet without secret in output', async () => {
    const docs = fixtureDocs();
    const idx = { model: 'mock', items: {} };
    await syncIndex(idx, docs, mockEmbed, { includeSecret: true, includeMirror: true });
    const qv = mockEmbed('industrial park');
    const ranked = rankByQuery(idx.items, qv, { k: 5, includeSecret: false, includeMirror: true });
    const docById = new Map(docs.map(d => [d.id, d]));
    const enriched = enrichResults(ranked, docById, 'industrial park');
    assert.ok(!enriched.some(r => r.id === 'secret/vault'));
    assert.equal(enriched[0].id, 'projects/industrial-park');
    const out = formatResults('industrial park', enriched, { k: 5, mode: 'semantic' });
    assert.doesNotMatch(out, /confidential/);
  });

  it('fallback keyword on fixtures', () => {
    const ranked = rankByKeywords(fixtureDocs(), 'quartz', { k: 2, includeMirror: true });
    assert.equal(ranked[0].id, 'projects/quartz-mine');
  });
});

describe('gde — IDX isolated under worktree ROOT', () => {
  it('IDX lives under <ROOT>/tools/.index of this checkout', () => {
    const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    assert.equal(resolve(ROOT), checkoutRoot, 'ROOT must match this checkout directory');
    assert.equal(IDX_DIR, join(ROOT, 'tools', '.index'));
    assert.equal(IDX, join(IDX_DIR, 'embeddings.json'));
    const rel = relative(ROOT, IDX);
    assert.match(rel, /^tools[/\\]\.index[/\\]embeddings\.json$/);
    assert.ok(!rel.startsWith('..'), 'index must not escape ROOT');
  });
});

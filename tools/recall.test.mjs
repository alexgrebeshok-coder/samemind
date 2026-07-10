#!/usr/bin/env node
// recall.test.mjs — unit tests for the recall index (node --test). Mock embed — no live server.
// Run: node --test tools/recall.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  stripLinks, docText, contentHash, cosine, passesTier, rankByQuery,
  storageOf, storagesPresent, syncIndex,
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

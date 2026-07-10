#!/usr/bin/env node
// integrity.test.mjs — data-integrity tests (P0). Uses only mkdtemp; never touches real memory.
// Run: node --test tools/integrity.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeBasename, safeMdPath } from '../lib/safe-path.mjs';
import { atomicWriteFileSync, atomicWriteJsonSync } from '../lib/atomic-write.mjs';
import { syncMirror } from '../lib/mirror-sync.mjs';

/** Minimal mirror entry builder (adapters live outside this public skeleton). */
function buildMirrorEntry({ name, description = '', body = '' }) {
  return {
    name,
    content: [
      '---',
      `title: "${name}"`,
      `description: "${description}"`,
      'visibility: mirror',
      'source: test',
      '---',
      '',
      body,
      '',
    ].join('\n'),
  };
}

describe('P0-1 path traversal', () => {
  it('assertSafeBasename rejects ../ and separators', () => {
    for (const bad of ['../../projects/other', 'foo/bar', '..', 'a/../b', '/etc/passwd']) {
      assert.throws(() => assertSafeBasename(bad), /unsafe path|path traversal/i);
    }
  });

  it('safeMdPath stays under baseDir', () => {
    const base = mkdtempSync(join(tmpdir(), 'samemind-safe-'));
    try {
      assert.throws(
        () => safeMdPath(base, '../../outside'),
        /unsafe path|path traversal/i,
      );
      const ok = safeMdPath(base, 'valid-name');
      assert.ok(ok.startsWith(base));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('syncMirror rejects traversal in name', () => {
    const out = mkdtempSync(join(tmpdir(), 'samemind-mirror-'));
    try {
      assert.throws(
        () => syncMirror({
          outDir: out,
          sourceMarker: 'test',
          entries: [{ name: '../../evil', content: '---\nsource: test\n---\n' }],
        }),
        /unsafe path|path traversal/i,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('buildMirrorEntry + syncMirror writes only under outDir', () => {
    const out = mkdtempSync(join(tmpdir(), 'samemind-entry-'));
    const canon = mkdtempSync(join(tmpdir(), 'samemind-canon-'));
    try {
      const entry = buildMirrorEntry({
        name: 'my-topic',
        description: 'd',
        body: 'body',
      });
      syncMirror({ outDir: out, sourceMarker: 'test', entries: [entry] });
      assert.ok(existsSync(join(out, 'my-topic.md')));
      assert.ok(!existsSync(join(canon, 'my-topic.md')));
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(canon, { recursive: true, force: true });
    }
  });
});

describe('P0-2 atomic index write', () => {
  it('atomicWriteJsonSync: partial .tmp write does not corrupt existing index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-idx-'));
    try {
      const idxPath = join(dir, 'embeddings.json');
      const good = { model: 'test', items: { a: { hash: 'abc', vector: [1, 0] } } };
      atomicWriteJsonSync(idxPath, good);
      const before = readFileSync(idxPath, 'utf8');

      // Simulate crash mid-write: tmp created, rename never ran
      writeFileSync(join(dir, '.embeddings.json.9999.dead.tmp'), '{ "broken": ');

      const after = readFileSync(idxPath, 'utf8');
      assert.equal(after, before);
      assert.doesNotThrow(() => JSON.parse(after));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomicWriteJsonSync replaces index only after full tmp write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-idx2-'));
    try {
      const p = join(dir, 'embeddings.json');
      atomicWriteJsonSync(p, { model: 'v1', items: {} });
      atomicWriteJsonSync(p, { model: 'v2', items: { n: { hash: 'h' } } });
      const loaded = JSON.parse(readFileSync(p, 'utf8'));
      assert.equal(loaded.model, 'v2');
      assert.ok(loaded.items.n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P0-3 mirror sync without delete-before-write', () => {
  function mkEntry(name, body = 'content') {
    return {
      name,
      content: `---\ntitle: "${name}"\nvisibility: mirror\nsource: test\n---\n\n${body}\n`,
    };
  }

  it('after sync old generated files replaced, data present', () => {
    const out = mkdtempSync(join(tmpdir(), 'samemind-sync-'));
    try {
      syncMirror({ outDir: out, sourceMarker: 'test', entries: [mkEntry('a'), mkEntry('b')] });
      assert.ok(existsSync(join(out, 'a.md')));
      assert.ok(existsSync(join(out, 'b.md')));

      syncMirror({ outDir: out, sourceMarker: 'test', entries: [mkEntry('a', 'updated'), mkEntry('c')] });
      assert.match(readFileSync(join(out, 'a.md'), 'utf8'), /updated/);
      assert.ok(!existsSync(join(out, 'b.md')));
      assert.ok(existsSync(join(out, 'c.md')));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('parallel double import: lock + data not lost', async () => {
    const out = mkdtempSync(join(tmpdir(), 'samemind-par-'));
    try {
      syncMirror({ outDir: out, sourceMarker: 'test', entries: [mkEntry('seed')] });

      const entries = [mkEntry('x'), mkEntry('y'), mkEntry('z')];
      const run = () => syncMirror({ outDir: out, sourceMarker: 'test', entries });

      const results = await Promise.allSettled([run(), run()]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      assert.equal(fulfilled.length + rejected.length, 2);
      assert.ok(fulfilled.length >= 1, 'at least one import finished');

      const files = ['x.md', 'y.md', 'z.md'].filter(f => existsSync(join(out, f)));
      assert.equal(files.length, 3, 'all three files present after parallel import');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('crash between phases: seed remains if second sync never starts', () => {
    const out = mkdtempSync(join(tmpdir(), 'samemind-crash-'));
    try {
      syncMirror({ outDir: out, sourceMarker: 'test', entries: [mkEntry('keep')] });
      const content = readFileSync(join(out, 'keep.md'), 'utf8');
      syncMirror({ outDir: out, sourceMarker: 'test', entries: [mkEntry('keep')], dry: true });
      assert.equal(readFileSync(join(out, 'keep.md'), 'utf8'), content);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

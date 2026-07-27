#!/usr/bin/env node
// digest-file.test.mjs — cold-start digest (tools/lib/digest-file.mjs). Covers:
//   - writes <root>/.samemind/digest.md and it contains the readable facts
//   - a secret-visibility concept is excluded
//   - freshest-first ordering (a ledger-touched concept precedes an untouched one)
//   - idempotent: two writes over an unchanged bundle produce byte-identical content
//   - atomic: no stray temp file left behind in .samemind/ after the write
//   - empty bundle → still writes a valid digest (no throw)
// node --test tools/digest-file.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeDigestFile, DIGEST_REL_PATH } from './lib/digest-file.mjs';

function mkBundle() {
  return mkdtempSync(join(tmpdir(), 'samemind-digest-'));
}
function concept(root, relPath, fm, body) {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(full, `---\n${front}\n---\n${body}\n`);
}

describe('digest-file: cold-start memory digest', () => {
  it('writes .samemind/digest.md containing readable facts, excluding secret', () => {
    const root = mkBundle();
    try {
      concept(root, 'concepts/atlas.md', { title: 'Atlas', type: 'Project' }, 'ATLAS_BODY_MARKER facts about atlas.');
      concept(root, 'concepts/lumen.md', { title: 'Lumen', type: 'Project' }, 'LUMEN_BODY_MARKER facts about lumen.');
      concept(root, 'secret/leak.md', { title: 'Leak', type: 'Concept', visibility: 'secret' }, 'SECRET_MARKER_HUSH.');

      const out = writeDigestFile(root);
      assert.equal(out.path, join(root, DIGEST_REL_PATH));
      assert.equal(out.concepts, 2, `expected 2 readable concepts, got ${out.concepts}`);

      const md = readFileSync(out.path, 'utf8');
      assert.ok(md.includes('ATLAS_BODY_MARKER'), 'atlas body missing');
      assert.ok(md.includes('LUMEN_BODY_MARKER'), 'lumen body missing');
      assert.ok(md.includes('concepts/atlas'), 'atlas id heading missing');
      assert.ok(!md.includes('SECRET_MARKER_HUSH'), 'secret concept leaked into digest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('orders freshest (ledger heat) first', () => {
    const root = mkBundle();
    try {
      concept(root, 'concepts/cold.md', { title: 'Cold', type: 'Project' }, 'cold body.');
      concept(root, 'concepts/hot.md', { title: 'Hot', type: 'Project' }, 'hot body.');
      // one recent ledger event touching concepts/hot → it should sort ahead of the untouched one
      mkdirSync(join(root, 'ledger'), { recursive: true });
      const ev = { actor: 'test', topic: 'concepts/hot', phase: 'step', status: 'ok', action: 'touch', ts: new Date().toISOString() };
      writeFileSync(join(root, 'ledger', 'events.jsonl'), `${JSON.stringify(ev)}\n`);

      const out = writeDigestFile(root);
      const md = readFileSync(out.path, 'utf8');
      assert.ok(md.indexOf('concepts/hot') < md.indexOf('concepts/cold'), 'hot concept should precede cold');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — two writes produce byte-identical content, no stray temp files', () => {
    const root = mkBundle();
    try {
      concept(root, 'concepts/a.md', { title: 'A', type: 'Note' }, 'body a.');
      concept(root, 'concepts/b.md', { title: 'B', type: 'Note' }, 'body b.');

      writeDigestFile(root);
      const first = readFileSync(join(root, DIGEST_REL_PATH), 'utf8');
      writeDigestFile(root);
      const second = readFileSync(join(root, DIGEST_REL_PATH), 'utf8');
      assert.equal(second, first, 'digest is not idempotent');

      // atomic write leaves no leftover temp file in .samemind/
      const entries = readdirSync(join(root, '.samemind'));
      assert.deepEqual(entries, ['digest.md'], `unexpected files in .samemind/: ${entries.join(',')}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('empty bundle still writes a valid digest', () => {
    const root = mkBundle();
    try {
      const out = writeDigestFile(root);
      assert.equal(out.concepts, 0);
      assert.ok(existsSync(out.path));
      assert.ok(readFileSync(out.path, 'utf8').includes('memory digest'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

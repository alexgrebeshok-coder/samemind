#!/usr/bin/env node
// okf-cache.test.mjs — per-file parse cache in lib/okf.mjs `load()` (Ф1 roadmap item).
// Run: node --test tools/okf-cache.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  return full;
}

describe('okf.mjs load() per-file parse cache', () => {
  let okf;
  let root;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'samemind-okf-cache-'));
    writeConcept(root, 'concepts/a.md', { type: 'Concept', title: 'A' });
    writeConcept(root, 'concepts/b.md', { type: 'Concept', title: 'B' });
    process.env.OKF_ROOT = root;
    // bust module cache: fresh instance per test file, same trick as relations.test.mjs
    okf = await import(`./lib/okf.mjs?t=${Date.now()}`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('first load() parses every file once', () => {
    okf._debugResetParseCache();
    const docs = okf.load();
    assert.equal(docs.length, 2);
    assert.equal(okf._debugParseCount(), 2);
  });

  it('repeated load() with nothing changed does not reparse', () => {
    okf._debugResetParseCache();
    okf.load();
    assert.equal(okf._debugParseCount(), 2);
    const docs2 = okf.load();
    assert.equal(docs2.length, 2);
    assert.equal(okf._debugParseCount(), 2, 'no new parses on unchanged reload');
  });

  it('touching a file forces a reparse of just that file', () => {
    okf._debugResetParseCache();
    okf.load();
    assert.equal(okf._debugParseCount(), 2);

    const target = join(root, 'concepts/a.md');
    const st = statSync(target);
    // bump mtime into the future — some filesystems have 1s mtime resolution, a same-second
    // touch could otherwise look unchanged to the mtimeMs+size fingerprint.
    const future = new Date(st.mtimeMs + 5000);
    utimesSync(target, future, future);

    const docs = okf.load();
    assert.equal(docs.length, 2);
    assert.equal(okf._debugParseCount(), 3, 'touched file reparsed, untouched file stayed cached');
  });

  it('editing content (mtime + size change) reparses and reflects new content', () => {
    okf._debugResetParseCache();
    okf.load();
    writeConcept(root, 'concepts/a.md', { type: 'Concept', title: 'A-renamed-longer-title' });

    const docs = okf.load();
    const a = docs.find(d => d.id === 'concepts/a');
    assert.equal(a.fm.title, 'A-renamed-longer-title');
    assert.equal(okf._debugParseCount(), 3);
  });

  it('a new file is picked up and parsed', () => {
    okf._debugResetParseCache();
    okf.load();
    assert.equal(okf._debugParseCount(), 2);
    writeConcept(root, 'concepts/c.md', { type: 'Concept', title: 'C' });

    const docs = okf.load();
    assert.equal(docs.length, 3);
    assert.ok(docs.some(d => d.id === 'concepts/c'));
    assert.equal(okf._debugParseCount(), 3, 'only the new file triggers a real parse');
  });

  it('a deleted file drops out of load() results (no stale cache leak into output)', () => {
    okf._debugResetParseCache();
    writeConcept(root, 'concepts/d.md', { type: 'Concept', title: 'D' });
    const first = okf.load();
    assert.ok(first.some(d => d.id === 'concepts/d'));

    rmSync(join(root, 'concepts/d.md'));
    const second = okf.load();
    assert.ok(!second.some(d => d.id === 'concepts/d'));
  });
});

#!/usr/bin/env node
// recall-expand.test.mjs — G2: 1-hop graph expand (tools/lib/recall.mjs expandHits) + the
// `samemind recall --expand` CLI wiring (tools/okf-recall.mjs).
// Run: node --test tools/recall-expand.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expandHits, DEFAULT_EXPAND_BUDGET } from './lib/recall.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OKF_RECALL = join(HERE, 'okf-recall.mjs');

/** Minimal in-memory doc shape matching okf.mjs `parse()`'s output — no real files needed for
 *  the pure-function tests. `file` follows the same `<root>/<id>.md` convention `parse()`
 *  guarantees (id = relative(root, file) sans `.md`), which is what `expandHits`'s root-inference
 *  (inferRootDir) relies on to resolve bundle-absolute links without a real filesystem. */
function mkDoc(id, { relations = {}, links = [], deprecated = false, title = null } = {}) {
  return {
    id,
    file: `/bundle/${id}.md`,
    fm: { title: title || id, type: 'Concept', ...(deprecated ? { deprecated: 'true' } : {}) },
    relations,
    links,
    supersedes: [],
    supersededBy: [],
  };
}

describe('expandHits — pure graph walk', () => {
  it('outbound relations edge pulls in the target', () => {
    const hub = mkDoc('entities/hub', { relations: { works_at: ['/entities/acme.md'] } });
    const acme = mkDoc('entities/acme');
    const docs = [hub, acme];
    const hits = [{ id: hub.id, title: hub.fm.title, type: 'Concept', score: 1 }];
    const extra = expandHits(hits, docs);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].id, 'entities/acme');
    assert.match(extra[0].label, /\(\+1 hop from entities\/hub\)/);
  });

  it('inbound relations edge (someone else relations-points at the hit) is pulled too', () => {
    const hub = mkDoc('entities/hub');
    const iris = mkDoc('entities/iris', { relations: { works_at: ['/entities/hub.md'] } });
    const docs = [hub, iris];
    const hits = [{ id: hub.id, score: 1 }];
    const extra = expandHits(hits, docs);
    assert.deepEqual(extra.map(e => e.id), ['entities/iris']);
  });

  it('reverse wikilink (markdown [text](path.md) pointing AT the hit) is pulled', () => {
    const hub = mkDoc('entities/hub');
    const citer = mkDoc('entities/citer', { links: ['/entities/hub.md'] });
    const docs = [hub, citer];
    const hits = [{ id: hub.id, score: 1 }];
    const extra = expandHits(hits, docs);
    assert.deepEqual(extra.map(e => e.id), ['entities/citer']);
  });

  it('the hit\'s own OUTBOUND wikilink (not reverse) is NOT pulled — only inbound counts', () => {
    const hub = mkDoc('entities/hub', { links: ['/entities/cited.md'] });
    const cited = mkDoc('entities/cited');
    const docs = [hub, cited];
    const hits = [{ id: hub.id, score: 1 }];
    const extra = expandHits(hits, docs);
    assert.deepEqual(extra, []);
  });

  it('budget caps total expanded docs across all seed hits', () => {
    const hub = mkDoc('entities/hub', {
      relations: { uses: ['/p1.md', '/p2.md', '/p3.md', '/p4.md', '/p5.md', '/p6.md', '/p7.md'] },
    });
    const neighbors = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map(id => mkDoc(id));
    const docs = [hub, ...neighbors];
    const hits = [{ id: hub.id, score: 1 }];
    const extra = expandHits(hits, docs, { budget: 3 });
    assert.equal(extra.length, 3);
    assert.equal(DEFAULT_EXPAND_BUDGET, 5); // documented default stays 5 unless overridden
  });

  it('a deprecated neighbor is never pulled in (same hygiene gate as live recall)', () => {
    const hub = mkDoc('entities/hub', { relations: { uses: ['/entities/old.md', '/entities/fresh.md'] } });
    const old = mkDoc('entities/old', { deprecated: true });
    const fresh = mkDoc('entities/fresh');
    const docs = [hub, old, fresh];
    const hits = [{ id: hub.id, score: 1 }];
    const extra = expandHits(hits, docs);
    assert.deepEqual(extra.map(e => e.id), ['entities/fresh']);
  });

  it('a doc already in the seed hits is never re-added as "+1 hop"', () => {
    const hub = mkDoc('entities/hub', { relations: { uses: ['/entities/also-hit.md'] } });
    const alsoHit = mkDoc('entities/also-hit');
    const docs = [hub, alsoHit];
    const hits = [{ id: hub.id, score: 1 }, { id: alsoHit.id, score: 0.5 }];
    const extra = expandHits(hits, docs);
    assert.deepEqual(extra, []);
  });

  it('no hits or no docs → [] (never throws)', () => {
    assert.deepEqual(expandHits([], [mkDoc('a')]), []);
    assert.deepEqual(expandHits([{ id: 'a', score: 1 }], []), []);
  });
});

// --- CLI wiring: samemind recall --expand -------------------------------------------------

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).flatMap(([k, v]) => {
    if (k === 'relations' && v && typeof v === 'object') {
      const lines = ['relations:'];
      for (const [rk, rv] of Object.entries(v)) lines.push(`  ${rk}: [${rv.join(', ')}]`);
      return lines;
    }
    return [`${k}: ${v}`];
  });
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
}

// Node's SQLite experimental-warning line embeds the child's PID (`node:12345)`), so two separate
// spawns of an otherwise-identical command never come out byte-identical — strip it before
// asserting equality between runs.
const stripNoise = s => s.replace(/^\(node:\d+\).*\n?/gm, '').replace(/^\(Use `node --trace-warnings.*\n?/gm, '');

function runRecall(root, args) {
  const r = spawnSync(process.execPath, [OKF_RECALL, ...args], {
    env: { ...process.env, OKF_ROOT: root, OKF_GLOBAL_ROOT: '', OKF_EMBED_URL: '' },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: stripNoise((r.stdout || '') + (r.stderr || '')) };
}

describe('okf-recall.mjs CLI — --expand', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-expand-cli-'));
    writeConcept(root, 'projects/lumen.md', {
      type: 'Project', title: 'Lumen',
      relations: { depends_on: ['/concepts/retrieval.md'] },
    }, 'Lumen notes app, backlink graph.\n');
    writeConcept(root, 'concepts/retrieval.md', { type: 'Concept', title: 'Retrieval strategy' },
      'How retrieval works for Lumen.\n');
    writeConcept(root, 'entities/iris.md', { type: 'Entity', title: 'Iris' },
      'Iris cites [Lumen](/projects/lumen.md) in her notes.\n');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('without --expand: output unchanged (no +hop rows, no expand-related warnings)', () => {
    const { code, out } = runRecall(root, ['Lumen', '-k', '5', '--mode', 'bm25']);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /\+hop/);
    assert.doesNotMatch(out, /1 hop from/);
  });

  it('--expand pulls in the relation target AND the reverse-wikilink citer, labeled', () => {
    const { code, out } = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand']);
    assert.equal(code, 0, out);
    assert.match(out, /\+hop.*concepts\/retrieval.*\(\+1 hop from projects\/lumen\)/);
    assert.match(out, /\+hop.*entities\/iris.*\(\+1 hop from projects\/lumen\)/);
  });

  it('--expand-hops 1 is equivalent to --expand', () => {
    const a = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand']);
    const b = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand-hops', '1']);
    assert.equal(a.out, b.out);
  });

  it('--expand-budget caps the +hop rows', () => {
    const { code, out } = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand', '--expand-budget', '1']);
    assert.equal(code, 0, out);
    const hopLines = out.split('\n').filter(l => l.includes('+hop'));
    assert.equal(hopLines.length, 1);
  });
});

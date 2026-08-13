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
import { relationKindTraversal } from './lib/relation-kinds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OKF_RECALL = join(HERE, 'okf-recall.mjs');

/** Minimal in-memory doc shape matching okf.mjs `parse()`'s output — no real files needed for
 *  the pure-function tests. `file` follows the same `<root>/<id>.md` convention `parse()`
 *  guarantees (id = relative(root, file) sans `.md`), which is what `expandHits`'s root-inference
 *  (inferRootDir) relies on to resolve bundle-absolute links without a real filesystem. */
function mkDoc(id, {
  relations = {}, links = [], deprecated = false, title = null, type = 'Concept',
  tags = [], supersedes = [], supersededBy = [], invalid_at = null,
} = {}) {
  return {
    id,
    file: `/bundle/${id}.md`,
    fm: {
      title: title || id,
      type,
      ...(tags.length ? { tags } : {}),
      ...(deprecated ? { deprecated: 'true' } : {}),
      ...(invalid_at ? { invalid_at } : {}),
    },
    relations,
    links,
    supersedes,
    supersededBy,
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

// --- 1.1: kind queue, aliases, forbidden edges, includeSuperseded, conflict ---------------
// Expected values are spec literals from graph-design-note.md §4.3 / §4.4, not recomputed
// from expandHits — dropping priority / alias / filter / kind / plumbing / ⚔ goes red.

describe('expandHits — 1.1 kind queue (mutation probes)', () => {
  it('alias equivalence: works_at ≡ member_of, spawned_by orients to informs inbound', () => {
    const hub = mkDoc('entities/hub', { relations: { works_at: ['/entities/acme.md'] } });
    const acme = mkDoc('entities/acme');
    const child = mkDoc('concepts/child', { relations: { spawned_by: ['/concepts/parent.md'] } });
    const parent = mkDoc('concepts/parent');
    const viaAlias = expandHits([{ id: hub.id, score: 1 }], [hub, acme]);
    assert.equal(viaAlias.length, 1);
    assert.equal(viaAlias[0].id, 'entities/acme');
    assert.equal(viaAlias[0].kind, 'member_of');
    assert.notEqual(viaAlias[0].kind, 'works_at');

    const viaReverse = expandHits([{ id: child.id, score: 1 }], [child, parent]);
    assert.equal(viaReverse.length, 1);
    assert.equal(viaReverse[0].id, 'concepts/parent');
    assert.equal(viaReverse[0].kind, 'informs');
    assert.notEqual(viaReverse[0].kind, 'spawned_by');
  });

  it('priority beats YAML insertion order: about before related under budget 1', () => {
    // related is listed first in the object; FIFO-YAML would pull weak. §4.3 says about first.
    const hub = mkDoc('entities/hub', {
      relations: {
        related: ['/entities/weak.md'],
        about: ['/entities/topic.md'],
      },
    });
    const weak = mkDoc('entities/weak');
    const topic = mkDoc('entities/topic');
    const extra = expandHits([{ id: hub.id, score: 1 }], [hub, weak, topic], { budget: 1 });
    assert.equal(extra.length, 1);
    assert.equal(extra[0].id, 'entities/topic');
    assert.equal(extra[0].kind, 'about');
  });

  it('kind queue across seeds: later seed about beats earlier seed related', () => {
    const a = mkDoc('entities/a', { relations: { related: ['/entities/weak.md'] } });
    const b = mkDoc('entities/b', { relations: { about: ['/entities/topic.md'] } });
    const weak = mkDoc('entities/weak');
    const topic = mkDoc('entities/topic');
    const extra = expandHits(
      [{ id: a.id, score: 1 }, { id: b.id, score: 0.9 }],
      [a, b, weak, topic],
      { budget: 1 },
    );
    assert.equal(extra.length, 1);
    assert.equal(extra[0].id, 'entities/topic');
    assert.equal(extra[0].kind, 'about');
    assert.equal(extra[0].expandedFrom, 'entities/b');
  });

  it('next / unknown / relations.supersedes are not expanded', () => {
    const hub = mkDoc('entities/hub', {
      relations: {
        next: ['/entities/board-next.md'],
        frobnicates: ['/entities/unknown.md'],
        'relations.supersedes': ['/entities/hygiene.md'],
        supersedes: ['/entities/hygiene2.md'],
        superseded_by: ['/entities/hygiene3.md'],
        about: ['/entities/topic.md'],
      },
    });
    const boardNext = mkDoc('entities/board-next');
    const unknown = mkDoc('entities/unknown');
    const hygiene = mkDoc('entities/hygiene');
    const hygiene2 = mkDoc('entities/hygiene2');
    const hygiene3 = mkDoc('entities/hygiene3');
    const topic = mkDoc('entities/topic');
    const extra = expandHits(
      [{ id: hub.id, score: 1 }],
      [hub, boardNext, unknown, hygiene, hygiene2, hygiene3, topic],
    );
    assert.deepEqual(extra.map(e => e.id), ['entities/topic']);
    assert.equal(extra[0].kind, 'about');
  });

  it('kind projection: every expanded row carries canonical kind + hop 1', () => {
    const hub = mkDoc('entities/hub', {
      relations: { covers: ['/entities/topic.md'], uses: ['/tools/hammer.md'] },
    });
    const topic = mkDoc('entities/topic');
    const hammer = mkDoc('tools/hammer');
    const citer = mkDoc('entities/citer', { links: ['/entities/hub.md'] });
    const extra = expandHits(
      [{ id: hub.id, score: 1 }],
      [hub, topic, hammer, citer],
    );
    assert.ok(extra.length >= 3, JSON.stringify(extra));
    for (const row of extra) {
      assert.equal(typeof row.kind, 'string');
      assert.ok(['about', 'uses', 'cites'].includes(row.kind), row.kind);
      assert.equal(row.hop, 1);
      assert.equal(row.expandedFrom, 'entities/hub');
      assert.equal(typeof row.id, 'string');
      assert.equal(typeof row.type, 'string');
      assert.match(row.label, /\(\+1 hop from entities\/hub\)/);
    }
    assert.equal(extra.find(e => e.id === 'entities/topic').kind, 'about');
    assert.equal(extra.find(e => e.id === 'tools/hammer').kind, 'uses');
    assert.equal(extra.find(e => e.id === 'entities/citer').kind, 'cites');
  });

  it('includeSuperseded parity: stale excluded by default, pulled with hygiene label when set', () => {
    const hub = mkDoc('entities/hub', {
      relations: { uses: ['/entities/old.md', '/entities/fresh.md'] },
    });
    const old = mkDoc('entities/old');
    const fresh = mkDoc('entities/fresh', { supersedes: ['/entities/old.md'] });
    const docs = [hub, old, fresh];
    const hits = [{ id: hub.id, score: 1 }];

    const liveOnly = expandHits(hits, docs);
    assert.deepEqual(liveOnly.map(e => e.id), ['entities/fresh']);

    const audit = expandHits(hits, docs, { includeSuperseded: true });
    assert.deepEqual(audit.map(e => e.id).sort(), ['entities/fresh', 'entities/old']);
    const stale = audit.find(e => e.id === 'entities/old');
    assert.match(stale.label, /superseded by/);
    assert.equal(stale.kind, 'uses');
  });

  it('deprecated neighbor stays out even with includeSuperseded', () => {
    const hub = mkDoc('entities/hub', { relations: { uses: ['/entities/gone.md'] } });
    const gone = mkDoc('entities/gone', { deprecated: true });
    const extra = expandHits([{ id: hub.id, score: 1 }], [hub, gone], { includeSuperseded: true });
    assert.deepEqual(extra, []);
  });

  it('conflict with seed appends existing ⚔ label, not a conflicts_with kind', () => {
    const seed = mkDoc('concepts/retrieval-strategy', {
      title: 'Retrieval strategy',
      tags: ['memory'],
      relations: { uses: ['/concepts/retrieval-approach.md'] },
    });
    const peer = mkDoc('concepts/retrieval-approach', {
      title: 'Retrieval approach',
      tags: ['memory'],
    });
    const extra = expandHits([{ id: seed.id, score: 1 }], [seed, peer]);
    assert.equal(extra.length, 1);
    assert.equal(extra[0].id, 'concepts/retrieval-approach');
    assert.equal(extra[0].kind, 'uses');
    assert.match(extra[0].label, /⚔ conflicts with concepts\/retrieval-strategy/);
    assert.notEqual(extra[0].kind, 'conflicts_with');
  });

  it('conflict with any top-k seed keeps ⚔ even when another seed pulled the neighbor', () => {
    const seed = mkDoc('concepts/retrieval-strategy', {
      title: 'Retrieval strategy',
      tags: ['memory'],
    });
    const peer = mkDoc('concepts/retrieval-approach', {
      title: 'Retrieval approach',
      tags: ['memory'],
    });
    const hub = mkDoc('entities/unrelated-hub', {
      type: 'Entity',
      title: 'Unrelated hub',
      relations: { uses: ['/concepts/retrieval-approach.md'] },
    });
    const extra = expandHits(
      [{ id: seed.id, score: 1 }, { id: hub.id, score: 0.9 }],
      [seed, peer, hub],
    );
    const row = extra.find(e => e.id === 'concepts/retrieval-approach');
    assert.ok(row, JSON.stringify(extra));
    assert.equal(row.expandedFrom, 'entities/unrelated-hub');
    assert.equal(row.kind, 'uses');
    assert.match(row.label, /⚔ conflicts with concepts\/retrieval-strategy/);
    assert.notEqual(row.kind, 'conflicts_with');
  });

  it('cites follows spec.directions — outbound in traversal would pull the hit own links', () => {
    const hub = mkDoc('entities/hub', { links: ['/entities/cited.md'] });
    const cited = mkDoc('entities/cited');
    const hits = [{ id: hub.id, score: 1 }];
    assert.deepEqual(expandHits(hits, [hub, cited]), []);
    assert.ok(!relationKindTraversal('cites').directions.includes('outbound'));

    const extra = expandHits(hits, [hub, cited], {
      kindTraversal: kind => {
        const spec = relationKindTraversal(kind);
        if (kind !== 'cites' || !spec) return spec;
        return { ...spec, directions: ['outbound'] };
      },
    });
    assert.equal(extra.length, 1);
    assert.equal(extra[0].id, 'entities/cited');
    assert.equal(extra[0].kind, 'cites');
  });
});

describe('okf-recall.mjs CLI — 1.1 kind + include-superseded', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-expand-11-cli-'));
    writeConcept(root, 'projects/lumen.md', {
      type: 'Project', title: 'Lumen',
      relations: {
        related: ['/concepts/nearby.md'],
        covers: ['/concepts/retrieval.md'],
      },
    }, 'Lumen notes app, backlink graph.\n');
    writeConcept(root, 'concepts/retrieval.md', { type: 'Concept', title: 'Retrieval strategy' },
      'How retrieval works for Lumen.\n');
    writeConcept(root, 'concepts/nearby.md', { type: 'Concept', title: 'Nearby note' },
      'Weak neighbor listed first in YAML.\n');
    writeConcept(root, 'entities/iris.md', { type: 'Entity', title: 'Iris' },
      'Iris cites [Lumen](/projects/lumen.md) in her notes.\n');
    writeConcept(root, 'concepts/old-fact.md', { type: 'Concept', title: 'Old expand fact' },
      'Superseded neighbor for include-superseded parity.\n');
    writeConcept(root, 'concepts/new-fact.md', {
      type: 'Concept', title: 'New expand fact',
      supersedes: '/concepts/old-fact.md',
    }, 'Replacement of the old expand fact.\n');
    writeConcept(root, 'projects/audit-hub.md', {
      type: 'Project', title: 'unique-audit-expand-hub',
      relations: { uses: ['/concepts/old-fact.md', '/concepts/new-fact.md'] },
    }, 'unique-audit-expand-hub marker for include-superseded CLI.\n');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('--expand prints canonical kind, not the raw covers alias', () => {
    const { code, out } = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand']);
    assert.equal(code, 0, out);
    assert.match(out, /\+hop\s+\S+\s+about\s+concepts\/retrieval/);
    assert.doesNotMatch(out, /\+hop\s+\S+\s+covers\s+/);
    assert.match(out, /\+hop\s+\S+\s+cites\s+entities\/iris/);
    assert.match(out, /\(\+1 hop from projects\/lumen\)/);
  });

  it('--expand-budget 1 prefers about over YAML-first related', () => {
    const { code, out } = runRecall(root, ['Lumen', '-k', '1', '--mode', 'bm25', '--expand', '--expand-budget', '1']);
    assert.equal(code, 0, out);
    const hopLines = out.split('\n').filter(l => l.includes('+hop'));
    assert.equal(hopLines.length, 1);
    assert.match(hopLines[0], /concepts\/retrieval/);
    assert.match(hopLines[0], /\babout\b/);
    assert.doesNotMatch(hopLines[0], /concepts\/nearby/);
  });

  it('without --include-superseded stale neighbor is not pulled', () => {
    const { code, out } = runRecall(root, ['unique-audit-expand-hub', '-k', '1', '--mode', 'bm25', '--expand']);
    assert.equal(code, 0, out);
    assert.match(out, /\+hop.*concepts\/new-fact/);
    assert.doesNotMatch(out, /concepts\/old-fact/);
  });

  it('--include-superseded pulls stale neighbor with the same hygiene mark', () => {
    const { code, out } = runRecall(root, [
      'unique-audit-expand-hub', '-k', '1', '--mode', 'bm25', '--expand', '--include-superseded',
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /\+hop.*concepts\/old-fact/);
    assert.match(out, /superseded by/);
  });
});

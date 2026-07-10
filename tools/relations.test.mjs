#!/usr/bin/env node
// relations.test.mjs — SameMind typed relations (frontmatter + rel queries + validate).
// Run: node --test tools/relations.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = join(HERE, 'okf-query.mjs');

function runQuery(root, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).flatMap(([k, v]) => {
    if (k === 'relations' && v && typeof v === 'object' && !Array.isArray(v)) {
      const lines = ['relations:'];
      for (const [rk, rv] of Object.entries(v)) {
        if (Array.isArray(rv)) lines.push(`  ${rk}: [${rv.join(', ')}]`);
        else lines.push(`  ${rk}: ${rv}`);
      }
      return lines;
    }
    if (Array.isArray(v)) return [`${k}: [${v.join(', ')}]`];
    return [`${k}: ${v}`];
  });
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
}

// --- unit: normalize / parse (import with OKF_ROOT set before import is hard;
// so we re-import via dynamic import after setting env, or test via subprocess +
// pure functions with a fixed ROOT).
// Pure functions: set OKF_ROOT then dynamic import.

describe('normalizeRelations + parse frontmatter', () => {
  let okf;
  let root;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'samemind-rel-unit-'));
    writeConcept(root, 'entities/a.md', {
      type: 'Entity',
      title: 'A',
      relations: {
        works_at: '/entities/b.md',
        depends_on: ['/projects/p.md', '/concepts/c.md'],
      },
    });
    writeConcept(root, 'entities/b.md', { type: 'Entity', title: 'B' });
    writeConcept(root, 'projects/p.md', { type: 'Project', title: 'P' });
    writeConcept(root, 'concepts/c.md', { type: 'Concept', title: 'C' });
    process.env.OKF_ROOT = root;
    // bust module cache: import with query string
    okf = await import(`./lib/okf.mjs?t=${Date.now()}`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('normalizeRelations: scalar → array, list stays list', () => {
    const n = okf.normalizeRelations({
      works_at: '/entities/b.md',
      depends_on: ['/projects/p.md', '/concepts/c.md'],
      empty: '',
    });
    assert.deepEqual(n.works_at, ['/entities/b.md']);
    assert.deepEqual(n.depends_on, ['/projects/p.md', '/concepts/c.md']);
    assert.deepEqual(n.empty, []);
  });

  it('normalizeRelations: null/array root → {}', () => {
    assert.deepEqual(okf.normalizeRelations(null), {});
    assert.deepEqual(okf.normalizeRelations([]), {});
  });

  it('parse: relations always arrays on document', () => {
    const docs = okf.load();
    const a = docs.find(d => d.id === 'entities/a');
    assert.ok(a, 'entities/a loaded');
    assert.deepEqual(a.relations.works_at, ['/entities/b.md']);
    assert.deepEqual(a.relations.depends_on, ['/projects/p.md', '/concepts/c.md']);
  });

  it('pathToId strips slash and .md', () => {
    assert.equal(okf.pathToId('/entities/acme-labs.md'), 'entities/acme-labs');
    assert.equal(okf.pathToId('projects/atlas.md'), 'projects/atlas');
  });
});

describe('rel query — outbound and inbound', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-rel-q-'));
    writeConcept(root, 'entities/alex.md', {
      type: 'User',
      title: 'Alex',
      relations: { works_at: '/entities/acme.md' },
    });
    writeConcept(root, 'entities/iris.md', {
      type: 'Entity',
      title: 'Iris',
      relations: { works_at: '/entities/acme.md' },
    });
    writeConcept(root, 'entities/acme.md', {
      type: 'Entity',
      title: 'Acme',
      relations: { uses: ['/projects/lumen.md'] },
    });
    writeConcept(root, 'projects/lumen.md', {
      type: 'Project',
      title: 'Lumen',
      relations: {
        depends_on: ['/concepts/retrieval.md', '/concepts/budget.md'],
      },
    });
    writeConcept(root, 'concepts/retrieval.md', { type: 'Concept', title: 'Retrieval' });
    writeConcept(root, 'concepts/budget.md', { type: 'Concept', title: 'Budget' });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('outbound: works_at from alex → acme', () => {
    const { code, out } = runQuery(root, ['rel', 'works_at', 'entities/alex']);
    assert.equal(code, 0, out);
    assert.match(out, /works_at from entities\/alex/);
    assert.match(out, /entities\/acme/);
    assert.match(out, /Acme/);
  });

  it('inbound: who works_at acme → alex + iris', () => {
    const { code, out } = runQuery(root, ['rel', 'works_at', 'entities/acme', '--inbound']);
    assert.equal(code, 0, out);
    assert.match(out, /Входящие works_at → entities\/acme/);
    assert.match(out, /entities\/alex/);
    assert.match(out, /entities\/iris/);
  });

  it('list-value depends_on: two targets', () => {
    const { code, out } = runQuery(root, ['rel', 'depends_on', 'projects/lumen']);
    assert.equal(code, 0, out);
    assert.match(out, /concepts\/retrieval/);
    assert.match(out, /concepts\/budget/);
  });

  it('default rel prints inbound section too', () => {
    const { code, out } = runQuery(root, ['rel', 'works_at', 'alex']);
    assert.equal(code, 0, out);
    assert.match(out, /Входящие works_at/);
  });
});

describe('validate — broken relation edge is warning', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-rel-val-'));
    writeConcept(root, 'entities/ok.md', {
      type: 'Entity',
      title: 'OK',
      relations: {
        works_at: '/entities/missing-org.md',
        depends_on: ['/projects/ghost.md'],
      },
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('conformant type still ✅, broken edges listed as ⚠️', () => {
    const { code, out } = runQuery(root, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅ OKF/);
    assert.match(out, /⚠️ Битые relations/);
    assert.match(out, /missing-org\.md/);
    assert.match(out, /ghost\.md/);
    assert.match(out, /works_at/);
    assert.match(out, /depends_on/);
  });
});

describe('links — relations count as edges', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-rel-links-'));
    writeConcept(root, 'entities/a.md', {
      type: 'Entity',
      title: 'A',
      relations: { works_at: '/entities/b.md' },
    }, '# A sees [B](/entities/b.md)\n');
    writeConcept(root, 'entities/b.md', { type: 'Entity', title: 'B' });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('edge tally includes relations', () => {
    const { code, out } = runQuery(root, ['links']);
    assert.equal(code, 0, out);
    assert.match(out, /relations: 1/);
    // b is not orphan (inbound from md + relation)
    assert.ok(!out.includes('entities/b\n') || !/Сироты[\s\S]*entities\/b/.test(out)
      || /Сироты \(нет входящих ссылок\):\n— нет/.test(out)
      || /Сироты[\s\S]*entities\/a/.test(out));
  });
});

describe('demo bundle has live relations', () => {
  const demoRoot = join(HERE, '..', 'demo');

  it('rel works_at acme-labs --inbound shows people', () => {
    if (!existsSync(join(demoRoot, 'entities', 'acme-labs.md'))) {
      // skip if demo missing in this checkout layout
      return;
    }
    const { code, out } = runQuery(demoRoot, ['rel', 'works_at', 'acme-labs', '--inbound']);
    assert.equal(code, 0, out);
    assert.match(out, /alex-doe|iris-vale/i);
  });

  it('validate demo: green, no broken relation warnings', () => {
    if (!existsSync(join(demoRoot, 'index.md'))) return;
    const { code, out } = runQuery(demoRoot, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅/);
    assert.ok(!out.includes('⚠️ Битые relations'), out);
  });
});

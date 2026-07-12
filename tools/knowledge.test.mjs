#!/usr/bin/env node
// knowledge.test.mjs — knowledge-cycle types (Analysis/Research/Idea): knowledgeChecks (unit)
// + validate warnings + board Ideas section + init templates + demo conformance/relations.
// node --test tools/knowledge.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInit } from './init.mjs';
import { buildBoard } from './board.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = join(HERE, 'okf-query.mjs');
const BOARD = join(HERE, 'board.mjs');
const DEMO = join(HERE, '..', 'demo');

function runQuery(root, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function runBoard(root, args = []) {
  const r = spawnSync(process.execPath, [BOARD, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** Minimal frontmatter writer: flat scalar keys, inline lists, optional relations block. */
function writeNode(root, relPath, fm, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const lines = [];
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'relations' && v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push('relations:');
      for (const [rk, rv] of Object.entries(v)) {
        lines.push(Array.isArray(rv) ? `  ${rk}: [${rv.join(', ')}]` : `  ${rk}: ${rv}`);
      }
    } else if (Array.isArray(v)) {
      lines.push(`${k}: [${v.join(', ')}]`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  writeFileSync(full, `---\n${lines.join('\n')}\n---\n\n${body}`);
}

// knowledgeChecks is a pure function of parsed docs; set OKF_ROOT before import so the
// module's module-level ROOT is harmless, then dynamic-import with cache busting.
let okf;
let unitRoot;
before(async () => {
  unitRoot = mkdtempSync(join(tmpdir(), 'samemind-know-unit-'));
  process.env.OKF_ROOT = unitRoot;
  okf = await import(`./lib/okf.mjs?t=${Date.now()}`);
});
after(() => { rmSync(unitRoot, { recursive: true, force: true }); });

const doc = (id, fm) => ({ id, reserved: false, fm });

describe('knowledgeChecks — unit (pure function)', () => {
  it('Idea without status → warns', () => {
    const w = okf.knowledgeChecks([doc('concepts/i', { type: 'Idea', title: 'I' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /concepts\/i: Idea missing 'status'/);
  });

  it('status outside the Idea dictionary → warns', () => {
    const w = okf.knowledgeChecks([doc('concepts/i', { type: 'Idea', status: 'maybe' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /outside dictionary/);
    assert.match(w[0], /spark\|incubating\|adopted\|rejected/);
    assert.match(w[0], /"maybe"/);
  });

  it('Idea rejected without rejected_reason → warns', () => {
    const w = okf.knowledgeChecks([doc('concepts/i', { type: 'Idea', status: 'rejected' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /concepts\/i: Idea 'rejected' missing 'rejected_reason'/);
  });

  it('Idea rejected WITH rejected_reason → clean', () => {
    const w = okf.knowledgeChecks([
      doc('concepts/i', { type: 'Idea', status: 'rejected', rejected_reason: 'superseded by a better idea' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('valid Idea across all statuses → clean', () => {
    const docs = [
      doc('concepts/i1', { type: 'Idea', status: 'spark' }),
      doc('concepts/i2', { type: 'Idea', status: 'incubating' }),
      doc('concepts/i3', { type: 'Idea', status: 'adopted' }),
      doc('concepts/i4', { type: 'Idea', status: 'rejected', rejected_reason: 'not worth it' }),
    ];
    assert.deepEqual(okf.knowledgeChecks(docs), []);
  });

  it('Analysis and Research have no status lifecycle → never warned', () => {
    const w = okf.knowledgeChecks([
      doc('concepts/a', { type: 'Analysis', title: 'A' }),             // no status field
      doc('concepts/r', { type: 'Research', title: 'R' }),             // no status field
      doc('concepts/a2', { type: 'Analysis', status: 'whatever' }),    // stray status ignored
    ]);
    assert.deepEqual(w, []);
  });

  it('non-knowledge types (Concept/Plan/Task/Decision/Session) → never warned', () => {
    const w = okf.knowledgeChecks([
      doc('concepts/c', { type: 'Concept', title: 'C' }),
      doc('projects/p', { type: 'Plan', title: 'P' }),          // no status — would warn under disciplineChecks, not here
      doc('projects/t', { type: 'Task', title: 'T' }),
      doc('concepts/d', { type: 'Decision', title: 'D' }),
      doc('concepts/s', { type: 'Session', title: 'S' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('reserved docs are skipped', () => {
    const w = okf.knowledgeChecks([
      { id: 'index', reserved: true, fm: { type: 'Idea' } }, // would warn if not skipped
      doc('concepts/i', { type: 'Idea', status: 'spark' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('status and type matched case-insensitively', () => {
    const w1 = okf.knowledgeChecks([doc('concepts/i', { type: 'idea', status: 'Rejected', rejected_reason: 'r' })]);
    assert.deepEqual(w1, []);
    const w2 = okf.knowledgeChecks([doc('concepts/i', { type: 'idea' })]);
    assert.match(w2[0], /concepts\/i: idea missing 'status'/);
  });

  it('KNOWLEDGE_STATUS_DICTIONARIES is frozen and has Idea only; STATUS_DICTIONARIES unaffected', () => {
    assert.ok(Object.isFrozen(okf.KNOWLEDGE_STATUS_DICTIONARIES));
    assert.deepEqual(Object.keys(okf.KNOWLEDGE_STATUS_DICTIONARIES), ['Idea']);
    // knowledge-cycle addition must not leak into the work-discipline dictionary
    assert.deepEqual(Object.keys(okf.STATUS_DICTIONARIES).sort(), ['Plan', 'Task']);
  });
});

describe('validate — knowledge-cycle warnings (integration)', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 'samemind-know-val-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('Idea missing status → warning block, still conformant (exit 0)', () => {
    writeNode(root, 'concepts/i.md', { type: 'Idea', title: 'I', visibility: 'internal' });
    const { code, out } = runQuery(root, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅ OKF/);
    assert.match(out, /⚠️ Knowledge cycle \(1\)/);
    assert.match(out, /concepts\/i: Idea missing 'status'/);
  });

  it('Idea rejected without rejected_reason → warning block', () => {
    writeNode(root, 'concepts/i2.md', { type: 'Idea', title: 'I2', status: 'rejected', visibility: 'internal' });
    const { code, out } = runQuery(root, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /Idea 'rejected' missing 'rejected_reason'/);
  });

  it('clean knowledge-cycle nodes → no Knowledge cycle block at all', () => {
    const clean = mkdtempSync(join(tmpdir(), 'samemind-know-clean-'));
    try {
      writeNode(clean, 'concepts/i.md', { type: 'Idea', title: 'I', status: 'incubating', visibility: 'internal' });
      writeNode(clean, 'concepts/a.md', { type: 'Analysis', title: 'A', visibility: 'internal' });
      writeNode(clean, 'concepts/r.md', { type: 'Research', title: 'R', visibility: 'internal' });
      const { code, out } = runQuery(clean, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.ok(!out.includes('Knowledge cycle'), out);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});

describe('init — knowledge-cycle templates', () => {
  it('scaffold includes the three knowledge-cycle templates with correct type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-know-init-'));
    try {
      assert.equal(runInit({ targetDir: dir }).ok, true);
      const expect = [
        ['concepts/_analysis-template.md', 'Analysis'],
        ['concepts/_research-template.md', 'Research'],
        ['concepts/_idea-template.md', 'Idea'],
      ];
      for (const [rel, type] of expect) {
        const p = join(dir, rel);
        assert.ok(existsSync(p), `${rel} missing`);
        assert.match(readFileSync(p, 'utf8'), new RegExp(`type: ${type}`));
      }
      // folder index points at the new templates + the spec doc
      const conceptsIndex = readFileSync(join(dir, 'concepts', 'index.md'), 'utf8');
      assert.match(conceptsIndex, /_analysis-template/);
      assert.match(conceptsIndex, /_research-template/);
      assert.match(conceptsIndex, /_idea-template/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freshly scaffolded bundle (0 concepts) still validates green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-know-init-val-'));
    try {
      runInit({ targetDir: dir });
      const { code, out } = runQuery(dir, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.ok(!out.includes('Knowledge cycle'), out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildBoard — Ideas section', () => {
  const idea = (id, status, extra = {}) => ({
    id, base: id.split('/').pop(), reserved: false,
    fm: {
      type: 'Idea',
      title: extra.title || id.split('/').pop(),
      description: extra.description || '',
      status,
      rejected_reason: extra.rejected_reason || '',
      timestamp: extra.timestamp || '2026-07-10T00:00:00Z',
      ...(extra.led_to ? { relations: { led_to: [extra.led_to] } } : {}),
    },
    relations: extra.led_to ? { led_to: [extra.led_to] } : undefined,
    body: '',
  });
  const plan = (id, title) => ({
    id, base: id.split('/').pop(), reserved: false,
    fm: { type: 'Plan', title, description: 'a plan', status: 'agreed', timestamp: '2026-07-10T00:00:00Z' },
    body: '',
  });

  it('incubating shown before spark, both visible', () => {
    const docs = [
      idea('concepts/i-spark', 'spark', { title: 'SparkIdea', timestamp: '2026-07-01T00:00:00Z' }),
      idea('concepts/i-incub', 'incubating', { title: 'IncubIdea', timestamp: '2026-07-02T00:00:00Z' }),
    ];
    const board = buildBoard(docs, { now: Date.UTC(2026, 6, 10) });
    assert.match(board, /## 💡 Ideas \(2\)/);
    const ideasSection = board.split('## 💡 Ideas')[1].split(/\n## /)[0];
    assert.ok(ideasSection.indexOf('IncubIdea') < ideasSection.indexOf('SparkIdea'),
      'incubating idea listed before spark idea');
  });

  it('adopted idea moves out of the main count, into an Adopted → Plans line with the Plan title', () => {
    const docs = [
      plan('projects/p-cron', 'Cron sync rollout'),
      idea('concepts/i-adopted', 'adopted', { title: 'AdoptedIdea', led_to: '/projects/p-cron.md' }),
      idea('concepts/i-incub', 'incubating', { title: 'IncubIdea' }),
    ];
    const board = buildBoard(docs, { now: Date.UTC(2026, 6, 10) });
    assert.match(board, /## 💡 Ideas \(1\)/, 'main count excludes the adopted idea');
    assert.ok(board.includes('IncubIdea'), 'incubating idea still in the main list');
    assert.match(board, /\*\*Adopted → Plans \(1\)\*\*/);
    assert.match(board, /AdoptedIdea.*adopted.*→.*Cron sync rollout/s);
  });

  it('rejected idea is hidden entirely — not in the main list, not in Adopted', () => {
    // timestamp outside the default 7-day Recent window too, so it can't leak in there either
    // (Recent is a cross-cutting "what changed" feed, same as it is for superseded Plans).
    const docs = [
      idea('concepts/i-rejected', 'rejected', {
        title: 'DeadIdea', rejected_reason: 'no longer relevant', timestamp: '2026-01-01T00:00:00Z',
      }),
      idea('concepts/i-incub', 'incubating', { title: 'IncubIdea' }),
    ];
    const board = buildBoard(docs, { now: Date.UTC(2026, 6, 10) });
    assert.match(board, /## 💡 Ideas \(1\)/);
    assert.ok(!board.includes('DeadIdea'), 'rejected idea never rendered');
  });

  it('adopted idea with no led_to relation still renders (no dangling arrow crash)', () => {
    const docs = [idea('concepts/i-adopted', 'adopted', { title: 'OrphanAdopted' })];
    const board = buildBoard(docs, { now: Date.UTC(2026, 6, 10) });
    assert.match(board, /OrphanAdopted.*adopted/s);
  });

  it('empty bundle → Ideas section present with 0 and no Adopted subsection', () => {
    const board = buildBoard([], { now: Date.UTC(2026, 6, 10) });
    assert.match(board, /## 💡 Ideas \(0\)/);
    assert.ok(!board.includes('Adopted → Plans'));
  });
});

describe('CLI board — Ideas via bin', () => {
  it('stdout includes the Ideas heading for a scaffolded (empty) bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-know-board-cli-'));
    try {
      runInit({ targetDir: dir });
      const { code, out } = runBoard(dir);
      assert.equal(code, 0, out);
      assert.match(out, /## 💡 Ideas \(0\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo — live knowledge-cycle samples', () => {
  it('has one of each knowledge-cycle type, linked by relations', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    for (const [type, needle] of [
      ['Analysis', 'analysis-mirror-staleness'],
      ['Research', 'research-mirror-sync-mechanism'],
      ['Idea', 'idea-cron-sync-adapters'],
    ]) {
      const { code, out } = runQuery(DEMO, ['type', type]);
      assert.equal(code, 0, out);
      assert.match(out, new RegExp(needle), `${type} sample missing`);
    }
  });

  it('Analysis and Research both inform the Idea (rel informs --inbound)', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runQuery(DEMO, ['rel', 'informs', 'idea-cron-sync-adapters', '--inbound']);
    assert.equal(code, 0, out);
    assert.match(out, /analysis-mirror-staleness/);
    assert.match(out, /research-mirror-sync-mechanism/);
  });

  it('Research is spawned_by the Analysis', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runQuery(DEMO, ['rel', 'spawned_by', 'research-mirror-sync-mechanism']);
    assert.equal(code, 0, out);
    assert.match(out, /analysis-mirror-staleness/);
  });

  it('demo Idea is incubating and carries a worked Reflections entry', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const content = readFileSync(join(DEMO, 'concepts', 'idea-cron-sync-adapters.md'), 'utf8');
    assert.match(content, /status: incubating/);
    assert.match(content, /## Reflections/);
    assert.match(content, /- 20\d\d-\d\d-\d\d .*:/); // at least one dated reflection line
  });

  it('board over the demo bundle shows the incubating idea', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runBoard(DEMO);
    assert.equal(code, 0, out);
    assert.match(out, /## 💡 Ideas \(1\)/);
    assert.ok(out.includes('Cron-sync adapters for engine mirrors'));
  });

  it('validate demo: green, no broken relations, no knowledge-cycle warnings', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runQuery(DEMO, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅/);
    assert.ok(!out.includes('⚠️ Broken relations'), out);
    assert.ok(!out.includes('Knowledge cycle'), out);
  });
});

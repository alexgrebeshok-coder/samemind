#!/usr/bin/env node
// discipline.test.mjs — work-discipline types: disciplineChecks (unit) + validate
// warnings + init templates + demo conformance. node --test tools/discipline.test.mjs
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

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = join(HERE, 'okf-query.mjs');
const DEMO = join(HERE, '..', 'demo');

function runQuery(root, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
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

// disciplineChecks is a pure function of parsed docs; set OKF_ROOT before import so
// the module's module-level ROOT is harmless, then dynamic-import with cache busting.
let okf;
let unitRoot;
before(async () => {
  unitRoot = mkdtempSync(join(tmpdir(), 'samemind-disc-unit-'));
  process.env.OKF_ROOT = unitRoot;
  okf = await import(`./lib/okf.mjs?t=${Date.now()}`);
});
after(() => { rmSync(unitRoot, { recursive: true, force: true }); });

const doc = (id, fm) => ({ id, reserved: false, fm });

describe('disciplineChecks — unit (pure function)', () => {
  it('Plan without status → warns', () => {
    const w = okf.disciplineChecks([doc('projects/p', { type: 'Plan', title: 'P' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /projects\/p: Plan missing 'status'/);
  });

  it('Task without status → warns', () => {
    const w = okf.disciplineChecks([doc('projects/t', { type: 'Task', title: 'T' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /projects\/t: Task missing 'status'/);
  });

  it('status outside the type dictionary → warns (Plan)', () => {
    const w = okf.disciplineChecks([doc('projects/p', { type: 'Plan', status: 'approved' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /outside dictionary/);
    assert.match(w[0], /draft\|agreed\|in-progress\|done\|superseded/);
    assert.match(w[0], /"approved"/);
  });

  it('status outside the Task dictionary → warns', () => {
    const w = okf.disciplineChecks([doc('projects/t', { type: 'Task', status: 'wip' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /backlog\|in-progress\|done\|blocked/);
  });

  it('Task blocked without blocked_reason → warns', () => {
    const w = okf.disciplineChecks([doc('projects/t', { type: 'Task', status: 'blocked' })]);
    assert.equal(w.length, 1);
    assert.match(w[0], /projects\/t: Task 'blocked' missing 'blocked_reason'/);
  });

  it('Task blocked WITH blocked_reason → clean', () => {
    const w = okf.disciplineChecks([
      doc('projects/t', { type: 'Task', status: 'blocked', blocked_reason: 'waiting on X' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('valid Plan + valid Task (all states) → clean', () => {
    const docs = [
      doc('projects/p1', { type: 'Plan', status: 'agreed' }),
      doc('projects/p2', { type: 'Plan', status: 'superseded' }),
      doc('projects/t1', { type: 'Task', status: 'backlog' }),
      doc('projects/t2', { type: 'Task', status: 'in-progress' }),
      doc('projects/t3', { type: 'Task', status: 'done' }),
    ];
    assert.deepEqual(okf.disciplineChecks(docs), []);
  });

  it('Decision and Session have no status lifecycle → never warned', () => {
    const w = okf.disciplineChecks([
      doc('concepts/d', { type: 'Decision', title: 'D' }),          // no status field
      doc('concepts/s', { type: 'Session', title: 'S' }),           // no status field
      doc('concepts/d2', { type: 'Decision', status: 'whatever' }), // stray status ignored
    ]);
    assert.deepEqual(w, []);
  });

  it('non-discipline types (Concept/Entity/Project) → never warned', () => {
    const w = okf.disciplineChecks([
      doc('concepts/c', { type: 'Concept', title: 'C' }),
      doc('entities/e', { type: 'Entity', title: 'E' }),
      doc('projects/x', { type: 'Project', title: 'X' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('reserved docs are skipped', () => {
    const w = okf.disciplineChecks([
      { id: 'index', reserved: true, fm: { type: 'Plan' } }, // would warn if not skipped
      doc('projects/p', { type: 'Plan', status: 'agreed' }),
    ]);
    assert.deepEqual(w, []);
  });

  it('status and type matched case-insensitively', () => {
    // lowercase type still resolves to the dictionary; capitalized status still valid
    const w1 = okf.disciplineChecks([doc('projects/t', { type: 'task', status: 'Blocked', blocked_reason: 'r' })]);
    assert.deepEqual(w1, []);
    // but missing status on a lowercase-typed task still warns, showing the original casing
    const w2 = okf.disciplineChecks([doc('projects/t', { type: 'plan' })]);
    assert.match(w2[0], /projects\/t: plan missing 'status'/);
  });

  it('STATUS_DICTIONARIES is frozen and has Plan + Task only', () => {
    assert.ok(Object.isFrozen(okf.STATUS_DICTIONARIES));
    assert.deepEqual(Object.keys(okf.STATUS_DICTIONARIES).sort(), ['Plan', 'Task']);
  });
});

describe('validate — discipline warnings (integration)', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 'samemind-disc-val-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('Plan missing status → warning block, still conformant (exit 0)', () => {
    writeNode(root, 'projects/p.md', { type: 'Plan', title: 'P', visibility: 'internal' });
    const { code, out } = runQuery(root, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅ OKF/);
    assert.match(out, /⚠️ Work discipline \(1\)/);
    assert.match(out, /projects\/p: Plan missing 'status'/);
  });

  it('Task blocked without reason → warning block', () => {
    writeNode(root, 'projects/t.md', { type: 'Task', title: 'T', status: 'blocked', visibility: 'internal' });
    const { code, out } = runQuery(root, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /Task 'blocked' missing 'blocked_reason'/);
  });

  it('clean discipline nodes → no discipline block at all', () => {
    const clean = mkdtempSync(join(tmpdir(), 'samemind-disc-clean-'));
    try {
      writeNode(clean, 'projects/p.md', { type: 'Plan', title: 'P', status: 'agreed', visibility: 'internal' });
      writeNode(clean, 'projects/t.md', {
        type: 'Task', title: 'T', status: 'blocked', blocked_reason: 'why', visibility: 'internal',
      });
      const { code, out } = runQuery(clean, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.ok(!out.includes('Work discipline'), out);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});

describe('init — work-discipline templates', () => {
  it('scaffold includes the four discipline templates with correct type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-disc-init-'));
    try {
      assert.equal(runInit({ targetDir: dir }).ok, true);
      const expect = [
        ['projects/_plan-template.md', 'Plan'],
        ['projects/_task-template.md', 'Task'],
        ['concepts/_decision-template.md', 'Decision'],
        ['concepts/_session-template.md', 'Session'],
      ];
      for (const [rel, type] of expect) {
        const p = join(dir, rel);
        assert.ok(existsSync(p), `${rel} missing`);
        assert.match(readFileSync(p, 'utf8'), new RegExp(`type: ${type}`));
      }
      // folder indexes point at the new templates + the spec doc
      assert.match(readFileSync(join(dir, 'projects', 'index.md'), 'utf8'), /_plan-template/);
      assert.match(readFileSync(join(dir, 'concepts', 'index.md'), 'utf8'), /_decision-template/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freshly scaffolded bundle (0 concepts) still validates green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-disc-init-val-'));
    try {
      runInit({ targetDir: dir });
      const { code, out } = runQuery(dir, ['validate']);
      assert.equal(code, 0, out);
      assert.match(out, /✅ OKF/);
      assert.ok(!out.includes('Work discipline'), out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo — live discipline samples', () => {
  it('has one of each discipline type', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    for (const [type, needle] of [
      ['Plan', 'plan-lumen-sync'],
      ['Task', 'task-lumen-backlinks'],
      ['Decision', 'decision-lumen-local-first'],
      ['Session', 'session-2026-07-09-lumen-sync'],
    ]) {
      const { code, out } = runQuery(DEMO, ['type', type]);
      assert.equal(code, 0, out);
      assert.match(out, new RegExp(needle), `${type} sample missing`);
    }
  });

  it('at least three Tasks across different statuses, one blocked with a reason', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { out } = runQuery(DEMO, ['type', 'Task']);
    const tasks = out.split('\n').filter(l => /projects\/task-/.test(l));
    assert.ok(tasks.length >= 3, `expected ≥3 tasks, got ${tasks.length}`);
    // the blocked one carries a non-empty blocked_reason
    const atlas = readFileSync(join(DEMO, 'projects', 'task-atlas-retrieval.md'), 'utf8');
    assert.match(atlas, /status: blocked/);
    assert.match(atlas, /^blocked_reason: .+/m);
  });

  it('validate demo: green, no broken relations, no discipline warnings', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runQuery(DEMO, ['validate']);
    assert.equal(code, 0, out);
    assert.match(out, /✅/);
    assert.ok(!out.includes('⚠️ Broken relations'), out);
    assert.ok(!out.includes('Work discipline'), out);
  });
});

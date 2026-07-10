#!/usr/bin/env node
// board.test.mjs — samemind board: kanban over the work-discipline layer.
// Unit (pure buildBoard) + integration (CLI --write / stdout / demo / validate-stays-green).
//   node --test tools/board.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './board.mjs';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, 'board.mjs');
const QUERY = join(HERE, 'okf-query.mjs');
const DEMO = join(HERE, '..', 'demo');

// Fixed "now" so aging/davnost is deterministic: 2026-07-10T12:00:00Z.
const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const DAY = 86_400_000;
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

/** Minimal parsed-doc stub matching what lib/okf.mjs `parse()` yields for buildBoard. */
function doc(id, fm) {
  return { id, base: id.split('/').pop(), reserved: false, fm, relations: fm.relations, body: '' };
}

function task(id, status, extra = {}) {
  return doc(id, {
    type: 'Task',
    title: extra.title || id.split('/').pop(),
    description: extra.description || '',
    status,
    blocked_reason: extra.blocked_reason || '',
    timestamp: extra.timestamp ?? daysAgo(1),
    ...(extra.project ? { relations: { project: [extra.project] } } : {}),
  });
}

function runCLI(root, args, env = {}) {
  const r = spawnSync(process.execPath, [BOARD, ...args], {
    env: { ...process.env, OKF_ROOT: root, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

function runQuery(root, args) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
    env: { ...process.env, OKF_ROOT: root }, encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

// ───────────────────────── unit: buildBoard (pure) ─────────────────────────

describe('buildBoard — columns by status', () => {
  const docs = [
    task('projects/t-back', 'backlog', { title: 'BacklogTask' }),
    task('projects/t-prog', 'in-progress', { title: 'ProgTask' }),
    task('projects/t-done', 'done', { title: 'DoneTask' }),
    task('projects/t-block', 'blocked', { title: 'BlockTask', blocked_reason: 'why', timestamp: daysAgo(2) }),
  ];
  const board = buildBoard(docs, { now: NOW });

  it('routes tasks into the four columns by status', () => {
    assert.match(board, /## 🆕 Backlog \(1\)/);
    assert.match(board, /## 🔧 In progress \(1\)/);
    assert.match(board, /## 🔴 Blocked \(1\)/);
    assert.match(board, /## ✅ Done · last 10 \(1\)/);
    assert.ok(board.includes('BacklogTask'), 'backlog task present');
    assert.ok(board.includes('ProgTask'), 'in-progress task present');
    assert.ok(board.includes('DoneTask'), 'done task present');
    assert.ok(board.includes('BlockTask'), 'blocked task present');
  });

  it('renders each item as a bundle-absolute markdown link', () => {
    assert.ok(board.includes('](/projects/t-back.md)'), 'link is /projects/…');
  });
});

describe('buildBoard — blocked reason + davnost + aging', () => {
  it('shows the blocked_reason and age in days; no aging when fresh', () => {
    const board = buildBoard([
      task('projects/t', 'blocked', { blocked_reason: 'waiting on license', timestamp: daysAgo(3) }),
    ], { now: NOW });
    assert.ok(board.includes('⛔ waiting on license'), 'reason shown');
    assert.ok(board.includes('⏳ 3д'), 'age shown');
    assert.ok(!board.includes('aging'), 'fresh block not flagged aging');
  });

  it('flags aging when the block is older than the threshold', () => {
    const board = buildBoard([
      task('projects/t', 'blocked', { blocked_reason: 'stale', timestamp: daysAgo(20) }),
    ], { now: NOW });
    assert.match(board, /⏳ 20д \(aging\)/, 'age + aging marker');
  });

  it('omits the age line when the task has no usable timestamp', () => {
    const board = buildBoard([
      task('projects/t', 'blocked', { blocked_reason: 'r', timestamp: '' }),
    ], { now: NOW });
    assert.ok(board.includes('⛔ r'));
    assert.ok(!/⏳/.test(board), 'no age line without timestamp');
  });
});

describe('buildBoard — plans (superseded hidden)', () => {
  it('shows active plans, hides superseded', () => {
    const docs = [
      doc('projects/p1', { type: 'Plan', title: 'ActivePlan', description: 'd', status: 'agreed', timestamp: daysAgo(1) }),
      doc('projects/p2', { type: 'Plan', title: 'DeadPlan', description: 'd', status: 'superseded', timestamp: daysAgo(30) }),
      doc('projects/p3', { type: 'Plan', title: 'DonePlan', description: 'd', status: 'done', timestamp: daysAgo(40) }),
    ];
    const board = buildBoard(docs, { now: NOW });
    assert.ok(board.includes('ActivePlan'), 'agreed plan shown');
    assert.ok(!board.includes('DeadPlan'), 'superseded plan hidden');
    assert.ok(!board.includes('DonePlan'), 'done plan hidden (history)');
  });
});

describe('buildBoard --project filter', () => {
  const docs = [
    task('projects/t-lumen-1', 'in-progress', { title: 'LumenOne', project: '/projects/lumen.md' }),
    task('projects/t-lumen-2', 'backlog', { title: 'LumenTwo', project: '/projects/lumen.md' }),
    task('projects/t-atlas-1', 'in-progress', { title: 'AtlasOne', project: '/projects/atlas.md' }),
  ];

  // --project scopes only the four Task columns (Plans / Recent / Sessions stay
  // portfolio-wide — see docs/work-discipline.md), so we assert column counts, not
  // global string absence (the other project's tasks still surface in Recent).
  it('scopes task columns to one project (matched by stem)', () => {
    const board = buildBoard(docs, { now: NOW, project: '/projects/lumen.md' });
    assert.match(board, /## 🔧 In progress \(1\)/);   // only lumen's in-progress task
    assert.match(board, /## 🆕 Backlog \(1\)/);        // only lumen's backlog task
    assert.ok(board.includes('LumenOne') && board.includes('LumenTwo'));
    assert.match(board, /Фильтр задач: проект `projects\/lumen`/);
  });

  it('accepts the bare project name too', () => {
    const board = buildBoard(docs, { now: NOW, project: 'atlas' });
    assert.match(board, /## 🔧 In progress \(1\)/);
    assert.match(board, /## 🆕 Backlog \(0\)/);        // atlas has no backlog task
    assert.ok(board.includes('AtlasOne'));
  });
});

describe('buildBoard — limits & windows', () => {
  it('caps the Done column at doneLimit (newest first)', () => {
    const docs = [];
    for (let i = 0; i < 12; i++) docs.push(task(`projects/d${i}`, 'done', { title: `Done${i}`, timestamp: daysAgo(i) }));
    const board = buildBoard(docs, { now: NOW, doneLimit: 5 });
    assert.match(board, /## ✅ Done · last 5 \(5\)/);
    // inspect the Done section only (older done tasks also surface in Recent)
    const doneSection = board.split('## ✅ Done')[1].split(/\n## /)[0];
    const bullets = doneSection.match(/^- \*\*/gm) || [];
    assert.equal(bullets.length, 5, 'exactly 5 done bullets');
    assert.ok(doneSection.includes('Done0') && doneSection.includes('Done4'), '5 newest shown');
    assert.ok(!doneSection.includes('Done5'), '6th dropped from the Done column');
  });

  it('Recent includes docs within the window, excludes older', () => {
    const docs = [
      doc('concepts/fresh', { type: 'Concept', title: 'Fresh', description: 'd', timestamp: daysAgo(3) }),
      doc('concepts/old', { type: 'Concept', title: 'Old', description: 'd', timestamp: daysAgo(20) }),
    ];
    const board = buildBoard(docs, { now: NOW, recentDays: 7 });
    assert.ok(board.includes('Fresh'));
    assert.ok(!board.includes('Old'));
  });

  it('shows at most the last 3 sessions', () => {
    const docs = [];
    for (let i = 0; i < 5; i++) {
      docs.push(doc(`concepts/s${i}`, { type: 'Session', title: `S${i}`, description: 'd', date: daysAgo(i).slice(0, 10), timestamp: daysAgo(i) }));
    }
    const board = buildBoard(docs, { now: NOW });
    assert.match(board, /### Последние сессии \(3\)/);
    // the sessions subsection holds exactly 3 one-liners (older sessions also surface in Recent)
    const sessSection = board.split('### Последние сессии')[1];
    const bullets = sessSection.match(/^- \[/gm) || [];
    assert.equal(bullets.length, 3, 'exactly 3 session summaries');
    assert.ok(sessSection.includes('S0') && sessSection.includes('S2'), '3 newest sessions');
    assert.ok(!sessSection.includes('S3'), '4th dropped from the summary');
  });
});

describe('buildBoard — robustness', () => {
  it('empty bundle → a board with empty sections, no throw', () => {
    const board = buildBoard([], { now: NOW });
    assert.match(board, /^# Dashboard/);
    assert.match(board, /## 🆕 Backlog \(0\)/);
    assert.ok(board.includes('_(пусто)_'), 'empty sections marked');
  });

  it('is idempotent: same docs+now → identical bytes', () => {
    const docs = [task('projects/t', 'blocked', { blocked_reason: 'x', timestamp: daysAgo(2) })];
    assert.equal(buildBoard(docs, { now: NOW }), buildBoard(docs, { now: NOW }));
  });
});

// ───────────────────────── integration: CLI ─────────────────────────

describe('CLI — stdout / --write / validate', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-board-cli-'));
    runInit({ targetDir: root });
    writeFileSync(join(root, 'projects', 't.md'), `---
type: Task
title: CLI task
description: a task for the CLI test
status: in-progress
timestamp: ${daysAgo(1)}
relations:
  project: /projects/lumen.md
---
`, 'utf8');
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('stdout mode prints the board', () => {
    const { code, out } = runCLI(root, []);
    assert.equal(code, 0, out);
    assert.match(out, /^# Dashboard/);
    assert.ok(out.includes('CLI task'));
  });

  it('--write creates DASHBOARD.md and stays green under validate', () => {
    const { code, out } = runCLI(root, ['--write']);
    assert.equal(code, 0, out);
    const dash = join(root, 'DASHBOARD.md');
    assert.ok(existsSync(dash), 'DASHBOARD.md written');
    const content = readFileSync(dash, 'utf8');
    assert.ok(content.includes('CLI task'), 'dashboard reflects the task');
    // DASHBOARD.md is RESERVED → not flagged as a concept by validate
    const v = runQuery(root, ['validate']);
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /✅ OKF/);
    assert.ok(!v.out.includes('DASHBOARD'), 'dashboard not treated as a concept');
  });

  it('--write is idempotent (second write yields identical bytes)', () => {
    const dash = join(root, 'DASHBOARD.md');
    const first = readFileSync(dash, 'utf8');
    runCLI(root, ['--write']);
    const second = readFileSync(dash, 'utf8');
    assert.equal(first, second, 're-writing produces byte-identical output');
  });
});

describe('init — DASHBOARD placeholder', () => {
  it('scaffold includes DASHBOARD.md with the board hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-board-init-'));
    try {
      assert.equal(runInit({ targetDir: dir }).ok, true);
      const p = join(dir, 'DASHBOARD.md');
      assert.ok(existsSync(p), 'DASHBOARD.md scaffolded');
      const c = readFileSync(p, 'utf8');
      assert.match(c, /^# Dashboard/);
      assert.match(c, /samemind board --write/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo — non-empty board', () => {
  it('renders a populated board from the demo bundle', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runCLI(DEMO, []);
    assert.equal(code, 0, out);
    assert.ok(out.length > 200, 'board is non-trivial');
    assert.ok(out.includes('Wire retrieval strategy over the Atlas corpus'), 'blocked demo task shown');
    assert.ok(out.includes('Lumen multi-device sync'), 'agreed plan shown');
    assert.match(out, /## 🔴 Blocked \(1\)/);
  });
});

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
import http from 'node:http';
import { buildBoard, buildBoardModel, OVERDUE_ENGINES_LIMIT, LEDGER_DERIVED_CAP } from './board.mjs';
import { runInit } from './init.mjs';
import { buildRegistry, writeRegistry } from './lib/fleet.mjs';
import { appendEvent } from './lib/ledger.mjs';
import { createUiServer } from './lib/ui-server.mjs';

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
    assert.ok(board.includes('⏳ 3d'), 'age shown');
    assert.ok(!board.includes('aging'), 'fresh block not flagged aging');
  });

  it('flags aging when the block is older than the threshold', () => {
    const board = buildBoard([
      task('projects/t', 'blocked', { blocked_reason: 'stale', timestamp: daysAgo(20) }),
    ], { now: NOW });
    assert.match(board, /⏳ 20d \(aging\)/, 'age + aging marker');
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
    assert.match(board, /Task filter: project `projects\/lumen`/);
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
    assert.match(board, /### Recent sessions \(3\)/);
    // the sessions subsection holds exactly 3 one-liners (older sessions also surface in Recent)
    const sessSection = board.split('### Recent sessions')[1];
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
    assert.ok(board.includes('_(empty)_'), 'empty sections marked');
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

  it('--json prints one line: contract=1, kind=board, generatedAt, data = buildBoardModel()', () => {
    const { code, out } = runCLI(root, ['--json']);
    assert.equal(code, 0, out);
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.contract, 1);
    assert.equal(payload.kind, 'board');
    assert.ok(!Number.isNaN(Date.parse(payload.generatedAt)), 'generatedAt is a valid ISO timestamp');
    assert.ok(Array.isArray(payload.data.inprog));
    assert.ok(payload.data.inprog.some(d => d.fm.title === 'CLI task'), 'data is the real buildBoardModel() output');
    assert.ok(Array.isArray(payload.data.backlog) && Array.isArray(payload.data.blocked) && Array.isArray(payload.data.plans));
  });

  it('--json rejects --write (one projection at a time)', () => {
    const { code, out } = runCLI(root, ['--json', '--write']);
    assert.notEqual(code, 0);
    assert.match(out, /--json is incompatible with --write\/--html/);
  });

  it('--json rejects --html (one projection at a time)', () => {
    const { code, out } = runCLI(root, ['--json', '--html']);
    assert.notEqual(code, 0);
    assert.match(out, /--json is incompatible with --write\/--html/);
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

// ─────────────────────────── board: 🔥 Overdue engines (fleet) ───────────────────────────

describe('board — 🔥 Overdue engines (unit, pure buildBoard/buildBoardModel)', () => {
  function overdueRow(id, extra = {}) {
    return {
      id, role: 'executor', status: 'active', lastSeen: null, silentSec: null, heartbeatSec: 3600, overdue: true, ...extra,
    };
  }

  it('empty overdueEngines → section is OMITTED entirely (unlike Open failures, no standing "(0)" heading)', () => {
    const md = buildBoard([], { now: NOW, overdueEngines: [] });
    assert.ok(!md.includes('🔥 Overdue engines'), 'section absent when there is nothing to show');
  });

  it('defaults to [] when overdueEngines is not passed — no crash, section still absent', () => {
    const model = buildBoardModel([], { now: NOW });
    assert.deepEqual(model.overdueEnginesShown, []);
    assert.equal(model.overdueEnginesTotal, 0);
    assert.ok(!buildBoard([], { now: NOW }).includes('🔥 Overdue engines'));
  });

  it('renders each overdue engine with id/role/silence/limit/last-seen', () => {
    const md = buildBoard([], {
      now: NOW,
      overdueEngines: [overdueRow('grok', { lastSeen: '2026-07-01T10:00:00.000Z', silentSec: 777600, heartbeatSec: 86400 })],
    });
    assert.match(md, /## 🔥 Overdue engines \(1\)/);
    assert.match(md, /\*\*grok\*\* — executor, silent 777600s \(limit 86400s\) _\(last seen 2026-07-01 10:00\)_/);
  });

  it('a never-seen engine (silentSec/lastSeen null) renders "∞" and "never seen"', () => {
    const md = buildBoard([], { now: NOW, overdueEngines: [overdueRow('ghost')] });
    assert.match(md, /\*\*ghost\*\* — executor, silent ∞ \(limit 3600s\) _\(last seen never seen\)_/);
  });

  it('appears after 🔥 Open failures and before 🆕 Backlog when both are present', () => {
    const md = buildBoard([], {
      now: NOW,
      openFailures: [{
        ts: '2026-01-01T00:00:00Z', actor: 'a', topic: 'x', phase: 'fail', status: 'fail', action: 'x broke',
      }],
      overdueEngines: [overdueRow('grok')],
    });
    const failIdx = md.indexOf('## 🔥 Open failures');
    const overdueIdx = md.indexOf('## 🔥 Overdue engines');
    const backlogIdx = md.indexOf('## 🆕 Backlog');
    assert.ok(failIdx >= 0 && failIdx < overdueIdx && overdueIdx < backlogIdx);
  });

  it('caps display at OVERDUE_ENGINES_LIMIT, most-silent first, with a "…and N more" note and full count in the heading', () => {
    const many = Array.from({ length: OVERDUE_ENGINES_LIMIT + 2 }, (_, i) =>
      overdueRow(`engine-${i}`, { silentSec: (i + 1) * 100, heartbeatSec: 60 }));
    const model = buildBoardModel([], { now: NOW, overdueEngines: many });
    assert.equal(model.overdueEnginesTotal, OVERDUE_ENGINES_LIMIT + 2);
    assert.equal(model.overdueEnginesShown.length, OVERDUE_ENGINES_LIMIT);
    // most-silent first: the highest silentSec sorts first
    assert.equal(model.overdueEnginesShown[0].id, `engine-${OVERDUE_ENGINES_LIMIT + 1}`);

    const md = buildBoard([], { now: NOW, overdueEngines: many });
    assert.match(md, new RegExp(`## 🔥 Overdue engines \\(${OVERDUE_ENGINES_LIMIT + 2}\\)`));
    assert.match(md, /…and 2 more — `samemind fleet status`/);
  });
});

describe('board — 🔥 Overdue engines (CLI integration, real fleet registry + ledger)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-fleet-board-cli-'));
    runInit({ targetDir: root });
    writeRegistry(root, buildRegistry({ engines: [{ id: 'grok', role: 'executor', heartbeatSec: 60 }] }));
    appendEvent(root, {
      actor: 'grok', topic: 't', phase: 'start', action: 'began long ago', ts: '2020-01-01T00:00:00Z',
    });
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('samemind board surfaces the real overdue engine from fleet/registry.json + the ledger', () => {
    const r = runCLI(root, []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /## 🔥 Overdue engines \(1\)/);
    assert.match(r.out, /\*\*grok\*\*/);
  });

  it('no fleet registry at all → section absent, rest of the board unaffected', () => {
    const bareRoot = mkdtempSync(join(tmpdir(), 'samemind-fleet-board-bare-'));
    try {
      runInit({ targetDir: bareRoot });
      const r = runCLI(bareRoot, []);
      assert.equal(r.code, 0, r.out);
      assert.ok(!r.out.includes('🔥 Overdue engines'));
      assert.match(r.out, /^# Dashboard/);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
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
    // Blocked holds the real Task doc PLUS a derived ledger card (atlas-retrieval's last event
    // is a fail — neither its id nor title matches the Task doc's, so both show, see
    // "derived-канбан: demo fixture" below).
    assert.match(out, /## 🔴 Blocked \(2\)/);
  });

  it('--json renders the same demo state as valid, parseable JSON', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, out } = runCLI(DEMO, ['--json']);
    assert.equal(code, 0, out);
    const payload = JSON.parse(out.trim());
    assert.equal(payload.contract, 1);
    assert.equal(payload.kind, 'board');
    assert.ok(payload.data.blocked.some(d => d.fm.title?.includes('Wire retrieval strategy')));
  });
});

// ─────────────────── derived-канбан: synthesize cards from ledger topics ───────────────────
// A bundle can have hundreds of ledger topics (tools/lib/ledger.mjs) and zero Task docs — the
// board should not sit empty just because nobody wrote Task frontmatter. See docs/ui-spec.md §3.1.

describe('derived-канбан (a) — no ledgerTopics: byte-identical to the pre-feature board', () => {
  const docs = [
    task('projects/t-prog', 'in-progress', { title: 'ProgTask' }),
    task('projects/t-block', 'blocked', { title: 'BlockTask', blocked_reason: 'why' }),
    task('projects/t-done', 'done', { title: 'DoneTask' }),
  ];

  it('omitting ledgerTopics behaves exactly like passing [] — no ledger markers anywhere', () => {
    const withoutOpt = buildBoard(docs, { now: NOW });
    const withEmpty = buildBoard(docs, { now: NOW, ledgerTopics: [] });
    assert.equal(withoutOpt, withEmpty, 'omitted vs empty-array ledgerTopics produce identical bytes');
    assert.ok(!withoutOpt.includes('(ledger)'), 'no derived-card marker');
    assert.ok(!withoutOpt.includes('from the ledger'), 'no overflow note');
    assert.match(withoutOpt, /## 🔧 In progress \(1\)/);
    assert.match(withoutOpt, /## 🔴 Blocked \(1\)/);
    assert.match(withoutOpt, /## ✅ Done · last 10 \(1\)/);
  });

  it('model exposes ledgerOverflow all-zero when there is nothing to derive', () => {
    const model = buildBoardModel(docs, { now: NOW });
    assert.deepEqual(model.ledgerOverflow, { inprog: 0, blocked: 0, done: 0 });
  });
});

describe('derived-канбан (в) — a stale "done" topic (older than recentDays) is dropped entirely', () => {
  it('produces no card in any column, not even counted toward overflow', () => {
    const staleTopic = {
      topic: 'ghost-topic', count: 2, openFail: null,
      last: { ts: daysAgo(30), actor: 'grok', phase: 'done', status: 'ok', action: 'long since done' },
    };
    const model = buildBoardModel([], { now: NOW, recentDays: 7, ledgerTopics: [staleTopic] });
    assert.equal(model.done.length, 0, 'stale done is not shown in Done');
    assert.equal(model.inprog.length, 0);
    assert.equal(model.blocked.length, 0);
    assert.equal(model.ledgerOverflow.done, 0, 'dropped, not capped — never counted as overflow');
  });

  it('a "done" topic inside the recentDays window DOES show, in the Done column', () => {
    const freshTopic = {
      topic: 'fresh-topic', count: 1, openFail: null,
      last: { ts: daysAgo(2), actor: 'grok', phase: 'done', status: 'ok', action: 'shipped it' },
    };
    const model = buildBoardModel([], { now: NOW, recentDays: 7, ledgerTopics: [freshTopic] });
    assert.equal(model.done.length, 1);
    assert.equal(model.done[0].id, 'ledger:fresh-topic');
    assert.equal(model.done[0].source, 'ledger');
  });
});

describe('derived-канбан (г) — caps at 8 per column, freshest first, "N more" overflow note', () => {
  it('10 in-progress-phase topics → 8 shown newest-first, overflow note names the remaining 2', () => {
    // topic-9 freshest (daysAgo(1)) … topic-0 oldest (daysAgo(10))
    const topics = Array.from({ length: 10 }, (_, i) => ({
      topic: `topic-${i}`, count: 1, openFail: null,
      last: { ts: daysAgo(10 - i), actor: 'grok', phase: 'step', status: 'ok', action: `working on ${i}` },
    }));
    const model = buildBoardModel([], { now: NOW, ledgerTopics: topics });
    assert.equal(model.inprog.length, LEDGER_DERIVED_CAP);
    assert.equal(model.ledgerOverflow.inprog, 2);
    assert.equal(model.inprog[0].id, 'ledger:topic-9', 'freshest shown first');
    assert.equal(model.inprog[LEDGER_DERIVED_CAP - 1].id, 'ledger:topic-2', '8th-newest is the last one shown');

    const md = buildBoard([], { now: NOW, ledgerTopics: topics });
    assert.match(md, /## 🔧 In progress \(10\)/, 'heading quotes the true total, not the 8 shown');
    assert.match(md, /_…and 2 more from the ledger — `samemind ledger status`_/);
  });
});

describe('columnTotals — the honest count behind a capped column', () => {
  it('12 ledger topics + 2 Task docs → totals count all 14, arrays still cap at 8 + docs', () => {
    const docs = [
      task('projects/t-a', 'in-progress', { title: 'DocA' }),
      task('projects/t-b', 'in-progress', { title: 'DocB' }),
    ];
    const topics = Array.from({ length: 12 }, (_, i) => ({
      topic: `topic-${i}`, count: 1, openFail: null,
      last: { ts: daysAgo(12 - i), actor: 'grok', phase: 'step', status: 'ok', action: `step ${i}` },
    }));
    const model = buildBoardModel(docs, { now: NOW, ledgerTopics: topics });

    assert.equal(model.columnTotals.inprog, 2 + 12, 'doc cards + every derived candidate');
    assert.equal(model.inprog.length, 2 + LEDGER_DERIVED_CAP, 'shown array stays capped');
    assert.equal(model.ledgerOverflow.inprog, 12 - LEDGER_DERIVED_CAP);
    // the three numbers must always reconcile, or the overflow note contradicts the heading
    assert.equal(model.columnTotals.inprog, model.inprog.length + model.ledgerOverflow.inprog);

    const md = buildBoard(docs, { now: NOW, ledgerTopics: topics });
    assert.match(md, /## 🔧 In progress \(14\)/);
    assert.match(md, /_…and 4 more from the ledger/);
  });

  it('blocked and done carry their own totals; backlog has no ledger analogue', () => {
    const mk = (n, phase, prefix) => Array.from({ length: n }, (_, i) => ({
      topic: `${prefix}-${i}`, count: 1, openFail: null,
      last: { ts: daysAgo(1), actor: 'grok', phase, status: phase === 'fail' ? 'fail' : 'ok', action: 'x' },
    }));
    const model = buildBoardModel([], {
      now: NOW, ledgerTopics: [...mk(11, 'fail', 'f'), ...mk(9, 'done', 'd')],
    });
    assert.equal(model.columnTotals.blocked, 11);
    assert.equal(model.columnTotals.done, 9);
    assert.equal(model.columnTotals.backlog, 0, 'backlog is never synthesized from the ledger');
    assert.equal(model.blocked.length, LEDGER_DERIVED_CAP);
    assert.equal(model.done.length, LEDGER_DERIVED_CAP);
  });

  it('no ledger → totals equal the shown lengths, so every heading stays byte-identical', () => {
    const docs = [
      task('projects/t-1', 'backlog', { title: 'B1' }),
      task('projects/t-2', 'in-progress', { title: 'P1' }),
      task('projects/t-3', 'blocked', { title: 'K1', blocked_reason: 'why' }),
      task('projects/t-4', 'done', { title: 'D1' }),
    ];
    const model = buildBoardModel(docs, { now: NOW });
    for (const col of ['backlog', 'inprog', 'blocked', 'done']) {
      assert.equal(model.columnTotals[col], model[col].length, `${col}: total == shown`);
    }
  });

  it('done stays a "last N" window: its total never exceeds doneLimit', () => {
    const docs = Array.from({ length: 14 }, (_, i) => task(`projects/d-${i}`, 'done', { title: `D${i}` }));
    const model = buildBoardModel(docs, { now: NOW, doneLimit: 10 });
    assert.equal(model.done.length, 10);
    assert.equal(model.columnTotals.done, 10, 'the heading already says "last 10" — it is a window, not a claim');
  });
});

describe('derived-канбан (д) — a canon Task doc (exact id or title match) suppresses the derived card', () => {
  it('a Task whose TITLE equals the ledger topic wins — no derived duplicate', () => {
    const docs = [task('projects/t-canon', 'blocked', { title: 'atlas-retrieval' })];
    const topics = [{
      topic: 'atlas-retrieval', count: 3, openFail: null,
      last: { ts: daysAgo(1), actor: 'cursor', phase: 'fail', status: 'fail', action: 'broke' },
    }];
    const model = buildBoardModel(docs, { now: NOW, ledgerTopics: topics });
    assert.equal(model.blocked.length, 1, 'only the real Task card, no derived duplicate');
    assert.ok(!model.blocked.some(c => c.source === 'ledger'));
  });

  it('a Task whose ID equals the ledger topic also wins', () => {
    const docs = [task('atlas-retrieval', 'blocked', { title: 'Something else entirely' })];
    const topics = [{
      topic: 'atlas-retrieval', count: 1, openFail: null,
      last: { ts: daysAgo(1), actor: 'cursor', phase: 'fail', status: 'fail', action: 'broke' },
    }];
    const model = buildBoardModel(docs, { now: NOW, ledgerTopics: topics });
    assert.equal(model.blocked.length, 1);
    assert.ok(!model.blocked.some(c => c.source === 'ledger'));
  });

  it('a near-miss (not an exact string match) is NOT suppressed — no fuzzy matching', () => {
    const docs = [task('projects/t-near', 'blocked', { title: 'Atlas Retrieval (fix it)' })];
    const topics = [{
      topic: 'atlas-retrieval', count: 1, openFail: null,
      last: { ts: daysAgo(1), actor: 'cursor', phase: 'fail', status: 'fail', action: 'broke' },
    }];
    const model = buildBoardModel(docs, { now: NOW, ledgerTopics: topics });
    assert.equal(model.blocked.length, 2, 'real task + derived card both present — near-miss title does not suppress');
    assert.ok(model.blocked.some(c => c.source === 'ledger' && c.id === 'ledger:atlas-retrieval'));
  });
});

describe("derived-канбан (е) — GET /api/board serves source:'ledger' cards (demo bundle, via ui-server)", () => {
  it("lumen-sync (last event: note → inprog) and atlas-retrieval (last event: fail → blocked) are source:'ledger'", async () => {
    const server = createUiServer({ root: DEMO });
    await new Promise((resolvePromise, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    try {
      const port = server.address().port;
      const body = await new Promise((resolvePromise, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/api/board', method: 'GET' },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolvePromise(data));
          },
        );
        req.on('error', reject);
        req.end();
      });
      const { data } = JSON.parse(body);
      assert.ok(
        data.inprog.some((c) => c.source === 'ledger' && c.id === 'ledger:lumen-sync'),
        "lumen-sync (last event phase 'note') shows as an in-progress derived card",
      );
      assert.ok(
        data.blocked.some((c) => c.source === 'ledger' && c.id === 'ledger:atlas-retrieval'),
        "atlas-retrieval (last event phase 'fail') shows as a blocked derived card",
      );
    } finally {
      server.close();
    }
  });
});

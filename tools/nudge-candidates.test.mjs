#!/usr/bin/env node
// nudge-candidates.test.mjs — pure unit tests for buildCandidates.
// Covers: open vs closed failures, today's activity suppress, age ranking,
// empty-is-ok, no secrets/bodies in text, determinism.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidates,
  safeLabel,
  DAY_MS,
  DEFAULT_MIN_AGE_MS,
  KIND_RANK,
} from './lib/nudge-candidates.mjs';
import { summarizeLedger, buildEvent } from './lib/ledger.mjs';
import { buildBoardModel } from './board.mjs';
import { buildHandoffModel } from './handoff.mjs';

const NOW = Date.parse('2026-08-03T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

function ev(topic, phase, status, ts, extra = {}) {
  return buildEvent({
    actor: 'test',
    topic,
    phase,
    status,
    action: extra.action || `${phase}/${status}`,
    ts,
    ...extra,
  });
}

function task({ id, title, status, timestamp, blocked_reason, body }) {
  const fm = { type: 'Task', title, status, timestamp };
  if (blocked_reason !== undefined) fm.blocked_reason = blocked_reason;
  return {
    id,
    reserved: false,
    fm,
    relations: {},
    body: body || `# ${title}\n\nSECRET BODY sk-live-should-never-appear\n`,
  };
}

function session({ id, title, timestamp, body }) {
  return {
    id: id || 'sessions/2026-07-30',
    reserved: false,
    fm: { type: 'Session', title: title || 'Session', timestamp },
    relations: {},
    body: body || '## Next\n\n- finish the auth rewrite\n- rotate the staging key\n',
  };
}

// ─────────────────────────── open failures ──────────────────────────────────

describe('buildCandidates — open failures', () => {
  it('open (unclosed) fail becomes a candidate; closed does not', () => {
    const ledger = summarizeLedger([
      ev('broken-topic', 'fail', 'fail', daysAgo(3), { action: 'tests red on CI' }),
      ev('fixed-topic', 'fail', 'fail', daysAgo(4), { action: 'was broken' }),
      ev('fixed-topic', 'done', 'ok', daysAgo(2), { action: 'fixed' }),
    ]);
    const list = buildCandidates({ ledger, board: { blocked: [], inprog: [] }, now: NOW });
    const topics = list.filter(c => c.kind === 'open-failure').map(c => c.sourceRef);
    assert.ok(topics.includes('broken-topic'), 'open fail is a candidate');
    assert.ok(!topics.includes('fixed-topic'), 'closed fail is not a candidate');
    const hit = list.find(c => c.sourceRef === 'broken-topic');
    assert.equal(hit.kind, 'open-failure');
    assert.match(hit.text, /Незакрытый сбой/);
    assert.match(hit.why, /закрывающего события нет/);
    assert.equal(hit.age, 3);
  });

  it('topic with events today is NOT a candidate (work is moving)', () => {
    const ledger = summarizeLedger([
      // old open fail, but a step today → moving
      ev('active-bug', 'fail', 'fail', daysAgo(5), { action: 'still open' }),
      ev('active-bug', 'step', 'wip', hoursAgo(2), { action: 'investigating' }),
      // truly stale open fail
      ev('stale-bug', 'fail', 'fail', daysAgo(5), { action: 'forgotten' }),
    ]);
    const list = buildCandidates({ ledger, now: NOW });
    const refs = list.map(c => c.sourceRef);
    assert.ok(!refs.includes('active-bug'), 'today activity suppresses candidate');
    assert.ok(refs.includes('stale-bug'), 'quiet open fail remains');
  });

  it('fresh open fail (under minAge) is skipped — person still remembers', () => {
    const ledger = summarizeLedger([
      ev('just-broke', 'fail', 'fail', hoursAgo(2), { action: 'boom' }),
    ]);
    const list = buildCandidates({ ledger, now: NOW });
    assert.deepEqual(list, []);
  });
});

// ─────────────────────────── age ranking ────────────────────────────────────

describe('buildCandidates — age ranking', () => {
  it('older blocker ranks above younger one (age > count)', () => {
    const docs = [
      task({
        id: 'projects/old-block',
        title: 'Old blocker',
        status: 'blocked',
        timestamp: daysAgo(7),
        blocked_reason: 'waiting on license',
      }),
      task({
        id: 'projects/young-block',
        title: 'Young blocker',
        status: 'blocked',
        timestamp: daysAgo(2),
        blocked_reason: 'needs review',
      }),
    ];
    const board = buildBoardModel(docs, { now: NOW });
    const list = buildCandidates({ board, ledger: { topics: [], openFailures: [] }, now: NOW });
    const blocked = list.filter(c => c.kind === 'blocked');
    assert.ok(blocked.length >= 2, 'both blockers candidate');
    assert.equal(blocked[0].sourceRef, 'projects/old-block');
    assert.ok(blocked[0].age > blocked[1].age, 'older first');
  });

  it('open-failure outranks blocked of equal age', () => {
    const ledger = summarizeLedger([
      ev('fail-x', 'fail', 'fail', daysAgo(3)),
    ]);
    const board = buildBoardModel([
      task({
        id: 'projects/block-x',
        title: 'Block X',
        status: 'blocked',
        timestamp: daysAgo(3),
      }),
    ], { now: NOW });
    const list = buildCandidates({ board, ledger, now: NOW });
    assert.ok(list.length >= 2);
    assert.equal(list[0].kind, 'open-failure');
    assert.ok(KIND_RANK[list[0].kind] < KIND_RANK[list[1].kind]);
  });
});

// ─────────────────────────── empty is fine ──────────────────────────────────

describe('buildCandidates — silence is correct', () => {
  it('everything fine → empty list, not an error', () => {
    const board = buildBoardModel([
      task({
        id: 'projects/moving',
        title: 'Moving task',
        status: 'in-progress',
        timestamp: hoursAgo(1),
      }),
    ], { now: NOW });
    const ledger = summarizeLedger([
      ev('moving', 'step', 'ok', hoursAgo(1), { action: 'progress' }),
    ]);
    const handoff = buildHandoffModel([], { now: new Date(NOW) });
    const list = buildCandidates({ board, ledger, handoff, now: NOW });
    assert.deepEqual(list, []);
  });

  it('missing inputs → empty, never throws', () => {
    assert.deepEqual(buildCandidates({}), []);
    assert.deepEqual(buildCandidates({ now: NOW }), []);
    assert.deepEqual(buildCandidates({ board: null, ledger: null, handoff: null, now: NOW }), []);
  });
});

// ─────────────────────────── safety ─────────────────────────────────────────

describe('buildCandidates — no bodies, no secrets in text', () => {
  it('text/why never include document body or secret-shaped strings', () => {
    const secretBody = [
      'Full document body with private notes.',
      'api_key=sk-live-abc123XYZ999secret',
      'password: hunter2',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBg…',
    ].join('\n');
    const docs = [
      task({
        id: 'projects/sensitive',
        title: 'Rotate staging credentials',
        status: 'blocked',
        timestamp: daysAgo(4),
        blocked_reason: 'token sk-live-SHOULD-NOT-LEAK expired in vault',
        body: secretBody,
      }),
    ];
    const board = buildBoardModel(docs, { now: NOW });
    // open failure whose action is secret-shaped — must not leak into text
    const ledger = summarizeLedger([
      ev('secret-fail', 'fail', 'fail', daysAgo(4), {
        action: 'deploy failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload',
      }),
    ]);
    const list = buildCandidates({ board, ledger, now: NOW });
    assert.ok(list.length >= 1);
    const blob = list.map(c => `${c.text}\n${c.why}\n${c.sourceRef}`).join('\n');
    assert.ok(!blob.includes('sk-live-'), 'no sk-live key material');
    assert.ok(!blob.includes('Bearer eyJ'), 'no bearer token');
    assert.ok(!blob.includes('PRIVATE KEY'), 'no private key block');
    assert.ok(!blob.includes('hunter2'), 'no password');
    assert.ok(!blob.includes('Full document body'), 'no doc body');
    assert.ok(!blob.includes('private notes'), 'no doc body prose');
    // title/status only
    for (const c of list) {
      assert.ok(c.text.length < 120, 'one short phrase');
      assert.ok(!c.text.includes('\n'), 'single line');
    }
  });

  it('safeLabel strips secret-shaped substrings', () => {
    const cleaned = safeLabel('key sk-abcdefghijklmnop failed');
    assert.ok(!cleaned.includes('sk-abcdefghijklmnop'));
    assert.equal(safeLabel(''), 'без названия');
  });
});

// ─────────────────────────── determinism ────────────────────────────────────

describe('buildCandidates — determinism', () => {
  it('same input → same list (byte-stable)', () => {
    const ledger = summarizeLedger([
      ev('a', 'fail', 'fail', daysAgo(5)),
      ev('b', 'block', 'wip', daysAgo(3)),
    ]);
    const board = buildBoardModel([
      task({
        id: 'projects/z',
        title: 'Zulu',
        status: 'blocked',
        timestamp: daysAgo(6),
      }),
      task({
        id: 'projects/m',
        title: 'Mike',
        status: 'in-progress',
        timestamp: daysAgo(4),
      }),
    ], { now: NOW });
    const handoff = buildHandoffModel([
      session({ timestamp: daysAgo(3) }),
    ], { now: new Date(NOW) });
    const a = buildCandidates({ board, ledger, handoff, now: NOW });
    const b = buildCandidates({ board, ledger, handoff, now: NOW });
    assert.deepEqual(a, b);
    // second call again after mutation-free re-run
    const c = buildCandidates({ board, ledger, handoff, now: NOW });
    assert.equal(JSON.stringify(a), JSON.stringify(c));
  });

  it('does not call Date.now — missing now yields epoch-stable empty/finite result', () => {
    // With now=0, ages become huge for any ISO-2026 timestamps → still deterministic.
    const ledger = summarizeLedger([
      ev('old', 'fail', 'fail', '2020-01-01T00:00:00Z'),
    ]);
    const x = buildCandidates({ ledger, now: 0 });
    const y = buildCandidates({ ledger, now: 0 });
    assert.deepEqual(x, y);
  });
});

// ─────────────────────────── board / handoff shapes ─────────────────────────

describe('buildCandidates — board inprog + sessionNext', () => {
  it('stale in-progress becomes candidate; inprog with today ledger activity does not', () => {
    const docs = [
      task({
        id: 'projects/stale-wip',
        title: 'Stale WIP',
        status: 'in-progress',
        timestamp: daysAgo(5),
      }),
      task({
        id: 'projects/live-wip',
        title: 'Live WIP',
        status: 'in-progress',
        timestamp: daysAgo(5),
      }),
    ];
    const board = buildBoardModel(docs, { now: NOW });
    const ledger = summarizeLedger([
      // matches leaf "live-wip" / title via topic
      ev('live-wip', 'step', 'wip', hoursAgo(1), { action: 'pushing' }),
    ]);
    const list = buildCandidates({ board, ledger, now: NOW });
    const refs = list.map(c => c.sourceRef);
    assert.ok(refs.includes('projects/stale-wip'), 'quiet inprog is candidate');
    assert.ok(!refs.includes('projects/live-wip'), 'today activity suppresses inprog');
    const stale = list.find(c => c.sourceRef === 'projects/stale-wip');
    assert.equal(stale.kind, 'inprog-stale');
  });

  it('sessionNext only when last session is old enough; why is honest', () => {
    const oldSession = session({
      id: 'sessions/old',
      timestamp: daysAgo(3),
      body: '## Next\n\n- wire the probe endpoint\n',
    });
    const handoff = buildHandoffModel([oldSession], { now: new Date(NOW) });
    assert.ok(handoff.sessionNext.length >= 1);
    const list = buildCandidates({
      handoff,
      board: { blocked: [], inprog: [] },
      ledger: { topics: [], openFailures: [] },
      now: NOW,
    });
    const next = list.filter(c => c.kind === 'session-next');
    assert.ok(next.length >= 1);
    assert.match(next[0].text, /С прошлой сессии/);
    assert.match(next[0].why, /Next прошлой сессии/);
    assert.equal(next[0].sourceRef, 'sessions/old');

    // Fresh session → no session-next candidates
    const fresh = buildHandoffModel([
      session({ id: 'sessions/today', timestamp: hoursAgo(2), body: '## Next\n\n- do the thing\n' }),
    ], { now: new Date(NOW) });
    const quiet = buildCandidates({
      handoff: fresh,
      board: { blocked: [], inprog: [] },
      ledger: { topics: [], openFailures: [] },
      now: NOW,
    });
    assert.equal(quiet.filter(c => c.kind === 'session-next').length, 0);
  });

  it('respects max cap from config', () => {
    const fails = [];
    for (let i = 0; i < 8; i++) {
      fails.push(ev(`topic-${i}`, 'fail', 'fail', daysAgo(2 + i)));
    }
    const ledger = summarizeLedger(fails);
    const list = buildCandidates({ ledger, now: NOW, config: { max: 3 } });
    assert.equal(list.length, 3);
  });

  it('default minAgeMs is one day', () => {
    assert.equal(DEFAULT_MIN_AGE_MS, DAY_MS);
  });
});

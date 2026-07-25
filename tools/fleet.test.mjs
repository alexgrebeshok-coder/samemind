#!/usr/bin/env node
// fleet.test.mjs — fleet layer: a declared registry of agent engines plus heartbeat/assign
// over it. Covers:
//   - unit: lib/fleet.mjs (buildEngine/buildRegistry validation, readRegistry tolerance,
//     heartbeat semantics, buildAssignment validation)
//   - CLI: tools/fleet.mjs init|status|assign (spawned as a real subprocess)
//   - init reuses detectEngines() rather than re-implementing detection
//   - assign logs to the existing event ledger rather than a second storage format
// node --test tools/fleet.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runInit } from './init.mjs';
import {
  buildEngine, buildRegistry, buildAssignment, readRegistry, writeRegistry, registryFile,
  heartbeat, findEngine, ROLES, STATUSES, DEFAULT_STOP_POINTS,
} from './lib/fleet.mjs';
import { appendEvent, readEvents } from './lib/ledger.mjs';
import { detectEngines } from './lib/detect-engines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET_CLI = join(HERE, 'fleet.mjs');

function runCli(args, root, extraEnv = {}) {
  const r = spawnSync(process.execPath, [FLEET_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root, OKF_EMBED_URL: '', ...extraEnv },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`)); }

// ─────────────────────────────── unit: lib/fleet.mjs ───────────────────────────────

describe('buildEngine — validation (pure)', () => {
  it('requires an id', () => {
    assert.throws(() => buildEngine({}), /"id" is required/);
  });

  it('rejects an id outside the lowercase-alnum-hyphen shape', () => {
    assert.throws(() => buildEngine({ id: 'Not Valid!' }), /"id" must be lowercase alnum\/hyphen/);
  });

  it('rejects a role outside the dictionary — does not silently coerce', () => {
    assert.throws(() => buildEngine({ id: 'x', role: 'wizard' }), /"role" must be one of director\|executor\|reserve \(got "wizard"\)/);
  });

  it('rejects a status outside the dictionary', () => {
    assert.throws(() => buildEngine({ id: 'x', status: 'nope' }), /"status" must be one of active\|reserve\|dead/);
  });

  it('rejects a non-positive heartbeatSec', () => {
    assert.throws(() => buildEngine({ id: 'x', heartbeatSec: 0 }), /"heartbeatSec" must be a positive number/);
    assert.throws(() => buildEngine({ id: 'x', heartbeatSec: -5 }), /"heartbeatSec" must be a positive number/);
    assert.throws(() => buildEngine({ id: 'x', heartbeatSec: 'soon' }), /"heartbeatSec" must be a positive number/);
  });

  it('defaults role=executor, status=active, chain=false, heartbeatSec=default', () => {
    const e = buildEngine({ id: 'cursor' });
    assert.equal(e.role, 'executor');
    assert.equal(e.status, 'active');
    assert.equal(e.chain, false);
    assert.ok(e.heartbeatSec > 0);
  });

  it('accepts every role and status in the dictionaries', () => {
    for (const role of ROLES) {
      for (const status of STATUSES) {
        const e = buildEngine({ id: 'x', role, status });
        assert.equal(e.role, role);
        assert.equal(e.status, status);
      }
    }
  });
});

describe('buildRegistry — dedupes by id, validates every engine', () => {
  it('last entry for a repeated id wins', () => {
    const r = buildRegistry({ engines: [{ id: 'a', role: 'executor' }, { id: 'a', role: 'director' }] });
    assert.equal(r.engines.length, 1);
    assert.equal(r.engines[0].role, 'director');
  });

  it('defaults stopPoints to DEFAULT_STOP_POINTS', () => {
    const r = buildRegistry({ engines: [] });
    assert.deepEqual(r.stopPoints, DEFAULT_STOP_POINTS);
  });

  it('propagates a bad engine\'s validation error', () => {
    assert.throws(() => buildRegistry({ engines: [{ id: '' }] }), /"id" is required/);
  });
});

describe('readRegistry — tolerant of a missing or broken file', () => {
  it('missing fleet/registry.json → null', () => {
    const root = tmp('fleet-missing');
    try {
      assert.equal(readRegistry(root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('corrupt JSON → null, does not throw', () => {
    const root = tmp('fleet-corrupt');
    try {
      mkdirSync(join(root, 'fleet'), { recursive: true });
      writeFileSync(join(root, 'fleet', 'registry.json'), 'not { json at all', 'utf8');
      assert.doesNotThrow(() => readRegistry(root));
      assert.equal(readRegistry(root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('valid JSON but missing an `engines` array → null (shape guard)', () => {
    const root = tmp('fleet-shape');
    try {
      mkdirSync(join(root, 'fleet'), { recursive: true });
      writeFileSync(join(root, 'fleet', 'registry.json'), JSON.stringify({ version: 1 }), 'utf8');
      assert.equal(readRegistry(root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writeRegistry then readRegistry round-trips', () => {
    const root = tmp('fleet-roundtrip');
    try {
      const reg = buildRegistry({ engines: [{ id: 'cursor', role: 'executor' }] });
      writeRegistry(root, reg);
      const back = readRegistry(root);
      assert.equal(back.engines.length, 1);
      assert.equal(back.engines[0].id, 'cursor');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('heartbeat — silence detection (unit, pure)', () => {
  const NOW = Date.parse('2026-07-25T12:00:00Z');

  it('an active engine silent past its heartbeatSec is flagged overdue', () => {
    const engines = [buildEngine({ id: 'quiet', heartbeatSec: 3600 })];
    const events = [{ actor: 'quiet', ts: '2026-07-25T09:00:00Z' }]; // 3h ago > 1h limit
    const [row] = heartbeat(engines, events, NOW);
    assert.equal(row.overdue, true);
    assert.ok(row.silentSec > 3600);
  });

  it('a fresh engine within its heartbeatSec is NOT flagged', () => {
    const engines = [buildEngine({ id: 'fresh', heartbeatSec: 3600 })];
    const events = [{ actor: 'fresh', ts: '2026-07-25T11:50:00Z' }]; // 10min ago < 1h limit
    const [row] = heartbeat(engines, events, NOW);
    assert.equal(row.overdue, false);
  });

  it('an engine never seen in the ledger is flagged overdue (lastSeen null)', () => {
    const engines = [buildEngine({ id: 'ghost', heartbeatSec: 60 })];
    const [row] = heartbeat(engines, [], NOW);
    assert.equal(row.overdue, true);
    assert.equal(row.lastSeen, null);
  });

  it('a reserve/dead engine is never flagged overdue, even with no events', () => {
    const engines = [
      buildEngine({ id: 'benched', status: 'reserve' }),
      buildEngine({ id: 'retired', status: 'dead' }),
    ];
    const rows = heartbeat(engines, [], NOW);
    assert.ok(rows.every((r) => r.overdue === false));
  });

  it('only the latest event per actor counts as lastSeen', () => {
    const engines = [buildEngine({ id: 'e', heartbeatSec: 3600 })];
    const events = [
      { actor: 'e', ts: '2026-07-20T00:00:00Z' },
      { actor: 'e', ts: '2026-07-25T11:59:00Z' }, // 1 min ago — should win
      { actor: 'other', ts: '2026-07-25T11:59:59Z' },
    ];
    const [row] = heartbeat(engines, events, NOW);
    assert.equal(row.lastSeen, '2026-07-25T11:59:00.000Z');
    assert.equal(row.overdue, false);
  });

  it('malformed events (missing actor/ts) are ignored, never throw', () => {
    const engines = [buildEngine({ id: 'e', heartbeatSec: 60 })];
    assert.doesNotThrow(() => heartbeat(engines, [{ actor: 'e' }, { ts: 'garbage' }, null, {}], NOW));
  });

  it('empty engines/events → empty array, never throws', () => {
    assert.deepEqual(heartbeat([], [], NOW), []);
    assert.deepEqual(heartbeat([], undefined, NOW), []);
  });
});

describe('buildAssignment — validation (pure)', () => {
  it('requires engine/topic/goal/verify', () => {
    assert.throws(() => buildAssignment({ topic: 't', goal: 'g', verify: 'v' }), /"engine" is required/);
    assert.throws(() => buildAssignment({ engine: 'e', goal: 'g', verify: 'v' }), /"topic" is required/);
    assert.throws(() => buildAssignment({ engine: 'e', topic: 't', verify: 'v' }), /"goal" is required/);
    assert.throws(() => buildAssignment({ engine: 'e', topic: 't', goal: 'g' }), /"verify" is required/);
  });

  it('defaults stopPoints to DEFAULT_STOP_POINTS, boundaries to []', () => {
    const a = buildAssignment({ engine: 'e', topic: 't', goal: 'g', verify: 'v' });
    assert.deepEqual(a.stopPoints, DEFAULT_STOP_POINTS);
    assert.deepEqual(a.boundaries, []);
  });

  it('accepts explicit boundaries/stopPoints arrays', () => {
    const a = buildAssignment({
      engine: 'e', topic: 't', goal: 'g', verify: 'v',
      boundaries: ['repo/**'], stopPoints: ['prod'],
    });
    assert.deepEqual(a.boundaries, ['repo/**']);
    assert.deepEqual(a.stopPoints, ['prod']);
  });
});

describe('findEngine', () => {
  it('finds by id, null when absent or registry is null', () => {
    const reg = buildRegistry({ engines: [{ id: 'cursor' }] });
    assert.equal(findEngine(reg, 'cursor').id, 'cursor');
    assert.equal(findEngine(reg, 'nope'), null);
    assert.equal(findEngine(null, 'cursor'), null);
  });
});

// ─────────────────────────────────── CLI: tools/fleet.mjs ───────────────────────────────────

describe('CLI — samemind fleet init', () => {
  it('reuses detectEngines(): a target with AGENTS.md picks up the same ids detectEngines() would', () => {
    const root = tmp('fleet-cli-init');
    const target = tmp('fleet-cli-init-target');
    try {
      runInit({ targetDir: root });
      writeFileSync(join(target, 'AGENTS.md'), '# rules\n', 'utf8');
      const expected = detectEngines(target);
      assert.ok(expected.includes('cursor'));

      const r = runCli(['init', '--target', target], root);
      assert.equal(r.code, 0, r.out);
      const reg = readRegistry(root);
      const ids = reg.engines.map((e) => e.id);
      for (const id of expected) assert.ok(ids.includes(id), `expected ${id} in ${JSON.stringify(ids)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('is safe to run twice: second run does not drop already-registered engines', () => {
    const root = tmp('fleet-cli-init-twice');
    const target = tmp('fleet-cli-init-twice-target');
    try {
      runInit({ targetDir: root });
      writeFileSync(join(target, 'CLAUDE.md'), '# notes\n', 'utf8');
      runCli(['init', '--target', target], root);
      const first = readRegistry(root).engines.length;
      const r2 = runCli(['init', '--target', target], root);
      assert.equal(r2.code, 0, r2.out);
      assert.equal(readRegistry(root).engines.length, first);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('an empty target (no engine files) still produces a valid registry with default stop-points', () => {
    const root = tmp('fleet-cli-init-empty');
    const target = tmp('fleet-cli-init-empty-target');
    try {
      runInit({ targetDir: root });
      const r = runCli(['init', '--target', target], root);
      assert.equal(r.code, 0, r.out);
      const reg = readRegistry(root);
      assert.deepEqual(reg.stopPoints, DEFAULT_STOP_POINTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('CLI — samemind fleet status', () => {
  it('no registry yet → friendly message, exit 0 (not an error)', () => {
    const root = tmp('fleet-cli-status-empty');
    try {
      runInit({ targetDir: root });
      const r = runCli(['status'], root);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /no registry yet/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a silent engine is reported with the 🔥 marker; a fresh one is not', () => {
    const root = tmp('fleet-cli-status');
    try {
      runInit({ targetDir: root });
      writeRegistry(root, buildRegistry({
        engines: [
          { id: 'quiet-one', heartbeatSec: 60 },
          { id: 'fresh-one', heartbeatSec: 3600 },
        ],
      }));
      appendEvent(root, { actor: 'quiet-one', topic: 't', phase: 'start', action: 'began long ago', ts: '2020-01-01T00:00:00Z' });
      appendEvent(root, { actor: 'fresh-one', topic: 't', phase: 'step', action: 'just now' });
      const r = runCli(['status'], root);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /🔥 quiet-one/);
      assert.match(r.out, /✅ fresh-one/);
      assert.match(r.out, /1 engine\(s\) overdue: quiet-one/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a broken registry.json does not crash the CLI', () => {
    const root = tmp('fleet-cli-status-broken');
    try {
      runInit({ targetDir: root });
      mkdirSync(join(root, 'fleet'), { recursive: true });
      writeFileSync(join(root, 'fleet', 'registry.json'), '{ this is not json', 'utf8');
      const r = runCli(['status'], root);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /no registry yet/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('CLI — samemind fleet assign', () => {
  let root;
  before(() => {
    root = tmp('fleet-cli-assign');
    runInit({ targetDir: root });
    writeRegistry(root, buildRegistry({
      engines: [
        { id: 'cursor', role: 'executor' },
        { id: 'benched', role: 'executor', status: 'reserve' },
      ],
    }));
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('assigning to an engine not in the registry fails, nothing is logged', () => {
    const before_ = readEvents(root).length;
    const r = runCli(['assign', '--engine', 'nope', '--topic', 't', '--goal', 'g', '--verify', 'v'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /not in the registry/);
    assert.equal(readEvents(root).length, before_);
  });

  it('assigning to a non-active engine fails', () => {
    const r = runCli(['assign', '--engine', 'benched', '--topic', 't', '--goal', 'g', '--verify', 'v'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /not active/);
  });

  it('missing --verify fails with a clear message', () => {
    const r = runCli(['assign', '--engine', 'cursor', '--topic', 't', '--goal', 'g'], root);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /"verify" is required/);
  });

  it('a valid assignment logs a `start` event to the existing ledger — no second storage format', () => {
    const r = runCli([
      'assign', '--engine', 'cursor', '--topic', 'fleet-demo', '--goal', 'ship the thing',
      '--verify', 'tests green', '--boundary', 'tools/**',
    ], root);
    assert.equal(r.code, 0, r.out);
    const events = readEvents(root).filter((e) => e.topic === 'fleet-demo');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'cursor');
    assert.equal(events[0].phase, 'start');
    assert.match(events[0].action, /ship the thing/);
    assert.match(events[0].action, /tests green/);
    assert.equal(events[0].artifact, 'tools/**');
  });
});

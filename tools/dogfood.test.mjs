#!/usr/bin/env node
// dogfood.test.mjs — product self-health history for "week without failures":
//   - writeHealth state-change → ledger fail/ok (topic samemind-health), no spam on repeats
//   - project failure/success closes openFailures via the same path
//   - samemind dogfood: empty bundle is "нечем измерить", never "0 failures"
//   - fleet init seeds the samemind product engine
// node --test tools/dogfood.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { writeHealth, readHealth, HEALTH_TOPIC, HEALTH_ACTOR } from './lib/health.mjs';
import { readEvents, summarizeLedger } from './lib/ledger.mjs';
import {
  buildEngine, buildRegistry, writeRegistry, readRegistry,
  DEFAULT_PRODUCT_ENGINE, PRODUCT_ENGINE_ID, DEFAULT_STOP_POINTS,
  heartbeat,
} from './lib/fleet.mjs';
import { runInit } from './init.mjs';
import { assessDogfood } from './dogfood.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_CLI = join(HERE, 'project.mjs');
const DOGFOOD_CLI = join(HERE, 'dogfood.mjs');
const FLEET_CLI = join(HERE, 'fleet.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

function makeBundle() {
  const root = tmp('dogfood-bundle');
  const home = tmp('dogfood-home');
  const abs = join(root, 'concepts', 'retrieval.md');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '---\ntype: Concept\ntitle: Retrieval\nsource: demo\ntimestamp: 2026-07-10T00:00:00Z\n---\n\nbody\n', 'utf8');
  return { root, home };
}

function runProject(args, root, home) {
  return execFileSync(process.execPath, [PROJECT_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root, HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runDogfood(args, root, home) {
  return execFileSync(process.execPath, [DOGFOOD_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root, HOME: home || tmp('dogfood-cli-home') },
    encoding: 'utf8',
  });
}

function runFleet(args, root) {
  const r = execFileSync(process.execPath, [FLEET_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root, OKF_EMBED_URL: '' },
    encoding: 'utf8',
  });
  return r;
}

// ─────────────────────────────── writeHealth → ledger state change ───────────────────────────────

describe('writeHealth — ledger state-change events', () => {
  it('failure creates one fail event on samemind-health; openFailures lists it', () => {
    const root = tmp('health-fail');
    try {
      writeHealth(root, { ok: false, lastError: 'boom from test' });
      const evs = readEvents(root);
      assert.equal(evs.length, 1);
      assert.equal(evs[0].topic, HEALTH_TOPIC);
      assert.equal(evs[0].actor, HEALTH_ACTOR);
      assert.equal(evs[0].phase, 'fail');
      assert.equal(evs[0].status, 'fail');
      assert.match(evs[0].action, /boom from test/);
      assert.ok(evs[0].ref);

      const { openFailures } = summarizeLedger(evs);
      assert.equal(openFailures.length, 1);
      assert.equal(openFailures[0].topic, HEALTH_TOPIC);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('success after failure closes openFailures (done/ok on same topic)', () => {
    const root = tmp('health-recover');
    try {
      writeHealth(root, { ok: false, lastError: 'first fail' });
      assert.equal(summarizeLedger(readEvents(root)).openFailures.length, 1);

      writeHealth(root, { ok: true, targets: ['claude-code'] });
      const evs = readEvents(root);
      assert.equal(evs.length, 2);
      assert.equal(evs[1].phase, 'done');
      assert.equal(evs[1].status, 'ok');
      assert.match(evs[1].action, /recovered|projection ok/);

      const { openFailures } = summarizeLedger(evs);
      assert.equal(openFailures.length, 0, 'closing done/ok clears openFailures for the topic');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repeated failure does NOT append a second event (state-change only)', () => {
    const root = tmp('health-spam');
    try {
      writeHealth(root, { ok: false, lastError: 'fail A' });
      writeHealth(root, { ok: false, lastError: 'fail B' });
      writeHealth(root, { ok: false, lastError: 'fail C' });
      const evs = readEvents(root);
      assert.equal(evs.length, 1, 'only first fail is recorded');
      assert.match(evs[0].action, /fail A/);
      // health.json still shows the latest error (overwrite, not history)
      assert.equal(readHealth(root).lastError, 'fail C');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repeated success does NOT append more events after the first ok', () => {
    const root = tmp('health-ok-spam');
    try {
      writeHealth(root, { ok: true, targets: [] });
      writeHealth(root, { ok: true, targets: [] });
      writeHealth(root, { ok: true, targets: [] });
      assert.equal(readEvents(root).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fail → ok → fail appends three events (each is a real transition)', () => {
    const root = tmp('health-toggle');
    try {
      writeHealth(root, { ok: false, lastError: 'a' });
      writeHealth(root, { ok: true });
      writeHealth(root, { ok: false, lastError: 'b' });
      const evs = readEvents(root);
      assert.equal(evs.length, 3);
      assert.deepEqual(evs.map((e) => e.phase), ['fail', 'done', 'fail']);
      assert.equal(summarizeLedger(evs).openFailures.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── project CLI integration ───────────────────────────────

describe('samemind project — failure/success → ledger openFailures', () => {
  it('failed project run creates fail in ledger; next success clears openFailures', () => {
    const { root, home } = makeBundle();
    try {
      try { runProject(['--engine', 'not-a-real-engine'], root, home); } catch { /* expected */ }
      const afterFail = readEvents(root);
      assert.ok(afterFail.some((e) => e.topic === HEALTH_TOPIC && e.phase === 'fail'));
      assert.equal(summarizeLedger(afterFail).openFailures.filter((f) => f.topic === HEALTH_TOPIC).length, 1);

      runProject(['--engine', 'claude-code'], root, home);
      const afterOk = readEvents(root);
      assert.ok(afterOk.some((e) => e.topic === HEALTH_TOPIC && e.phase === 'done' && e.status === 'ok'));
      assert.equal(
        summarizeLedger(afterOk).openFailures.filter((f) => f.topic === HEALTH_TOPIC).length,
        0,
        'success after fail must close openFailures',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('two failed project runs in a row still leave a single fail event', () => {
    const { root, home } = makeBundle();
    try {
      try { runProject(['--engine', 'not-a-real-engine'], root, home); } catch { /* expected */ }
      try { runProject(['--engine', 'also-fake'], root, home); } catch { /* expected */ }
      const fails = readEvents(root).filter((e) => e.topic === HEALTH_TOPIC && e.phase === 'fail');
      assert.equal(fails.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── assessDogfood + CLI ───────────────────────────────

describe('assessDogfood (pure)', () => {
  it('empty events → measurable:false, days null (not 0)', () => {
    const data = assessDogfood([]);
    assert.equal(data.measurable, false);
    assert.equal(data.daysWithoutOpenFailure, null);
    assert.equal(data.open, false);
    assert.match(data.reason, /nothing to measure|нечем|no health/i);
  });

  it('open fail → days 0, open true', () => {
    const data = assessDogfood([
      {
        ts: '2026-07-01T00:00:00Z', actor: HEALTH_ACTOR, topic: HEALTH_TOPIC,
        phase: 'fail', status: 'fail', action: 'boom', artifact: null, ref: 'r1',
        quarantine: false, matches: [],
      },
    ], { now: Date.parse('2026-07-08T00:00:00Z') });
    assert.equal(data.measurable, true);
    assert.equal(data.open, true);
    assert.equal(data.daysWithoutOpenFailure, 0);
    assert.equal(data.lastFailure.open, true);
  });

  it('closed fail → days since fail timestamp', () => {
    const data = assessDogfood([
      {
        ts: '2026-07-01T00:00:00Z', actor: HEALTH_ACTOR, topic: HEALTH_TOPIC,
        phase: 'fail', status: 'fail', action: 'boom', artifact: null, ref: 'r1',
        quarantine: false, matches: [],
      },
      {
        ts: '2026-07-01T01:00:00Z', actor: HEALTH_ACTOR, topic: HEALTH_TOPIC,
        phase: 'done', status: 'ok', action: 'projection recovered', artifact: null, ref: 'r2',
        quarantine: false, matches: [],
      },
    ], { now: Date.parse('2026-07-08T00:00:00Z') });
    assert.equal(data.measurable, true);
    assert.equal(data.open, false);
    assert.equal(data.daysWithoutOpenFailure, 7);
    assert.equal(data.lastFailure.open, false);
  });
});

describe('samemind dogfood — CLI', () => {
  it('empty bundle: human says нечем измерить; --json measurable:false (not 0 failures)', () => {
    const root = tmp('dogfood-empty');
    const home = tmp('dogfood-empty-home');
    try {
      mkdirSync(root, { recursive: true });
      const human = runDogfood([], root, home);
      assert.match(human, /нечем измерить/);
      assert.doesNotMatch(human, /0 day/);

      const parsed = JSON.parse(runDogfood(['--json'], root, home));
      assert.equal(parsed.contract, 1);
      assert.equal(parsed.kind, 'dogfood');
      assert.ok(parsed.generatedAt);
      assert.equal(parsed.data.measurable, false);
      assert.equal(parsed.data.daysWithoutOpenFailure, null);
      assert.equal(parsed.data.topic, HEALTH_TOPIC);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--json after project fail then recover: measurable, open false', () => {
    const { root, home } = makeBundle();
    try {
      try { runProject(['--engine', 'not-a-real-engine'], root, home); } catch { /* expected */ }
      runProject(['--engine', 'claude-code'], root, home);
      const parsed = JSON.parse(runDogfood(['--json'], root, home));
      assert.equal(parsed.data.measurable, true);
      assert.equal(parsed.data.open, false);
      assert.equal(typeof parsed.data.daysWithoutOpenFailure, 'number');
      assert.ok(parsed.data.lastFailure);
      assert.equal(parsed.data.lastFailure.open, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── fleet: product engine ───────────────────────────────

describe('fleet — samemind product engine', () => {
  it('fleet init seeds samemind even when no agent files are detected', () => {
    const root = tmp('fleet-product');
    const target = tmp('fleet-product-target');
    try {
      runInit({ targetDir: root });
      runFleet(['init', '--target', target], root);
      const reg = readRegistry(root);
      const sm = reg.engines.find((e) => e.id === PRODUCT_ENGINE_ID);
      assert.ok(sm, 'samemind must be in registry after init');
      assert.equal(sm.heartbeatSec, DEFAULT_PRODUCT_ENGINE.heartbeatSec);
      assert.equal(sm.status, 'active');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('fleet init does not overwrite an existing samemind entry', () => {
    const root = tmp('fleet-product-keep');
    try {
      runInit({ targetDir: root });
      writeRegistry(root, buildRegistry({
        engines: [{ id: PRODUCT_ENGINE_ID, role: 'reserve', heartbeatSec: 99, zone: 'hand-tuned' }],
        stopPoints: DEFAULT_STOP_POINTS,
      }));
      runFleet(['init', '--target', root], root);
      const sm = readRegistry(root).engines.find((e) => e.id === PRODUCT_ENGINE_ID);
      assert.equal(sm.role, 'reserve');
      assert.equal(sm.heartbeatSec, 99);
      assert.equal(sm.zone, 'hand-tuned');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('heartbeat still keys lastSeen by actor only — health events as actor samemind update lastSeen', () => {
    const root = tmp('fleet-hb-actor');
    try {
      writeHealth(root, { ok: false, lastError: 'x' });
      const engines = [buildEngine(DEFAULT_PRODUCT_ENGINE)];
      const rows = heartbeat(engines, readEvents(root), Date.now());
      assert.equal(rows[0].id, PRODUCT_ENGINE_ID);
      assert.ok(rows[0].lastSeen, 'lastSeen comes from ledger actor=samemind');
      assert.equal(rows[0].overdue, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('demo fleet registry includes samemind', () => {
    const demoReg = join(HERE, '..', 'demo', 'fleet', 'registry.json');
    assert.ok(existsSync(demoReg));
    const reg = JSON.parse(readFileSync(demoReg, 'utf8'));
    assert.ok(reg.engines.some((e) => e.id === 'samemind'));
  });
});

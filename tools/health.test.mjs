#!/usr/bin/env node
// health.test.mjs — external heartbeat over `samemind project` runs (tools/lib/health.mjs, its
// wiring into tools/project.mjs, and `samemind status` reading it). Covers:
//   - unit: writeHealth/readHealth round-trip, missing/malformed file → null, atomic write (no
//     leftover tmp file), assessLiveness ok/stale/unknown (now injected — never Date.now())
//   - CLI: `samemind project` (real subprocess) writes health.json on success AND on failure,
//     preserving the existing non-zero exit; --dry-run never writes health; a broken health
//     write does not fail the run itself (secondary side-effect)
//   - CLI: `samemind status` human message with no health yet, --json contract:1, --root flag
// node --test tools/health.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  writeHealth, readHealth, assessLiveness, maybeAppendHealthLedger, HEALTH_TOPIC,
} from './lib/health.mjs';
import { readEvents } from './lib/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_CLI = join(HERE, 'project.mjs');
const STATUS_CLI = join(HERE, 'status.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

// ─────────────────────────────── unit: writeHealth / readHealth ───────────────────────────────

describe('writeHealth / readHealth', () => {
  it('round-trips ok/targets/version/schema_version, ts is a real ISO timestamp', () => {
    const root = tmp('health');
    try {
      const rec = writeHealth(root, { ok: true, targets: ['claude-code', 'cursor'], version: '0.12.0' });
      assert.equal(rec.ok, true);
      assert.equal(rec.lastError, null);
      assert.equal(rec.schema_version, 1);
      assert.equal(new Date(rec.ts).toISOString(), rec.ts, 'ts is produced by Date#toISOString, not Date.now()');

      assert.deepEqual(readHealth(root), rec);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('failure record carries lastError; targets/version default when omitted', () => {
    const root = tmp('health');
    try {
      writeHealth(root, { ok: false, lastError: 'boom' });
      const read = readHealth(root);
      assert.equal(read.ok, false);
      assert.equal(read.lastError, 'boom');
      assert.deepEqual(read.targets, []);
      assert.equal(read.version, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('readHealth: no file yet → null, never throws', () => {
    const root = tmp('health');
    try {
      assert.equal(readHealth(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('readHealth: malformed JSON → null, never throws', () => {
    const root = tmp('health');
    try {
      mkdirSync(join(root, '.samemind'), { recursive: true });
      writeFileSync(join(root, '.samemind', 'health.json'), '{ not json', 'utf8');
      assert.equal(readHealth(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write is atomic: only the final health.json lands, no leftover .tmp', () => {
    const root = tmp('health');
    try {
      writeHealth(root, { ok: true, targets: [] });
      assert.deepEqual(readdirSync(join(root, '.samemind')), ['health.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── unit: maybeAppendHealthLedger — ref keys the TRANSITION, not just the destination state ───
// (regression: same-ms fail→ok→fail collapsed to 2 events — the second `fail`'s ref matched the
// first `fail`'s ref, both computed from state+ts only, so appendEvent's dedup silently ate a
// real third event). Time is injected via `record.ts`/`previous.ts` — never Date.now() — so the
// test doesn't depend on the machine being fast enough to land two writes in one millisecond.
describe('maybeAppendHealthLedger — same-millisecond transitions', () => {
  it('fail → ok → fail, all at the SAME ts → three events (each a real transition)', () => {
    const root = tmp('health-ledger');
    try {
      const ts = '2026-01-01T00:00:00.500Z';
      const none = null;
      const fail1 = { ts, ok: false, lastError: 'boom' };
      const ok1 = { ts, ok: true, lastError: null };
      const fail2 = { ts, ok: false, lastError: 'boom again' };
      maybeAppendHealthLedger(root, none, fail1);   // none  → fail
      maybeAppendHealthLedger(root, fail1, ok1);     // fail  → ok
      maybeAppendHealthLedger(root, ok1, fail2);     // ok    → fail (same ts as fail1!)
      const events = readEvents(root).filter(e => e.topic === HEALTH_TOPIC);
      assert.equal(events.length, 3, 'each transition is a distinct real event, none dropped as a dup');
      assert.deepEqual(events.map(e => e.status), ['fail', 'ok', 'fail']);
      const refs = new Set(events.map(e => e.ref));
      assert.equal(refs.size, 3, 'three transitions → three distinct refs, even at one shared ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a genuine retry — same previous, same record, same ts — still dedups to one event', () => {
    const root = tmp('health-ledger');
    try {
      const previous = { ts: '2026-01-01T00:00:00.000Z', ok: false };
      const record = { ts: '2026-01-01T00:00:00.500Z', ok: true, lastError: null };
      maybeAppendHealthLedger(root, previous, record);
      maybeAppendHealthLedger(root, previous, record); // exact same transition, retried
      const events = readEvents(root).filter(e => e.topic === HEALTH_TOPIC);
      assert.equal(events.length, 1, 'identical transition retried is still one event, not two');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── unit: writeHealth retry idempotency — the state-diff short-circuit, not ref dedup ───
describe('writeHealth — retrying the same outcome never double-appends', () => {
  it('two writeHealth calls with the same ok/lastError append the ledger event only once', () => {
    const root = tmp('health-retry');
    try {
      writeHealth(root, { ok: false, lastError: 'boom' });
      writeHealth(root, { ok: false, lastError: 'boom' }); // retry of the same failure
      const events = readEvents(root).filter(e => e.topic === HEALTH_TOPIC);
      // previous.ok === record.ok short-circuits maybeAppendHealthLedger BEFORE it even builds a
      // ref — writeHealth persists health.json before touching the ledger, so the second call
      // already sees the first call's outcome as `previous` and never reaches appendEvent at all.
      assert.equal(events.length, 1, 'retry of an unchanged outcome is a no-op on the ledger');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── unit: assessLiveness (pure) ───────────────────────────────

describe('assessLiveness', () => {
  const intervalSec = 1800;

  it('no health record → unknown, ageSec null', () => {
    assert.deepEqual(assessLiveness(null, { intervalSec, now: 1000 }), { state: 'unknown', ageSec: null });
  });

  it('unparsable ts → unknown, ageSec null (forward-compat: never throws on a bad/foreign record)', () => {
    assert.deepEqual(assessLiveness({ ts: 'not-a-date' }, { intervalSec, now: 1000 }), { state: 'unknown', ageSec: null });
  });

  it('fresh (well within 2x interval) → ok', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const ts = new Date(now - 60_000).toISOString(); // 60s old
    assert.deepEqual(assessLiveness({ ts }, { intervalSec, now }), { state: 'ok', ageSec: 60 });
  });

  it('right at the 2x-interval boundary → still ok', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const ts = new Date(now - intervalSec * 2 * 1000).toISOString();
    assert.deepEqual(assessLiveness({ ts }, { intervalSec, now }), { state: 'ok', ageSec: intervalSec * 2 });
  });

  it('older than 2x interval → stale', () => {
    const now = Date.parse('2026-07-27T12:00:00Z');
    const ts = new Date(now - (intervalSec * 2 + 1) * 1000).toISOString();
    assert.deepEqual(assessLiveness({ ts }, { intervalSec, now }), { state: 'stale', ageSec: intervalSec * 2 + 1 });
  });
});

// ─────────────────────────────── CLI integration: project writes health ───────────────────────

/** Minimal tmp OKF bundle — just enough for `samemind project --engine claude-code` to have a
 *  fact to project and a place to write CLAUDE.md. `home` is an empty tmp dir so the global
 *  ~/.samemind config tier is never read from/written to by the test. */
function makeBundle() {
  const root = tmp('project-bundle');
  const home = tmp('project-home');
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

describe('samemind project — writes health.json', () => {
  it('success: ok:true, targets recorded, version stamped', () => {
    const { root, home } = makeBundle();
    try {
      runProject(['--engine', 'claude-code'], root, home);
      const health = readHealth(root);
      assert.ok(health, 'health.json written');
      assert.equal(health.ok, true);
      assert.deepEqual(health.targets, ['claude-code']);
      assert.ok(health.version, 'version stamped from package.json');
      assert.equal(health.lastError, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('failure (unknown engine, real run — no --dry-run): ok:false + non-zero exit preserved', () => {
    const { root, home } = makeBundle();
    try {
      assert.throws(() => runProject(['--engine', 'not-a-real-engine'], root, home));
      let caught = null;
      try {
        runProject(['--engine', 'not-a-real-engine'], root, home);
      } catch (e) {
        caught = e;
      }
      assert.equal(caught.status, 1, 'exit code unchanged by the health wiring');
      assert.match(String(caught.stderr || ''), /unknown engine "not-a-real-engine"/);

      const health = readHealth(root);
      assert.ok(health, 'health.json written on failure too');
      assert.equal(health.ok, false);
      assert.match(health.lastError, /unknown engine "not-a-real-engine"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--dry-run never writes health.json — not a real run', () => {
    const { root, home } = makeBundle();
    try {
      runProject(['--engine', 'claude-code', '--dry-run'], root, home);
      assert.equal(existsSync(join(root, '.samemind', 'health.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a broken health write does not fail the run (health is secondary)', () => {
    const { root, home } = makeBundle();
    try {
      // .samemind as a plain FILE blocks the mkdir -p a health write needs — the run must still
      // succeed and still write CLAUDE.md.
      writeFileSync(join(root, '.samemind'), 'not a directory', 'utf8');
      const out = runProject(['--engine', 'claude-code'], root, home);
      assert.match(out, /✓ claude-code/, 'the actual project run still succeeded');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── CLI: samemind status ───────────────────────────────

function runStatus(args, root, home) {
  return execFileSync(process.execPath, [STATUS_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root, HOME: home },
    encoding: 'utf8',
  });
}

describe('samemind status — CLI', () => {
  it('no health yet → human message, exit 0', () => {
    const root = tmp('status-empty');
    const home = tmp('status-home');
    try {
      const out = runStatus([], root, home);
      assert.match(out, /has not run yet/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--json after a project run: valid contract:1 wrapper, state ok', () => {
    const { root, home } = makeBundle();
    try {
      runProject(['--engine', 'claude-code'], root, home);
      const parsed = JSON.parse(runStatus(['--json'], root, home));
      assert.equal(parsed.contract, 1);
      assert.equal(parsed.kind, 'status');
      assert.equal(parsed.data.state, 'ok');
      assert.equal(parsed.data.ok, true);
      assert.deepEqual(parsed.data.targets, ['claude-code']);
      assert.ok(Number.isFinite(parsed.data.ageSec));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('failed project run shows up as ok:false, not stale/unknown', () => {
    const { root, home } = makeBundle();
    try {
      try { runProject(['--engine', 'not-a-real-engine'], root, home); } catch { /* expected non-zero */ }
      const parsed = JSON.parse(runStatus(['--json'], root, home));
      // liveness = the heartbeat is fresh; state folds outcome in → a failed run is NOT a
      // silent green (that's the bug class this layer exists to kill).
      assert.equal(parsed.data.liveness, 'ok', 'fresh but failed run is still a live (recent) heartbeat');
      assert.equal(parsed.data.state, 'failed', 'a fresh-but-failed run must not display as ok');
      assert.equal(parsed.data.ok, false);
      assert.match(parsed.data.lastError, /unknown engine/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--root flag targets an explicit bundle root (no OKF_ROOT needed)', () => {
    const { root, home } = makeBundle();
    try {
      runProject(['--engine', 'claude-code'], root, home);
      const out = execFileSync(process.execPath, [STATUS_CLI, '--root', root, '--json'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      assert.equal(JSON.parse(out).data.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

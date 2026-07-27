// serviced.test.mjs — the Phase-4 daemon core, driven with a virtual clock and injected
// projection/stat/watch so every reliability property is checked without a real wait. Each test
// uses its own tmp OKF_ROOT (the daemon mkdir's .samemind there for the advisory lock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from './serviced.mjs';
import { readHealth } from './lib/health.mjs';

/** Virtual clock: setTimer/clearTimer register {fireAt, fn}; advance(ms) fires due timers in time
 *  order (timers scheduled during a callback are picked up on the next advance). No real time. */
function makeClock(start = 1_000_000) {
  let vnow = start;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => vnow,
    set: (fn, ms) => { const id = seq++; timers.set(id, { at: vnow + Math.max(0, ms | 0), fn }); return id; },
    clear: (id) => { timers.delete(id); },
    advance(ms) {
      const target = vnow + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) if (t.at <= target && (pick === null || t.at < pick.t.at)) pick = { id, t };
        if (!pick) break;
        timers.delete(pick.id);
        vnow = pick.t.at;
        pick.t.fn();
      }
      vnow = target;
    },
    size: () => timers.size,
  };
}

/** Injectable watcher that just hands the daemon's onEvent/onError back to the test to drive. */
function makeWatch() {
  const ref = {};
  const watch = (root, onEvent, onError) => {
    ref.onEvent = onEvent;
    ref.onError = onError;
    ref.closed = false;
    return { close() { ref.closed = true; }, mode: 'test' };
  };
  return { watch, ref };
}

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'serviced-'));
  test.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
  return root;
}

// Common builder: virtual clock + fake watch + a counting/controllable projection.
function harness(opts = {}) {
  const root = newRoot();
  const clock = makeClock();
  const { watch, ref } = makeWatch();
  const base = {
    root,
    intervalSec: 3600,          // backstop far away unless a test shortens it
    debounceMs: 1500,
    settleChecks: 0,            // skip settle unless a test opts in
    now: clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    random: () => 1,            // jitter = 1.25× — deterministic
    statFn: () => ({ size: 1, mtimeMs: 1 }),
    watch,
    log: () => {},
  };
  const daemon = createDaemon({ ...base, ...opts });
  daemon.start();
  return { root, clock, ref, daemon };
}

// 1. debounce coalesces N events into ONE run.
test('debounce coalesces a burst of events into a single projection', async () => {
  let calls = 0;
  const { clock, ref, daemon } = harness({ runProjection: async () => { calls++; } });

  ref.onEvent('concepts/a.md');
  ref.onEvent('concepts/b.md');
  ref.onEvent('concepts/c.md');
  clock.advance(1500);           // fire the (single, reset) debounce timer
  await daemon._current();

  assert.equal(calls, 1, 'three events within the debounce window => one run');
  assert.equal(daemon.getState().pending, 0, 'pending drained by the run');
});

// 2. stat-settle rejects a file that is still changing (partial write) — no projection.
test('stat-settle skips the run while a changed file is unstable', async () => {
  let calls = 0;
  let size = 0;
  const { clock, ref, daemon } = harness({
    settleChecks: 1,
    delay: () => Promise.resolve(),          // don't pump the clock for the settle window
    statFn: () => ({ size: ++size, mtimeMs: size }), // different every stat => never settles
    runProjection: async () => { calls++; },
  });

  ref.onEvent('concepts/a.md');
  clock.advance(1500);
  await daemon._current();

  assert.equal(calls, 0, 'unstable file must not be projected');
  assert.equal(daemon.getState().pending, 1, 'the change is requeued for a later re-check');
  assert.equal(daemon.getState().running, false);
});

// 3. backstop full-rescan catches a change the watcher never reported.
test('backstop runs a projection even with no fs event (dropped-event backstop)', async () => {
  let calls = 0;
  const { clock, daemon } = harness({ intervalSec: 10, runProjection: async () => { calls++; } });

  // No ref.onEvent — simulate fs.watch silently dropping the event. Only time passes.
  clock.advance(13_000);          // > 10s * 1.25 jitter
  await daemon._current();

  assert.equal(calls, 1, 'backstop projected without any watch event');
});

// 4. overlap-guard: a trigger during an in-flight run does not start a parallel run.
test('overlap-guard: second trigger is coalesced, not run in parallel', async () => {
  const gate = [];
  const runProjection = () => new Promise((res) => { gate.push(res); });
  const { clock, ref, daemon } = harness({ runProjection });

  ref.onEvent('concepts/a.md');
  clock.advance(1500);                 // start run #1 (now blocked on gate[0])
  await Promise.resolve();
  assert.equal(gate.length, 1, 'run #1 started');
  assert.equal(daemon.getState().running, true);

  ref.onEvent('concepts/b.md');
  clock.advance(1500);                 // trigger while run #1 is in flight
  await Promise.resolve();
  assert.equal(gate.length, 1, 'no parallel run started');

  gate[0]();                           // finish run #1
  await daemon._current();
  clock.advance(1);                    // fire the coalesced follow-up (scheduleRetry(0))
  await Promise.resolve();
  assert.equal(gate.length, 2, 'the remembered trigger ran exactly once, after #1');
  gate[1]();
  await daemon._current();
});

// 5. degrade after k consecutive failures: health ok:false, and NO hot-loop afterward.
test('degrades after k failures, writes health ok:false, stops auto-retrying', async () => {
  let calls = 0;
  const { root, clock, ref, daemon } = harness({
    degradeAfter: 3,
    backoffBaseMs: 10,
    backoffMaxMs: 1000,
    runProjection: async () => { calls++; throw new Error('boom'); },
  });

  ref.onEvent('concepts/a.md');
  clock.advance(1500); await daemon._current();   // fail 1 -> retry@10
  clock.advance(10);   await daemon._current();    // fail 2 -> retry@20
  clock.advance(20);   await daemon._current();    // fail 3 -> DEGRADE

  const st = daemon.getState();
  assert.equal(st.degraded, true);
  assert.equal(st.backoff, 3);
  assert.equal(calls, 3, 'exactly k attempts, no more');

  const health = readHealth(root);
  assert.equal(health.ok, false);
  assert.match(health.lastError, /degraded/i);

  // No hot-loop: advancing far past every backoff must NOT fire more runs (backstop is 3600s away).
  clock.advance(600_000); await daemon._current();
  assert.equal(calls, 3, 'degraded daemon does not keep hammering');
});

// 6. a clean run after degrade resets backoff/degraded (recovery on the next real change).
test('a clean run after degrade resets the failure state', async () => {
  let calls = 0;
  const { clock, ref, daemon } = harness({
    degradeAfter: 3,
    backoffBaseMs: 10,
    runProjection: async () => { calls++; if (calls <= 3) throw new Error('boom'); },
  });

  ref.onEvent('concepts/a.md');
  clock.advance(1500); await daemon._current();
  clock.advance(10);   await daemon._current();
  clock.advance(20);   await daemon._current();     // degraded after 3 fails
  assert.equal(daemon.getState().degraded, true);

  ref.onEvent('concepts/b.md');                      // a fresh change → recovery attempt
  clock.advance(1500); await daemon._current();      // run #4 succeeds

  const st = daemon.getState();
  assert.equal(st.degraded, false, 'clean run clears degraded');
  assert.equal(st.backoff, 0, 'clean run resets backoff');
  assert.equal(calls, 4);
});

// digest: the cold-start digest is refreshed after a SUCCESSFUL projection (seam 6), for the
// daemon's own root, and is injectable so this needs no real bundle render.
test('refreshes the cold-start digest after a successful projection', async () => {
  const digestRoots = [];
  const { root, clock, ref, daemon } = harness({
    runProjection: async () => {},
    writeDigest: (r) => { digestRoots.push(r); },
  });

  ref.onEvent('concepts/a.md');
  clock.advance(1500);
  await daemon._current();

  assert.deepEqual(digestRoots, [root], 'digest written once, for the daemon root, after the run');
});

// digest: a FAILED projection must not refresh the digest (it would ship a stale/empty snapshot).
test('does not write the digest when the projection fails', async () => {
  let digestCalls = 0;
  const { clock, ref, daemon } = harness({
    runProjection: async () => { throw new Error('boom'); },
    writeDigest: () => { digestCalls++; },
  });

  ref.onEvent('concepts/a.md');
  clock.advance(1500);
  await daemon._current();

  assert.equal(digestCalls, 0, 'a failed projection must not refresh the digest');
});

// clean shutdown tears down the watcher and flushes a final health record.
test('stop() closes the watcher and writes a final health record', async () => {
  const { root, ref, daemon } = harness({ runProjection: async () => {} });
  daemon.stop();
  assert.equal(ref.closed, true, 'watcher closed on stop');
  const health = readHealth(root);
  assert.equal(health.ok, true, 'final heartbeat written on clean stop');
});

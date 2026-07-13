// file-lock.mjs — zero-dep advisory lock for read-modify-write critical sections on a shared
// file (ledger append, inbox/concept append, concept frontmatter edit). Node's `fs.mkdirSync`
// is an atomic exclusive-create on every platform we run on (POSIX + Windows) — no `open(…, 'wx')`
// races, no npm dependency. The lock IS a directory `${targetPath}.lock`; a `holder.json` inside
// it records { pid, ts } for stale-lock diagnosis, but the mutex itself is the mkdir call, not
// the file inside it.
//
// Guarantees:
//  - Mutual exclusion between any two callers (same process or different processes) that lock
//    the same targetPath before touching it.
//  - Stale-lock takeover: if the holder's pid is dead (ESRCH) OR the lock is older than `staleMs`,
//    the next waiter removes it and retries — a crashed writer can never wedge a bundle forever.
//  - Bounded wait: `acquireLock` throws after `timeoutMs` of retrying, it never blocks forever.
//
// A subtle bug lived here during development, worth recording: the very first version called
// `rmSync(lockDir)` whenever `statSync(lockDir)` had just failed (lock "already gone" — the
// previous holder released a moment ago). That rmSync is pointless (there is nothing to
// remove) AND dangerous — between the failed `statSync` and the `rmSync` a THIRD process can
// legitimately `mkdirSync` a brand new, active lock at that same path; the delayed `rmSync`
// then deletes that active lock out from under its rightful holder, and two processes end up
// inside the critical section at once (a concurrent-write test caught this: 8×15 writes lost
// exactly 1 event, reproducibly, ~30% of runs). Fix: "gone" means retry `mkdirSync` directly,
// no removal call at all. For the genuinely-stale case (dead pid / too old — a REAL crash),
// the same class of race is narrowed (not eliminated — no plain POSIX primitive gives a true
// compare-and-delete on a directory) by re-reading the holder immediately before removing and
// aborting the takeover if it changed underneath us.
//
// NOT a distributed lock (single-machine only — pid liveness check assumes same host), not a
// read/write lock (it's exclusive-only, fine for our short critical sections), not a queue
// (no fairness guarantee across waiters — acceptable for this package's write volume).
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, statSync,
} from 'node:fs';

const DEFAULT_STALE_MS = 30_000; // a lock older than this with no live holder is abandoned
const DEFAULT_TIMEOUT_MS = 10_000; // give up waiting for the lock after this long
const MAX_BACKOFF_MS = 50;

function lockDirFor(targetPath) {
  return `${targetPath}.lock`;
}

/** Synchronous sleep with no dependency — Atomics.wait on a throwaway SharedArrayBuffer is a
 *  documented Node.js main-thread capability (unlike browsers, Node never disallowed it). */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH: no such process → dead. EPERM: exists but not ours → still alive.
    return e.code === 'EPERM';
  }
}

/** Reads `${lockDir}/holder.json` → { pid, ts } or null (missing/corrupt — never throws). */
function readHolder(lockDir) {
  try {
    const raw = readFileSync(`${lockDir}/holder.json`, 'utf8');
    const h = JSON.parse(raw);
    return (h && Number.isFinite(h.pid)) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Inspects the CURRENTLY EXISTING lock at `lockDir` (caller already knows it exists — we just
 * hit EEXIST trying to create it) and classifies it:
 *   'active' — a live holder, back off and retry later, do NOT touch it.
 *   'stale'  — dead pid or older than staleMs; caller should reclaim it (see reclaimStale).
 * Never returns for "already gone" — that is the caller's job to notice via ENOENT on stat.
 */
function classify(lockDir, staleMs) {
  const st = statSync(lockDir); // may throw ENOENT — caller decides what "gone" means
  const holder = readHolder(lockDir);
  if (holder && holder.pid !== process.pid && !isPidAlive(holder.pid)) return 'stale';
  if ((Date.now() - st.mtimeMs) > staleMs) return 'stale';
  return 'active';
}

/**
 * Reclaims a lock already classified 'stale'. Re-reads the holder ONE more time, immediately
 * before removing, and only removes if it still looks like the SAME abandoned lock (same pid,
 * or still too old) — this does not make the removal fully atomic (no plain fs primitive can,
 * for a directory), but it collapses the window between "decided stale" and "removed it" down
 * to a single stat+read+compare, closing the bug described in the module comment above for
 * everything except a reclaim racing another reclaim in a sub-millisecond window — accepted
 * for a single-machine dev tool (see docs/... reasoning in the module header).
 */
function reclaimStale(lockDir, staleMs) {
  let st;
  try {
    st = statSync(lockDir);
  } catch {
    return; // gone already — nothing to reclaim, caller's mkdir retry will just succeed
  }
  const holder = readHolder(lockDir);
  const stillDead = holder && holder.pid !== process.pid && !isPidAlive(holder.pid);
  const stillOld = (Date.now() - st.mtimeMs) > staleMs;
  if (!stillDead && !stillOld) return; // someone legitimately refreshed it — leave it alone
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced with another reclaimer, ignore */ }
}

/**
 * Acquires an exclusive lock on `targetPath` (a file this call's critical section will
 * read-modify-write). Blocks (busy-wait with capped backoff) until acquired, a stale lock is
 * reclaimed, or `timeoutMs` elapses (throws). Returns the lock directory path — pass it to
 * `releaseLock`.
 */
export function acquireLock(targetPath, { staleMs = DEFAULT_STALE_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lockDir = lockDirFor(targetPath);
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    try {
      mkdirSync(lockDir); // atomic: throws EEXIST if another holder already made this dir
      try {
        writeFileSync(`${lockDir}/holder.json`, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      } catch { /* best-effort diagnostics only — the mkdir above already IS the lock */ }
      return lockDir;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let verdict;
      try {
        verdict = classify(lockDir, staleMs);
      } catch {
        continue; // ENOENT — already gone: nothing to remove, just retry mkdir immediately
      }
      if (verdict === 'stale') {
        reclaimStale(lockDir, staleMs);
        continue; // retry mkdir immediately, no need to sleep
      }
      if (Date.now() >= deadline) {
        throw new Error(`file-lock: timed out after ${timeoutMs}ms waiting for lock on ${targetPath}`);
      }
      sleepSync(backoff);
      backoff = Math.min(backoff * 1.5, MAX_BACKOFF_MS);
    }
  }
}

/** Releases a lock previously returned by `acquireLock`. Idempotent, never throws. */
export function releaseLock(lockDir) {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Runs `fn` (sync) while holding an exclusive lock on `targetPath`. Always releases, even if
 * `fn` throws. This is the one entry point callers should use — read-modify-write a shared
 * file inside `fn`.
 */
export function withFileLock(targetPath, fn, opts) {
  const lockDir = acquireLock(targetPath, opts);
  try {
    return fn();
  } finally {
    releaseLock(lockDir);
  }
}

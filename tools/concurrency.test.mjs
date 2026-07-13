#!/usr/bin/env node
// concurrency.test.mjs — safe concurrent writes across a fleet of agents sharing one bundle.
//   node --test tools/concurrency.test.mjs
//
// Background: two write paths do read-modify-write on a shared file — appendEvent
// (tools/lib/ledger.mjs, ledger/events.jsonl) and memoryWriteInbox/appendInbox
// (tools/lib/mcp.mjs + tools/capture.mjs, inbox/<name>.md). A synchronous read-then-write
// with no lock is a classic lost-update race: two processes read the same "before" content,
// both compute "before + their own addition", the second atomic write wins and silently
// discards the first process's addition (the write itself never corrupts — rename is
// atomic — the LOSS is a clean overwrite of an earlier writer's entire contribution).
// Node's single-threaded event loop means this race is INVISIBLE to same-process async
// interleaving of synchronous functions — it only manifests across real OS processes, so
// every race assertion below spawns real `child_process` workers, not in-process promises.
//
// Fix: lib/file-lock.mjs — a zero-dep mkdir-based mutual-exclusion lock (mkdir is atomic on
// every platform we run on) with stale-lock takeover (dead pid, or too-old with no live
// holder) and a bounded wait. `withFileLock(targetPath, fn)` now wraps every read-modify-write
// critical section named above, keyed by the target file path itself.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { acquireLock, releaseLock, withFileLock } from '../lib/file-lock.mjs';
import { safeMdPath } from '../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_LIB = join(HERE, 'lib', 'ledger.mjs');
const MCP_LIB = join(HERE, 'lib', 'mcp.mjs');
const QUERY_CLI = join(HERE, 'okf-query.mjs');

const tmpRoots = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'samemind-concurrency-'));
  tmpRoots.push(r);
  return r;
}
after(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

/** Writes a small worker script to `dir` and returns its path. */
function writeWorker(dir, name, code) {
  const p = join(dir, name);
  writeFileSync(p, code);
  return p;
}

function spawnWorker(scriptPath, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`worker ${scriptPath} ${args.join(' ')} exited ${code}: ${stderr}`));
      else resolvePromise();
    });
    child.on('error', reject);
  });
}

function runCli(args, root) {
  const r = spawnSync(process.execPath, [QUERY_CLI, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

// ─────────────────────────── lib/file-lock.mjs — unit (in-process, deterministic) ───────────────────────────

describe('lib/file-lock.mjs — acquire/release', () => {
  it('acquires and releases; a second acquire after release succeeds immediately', () => {
    const root = freshRoot();
    const target = join(root, 'x.md');
    const lock = acquireLock(target);
    assert.ok(existsSync(lock), 'lock dir created');
    releaseLock(lock);
    assert.ok(!existsSync(lock), 'lock dir removed');
    const lock2 = acquireLock(target, { timeoutMs: 500 });
    assert.ok(existsSync(lock2));
    releaseLock(lock2);
  });

  it('a live holder blocks a second acquire until timeout (bounded wait, not a hang)', () => {
    const root = freshRoot();
    const target = join(root, 'y.md');
    const lock = acquireLock(target); // held by THIS process (definitely alive) — never stale
    const start = Date.now();
    assert.throws(
      () => acquireLock(target, { timeoutMs: 150, staleMs: 60_000 }),
      /timed out/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 140, `should have waited out the timeout (waited ${elapsed}ms)`);
    assert.ok(elapsed < 5000, `should not hang way past the timeout (waited ${elapsed}ms)`);
    releaseLock(lock);
  });

  it('withFileLock always releases, even when fn throws', () => {
    const root = freshRoot();
    const target = join(root, 'z.md');
    assert.throws(() => withFileLock(target, () => { throw new Error('boom'); }), /boom/);
    // lock must be gone — a fresh acquire should succeed immediately, not time out
    const lock = acquireLock(target, { timeoutMs: 200 });
    releaseLock(lock);
  });

  it('withFileLock serializes read-modify-write on a shared counter file (no lost updates)', () => {
    // The canonical concept-file race: read a value, transform it, write it back.
    // Run many times in a tight loop with a lock — must land on exactly N.
    const root = freshRoot();
    const target = join(root, 'counter.md');
    writeFileSync(target, '0');
    const N = 200;
    for (let i = 0; i < N; i++) {
      withFileLock(target, () => {
        const cur = parseInt(readFileSync(target, 'utf8'), 10);
        writeFileSync(target, String(cur + 1));
      });
    }
    assert.equal(readFileSync(target, 'utf8'), String(N));
  });
});

describe('lib/file-lock.mjs — stale-lock takeover', () => {
  it('a lock left behind by a dead process is reclaimed immediately (no waiting for staleMs)', async () => {
    const root = freshRoot();
    const target = join(root, 'dead-holder.md');
    const workerDir = freshRoot();
    const worker = writeWorker(workerDir, 'die-with-lock.mjs', `
      import { acquireLock } from ${JSON.stringify(join(HERE, '..', 'lib', 'file-lock.mjs'))};
      acquireLock(process.argv[2]);
      process.exit(0); // exits WITHOUT releasing — simulates a crash mid-critical-section
    `);
    await spawnWorker(worker, [target], {});
    // the child is confirmed exited (awaited) — its pid is dead, lock dir is left on disk
    const lockDir = `${target}.lock`;
    assert.ok(existsSync(lockDir), 'lock dir left behind by the dead worker');

    const start = Date.now();
    // staleMs is huge (60s) — if takeover required waiting it out, this test would time out /
    // take ~60s. Dead-pid detection must short-circuit that.
    const lock = acquireLock(target, { staleMs: 60_000, timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `dead-holder takeover should be near-instant (took ${elapsed}ms)`);
    releaseLock(lock);
  });

  it('an old lock with no readable holder info is reclaimed once past staleMs', () => {
    const root = freshRoot();
    const target = join(root, 'old-holder.md');
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir); // no holder.json — simulates disk state file-lock itself never wrote
    const oldTime = new Date(Date.now() - 3600_000); // 1h ago
    utimesSync(lockDir, oldTime, oldTime);

    const lock = acquireLock(target, { staleMs: 1000, timeoutMs: 2000 });
    assert.ok(existsSync(`${lockDir}/holder.json`), 'reclaimed lock now has our own holder info');
    releaseLock(lock);
  });
});

// ─────────────────────────── race: ledger append (N processes × M events) ───────────────────────────

describe('concurrent ledger append — no lost events, no corruption', () => {
  it('8 processes × 15 appends land all 120 events exactly once, file stays parseable', async () => {
    const root = freshRoot();
    const N = 8;
    const M = 15;
    const workerDir = freshRoot();
    const worker = writeWorker(workerDir, 'ledger-worker.mjs', `
      const { appendEvent } = await import(${JSON.stringify(LEDGER_LIB)});
      const [, , actor, countStr, root] = process.argv;
      const count = parseInt(countStr, 10);
      for (let i = 0; i < count; i++) {
        appendEvent(root, { actor, topic: 'race-test', phase: 'step', status: 'ok', action: 'w' + i, ref: actor + '-' + i });
      }
    `);
    const actors = Array.from({ length: N }, (_, i) => `agent-${i}`);
    await Promise.all(actors.map(actor => spawnWorker(worker, [actor, String(M), root], {})));

    const file = join(root, 'ledger', 'events.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());

    let parseErrors = 0;
    const seenRefs = new Set();
    const dupes = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (seenRefs.has(evt.ref)) dupes.push(evt.ref);
        seenRefs.add(evt.ref);
      } catch { parseErrors++; }
    }
    assert.equal(parseErrors, 0, 'every line must be valid JSON — never a torn/interleaved write');
    assert.equal(lines.length, N * M, `expected ${N * M} lines, got ${lines.length} (lost writes)`);
    assert.equal(dupes.length, 0, 'no ref should ever be written twice');
    for (const actor of actors) {
      for (let i = 0; i < M; i++) {
        assert.ok(seenRefs.has(`${actor}-${i}`), `missing event ${actor}-${i}`);
      }
    }
  });
});

// ─────────────────────────── race: concept/inbox write (memory_write_inbox) ───────────────────────────

describe('concurrent memory_write_inbox — no lost notes, no corruption', () => {
  it('8 processes × 15 writes to the SAME inbox/fleet.md all survive intact', async () => {
    const root = freshRoot();
    const N = 8;
    const M = 15;
    const workerDir = freshRoot();
    const worker = writeWorker(workerDir, 'inbox-worker.mjs', `
      const { callTool } = await import(${JSON.stringify(MCP_LIB)});
      const [, , actor, countStr] = process.argv;
      const count = parseInt(countStr, 10);
      for (let i = 0; i < count; i++) {
        const r = await callTool('memory_write_inbox', { title: actor + '-' + i, content: 'marker::' + actor + '::' + i });
        if (r.isError) { console.error(r.content[0].text); process.exit(1); }
      }
    `);
    const actors = Array.from({ length: N }, (_, i) => `agent-${i}`);
    // ALL workers write as the SAME agent name → all target the one file inbox/fleet.md —
    // the exact "flот пишет одновременно в один бандл" scenario from the naryad.
    await Promise.all(actors.map(actor => spawnWorker(worker, [actor, String(M)], {
      OKF_ROOT: root, SAMEMIND_AGENT: 'fleet',
    })));

    const file = join(root, 'inbox', 'fleet.md');
    const raw = readFileSync(file, 'utf8');
    const markerCounts = new Map();
    const re = /marker::(agent-\d+)::(\d+)/g;
    let m;
    while ((m = re.exec(raw))) {
      const key = `${m[1]}::${m[2]}`;
      markerCounts.set(key, (markerCounts.get(key) || 0) + 1);
    }
    for (const actor of actors) {
      for (let i = 0; i < M; i++) {
        const key = `${actor}::${i}`;
        assert.equal(markerCounts.get(key), 1, `marker ${key} should appear exactly once (missing = lost write, >1 = corruption)`);
      }
    }
    assert.equal(markerCounts.size, N * M);

    // headings must all be well-formed (no interleaved/torn blocks bleeding into each other)
    const headings = raw.split('\n').filter(l => l.startsWith('## '));
    assert.equal(headings.length, N * M);
  });

  it('memory_write_inbox and capture.mjs\'s appendInbox share one lock key for the same file', () => {
    // Both derive the target path the same way for the same name — safeMdPath(dir, 'x') must
    // equal join(dir, 'x.md') so the two independent write paths actually exclude each other
    // (verified by code path, cheap regression guard against the two diverging silently).
    const dir = freshRoot();
    assert.equal(safeMdPath(dir, 'some-engine'), join(dir, 'some-engine.md'));
  });
});

// ─────────────────────────── validate stays clean after the race ───────────────────────────

describe('bundle stays valid after concurrent writes', () => {
  it('okf-query validate exits 0 on a bundle that only received concurrent ledger/inbox writes', async () => {
    const root = freshRoot();
    const workerDir = freshRoot();
    const ledgerWorker = writeWorker(workerDir, 'ledger-worker2.mjs', `
      const { appendEvent } = await import(${JSON.stringify(LEDGER_LIB)});
      appendEvent(process.argv[2], { actor: process.argv[3], topic: 't', phase: 'step', action: 'a', ref: process.argv[3] });
    `);
    const inboxWorker = writeWorker(workerDir, 'inbox-worker2.mjs', `
      const { callTool } = await import(${JSON.stringify(MCP_LIB)});
      await callTool('memory_write_inbox', { content: 'hello from ' + process.argv[2] });
    `);
    const jobs = [];
    for (let i = 0; i < 6; i++) jobs.push(spawnWorker(ledgerWorker, [root, `a${i}`], {}));
    for (let i = 0; i < 6; i++) jobs.push(spawnWorker(inboxWorker, [`a${i}`], { OKF_ROOT: root, SAMEMIND_AGENT: 'fleet' }));
    await Promise.all(jobs);

    const { code, out } = runCli(['validate'], root);
    assert.equal(code, 0, `validate should exit clean: ${out}`);
    assert.match(out, /conformant/);
  });
});

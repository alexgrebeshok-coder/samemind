#!/usr/bin/env node
// mcp-probe.test.mjs — tests for the MCP proof-of-life probe (tools/lib/mcp-probe.mjs), node --test.
// Fixtures are short .mjs scripts written into a mkdtemp dir and spawned as real child processes —
// the probe must classify each one-shot server correctly AND never leave a process orphaned.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

import { probeMcpServer, killTree, PROBE_STATUS, liveProbeCount } from './lib/mcp-probe.mjs';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, 'mcp-server.mjs');

let FIX;
let EXIT3, NOISE, SILENT, STUBBORN, FAKE;

before(() => {
  FIX = mkdtempSync(join(tmpdir(), 'samemind-probe-fix-'));

  EXIT3 = join(FIX, 'exit3.mjs');
  writeFileSync(EXIT3, 'process.exit(3);\n');

  // prints a non-JSON banner to stdout, then hangs → not-jsonrpc (stdout present, zero frames)
  NOISE = join(FIX, 'noise.mjs');
  writeFileSync(NOISE, "process.stdout.write('BANNER garbage not a json frame\\n'); setInterval(() => {}, 1e9);\n");

  // totally silent hang → timeout (no stdout at all)
  SILENT = join(FIX, 'silent.mjs');
  writeFileSync(SILENT, 'setInterval(() => {}, 1e9);\n');

  // stubborn: ignores SIGTERM (so the SIGKILL escalation is what kills it) and spawns a grandchild
  // (same script, --child) that also ignores SIGTERM, holds the inherited pipes, and prints its pid
  // to stderr — proving npx-style grandchildren die with the group.
  STUBBORN = join(FIX, 'stubborn.mjs');
  writeFileSync(STUBBORN, [
    "import { spawn } from 'node:child_process';",
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    "if (process.argv.includes('--child')) {",
    "  process.stderr.write('GRANDCHILD_PID=' + process.pid + '\\n');",
    "} else {",
    "  const gc = spawn(process.execPath, [process.argv[1], '--child'], { stdio: 'inherit' });",
    "  gc.unref();",
    "}",
    'setInterval(() => {}, 1e9);',
  ].join('\n'));

  // a controllable fake JSON-RPC server: name / tools / handshake-error behaviour from env.
  FAKE = join(FIX, 'fake-server.mjs');
  writeFileSync(FAKE, [
    "import { createInterface } from 'node:readline';",
    "const NAME = process.env.SP_NAME || 'samemind';",
    "const TOOLS = JSON.parse(process.env.SP_TOOLS || '[\"memory_search\",\"memory_get\",\"memory_health\"]');",
    "const HS_ERR = process.env.SP_HANDSHAKE_ERROR === '1';",
    "const rl = createInterface({ input: process.stdin, terminal: false });",
    "function send(m){ process.stdout.write(JSON.stringify(m) + '\\n'); }",
    "rl.on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') {",
    "    if (HS_ERR) return send({ jsonrpc:'2.0', id:m.id, error:{ code:-32603, message:'boom' } });",
    "    send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2025-06-18', capabilities:{tools:{}}, serverInfo:{ name:NAME, version:'9.9.9' } } });",
    "  } else if (m.method === 'tools/list') {",
    "    send({ jsonrpc:'2.0', id:m.id, result:{ tools: TOOLS.map(name => ({ name, description:'x', inputSchema:{ type:'object', properties:{} } })) } });",
    "  } else if (m.method === 'tools/call') {",
    "    send({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:JSON.stringify({ concepts: 5 }) }] } });",
    "  }",
    "});",
    "rl.on('close', () => process.exit(0));",
  ].join('\n'));
});

after(() => {
  rmSync(FIX, { recursive: true, force: true });
});

/** Polls until `pid` is unreapable (ESRCH) or `timeoutMs` elapses — used to confirm the group kill. */
async function waitForDead(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') return; throw e; }
    if (performance.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await sleep(40);
  }
}

describe('mcp-probe — happy path on the real server', () => {
  it('real samemind server: ok, name samemind, core tools present, health.concepts > 0', async () => {
    const bundle = mkdtempSync(join(tmpdir(), 'sm-probe-bundle-'));
    try {
      assert.equal(runInit({ targetDir: bundle, demo: true }).ok, true);
      const r = await probeMcpServer({
        command: process.execPath, args: [MCP_SERVER],
        env: { OKF_ROOT: bundle, OKF_EMBED_URL: '', OKF_GLOBAL_ROOT: '' },
        timeoutMs: 20000,
      });
      assert.equal(r.status, PROBE_STATUS.OK, JSON.stringify(r));
      assert.equal(r.serverInfo.name, 'samemind');
      assert.equal(r.protocolSupported, true);
      for (const core of ['memory_search', 'memory_get', 'memory_health']) {
        assert.ok(r.tools.includes(core), `missing core tool ${core}: ${r.tools}`);
      }
      assert.ok(r.health && r.health.concepts > 0, `health.concepts not > 0: ${JSON.stringify(r.health)}`);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it('callHealth:false skips memory_health and still returns ok', async () => {
    const bundle = mkdtempSync(join(tmpdir(), 'sm-probe-bundle-'));
    try {
      runInit({ targetDir: bundle, demo: true });
      const r = await probeMcpServer({
        command: process.execPath, args: [MCP_SERVER],
        env: { OKF_ROOT: bundle, OKF_EMBED_URL: '', OKF_GLOBAL_ROOT: '' },
        callHealth: false, timeoutMs: 20000,
      });
      assert.equal(r.status, PROBE_STATUS.OK);
      assert.equal(r.health, null);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('mcp-probe — spawn failures', () => {
  it('nonexistent binary → spawn-failed, ENOENT, no throw', async () => {
    const r = await probeMcpServer({ command: '/no/such/binary/xyzzy', args: [], timeoutMs: 2000 });
    assert.equal(r.status, PROBE_STATUS.SPAWN_FAILED);
    assert.equal(r.spawnError.code, 'ENOENT');
  });

  it('injectable spawnImpl is called exactly once — a dead path spawns no retry storm', async () => {
  let calls = 0;
    const mockSpawn = () => {
      calls++;
      const fake = new EventEmitter();
      fake.stdin = new PassThrough();   // real streams — readline.createInterface needs a Readable
      fake.stdout = new PassThrough();
      fake.stderr = new PassThrough();
      fake.unref = () => {};
      fake.kill = () => {};
      fake.pid = 99999;
      setImmediate(() => fake.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return fake;
    };
    const r = await probeMcpServer({ command: 'whatever', spawnImpl: mockSpawn, timeoutMs: 1000 });
    assert.equal(r.status, PROBE_STATUS.SPAWN_FAILED);
    assert.equal(r.spawnError.code, 'ENOENT');
    assert.equal(calls, 1); // proves exactly one spawn, no retries/leaks on the dead path
    assert.equal(liveProbeCount(), 0);
  });
});

describe('mcp-probe — crash & hang classification', () => {
  it('child exits with code 3 before the handshake → crashed, exitCode 3', async () => {
    const r = await probeMcpServer({ command: process.execPath, args: [EXIT3], timeoutMs: 2000 });
    assert.equal(r.status, PROBE_STATUS.CRASHED);
    assert.equal(r.exitCode, 3);
  });

  it('stdout has non-RPC noise and hangs → not-jsonrpc + stdoutNoise', async () => {
    const r = await probeMcpServer({ command: process.execPath, args: [NOISE], timeoutMs: 300 });
    assert.equal(r.status, PROBE_STATUS.NOT_JSONRPC);
    assert.match(r.stdoutNoise, /BANNER garbage/);
  });

  it('silent hang with no stdout → timeout, fast (durationMs < 3000)', async () => {
    const r = await probeMcpServer({ command: process.execPath, args: [SILENT], timeoutMs: 300 });
    assert.equal(r.status, PROBE_STATUS.TIMEOUT);
    assert.ok(r.durationMs < 3000, `durationMs=${r.durationMs}`);
  });
});

// win32 has no negative-pid group signals; the stubborn-child proof is unix-only there.
const stubbornIt = process.platform === 'win32' ? it.skip : it;
describe('mcp-probe — process-group kill (stubborn child)', () => {
  stubbornIt('SIGTERM-ignoring child + grandchild: whole group dies, grandchild ESRCH', async () => {
    const r = await probeMcpServer({ command: process.execPath, args: [STUBBORN], timeoutMs: 1500 });
    const m = /GRANDCHILD_PID=(\d+)/.exec(r.stderrTail);
    assert.ok(m, `grandchild pid not captured in stderr: ${JSON.stringify(r.stderrTail)}`);
    const gpid = Number(m[1]);
    await waitForDead(gpid, 3000); // SIGTERM is ignored → SIGKILL (300ms grace) is what reaps it
    assert.throws(() => process.kill(gpid, 0), (e) => e.code === 'ESRCH');
  });
});

describe('mcp-probe — handshake classification', () => {
  it('valid handshake but serverInfo.name=other → not-samemind', async () => {
    const r = await probeMcpServer({
      command: process.execPath, args: [FAKE], env: { SP_NAME: 'other' }, timeoutMs: 2000,
    });
    assert.equal(r.status, PROBE_STATUS.NOT_SAMEMIND);
    assert.equal(r.serverInfo.name, 'other');
  });

  it('valid handshake but tools=[] → no-tools, missingCore = all three', async () => {
    const r = await probeMcpServer({
      command: process.execPath, args: [FAKE], env: { SP_TOOLS: '[]' }, timeoutMs: 2000,
    });
    assert.equal(r.status, PROBE_STATUS.NO_TOOLS);
    assert.deepEqual([...r.missingCore].sort(), ['memory_get', 'memory_health', 'memory_search']);
  });

  it('initialize returns a JSON-RPC error → handshake-error', async () => {
    const r = await probeMcpServer({
      command: process.execPath, args: [FAKE], env: { SP_HANDSHAKE_ERROR: '1' }, timeoutMs: 2000,
    });
    assert.equal(r.status, PROBE_STATUS.HANDSHAKE_ERROR);
  });
});

describe('mcp-probe — no orphans', () => {
  it('LIVE is empty after each probe of every kind', async () => {
    const cases = [
      { command: process.execPath, args: [SILENT], timeoutMs: 300 },                 // timeout
      { command: process.execPath, args: [NOISE], timeoutMs: 300 },                  // not-jsonrpc
      { command: process.execPath, args: [EXIT3], timeoutMs: 2000 },                 // crashed
      { command: '/no/such/binary/xyzzy', timeoutMs: 1000 },                         // spawn-failed
      { command: process.execPath, args: [FAKE], env: { SP_NAME: 'other' }, timeoutMs: 2000 }, // not-samemind
    ];
    for (const cfg of cases) {
      await probeMcpServer(cfg);
      assert.equal(liveProbeCount(), 0, `LIVE not empty after ${cfg.command} ${JSON.stringify(cfg.args)}`);
    }
  });

  it('killTree on an already-dead / null child does not throw', () => {
    assert.doesNotThrow(() => killTree(null));
    const dead = new EventEmitter();
    dead.stdin = { end() {} };
    dead.kill = () => {};
    dead.pid = 99999;
    assert.doesNotThrow(() => killTree(dead)); // 99999 not alive → ESRCH path, swallowed
  });
});

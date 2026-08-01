// mcp-probe.mjs — proof-of-life probe for a configured MCP server.
//
// The defect this exists to close: writing a server into a config file is treated as "connected".
// That is a lie. The server may not start, may crash, may hang, or may advertise the wrong tools —
// and the user only finds out through broken work. probeMcpServer drives the real handshake the way
// a client would (initialize → initialized → tools/list → memory_health) and returns a *classified*
// result, turning "it hangs" into an exact diagnosis.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio. Protocol versions come from mcp.mjs, not
// hardcoded here. Reference shape (NOT copyable — it has no timeout): tools/mcp.test.mjs startClient.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION,
} from './mcp.mjs';

export const PROBE_STATUS = Object.freeze({
  OK: 'ok',
  SPAWN_FAILED: 'spawn-failed',
  CRASHED: 'crashed',
  NOT_JSONRPC: 'not-jsonrpc',
  HANDSHAKE_ERROR: 'handshake-error',
  NOT_SAMEMIND: 'not-samemind',
  NO_TOOLS: 'no-tools',
  TIMEOUT: 'timeout',
});

// Core tools every samemind server must serve — NOT all ten: a legitimately older server with the
// core three is healthy; a gap among the other seven is a finding, not a failure.
const CORE_TOOLS = ['memory_search', 'memory_get', 'memory_health'];
const MAX_STDOUT_BYTES = 1 << 20;   // 1 MiB cap — a runaway child must not bloat doctor's memory
const STDERR_TAIL_BYTES = 2048;     // sliding tail
const NOISE_MAX_LINES = 64;
const SIGKILL_DELAY_MS = 300;
const IS_WIN = process.platform === 'win32';

// Live children across all probes. A Ctrl-C or crash in doctor must not leave an MCP server
// orphaned, so every spawned child is tracked and the process-exit hook reaps the lot.
const LIVE = new Set();
process.once('exit', () => {
  for (const child of LIVE) {
    if (child.pid != null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ } }
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

/** Number of probe-spawned children still alive — must be 0 after every probe. */
export function liveProbeCount() { return LIVE.size; }

/**
 * Kill a probe child and its whole process group. The hard part of this module: the command is
 * often `npx samemind serve`, where npx is the child and node is the GRANDCHILD holding the pipes,
 * so killing only the child leaves a live orphan. Order matters:
 *   1) close stdin — our own server exits on stdin close (mcp-server.mjs rl.on('close') → exit(0));
 *   2) SIGTERM the process group via -pid (child was spawned detached, so it leads the group);
 *   3) SIGKILL the group after a short grace; ESRCH means already gone → fall back to child.kill.
 * On win32 there are no negative-pid signal semantics, so the group kill is `taskkill /T /F`.
 */
export function killTree(child) {
  if (!child) return;
  LIVE.delete(child);
  try { child.stdin && child.stdin.end(); } catch { /* stdin already closed */ }

  if (IS_WIN) {
    if (child.pid != null) {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    try { child.kill(); } catch { /* already dead */ }
    return;
  }

  const pid = child.pid;
  if (pid == null) { try { child.kill(); } catch { /* no pid */ } return; }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (e) {
    if (e.code !== 'ESRCH') { try { child.kill('SIGTERM'); } catch { /* best effort */ } }
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e) {
      if (e.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
    }
  }, SIGKILL_DELAY_MS);
  if (typeof killer.unref === 'function') killer.unref(); // never let a lingering killer block doctor's exit
  try { child.unref(); } catch { /* already unref'd */ }
}

/**
 * Probes an MCP server over stdio JSON-RPC: initialize → notifications/initialized → tools/list →
 * (optional) tools/call memory_health, then kills the child. ONE shared deadline governs the whole
 * sequence — a hang anywhere is reported as the precise failure it is, never left as a mystery.
 *
 * `spawnImpl` (default: node's spawn) is injectable so a test can prove spawn behaviour without a
 * real process — e.g. that a dead path produces spawn-failed with exactly one spawn attempt.
 */
export async function probeMcpServer({
  command, args = [], env = {}, cwd = homedir(),
  timeoutMs = 10000, callHealth = true, spawnImpl = spawn,
}) {
  const start = performance.now();
  const out = {
    status: null, durationMs: 0, protocolVersion: null, protocolSupported: false,
    serverInfo: null, tools: null, missingCore: [], health: null,
    exitCode: null, signal: null, spawnError: null, stdoutNoise: '', stderrTail: '',
  };

  let stdoutBytes = 0;
  let framesParsed = 0;
  let stderrTail = '';
  const noiseLines = [];
  const pending = new Map();
  let nextId = 1;
  let child = null;
  let done = false;
  let resolveOuter;

  const deadline = setTimeout(() => {
    // The whole sequence hung. Classify it precisely: stdout-but-no-parsable-frame = not-jsonrpc
    // (an engine banner-printing into stdout); otherwise a silent hang = timeout. That split is the
    // most valuable thing this probe does — it turns "it hangs" into an exact diagnosis.
    if (framesParsed === 0 && stdoutBytes > 0) finish(PROBE_STATUS.NOT_JSONRPC);
    else finish(PROBE_STATUS.TIMEOUT);
  }, timeoutMs);

  function finish(status, extra) {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    out.status = status;
    out.durationMs = Math.round(performance.now() - start);
    out.stderrTail = stderrTail;
    out.stdoutNoise = noiseLines.join('\n');
    if (extra) Object.assign(out, extra);
    killTree(child);
    resolveOuter(out);
  }

  return new Promise((resolve) => {
    resolveOuter = resolve;
    try {
      child = spawnImpl(command, args, {
        env: { ...process.env, ...env },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !IS_WIN, // child leads its own process group → -pid kills npx AND its grandchildren
      });
    } catch (e) {
      clearTimeout(deadline);
      out.durationMs = Math.round(performance.now() - start);
      out.status = PROBE_STATUS.SPAWN_FAILED;
      out.spawnError = { message: e.message, code: e.code, syscall: e.syscall };
      resolve(out);
      return;
    }
    LIVE.add(child);

    // ENOENT/EACCES arrive as an 'error' EVENT, not a throw — that is why this uses spawn, not
    // spawnSync. A missing binary therefore becomes spawn-failed, never an uncaught exception.
    child.on('error', (e) => {
      finish(PROBE_STATUS.SPAWN_FAILED, {
        spawnError: { message: e.message, code: e.code, syscall: e.syscall },
      });
    });
    child.on('exit', (code, signal) => {
      // Exit before the handshake completed = the server crashed. A clean exit after killTree is
      // already guarded by `done` (killTree runs inside finish, which sets done before the exit lands).
      if (!done) finish(PROBE_STATUS.CRASHED, { exitCode: code, signal });
    });

    const writeLine = (line) => { try { child.stdin.write(`${line}\n`); } catch { /* pipe closed */ } };
    const request = (method, params) => {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    };
    const notify = (method, params) => writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));

    // Count raw bytes separately from line parsing so "noise with no trailing newline" still reads
    // as not-jsonrpc rather than a silent timeout.
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) { try { child.stdout.destroy(); } catch { /* capped */ } }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_BYTES);
    });
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch {
        if (noiseLines.length < NOISE_MAX_LINES) noiseLines.push(line.slice(0, 512));
        return;
      }
      framesParsed++;
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });

    try { child.unref(); } catch { /* already unref'd */ }

    // The handshake as a then-chain — never a blocking await, so no step can outlive `done` and
    // leave a dangling promise when the deadline fires.
    request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'samemind-probe', version: '0.0.0' },
    }).then((msg) => {
      if (done) return;
      if (msg && msg.error) return finish(PROBE_STATUS.HANDSHAKE_ERROR);
      const r = (msg && msg.result) || {};
      out.protocolVersion = r.protocolVersion || null;
      out.protocolSupported = SUPPORTED_PROTOCOL_VERSIONS.includes(r.protocolVersion);
      out.serverInfo = r.serverInfo || null;
      if ((r.serverInfo && r.serverInfo.name) !== 'samemind') return finish(PROBE_STATUS.NOT_SAMEMIND);
      notify('notifications/initialized', {});
      request('tools/list', {}).then((tmsg) => {
        if (done) return;
        const tools = (tmsg && tmsg.result && tmsg.result.tools) || [];
        out.tools = tools.map((t) => t.name);
        out.missingCore = CORE_TOOLS.filter((c) => !tools.some((t) => t.name === c));
        if (out.missingCore.length > 0) return finish(PROBE_STATUS.NO_TOOLS);
        if (!callHealth) return finish(PROBE_STATUS.OK);
        request('tools/call', { name: 'memory_health', arguments: {} }).then((hmsg) => {
          if (done) return;
          try {
            const text = hmsg && hmsg.result && hmsg.result.content && hmsg.result.content[0] && hmsg.result.content[0].text;
            out.health = text ? JSON.parse(text) : null;
          } catch { out.health = null; }
          finish(PROBE_STATUS.OK);
        });
      });
    });
  });
}

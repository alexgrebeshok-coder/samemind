#!/usr/bin/env node
// contract-shape.test.mjs — frozen top-level `data` keys per JSON contract surface (sm10).
// Values drift; shape does not. Renaming a field here must fail the suite.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createUiServer } from './lib/ui-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, '..', 'demo');
const STATUS_CLI = join(HERE, 'status.mjs');
const FLEET_CLI = join(HERE, 'fleet.mjs');
const LEDGER_CLI = join(HERE, 'ledger.mjs');
const OKF_QUERY_CLI = join(HERE, 'okf-query.mjs');
const PROACTIVE_CLI = join(HERE, 'proactive.mjs');

const BOARD_KEYS = [
  'nowMs', 'doneLimit', 'recentDays', 'project',
  'backlog', 'inprog', 'blocked', 'done', 'plans',
  'ideaIncubating', 'ideaSpark', 'ideaAdopted', 'ideasVisible',
  'recent', 'sessions',
  'openFailuresShown', 'openFailuresTotal',
  'overdueEnginesShown', 'overdueEnginesTotal',
  'ledgerOverflow', 'columnTotals',
];
const HANDOFF_KEYS = [
  'projectKey', 'dayWindow', 'active', 'recentDecisions', 'plansInForce',
  'lastSession', 'blocked', 'sessionNext', 'nowMs',
];
// `node` and `platform` were deliberately dropped before the freeze: a contract that carries the
// runtime version invites consumers to match on it, and then we cannot change it. They remain in
// doctor's human output, which is not frozen.
const DOCTOR_KEYS = [
  'ok', 'version', 'root', 'active', 'engines', 'consistency', 'summary', 'findings',
];
const FLEET_KEYS = ['engines', 'stopPoints'];
const FLEET_ENGINE_KEYS = ['id', 'role', 'status', 'lastSeen', 'silentSec', 'heartbeatSec', 'overdue'];
const LEDGER_KEYS = ['topics', 'openFailures'];
const LEDGER_TOPIC_KEYS = ['topic', 'last', 'count', 'openFail', 'evs'];
const LINKS_KEYS = ['nodes', 'edges', 'orphans', 'broken', 'mdEdges', 'relCount', 'supersedeCount', 'totalEdges'];
const HEALTH_KEYS = ['root', 'concepts', 'version', 'searchMode'];
const STATUS_KEYS = ['state', 'liveness', 'ageSec', 'ok', 'lastError', 'targets', 'version', 'ts'];
const SETTINGS_KEYS = ['root', 'configPath', 'globalConfigPath', 'features'];
const SETTINGS_FEATURE_KEYS = ['values', 'layers', 'state', 'available'];
const VOICE_PROBE_KEYS = ['state', 'available', 'url', 'probe'];
const VOICE_ROUTE_KEYS = ['intent', 'action', 'confidence', 'ref', 'slots', 'missing', 'say', 'threshold', 'quarantine'];
const CONCEPT_ROW_KEYS = ['id', 'title', 'type', 'tags', 'status', 'date'];
const CONCEPT_DETAIL_KEYS = ['id', 'frontmatter', 'body'];
const LEDGER_EVENT_KEYS = ['ts', 'actor', 'topic', 'phase', 'status', 'action', 'artifact', 'ref', 'quarantine', 'matches'];
const PROACTIVE_KEYS = ['skipped', 'reason', 'query', 'hits', 'pack', 'tokens', 'chars', 'latencyMs', 'manualRecallsSaved'];

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`)); }

function assertEnvelope(json, kind) {
  assert.equal(json.contract, 1);
  assert.equal(json.kind, kind);
  assert.ok(json.generatedAt, `${kind}: missing generatedAt`);
  assert.ok(!Number.isNaN(Date.parse(json.generatedAt)), `${kind}: generatedAt not ISO`);
  assert.ok(json.data !== undefined && typeof json.data === 'object', `${kind}: missing data`);
}

function assertKeys(obj, keys, label) {
  for (const k of keys) {
    assert.ok(k in obj, `${label} data missing key "${k}"`);
  }
}

function listen(opts) {
  return new Promise((resolvePromise, reject) => {
    const server = createUiServer(opts);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function request(port, path, { method = 'GET', body, host } = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = host ? { Host: host } : {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
      headers.Origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path, method, headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postConfig(port, body = '{}') {
  return new Promise((resolve) => {
    const lines = [
      'POST /api/config HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      `Origin: http://127.0.0.1:${port}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ];
    const c = net.connect(port, '127.0.0.1', () => c.write(lines.join('\r\n')));
    let data = '';
    c.on('data', (d) => { data += d; });
    c.on('close', () => {
      const sep = data.indexOf('\r\n\r\n');
      const rawBody = sep >= 0 ? data.slice(sep + 4) : '';
      resolve({ status: Number(data.split('\r\n')[0].split(' ')[1]), body: rawBody });
    });
  });
}

function sseConnect(port, path) {
  const req = http.request({
    hostname: '127.0.0.1', port, path, method: 'GET',
  });
  const state = { status: null, buf: '', events: [] };
  const ready = new Promise((resolvePromise, reject) => {
    req.on('response', (res) => {
      state.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        state.buf += chunk;
        let idx;
        while ((idx = state.buf.indexOf('\n\n')) !== -1) {
          const raw = state.buf.slice(0, idx);
          state.buf = state.buf.slice(idx + 2);
          if (!raw.trim() || raw.startsWith(':')) continue;
          const lines = raw.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event: '));
          const dataLine = lines.find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          state.events.push({
            event: eventLine ? eventLine.slice(7) : 'message',
            data: JSON.parse(dataLine.slice(6)),
          });
        }
      });
      resolvePromise(res);
    });
    req.on('error', reject);
  });
  req.end();
  return { req, state, ready };
}

async function waitForSse(state, predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = state.events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for SSE event, got: ${JSON.stringify(state.events)}`);
}

// ─────────────────────────────── HTTP: demo bundle ───────────────────────────────

describe('contract shape — HTTP (demo bundle)', () => {
  let server, port;

  before(async () => {
    server = await listen({ root: DEMO, distDir: null });
    port = server.address().port;
  });
  after(() => server.close());

  it('GET /api/board → board data keys', async () => {
    const r = await request(port, '/api/board');
    const json = JSON.parse(r.body);
    assertEnvelope(json, 'board');
    assertKeys(json.data, BOARD_KEYS, 'board');
    assert.ok(!('byId' in json.data), 'board wire must omit byId');
  });

  it('GET /api/handoff → handoff data keys', async () => {
    const json = JSON.parse((await request(port, '/api/handoff')).body);
    assertEnvelope(json, 'handoff');
    assertKeys(json.data, HANDOFF_KEYS, 'handoff');
  });

  it('GET /api/doctor → doctor data keys', async () => {
    const json = JSON.parse((await request(port, '/api/doctor')).body);
    assertEnvelope(json, 'doctor');
    assertKeys(json.data, DOCTOR_KEYS, 'doctor');
  });

  it('GET /api/fleet → fleet data keys', async () => {
    const json = JSON.parse((await request(port, '/api/fleet')).body);
    assertEnvelope(json, 'fleet');
    assertKeys(json.data, FLEET_KEYS, 'fleet');
    if (json.data.engines.length) assertKeys(json.data.engines[0], FLEET_ENGINE_KEYS, 'fleet.engine');
  });

  it('GET /api/ledger → ledger data keys', async () => {
    const json = JSON.parse((await request(port, '/api/ledger')).body);
    assertEnvelope(json, 'ledger');
    assertKeys(json.data, LEDGER_KEYS, 'ledger');
    if (json.data.topics.length) assertKeys(json.data.topics[0], LEDGER_TOPIC_KEYS, 'ledger.topic');
  });

  it('GET /api/graph → links data keys', async () => {
    const json = JSON.parse((await request(port, '/api/graph')).body);
    assertEnvelope(json, 'links');
    assertKeys(json.data, LINKS_KEYS, 'links');
  });

  it('GET /api/health → health data keys', async () => {
    const json = JSON.parse((await request(port, '/api/health')).body);
    assertEnvelope(json, 'health');
    assertKeys(json.data, HEALTH_KEYS, 'health');
  });

  it('GET /api/status → status data keys', async () => {
    const json = JSON.parse((await request(port, '/api/status')).body);
    assertEnvelope(json, 'status');
    assertKeys(json.data, STATUS_KEYS, 'status');
  });

  it('GET /api/settings → settings data keys', async () => {
    const json = JSON.parse((await request(port, '/api/settings')).body);
    assertEnvelope(json, 'settings');
    assertKeys(json.data, SETTINGS_KEYS, 'settings');
    assertKeys(json.data.features.voice, SETTINGS_FEATURE_KEYS, 'settings.features.voice');
    assertKeys(json.data.features.vision, SETTINGS_FEATURE_KEYS, 'settings.features.vision');
  });

  it('GET /api/voice/probe → voice-probe data keys', async () => {
    const json = JSON.parse((await request(port, '/api/voice/probe')).body);
    assertEnvelope(json, 'voice-probe');
    assertKeys(json.data, VOICE_PROBE_KEYS, 'voice-probe');
  });

  it('GET /api/voice/route → voice-route data keys', async () => {
    const json = JSON.parse((await request(port, '/api/voice/route?text=hello&confidence=0.9')).body);
    assertEnvelope(json, 'voice-route');
    assertKeys(json.data, VOICE_ROUTE_KEYS, 'voice-route');
  });

  it('GET /api/concepts → concepts list row keys', async () => {
    const json = JSON.parse((await request(port, '/api/concepts')).body);
    assertEnvelope(json, 'concepts');
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.length > 0, 'demo bundle should have concepts');
    assertKeys(json.data[0], CONCEPT_ROW_KEYS, 'concepts[]');
  });

  it('GET /api/concept/<id> → concept detail keys', async () => {
    const list = JSON.parse((await request(port, '/api/concepts')).body).data;
    const id = list[0].id;
    const json = JSON.parse((await request(port, `/api/concept/${id}`)).body);
    assertEnvelope(json, 'concept');
    assertKeys(json.data, CONCEPT_DETAIL_KEYS, 'concept');
  });

});

// The only write in this file gets its own throwaway bundle. Aimed at `demo/`, it left a
// `demo/.samemind/config.json` behind on every run — and `demo/` ships in the tarball, so the
// fixture would drift into the package carrying settings nobody chose. A write test must never
// point at data that is read by anything else.
describe('contract shape — POST /api/config (throwaway bundle)', () => {
  let dir, server, port;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cshape-write-'));
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    writeFileSync(join(dir, 'index.md'), '# bundle\n', 'utf8');
    server = await listen({ root: dir, distDir: null });
    port = server.address().port;
  });
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('POST /api/config → settings-shaped response body', async () => {
    const r = await postConfig(port, JSON.stringify({ voice: { enabled: false } }));
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assertEnvelope(json, 'settings');
    assertKeys(json.data, SETTINGS_KEYS, 'POST /api/config');
  });
});

// ─────────────────────────────── SSE envelopes ───────────────────────────────

describe('contract shape — SSE ledger stream', () => {
  let dir, server, port;

  before(async () => {
    dir = tmp('shape-sse');
    mkdirSync(join(dir, 'ledger'), { recursive: true });
    writeFileSync(join(dir, 'ledger', 'events.jsonl'), `${JSON.stringify({
      ts: '2026-07-26T00:00:00.000Z', actor: 'test', topic: 'shape-fixture', phase: 'start',
      status: 'ok', action: 'seed', artifact: null, ref: null, quarantine: false, matches: [],
    })}\n`);
    server = await listen({ root: dir, distDir: null });
    port = server.address().port;
  });
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('ledger-snapshot → events array on data', async () => {
    const conn = sseConnect(port, '/api/events/stream');
    await conn.ready;
    const snap = await waitForSse(conn.state, (e) => e.event === 'snapshot');
    assertEnvelope(snap.data, 'ledger-snapshot');
    assert.ok(Array.isArray(snap.data.data.events), 'ledger-snapshot.data.events');
    if (snap.data.data.events.length) assertKeys(snap.data.data.events[0], LEDGER_EVENT_KEYS, 'ledger-snapshot.event');
    conn.req.destroy();
  });

  it('ledger-event → single event keys on data', async () => {
    const conn = sseConnect(port, '/api/events/stream');
    await conn.ready;
    await waitForSse(conn.state, (e) => e.event === 'snapshot');
    appendFileSync(join(dir, 'ledger', 'events.jsonl'), `${JSON.stringify({
      ts: '2026-07-26T00:01:00.000Z', actor: 'test', topic: 'shape-live', phase: 'step',
      status: 'ok', action: 'live', artifact: null, ref: null, quarantine: false, matches: [],
    })}\n`);
    const ev = await waitForSse(conn.state, (e) => e.event === 'event' && e.data.data?.topic === 'shape-live', 8000);
    assertEnvelope(ev.data, 'ledger-event');
    assertKeys(ev.data.data, LEDGER_EVENT_KEYS, 'ledger-event');
    conn.req.destroy();
  });
});

// ─────────────────────────────── CLI envelopes (generatedAt parity) ───────────────────────────────

describe('contract shape — CLI --json', () => {
  it('samemind status --json → status data keys + generatedAt', () => {
    const r = spawnSync(process.execPath, [STATUS_CLI, '--root', DEMO, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'status --json: one line');
    const json = JSON.parse(lines[0]);
    assertEnvelope(json, 'status');
    assertKeys(json.data, STATUS_KEYS, 'status');
  });

  it('samemind fleet status --json → fleet data keys + generatedAt', () => {
    const r = spawnSync(process.execPath, [FLEET_CLI, 'status', '--json'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout.trim());
    assertEnvelope(json, 'fleet');
    assertKeys(json.data, FLEET_KEYS, 'fleet');
  });

  it('samemind ledger status --json → ledger data keys + generatedAt', () => {
    const r = spawnSync(process.execPath, [LEDGER_CLI, 'status', '--json'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout.trim());
    assertEnvelope(json, 'ledger');
    assertKeys(json.data, LEDGER_KEYS, 'ledger');
    if (json.data.topics.length) assertKeys(json.data.topics[0], LEDGER_TOPIC_KEYS, 'ledger.topic');
  });

  it('okf-query links --json → links data keys + generatedAt', () => {
    const r = spawnSync(process.execPath, [OKF_QUERY_CLI, 'links', '--json'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'links --json: one line');
    const json = JSON.parse(lines[0]);
    assertEnvelope(json, 'links');
    assertKeys(json.data, LINKS_KEYS, 'links');
  });

  it('proactive --json → proactive envelope + data keys', () => {
    const r = spawnSync(process.execPath, [PROACTIVE_CLI, 'что по lumen проекту', '--json', '--force'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'proactive --json: one line');
    const json = JSON.parse(lines[0]);
    assertEnvelope(json, 'proactive');
    assertKeys(json.data, PROACTIVE_KEYS, 'proactive');
  });
});

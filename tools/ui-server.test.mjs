#!/usr/bin/env node
// ui-server.test.mjs — samemind ui: local read-only HTTP dashboard (tools/lib/ui-server.mjs).
//   node --test tools/ui-server.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createUiServer } from './lib/ui-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, '..', 'demo');

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`)); }

/** Starts a server on an ephemeral port, resolves once it's listening. */
function listen(opts) {
  return new Promise((resolvePromise, reject) => {
    const server = createUiServer(opts);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function request(port, path, { method = 'GET', host } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: host ? { Host: host } : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────── demo bundle: every endpoint ───────────────────────────────

describe('createUiServer — demo bundle endpoints', () => {
  let server, port;

  before(async () => {
    server = await listen({ root: DEMO, distDir: null });
    port = server.address().port;
  });
  after(() => server.close());

  const cases = [
    ['/api/health', 'health'],
    ['/api/status', 'status'],
    ['/api/doctor', 'doctor'],
    ['/api/board', 'board'],
    ['/api/handoff', 'handoff'],
    ['/api/fleet', 'fleet'],
    ['/api/ledger', 'ledger'],
    ['/api/concepts', 'concepts'],
    ['/api/graph', 'links'],
  ];

  for (const [path, kind] of cases) {
    it(`GET ${path} → contract:1, kind:${kind}`, async () => {
      const r = await request(port, path);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      assert.ok(!r.body.includes('\n'), 'body should be one-line JSON');
      const json = JSON.parse(r.body);
      assert.equal(json.contract, 1);
      assert.equal(json.kind, kind);
      assert.ok(json.generatedAt);
      assert.ok('data' in json);
    });
  }

  it('GET /api/health reports demo bundle root/version/searchMode', async () => {
    const r = await request(port, '/api/health');
    const { data } = JSON.parse(r.body);
    assert.equal(data.root, DEMO);
    assert.equal(data.searchMode, 'bm25');
    assert.ok(data.concepts > 0);
    assert.ok(typeof data.version === 'string' && data.version.length > 0);
  });

  it('GET /api/graph resolves edges against the server\'s own root, not OKF_ROOT (regression: ' +
     'buildLinksModel used to resolve links/relations against the module-level ROOT in okf.mjs, ' +
     'so a bundle passed only via --root/{root} came back with 0 edges and every link "broken")', async () => {
    const r = await request(port, '/api/graph');
    const { data } = JSON.parse(r.body);
    assert.ok(data.edges.length > 0, `expected resolved edges against DEMO root, got 0 (broken: ${JSON.stringify(data.broken)})`);
    assert.equal(data.broken.length, 0, `expected no broken edges, got: ${JSON.stringify(data.broken)}`);
  });

  it('GET /api/board carries the demo fixture\'s non-empty failures/overdue (docs/ui-spec.md)', async () => {
    const r = await request(port, '/api/board');
    const { data } = JSON.parse(r.body);
    assert.ok(data.openFailuresTotal >= 1);
    assert.ok(Array.isArray(data.overdueEnginesShown));
  });

  it('GET /api/board omits byId (Map would JSON as {} and mislead consumers)', async () => {
    const r = await request(port, '/api/board');
    const { data } = JSON.parse(r.body);
    assert.ok(!('byId' in data), 'byId must not appear in the JSON board model');
  });

  it('GET /api/status → contract:1 kind:status with display-folded state fields', async () => {
    const r = await request(port, '/api/status');
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.contract, 1);
    assert.equal(json.kind, 'status');
    assert.ok(json.data);
    // Same keys as samemind status --json; state is displayState (ok|failed|stale|unknown).
    for (const k of ['state', 'liveness', 'ageSec', 'ok', 'lastError', 'targets', 'version', 'ts']) {
      assert.ok(k in json.data, `status data missing ${k}`);
    }
    assert.ok(['ok', 'failed', 'stale', 'unknown'].includes(json.data.state));
  });

  it('GET /api/doctor → contract:1 kind:doctor, env values stay redacted', async () => {
    const r = await request(port, '/api/doctor');
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.contract, 1);
    assert.equal(json.kind, 'doctor');
    assert.ok(json.data);
    assert.ok(Array.isArray(json.data.engines));
    // Secret env values must never appear as plain strings: redactEnv turns non-allowlisted
    // values into `<set:N>` / `<empty>` / host-only URL forms (tools/lib/engine-mcp.mjs).
    const body = r.body;
    // If any location.env exists, every value is either an allowlisted path-ish string or a redact marker.
    for (const eng of json.data.engines) {
      for (const loc of eng.states?.connected?.locations || []) {
        if (!loc.env || typeof loc.env !== 'object') continue;
        for (const [key, val] of Object.entries(loc.env)) {
          if (key === 'OKF_ROOT' || key === 'OKF_GLOBAL_ROOT' || key === 'OKF_EMBED_MODEL'
              || key === 'OKF_INDEX_BACKEND' || key === 'SAMEMIND_AGENT' || key === 'NODE_ENV') {
            continue; // allowlisted — shown in clear (paths/flags, not secrets)
          }
          const s = String(val);
          assert.ok(
            s.startsWith('<set:') || s === '<empty>' || s === '<url>' || s.startsWith('http://') || s.startsWith('https://'),
            `env ${key} leaked a raw secret value: ${s}`,
          );
        }
      }
    }
    // Belt-and-braces: common secret shapes must not appear in the whole body.
    assert.ok(!/sk-[a-zA-Z0-9]{10,}/.test(body), 'body must not contain sk-… API key material');
    assert.ok(!/api[_-]?key["\s:=]+[a-zA-Z0-9_-]{16,}/i.test(body), 'body must not contain raw api_key assignments');
    void body;
  });

  it('POST /api/status and /api/doctor → 405 (read-only intact)', async () => {
    const status = await request(port, '/api/status', { method: 'POST' });
    const doctor = await request(port, '/api/doctor', { method: 'POST' });
    assert.equal(status.status, 405);
    assert.equal(doctor.status, 405);
  });

  it('GET /api/concepts?q= ranks via BM25 and returns the documented shape', async () => {
    const r = await request(port, '/api/concepts?q=lumen');
    assert.equal(r.status, 200);
    const { data } = JSON.parse(r.body);
    assert.ok(Array.isArray(data));
    if (data.length) {
      const row = data[0];
      assert.ok('id' in row && 'title' in row && 'type' in row && 'tags' in row && 'status' in row && 'date' in row);
    }
  });

  it('GET /api/concepts?type= filters', async () => {
    const r = await request(port, '/api/concepts?type=idea');
    const { data } = JSON.parse(r.body);
    assert.ok(data.every((c) => c.type.toLowerCase() === 'idea'));
  });

  it('GET /api/concept/<id> returns frontmatter + body for a real concept', async () => {
    const list = JSON.parse((await request(port, '/api/concepts')).body).data;
    assert.ok(list.length > 0, 'demo bundle should have concepts');
    const id = list[0].id;
    const r = await request(port, `/api/concept/${id}`);
    assert.equal(r.status, 200);
    const { kind, data } = JSON.parse(r.body);
    assert.equal(kind, 'concept');
    assert.equal(data.id, id);
    assert.ok(data.frontmatter);
    assert.equal(typeof data.body, 'string');
  });

  it('GET /api/concept/<missing> → 404', async () => {
    const r = await request(port, '/api/concept/does-not-exist');
    assert.equal(r.status, 404);
    assert.ok(JSON.parse(r.body).error);
  });

  it('GET /api/concept/../../etc/passwd (traversal) → 400/404, never 200', async () => {
    const r = await request(port, '/api/concept/../../etc/passwd');
    assert.ok([400, 404].includes(r.status), `expected 400/404, got ${r.status}`);
  });

  it('GET /api/concept/..%2F..%2Fetc%2Fpasswd (encoded traversal) → 400/404', async () => {
    const r = await request(port, '/api/concept/..%2F..%2Fetc%2Fpasswd');
    assert.ok([400, 404].includes(r.status), `expected 400/404, got ${r.status}`);
  });

  it('unknown /api/* → 404 JSON {error}', async () => {
    const r = await request(port, '/api/nonsense');
    assert.equal(r.status, 404);
    assert.ok(JSON.parse(r.body).error);
  });

  it('POST to an endpoint → 405', async () => {
    const r = await request(port, '/api/health', { method: 'POST' });
    assert.equal(r.status, 405);
  });

  it('PUT/DELETE also → 405', async () => {
    const put = await request(port, '/api/board', { method: 'PUT' });
    const del = await request(port, '/api/board', { method: 'DELETE' });
    assert.equal(put.status, 405);
    assert.equal(del.status, 405);
  });

  it('Host: evil.com → 403 (DNS rebinding guard)', async () => {
    const r = await request(port, '/api/health', { host: 'evil.com' });
    assert.equal(r.status, 403);
  });

  it('Host: localhost.evil.com → 403 (prefix-match bypass rejected)', async () => {
    const r = await request(port, '/api/health', { host: 'localhost.evil.com' });
    assert.equal(r.status, 403);
  });

  it('Host: 127.0.0.1:<port> (default) → allowed', async () => {
    const r = await request(port, '/api/health');
    assert.equal(r.status, 200);
  });

  it('GET / without dist → placeholder page mentions /api/health', async () => {
    const r = await request(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /\/api\/health/);
  });
});

// ─────────────────────────────── secret concept isolation ───────────────────────────────

describe('createUiServer — secret-visibility concepts never leak', () => {
  let dir, server, port;

  before(async () => {
    dir = tmp('ui-secret');
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    writeFileSync(join(dir, 'concepts', 'normal.md'), [
      '---', 'type: Concept', 'title: Normal Thing', 'visibility: internal', 'tags: [foo]', '---',
      '', 'Body text mentioning foo bar baz.', '',
    ].join('\n'));
    writeFileSync(join(dir, 'concepts', 'secret.md'), [
      '---', 'type: Concept', 'title: Secret Thing', 'visibility: secret', 'tags: [foo]', '---',
      '', 'Secret body should never leak.', '',
    ].join('\n'));
    server = await listen({ root: dir, distDir: null });
    port = server.address().port;
  });
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('GET /api/concepts excludes the secret concept', async () => {
    const r = await request(port, '/api/concepts');
    const { data } = JSON.parse(r.body);
    const ids = data.map((c) => c.id);
    assert.ok(ids.includes('concepts/normal'));
    assert.ok(!ids.includes('concepts/secret'));
  });

  it('GET /api/concepts?q= (BM25 over a shared tag) still excludes the secret concept', async () => {
    const r = await request(port, '/api/concepts?q=foo');
    const { data } = JSON.parse(r.body);
    const ids = data.map((c) => c.id);
    assert.ok(!ids.includes('concepts/secret'));
  });

  it('GET /api/concept/concepts/secret → 404, not the content', async () => {
    const r = await request(port, '/api/concept/concepts/secret');
    assert.equal(r.status, 404);
  });

  it('GET /api/concept/concepts/normal → 200 with body', async () => {
    const r = await request(port, '/api/concept/concepts/normal');
    assert.equal(r.status, 200);
    const { data } = JSON.parse(r.body);
    assert.match(data.body, /foo bar baz/);
  });
});

// ─────────────────────────────── static: dist present, path traversal ───────────────────────────────

describe('createUiServer — static assets from distDir', () => {
  let dir, distDir, server, port;

  before(async () => {
    dir = tmp('ui-dist-root');
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    distDir = tmp('ui-dist');
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>built</title><body>built ui</body>');
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("hi");');
    server = await listen({ root: dir, distDir });
    port = server.address().port;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(distDir, { recursive: true, force: true });
  });

  it('GET / serves dist/index.html when present', async () => {
    const r = await request(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /built ui/);
  });

  it('GET /assets/app.js serves the file with a JS content-type', async () => {
    const r = await request(port, '/assets/app.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /javascript/);
    assert.match(r.body, /console\.log/);
  });

  it('GET /assets/../../../../etc/passwd (traversal) never escapes distDir', async () => {
    const r = await request(port, '/assets/../../../../etc/passwd');
    assert.notEqual(r.status, 200);
  });
});

// ─────────────────────────────── live event stream: GET /api/events/stream (SSE) ───────────────────────────────

/** Opens an SSE connection and buffers parsed `{ event, data }` messages as they arrive
 *  (heartbeat `: ping` comments are swallowed, not pushed). `ready` resolves once headers
 *  are in; caller destroys `req` when done with the stream. */
function sseConnect(port, path, { host } = {}) {
  const req = http.request({
    hostname: '127.0.0.1', port, path, method: 'GET',
    headers: host ? { Host: host } : {},
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
          if (!raw.trim() || raw.startsWith(':')) continue; // heartbeat comment
          const lines = raw.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event: '));
          const dataLine = lines.find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          state.events.push({ event: eventLine ? eventLine.slice(7) : 'message', data: JSON.parse(dataLine.slice(6)) });
        }
      });
      resolvePromise(res);
    });
    req.on('error', reject);
  });
  req.end();
  return { req, state, ready };
}

async function waitForSse(state, predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = state.events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for SSE event, got: ${JSON.stringify(state.events)}`);
}

describe('createUiServer — GET /api/events/stream (SSE)', () => {
  let dir, server, port;

  before(async () => {
    dir = tmp('ui-sse');
    mkdirSync(join(dir, 'ledger'), { recursive: true });
    writeFileSync(join(dir, 'ledger', 'events.jsonl'), JSON.stringify({
      ts: '2026-07-26T00:00:00.000Z', actor: 'test', topic: 'sse-fixture', phase: 'start',
      status: 'ok', action: 'seed event', artifact: null, ref: null, quarantine: false, matches: [],
    }) + '\n');
    server = await listen({ root: dir, distDir: null });
    port = server.address().port;
  });
  after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  // One persistent connection covers both the snapshot-on-connect and live-append assertions
  // (a real dashboard tab does the same — connect once, then observe events over time), rather
  // than two independent sseConnect()s that would tear down and restart the hub's watch between
  // them for no reason.
  it('connect → snapshot, then a ledger append arrives live', async () => {
    const conn = sseConnect(port, '/api/events/stream');
    await conn.ready;
    assert.equal(conn.state.status, 200);
    const snap = await waitForSse(conn.state, (e) => e.event === 'snapshot');
    assert.equal(snap.data.contract, 1);
    assert.equal(snap.data.kind, 'ledger-snapshot');
    assert.ok(Array.isArray(snap.data.data.events));
    assert.ok(snap.data.data.events.some((e) => e.topic === 'sse-fixture'));

    appendFileSync(join(dir, 'ledger', 'events.jsonl'), JSON.stringify({
      ts: '2026-07-26T00:01:00.000Z', actor: 'test', topic: 'sse-live', phase: 'step',
      status: 'ok', action: 'live append', artifact: null, ref: null, quarantine: false, matches: [],
    }) + '\n');
    // ponytail: fs.watch delivery is normally ~tens of ms; the 2s poll (always running
    // alongside fs.watch as a correctness backstop — see ui-server.mjs startWatch) caps the
    // worst case. The extra margin here just absorbs scheduling jitter on a saturated CI box.
    const ev = await waitForSse(conn.state, (e) => e.event === 'event' && e.data.data?.topic === 'sse-live', 8000);
    assert.equal(ev.data.contract, 1);
    assert.equal(ev.data.kind, 'ledger-event');
    assert.equal(ev.data.data.action, 'live append');
    conn.req.destroy();
  });

  it('Host: evil.com → 403 (same guard as every other route)', async () => {
    const r = await request(port, '/api/events/stream', { host: 'evil.com' });
    assert.equal(r.status, 403);
  });

  it('POST /api/events/stream → 405', async () => {
    const r = await request(port, '/api/events/stream', { method: 'POST' });
    assert.equal(r.status, 405);
  });
});

// ─────────────────────────────── voice companion probe: GET /api/voice/probe ───────────────────────────────

describe('createUiServer — GET /api/voice/probe', () => {
  let dir, server, port, origHome;

  // Each case gets its own bundle + server (the configured url differs). HOME is pinned to the
  // bundle's own empty dir so the developer's real ~/.samemind can never leak a serviceUrl in, and
  // `fetchImpl` is injected so no real network ever leaves the process.
  async function boot(serviceUrl, fetchImpl) {
    dir = tmp('ui-voice');
    mkdirSync(join(dir, 'concepts'), { recursive: true });
    writeFileSync(join(dir, 'index.md'), '# bundle\n', 'utf8');
    mkdirSync(join(dir, '.samemind'), { recursive: true });
    writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify({ voice: { serviceUrl } }), 'utf8');
    origHome = process.env.HOME;
    process.env.HOME = dir;
    server = await listen({ root: dir, distDir: null, fetchImpl });
    port = server.address().port;
  }
  function down() {
    if (server) server.close();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  it('no serviceUrl → unavailable, no fetch, contract envelope', async () => {
    let called = 0;
    await boot(null, async () => { called++; throw new Error('no network'); });
    try {
      const r = await request(port, '/api/voice/probe');
      assert.equal(r.status, 200);
      const json = JSON.parse(r.body);
      assert.equal(json.contract, 1);
      assert.equal(json.kind, 'voice-probe');
      assert.equal(json.data.state, 'unavailable');
      assert.equal(json.data.probe, null);
      assert.equal(called, 0, 'no serviceUrl must short-circuit before any fetch');
    } finally { down(); }
  });

  it('configured + live probe → reachable, model reported', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'whisper-1' }] }) });
    await boot('http://127.0.0.1:8000', fetchImpl);
    try {
      const r = await request(port, '/api/voice/probe');
      const json = JSON.parse(r.body);
      assert.equal(json.data.state, 'reachable');
      assert.equal(json.data.available, true);
      assert.equal(json.data.probe.model, 'whisper-1');
    } finally { down(); }
  });

  it('configured but unreachable → configured (NOT green), probe null', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await boot('http://127.0.0.1:8000', fetchImpl);
    try {
      const r = await request(port, '/api/voice/probe');
      const json = JSON.parse(r.body);
      assert.equal(json.data.state, 'configured');
      assert.equal(json.data.available, false);
      assert.equal(json.data.probe, null);
    } finally { down(); }
  });

  it('POST → 405 (the probe route stays read-only)', async () => {
    await boot(null, async () => { throw new Error('no network'); });
    try {
      const r = await request(port, '/api/voice/probe', { method: 'POST' });
      assert.equal(r.status, 405);
    } finally { down(); }
  });
});

// No dedicated "no leaked handles" test: it's proven by the test *process* — every `after()`
// above calls server.close(), which (per the ui-server.mjs comment on server.close) ends every
// open SSE stream and force-drops its socket. If a watcher, heartbeat interval, or connection
// leaked, `node --test` would hang past this file's last test instead of exiting.

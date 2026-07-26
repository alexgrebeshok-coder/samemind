#!/usr/bin/env node
// ui-server.test.mjs — samemind ui: local read-only HTTP dashboard (tools/lib/ui-server.mjs).
//   node --test tools/ui-server.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

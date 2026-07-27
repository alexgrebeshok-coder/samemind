#!/usr/bin/env node
// mcp-http.test.mjs — Streamable-HTTP MCP transport (tools/lib/mcp-http.mjs). Covers:
//   - listens on an ephemeral 127.0.0.1 port; POST /mcp tools/list returns the shared tool set
//   - memory_search over HTTP returns a result (reused mcp.mjs handler, no re-implementation)
//   - Host: evil.com → 403 (DNS-rebinding guard, exact-match)
//   - a secret concept never leaks through the HTTP transport (isolation inherited from mcp.mjs)
//   - server.close() completes cleanly (no hanging handles)
// node --test tools/mcp-http.test.mjs
//
// OKF_ROOT / OKF_EMBED_URL are set BEFORE the dynamic import of mcp-http.mjs: okf.mjs captures
// ROOT (and mcp.mjs its embed config) at module-eval time, so the bundle must exist and env must
// be set first. Static imports here are node builtins only for exactly that reason.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const BUNDLE = mkdtempSync(join(tmpdir(), 'samemind-mcp-http-'));

function concept(relPath, fm, body) {
  const full = join(BUNDLE, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(full, `---\n${front}\n---\n${body}\n`);
}

function post(port, jsonBody, { host } = {}) {
  return new Promise((resolvePromise, reject) => {
    const data = Buffer.from(JSON.stringify(jsonBody), 'utf8');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (host) headers.Host = host;
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON body (e.g. 202) */ }
        resolvePromise({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function toolJson(res) {
  assert.ok(res.json?.result?.content?.[0]?.text, `tool result missing content: ${res.text}`);
  return JSON.parse(res.json.result.content[0].text);
}

describe('mcp-http: Streamable HTTP MCP transport', () => {
  let server;
  let port;

  before(async () => {
    concept('concepts/lumen.md', { title: 'Lumen Project', type: 'Project' },
      'Lumen is the flagship widget for zephyrquux search indexing.');
    concept('secret/leak.md', { title: 'Secret Ledger', type: 'Concept', visibility: 'secret' },
      'Top secret marker HUSHVALUE must never appear over HTTP.');

    process.env.OKF_ROOT = BUNDLE;
    process.env.OKF_EMBED_URL = ''; // no embeddings endpoint → BM25 fallback (same as other MCP tests)
    process.env.SAMEMIND_AGENT = 'http-test';

    const { createMcpHttpServer } = await import('./lib/mcp-http.mjs');
    server = createMcpHttpServer({ root: BUNDLE, port: 0 });
    await once(server, 'listening');
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    rmSync(BUNDLE, { recursive: true, force: true });
  });

  it('binds an ephemeral 127.0.0.1 port', () => {
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
  });

  it('initialize returns serverInfo + a supported protocol version', async () => {
    const res = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.serverInfo.name, 'samemind');
    assert.equal(res.json.result.protocolVersion, '2025-06-18');
  });

  it('tools/list advertises the shared memory_* tool set', async () => {
    const res = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('memory_search'), `missing memory_search: ${names.join(',')}`);
    assert.ok(names.includes('memory_get'));
    assert.equal(names.length, 10);
  });

  it('memory_search over HTTP returns a matching result', async () => {
    const res = await post(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'zephyrquux', no_global: true } },
    });
    assert.equal(res.status, 200);
    const payload = toolJson(res);
    assert.ok(payload.count >= 1, `expected a hit, got ${JSON.stringify(payload)}`);
    assert.ok(payload.results.some((r) => r.id === 'concepts/lumen'));
  });

  it('rejects a spoofed Host header (DNS-rebinding guard)', async () => {
    const res = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { host: 'evil.com' });
    assert.equal(res.status, 403);
  });

  it('never leaks a secret-visibility concept', async () => {
    // via memory_get (defense-in-depth path)
    const got = await post(port, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'memory_get', arguments: { id: 'secret/leak' } },
    });
    const getPayload = toolJson(got);
    assert.equal(getPayload.found, false, `secret concept was returned: ${JSON.stringify(getPayload)}`);

    // and it never surfaces via search either. NB: memory_search echoes the query back in the
    // payload's `query` field, so we assert on `results` (ids + snippets), not the raw response.
    const searched = await post(port, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'HUSHVALUE', no_global: true } },
    });
    const searchPayload = toolJson(searched);
    assert.ok(!searchPayload.results.some((r) => r.id === 'secret/leak'), 'secret concept in search results');
    assert.ok(
      !searchPayload.results.some((r) => (r.snippet || '').includes('HUSHVALUE')),
      'secret body leaked through a search snippet',
    );
  });

  it('notifications get 202 with no body', async () => {
    const res = await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(res.text, '');
  });

  it('non-/mcp path → 404, GET → 405', async () => {
    const notFound = await new Promise((resolvePromise, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/nope', method: 'POST', headers: { 'Content-Length': 0 } },
        (r) => { r.resume(); r.on('end', () => resolvePromise(r.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(notFound, 404);

    const getStatus = await new Promise((resolvePromise, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET' },
        (r) => { r.resume(); r.on('end', () => resolvePromise(r.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(getStatus, 405);
  });

  it('close() completes cleanly (no hanging handles)', async () => {
    const s = server;
    server = null; // after() won't double-close
    await new Promise((r) => s.close(r)); // resolves only once fully closed
    assert.ok(true);
  });
});

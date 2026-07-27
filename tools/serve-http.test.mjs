#!/usr/bin/env node
// serve-http.test.mjs — seam 2: `samemind serve --http` starts the Streamable-HTTP MCP transport
// (not stdio) on an ephemeral 127.0.0.1 port and answers tools/list. The HTTP transport itself is
// covered in depth by mcp-http.test.mjs; this asserts only the serve seam — that --http routes to
// it and returns a live server. OKF_ROOT is set BEFORE importing mcp-server.mjs (okf.mjs captures
// ROOT at module-eval), same pattern as mcp-http.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const BUNDLE = mkdtempSync(join(tmpdir(), 'samemind-serve-http-'));

function post(port, jsonBody) {
  return new Promise((resolvePromise, reject) => {
    const data = Buffer.from(JSON.stringify(jsonBody), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
          resolvePromise({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('serve --http: routes to the HTTP MCP transport', () => {
  let server;
  let port;

  before(async () => {
    process.env.OKF_ROOT = BUNDLE;
    process.env.OKF_EMBED_URL = ''; // BM25 fallback, no embeddings endpoint
    const { main } = await import('./mcp-server.mjs');
    server = main(['--http', '--port', '0']); // ephemeral loopback port
    assert.ok(server && typeof server.address === 'function', 'main(--http) returns an http.Server');
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

  it('answers tools/list with the shared memory_* tool set', async () => {
    const res = await post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 200);
    const names = res.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('memory_search'), `missing memory_search: ${names.join(',')}`);
    assert.equal(names.length, 10);
  });
});

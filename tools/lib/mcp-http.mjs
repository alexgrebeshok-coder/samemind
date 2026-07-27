// mcp-http.mjs — Streamable-HTTP transport for the SAME samemind MCP tools that
// tools/mcp-server.mjs serves over stdio. Same 10 memory_* tools, same handlers (imported from
// ./mcp.mjs — TOOLS + callTool); only the framing differs: JSON-RPC over HTTP POST instead of
// newline-delimited stdio. No tool logic lives here.
//
// Security posture (why this is safe to run on a dev box):
//  - binds 127.0.0.1 ONLY — createMcpHttpServer listens there itself, not left to the caller.
//  - exact-match Host allow-list (same guard as ui-server.mjs) — kills DNS-rebinding: a page on
//    evil.com resolving to 127.0.0.1 sends Host: evil.com and gets 403 before any tool runs.
//  - secret-visibility isolation + prompt-injection quarantine are inherited wholesale from the
//    tool handlers in mcp.mjs (callTool → readableDocs = load({includeSecret:false})); this file
//    adds NO tool logic, so there is no second place for either to regress.
//
// Streamable HTTP, minimal profile (MCP 2025-06-18): POST /mcp with a single JSON-RPC message.
// Requests → 200 application/json with the JSON-RPC response. Notifications (no id) → 202, no body.
// GET /mcp → 405: we expose no server-initiated SSE stream, because every tool here is single-shot
// request/response — there is nothing to push. No session header, no JSON-RPC batching.
// ponytail: no SSE / no sessions — add a GET /mcp SSE stream (ui-server hub is the template) only
// if a future streaming tool actually needs server→client push.
import http from 'node:http';
import { resolve } from 'node:path';

import {
  TOOLS, callTool, SERVER_NAME, SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION,
} from './mcp.mjs';
import { ROOT } from './okf.mjs';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB — a memory tool call is tiny; cap guards against a flood

// Exact-match Host allow-list — identical semantics to ui-server.mjs hostAllowed (bare forms use
// equality so "localhost.evil.com" is rejected; only ":port" suffixes use startsWith). Duplicated
// (5 lines) rather than exported from ui-server.mjs to avoid editing a file this task doesn't own;
// a security guard this small is safer copied than coupled across an ownership boundary.
function hostAllowed(host) {
  const h = String(host || '');
  return h === 'localhost' || h === '127.0.0.1' || h.startsWith('localhost:') || h.startsWith('127.0.0.1:');
}

/** Dispatch one JSON-RPC message against the shared tool set. Returns the JSON-RPC response
 *  object for a request, or null for a notification (id === undefined). Mirrors the method table
 *  in tools/mcp-server.mjs — the transport envelope is inherently per-transport; the TOOLS list
 *  and callTool are the shared surface, imported, never re-implemented. */
async function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || !msg.method) {
    const id = msg && msg.id !== undefined ? msg.id : null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return isNotification ? null : { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await callTool(name, args || {});
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    return isNotification ? null : { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
  }
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  if (!hostAllowed(req.headers.host)) { sendJson(res, 403, { error: 'forbidden host' }); return; }
  const url = req.url.split('?')[0];
  if (url !== '/mcp') { sendJson(res, 404, { error: 'not found — POST JSON-RPC to /mcp' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — POST JSON-RPC to /mcp' }); return; }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: e.message } });
    return;
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
    return;
  }
  const response = await dispatch(msg);
  if (response === null) { res.writeHead(202).end(); return; } // notification — accepted, no body
  sendJson(res, 200, response);
}

/** Create + start the Streamable-HTTP MCP server, bound to 127.0.0.1 only. `port` 0 = ephemeral
 *  (read server.address().port after the 'listening' event). `root` is optional; when given it
 *  MUST equal the bundle root the tool handlers are bound to (OKF_ROOT, resolved in okf.mjs at
 *  import time) — a mismatch throws rather than silently serving the wrong bundle, since callTool
 *  targets that module-level root, not a per-request one (same as the stdio server). Returns the
 *  http.Server; attach your own 'error'/'listening' handlers as needed. */
export function createMcpHttpServer({ root, port = 0 } = {}) {
  if (root !== undefined && root !== null && resolve(root) !== ROOT) {
    throw new Error(`createMcpHttpServer: root ${resolve(root)} != tool root ${ROOT} — set OKF_ROOT before import to retarget`);
  }
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      try { sendJson(res, 500, { error: e.message }); } catch { /* headers already sent */ }
    });
  });
  // No keep-alive SSE here, but a client socket left open would still make close() hang; force-drop
  // lingering sockets so SIGTERM/close completes promptly (same reason ui-server overrides close).
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return origClose(cb);
  };
  server.listen(port, '127.0.0.1');
  return server;
}

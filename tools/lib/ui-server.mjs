// ui-server.mjs — samemind ui: local read-only HTTP dashboard over one bundle (docs/ui-spec.md).
// Pure factory `createUiServer({ root, distDir })` → node:http server; every handler takes
// `root` explicitly (never reads a module-level ROOT/env) so a caller (tests, `tools/ui.mjs`
// with --root) can point one process at any bundle without re-importing anything.
//
// Read-only: no write endpoints exist. GET only — every other method is 405. Binds to
// 127.0.0.1 only (caller's job, see tools/ui.mjs); this module also rejects requests whose
// Host header doesn't name localhost/127.0.0.1, as defense against DNS rebinding from a page
// on another origin that a browser on this machine might load.
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load, findById } from './okf.mjs';
import { readEvents, summarizeLedger } from './ledger.mjs';
import { readRegistry, heartbeat } from './fleet.mjs';
import { buildBoardModel, dateOf, statusOf } from '../board.mjs';
import { buildHandoffModel } from '../handoff.mjs';
import { buildLinksModel } from '../okf-query.mjs';
import { buildCorpus, bm25Score } from './bm25.mjs';
import { docText } from './recall.mjs';
import { assertSafeConceptId } from '../../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function wrap(kind, data) {
  return { contract: 1, kind, generatedAt: new Date().toISOString(), data };
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

// Host header allow-list: exact localhost/127.0.0.1, or either with a `:port` suffix. A plain
// prefix check (`host.startsWith('localhost')`) would let "localhost.evil.com" through — the
// whole point of this guard — so bare forms use equality, only the `:`-suffixed forms use startsWith.
function hostAllowed(host) {
  const h = String(host || '');
  return h === 'localhost' || h === '127.0.0.1' || h.startsWith('localhost:') || h.startsWith('127.0.0.1:');
}

const API_ENDPOINTS = [
  'GET /api/health', 'GET /api/board', 'GET /api/handoff', 'GET /api/fleet',
  'GET /api/ledger', 'GET /api/concepts', 'GET /api/concept/<id>', 'GET /api/graph',
];

function placeholderHtml() {
  const items = API_ENDPOINTS.map(e => `<li><code>${e}</code></li>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>samemind ui</title></head>
<body>
<h1>samemind ui</h1>
<p>frontend not built yet; API is live at <code>/api/health</code></p>
<ul>${items}</ul>
</body></html>`;
}

// --- pure-ish endpoint handlers: I/O in, wrapped model out (root always explicit) ---------

function apiHealth(root) {
  const docs = load({ includeSecret: false }, root).filter(d => !d.reserved);
  return wrap('health', { root, concepts: docs.length, version: PKG.version, searchMode: 'bm25' });
}

function apiBoard(root) {
  const docs = load({ includeSecret: false }, root);
  const events = readEvents(root);
  const { openFailures } = summarizeLedger(events);
  const registry = readRegistry(root);
  const overdueEngines = registry ? heartbeat(registry.engines, events, Date.now()).filter(e => e.overdue) : [];
  const model = buildBoardModel(docs, { now: Date.now(), openFailures, overdueEngines });
  return wrap('board', model);
}

function apiHandoff(root) {
  const docs = load({ includeSecret: false, includeMirror: true }, root);
  const model = buildHandoffModel(docs, { now: new Date() });
  return wrap('handoff', model);
}

function apiFleet(root) {
  const registry = readRegistry(root);
  const events = readEvents(root);
  const engines = registry ? heartbeat(registry.engines, events, Date.now()) : [];
  const stopPoints = registry ? registry.stopPoints : [];
  return wrap('fleet', { engines, stopPoints });
}

function apiLedger(root) {
  const { topics, openFailures } = summarizeLedger(readEvents(root));
  return wrap('ledger', { topics, openFailures });
}

function apiConcepts(root, query) {
  const type = query.get('type');
  const tag = query.get('tag');
  const q = (query.get('q') || '').trim();
  let docs = load({ includeSecret: false }, root).filter(d => !d.reserved);
  if (type) docs = docs.filter(d => String(d.fm?.type || '').toLowerCase() === type.toLowerCase());
  if (tag) docs = docs.filter(d => (d.fm?.tags || []).map(t => String(t).toLowerCase()).includes(tag.toLowerCase()));
  if (q) {
    const corpus = buildCorpus(docs, { textOf: docText });
    docs = docs
      .map(d => ({ d, score: bm25Score(q, d.id, corpus) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.d);
  }
  const list = docs.map(d => ({
    id: d.id,
    title: d.fm?.title || '',
    type: d.fm?.type || '',
    tags: d.fm?.tags || [],
    status: statusOf(d),
    date: dateOf(d),
  }));
  return wrap('concepts', list);
}

function apiGraph(root) {
  const docs = load({ includeSecret: false }, root);
  return wrap('links', buildLinksModel(docs));
}

const API_ROUTES = {
  '/api/health': apiHealth,
  '/api/board': apiBoard,
  '/api/handoff': apiHandoff,
  '/api/fleet': apiFleet,
  '/api/ledger': apiLedger,
  '/api/concepts': apiConcepts,
  '/api/graph': apiGraph,
};

/** GET /api/concept/<id>: validated through the same traversal guard memory_get uses. */
function handleConceptDetail(res, root, idRaw) {
  let rel;
  try {
    rel = assertSafeConceptId(idRaw, root);
  } catch {
    sendJson(res, 400, { error: 'invalid concept id' });
    return;
  }
  const docs = load({ includeSecret: false }, root); // secret already excluded at load() level
  const doc = findById(docs, rel)[0];
  if (!doc) { sendJson(res, 404, { error: 'not found' }); return; }
  sendJson(res, 200, wrap('concept', { id: doc.id, frontmatter: doc.fm, body: doc.body }));
}

/** Static file strictly under `distDir` (resolve + prefix check — no path traversal). */
function serveStaticFile(res, distDir, relPath) {
  if (!distDir) return false;
  const base = resolve(distDir);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) return false; // traversal attempt
  if (!existsSync(target) || !statSync(target).isFile()) return false;
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  const body = readFileSync(target);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
  return true;
}

function handleRequest(req, res, root, distDir) {
  if (!hostAllowed(req.headers.host)) { sendJson(res, 403, { error: 'forbidden host' }); return; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }

  // Parse path/query by hand, not via `new URL()` — WHATWG URL normalizes `../`/`%2e%2e`
  // dot-segments away during parsing, which would silently defeat the traversal guard below
  // (assertSafeConceptId never gets to see the raw ".." segment). Query parsing alone is safe
  // to hand to URLSearchParams since it never touches the path.
  const qIdx = req.url.indexOf('?');
  const rawPath = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : req.url.slice(qIdx + 1);
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { pathname = rawPath; }
  const query = new URLSearchParams(rawQuery);

  if (pathname.startsWith('/api/concept/')) {
    handleConceptDetail(res, root, pathname.slice('/api/concept/'.length));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(API_ROUTES, pathname)) {
    sendJson(res, 200, API_ROUTES[pathname](root, query));
    return;
  }
  if (pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'not found' }); return; }

  if (pathname === '/') {
    if (serveStaticFile(res, distDir, 'index.html')) return;
    sendHtml(res, 200, placeholderHtml());
    return;
  }
  if (pathname.startsWith('/assets/')) {
    if (serveStaticFile(res, distDir, pathname.slice(1))) return;
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  // Any other non-API GET: serve from dist if it happens to exist there, else the placeholder
  // (there is no SPA to fall back to yet — see docs/ui-spec.md §0, dist ships later).
  if (serveStaticFile(res, distDir, pathname.replace(/^\//, ''))) return;
  sendHtml(res, 200, placeholderHtml());
}

/** Creates the read-only dashboard HTTP server. Caller decides host/port to listen on
 *  (tools/ui.mjs binds 127.0.0.1 only, per docs/ui-spec.md §0). */
export function createUiServer({ root, distDir = null } = {}) {
  if (!root) throw new Error('createUiServer: "root" is required');
  return http.createServer((req, res) => {
    try {
      handleRequest(req, res, root, distDir);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

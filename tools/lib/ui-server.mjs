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
import { existsSync, readFileSync, statSync, watch as fsWatch, openSync, readSync, closeSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load, findById } from './okf.mjs';
import { readEvents, summarizeLedger, ledgerFile, ledgerDir } from './ledger.mjs';
import { readRegistry, heartbeat } from './fleet.mjs';
import { readHealth, assessLiveness } from './health.mjs';
import { readProjectionConfig } from './projection-config.mjs';
import { buildBoardModel, dateOf, statusOf } from '../board.mjs';
import { buildHandoffModel } from '../handoff.mjs';
import { buildLinksModel } from '../okf-query.mjs';
import { displayState } from '../status.mjs';
import { runDoctor } from '../doctor.mjs';
import { buildCorpus, bm25Score } from './bm25.mjs';
import { docText } from './recall.mjs';
import { assertSafeConceptId } from '../../lib/safe-path.mjs';
import { checkWriteRequest } from './http-guard.mjs';
import { buildSettingsModel, applySettingsPatch, assessAvailability } from './settings.mjs';
import { readFeatureConfig } from './feature-config.mjs';
import { probeVoiceCompanion } from './probe-voice.mjs';
import { routeIntent } from './voice-intent.mjs';
import { scanForInjection } from './injection.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
// Same default as tools/status.mjs — keep in lockstep with projection-config / serviced cadence.
const DEFAULT_INTERVAL_SEC = 1800;

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
  'GET /api/health', 'GET /api/status', 'GET /api/doctor', 'GET /api/board',
  'GET /api/handoff', 'GET /api/fleet', 'GET /api/ledger', 'GET /api/concepts',
  'GET /api/concept/<id>', 'GET /api/graph', 'GET /api/events/stream',
  'GET /api/voice/probe', 'GET /api/voice/route',
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

/** Projection liveness — same payload as `samemind status --json` (displayState folds
 *  fresh-but-failed into `failed`, so a green mark never covers a broken last run). */
function apiStatus(root) {
  const health = readHealth(root);
  const cfg = readProjectionConfig(root);
  const intervalSec = Number.isFinite(cfg.intervalSec) ? cfg.intervalSec : DEFAULT_INTERVAL_SEC;
  const { state, ageSec } = assessLiveness(health, { intervalSec });
  return wrap('status', {
    state: displayState(state, health),
    liveness: state,
    ageSec,
    ok: health?.ok ?? null,
    lastError: health?.lastError ?? null,
    targets: health?.targets ?? [],
    version: health?.version ?? null,
    ts: health?.ts ?? null,
  });
}

/** Engine connection report — probe:false so a GET never spawns MCP servers. Env values
 *  stay redacted inside runDoctor (publicEntry → redactEnv); do not unmask here. */
async function apiDoctor(root) {
  const report = await runDoctor({ root, probe: false });
  return wrap('doctor', report);
}

function apiBoard(root) {
  const docs = load({ includeSecret: false }, root);
  const events = readEvents(root);
  const { openFailures, topics } = summarizeLedger(events);
  const registry = readRegistry(root);
  const overdueEngines = registry ? heartbeat(registry.engines, events, Date.now()).filter(e => e.overdue) : [];
  const model = buildBoardModel(docs, { now: Date.now(), openFailures, overdueEngines, ledgerTopics: topics });
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
  return wrap('links', buildLinksModel(docs, { root }));
}

function apiSettings(root) {
  return wrap('settings', buildSettingsModel(root));
}

/** Runs the voice-companion reachability probe on demand (the "check connection" button), never on
 *  a render. Reads the configured serviceUrl, probes it, and folds the result back through
 *  assessAvailability — so the same state machine that powers GET /api/settings also answers here,
 *  only now with the `reachable` state a pure render can never produce. */
async function apiVoiceProbe(root, fetchImpl = fetch) {
  const values = readFeatureConfig(root);
  const probe = await probeVoiceCompanion({ url: values.voice.serviceUrl, fetchImpl });
  const { voice } = assessAvailability(values, { voiceProbe: probe });
  return wrap('voice-probe', { ...voice, url: values.voice.serviceUrl, probe });
}

/**
 * The intent gate, served from the core implementation.
 *
 * This route exists so the browser never has to own a second copy of the gate. A hand-mirrored
 * client-side router would drift from `lib/voice-intent.mjs`, and the copy is the one a person
 * actually sees — a weakened browser-side injection scan would show "no quarantine" on a phrase
 * the core quarantines, and a divergent threshold would show a decision the core would not take.
 *
 * GET, not POST: routing computes a verdict and changes nothing, so it needs no write guard.
 * The transcript rides in the query string; that is fine here because nothing is persisted and
 * the server is loopback-only — but it is also why this must never grow a side effect.
 */
function apiVoiceRoute(root, query) {
  const text = query.get('text') || '';
  const confidence = Number(query.get('confidence'));
  const cfg = readFeatureConfig(root);
  const threshold = Number.isFinite(cfg.voice.confidenceThreshold) ? cfg.voice.confidenceThreshold : 0.6;
  const decision = routeIntent(text, {
    confidence: Number.isFinite(confidence) ? confidence : 0,
    threshold,
  });
  return wrap('voice-route', { ...decision, threshold, quarantine: scanForInjection(text) });
}

/** 64 KiB is far more than a settings patch needs; the cap exists so a hostile or buggy client
 *  cannot make the dashboard buffer unbounded memory. Mirrors the MCP HTTP transport's limit. */
const MAX_WRITE_BODY = 64 * 1024;

function handleConfigWrite(req, res, root) {
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > MAX_WRITE_BODY) {
      aborted = true;
      sendJson(res, 413, { error: 'body too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    let patch;
    try { patch = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
    let result;
    try { result = applySettingsPatch(root, patch); } catch (e) { sendJson(res, 500, { error: e.message }); return; }
    if (!result.ok) { sendJson(res, result.status, { error: 'rejected', errors: result.errors }); return; }
    // Echo the re-read model, not the patch: the screen must render what is on disk now, so a
    // silently-normalized or partially-applied value can never look like a clean save.
    sendJson(res, 200, wrap('settings', result.settings.features ? result.settings : buildSettingsModel(root)));
  });
}

const API_ROUTES = {
  '/api/health': apiHealth,
  '/api/settings': apiSettings,
  '/api/status': apiStatus,
  '/api/doctor': apiDoctor,
  '/api/board': apiBoard,
  '/api/handoff': apiHandoff,
  '/api/fleet': apiFleet,
  '/api/ledger': apiLedger,
  '/api/concepts': apiConcepts,
  '/api/graph': apiGraph,
  '/api/voice/route': apiVoiceRoute,
};

// --- live event stream: GET /api/events/stream (SSE) -------------------------------------
//
// One hub per createUiServer() call, shared by every connected client (spec allows either a
// per-client offset or a common emitter — a shared emitter is the smaller diff: one
// watcher/offset no matter how many browser tabs are open, torn down when the last client
// leaves so an idle server holds no open handles).

const HEARTBEAT_MS = 25000;
const POLL_MS = 2000;

function createLedgerStreamHub(root) {
  const clients = new Set(); // { res, hb }
  let offset = 0;
  let stopWatch = null;

  /** Reads whatever grew past `offset` since the last check, parses complete lines (corrupt
   *  ones skipped, same contract as ledger.mjs readEvents), and broadcasts each as an
   *  `event` SSE message. A trailing line with no newline yet is left for the next tick. */
  function checkForNewLines() {
    const file = ledgerFile(root);
    if (!existsSync(file)) return;
    let size;
    try { size = statSync(file).size; } catch { return; }
    if (size < offset) offset = 0; // truncated/rotated underneath us — restart from scratch
    if (size <= offset) return;
    const len = size - offset;
    const buf = Buffer.alloc(len);
    let fd;
    try { fd = openSync(file, 'r'); } catch { return; }
    try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    const partial = lines.pop(); // last chunk with no trailing \n yet — hold back
    offset = size - Buffer.byteLength(partial, 'utf8');
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const payload = `event: event\ndata: ${JSON.stringify(wrap('ledger-event', ev))}\n\n`;
      for (const c of clients) c.res.write(payload);
    }
  }

  function startWatch() {
    offset = existsSync(ledgerFile(root)) ? statSync(ledgerFile(root)).size : 0;
    const dir = ledgerDir(root);
    let watcher = null;
    // fs.watch needs the directory to already exist, and Node's own docs warn it isn't
    // reliable on every platform/load condition (events can be coalesced or dropped, not just
    // "slow") — so the 2s poll always runs alongside it, not only when fs.watch is unavailable
    // or errors. fs.watch is the low-latency common case; the poll is the correctness backstop.
    if (existsSync(dir)) {
      try {
        watcher = fsWatch(dir, { persistent: false }, () => checkForNewLines());
        watcher.on('error', () => { watcher.close(); watcher = null; });
      } catch { /* dir vanished between the check and the call — poll still covers it */ }
    }
    const poll = setInterval(checkForNewLines, POLL_MS);
    stopWatch = () => { if (watcher) watcher.close(); clearInterval(poll); };
  }

  function addClient(res) {
    if (clients.size === 0) startWatch();
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, HEARTBEAT_MS);
    const client = { res, hb };
    clients.add(client);
    return client;
  }

  function removeClient(client) {
    clearInterval(client.hb);
    clients.delete(client);
    if (clients.size === 0 && stopWatch) { stopWatch(); stopWatch = null; }
  }

  /** Ends every open stream and stops watching — called from server.close(). */
  function endAll() {
    for (const c of [...clients]) { clearInterval(c.hb); try { c.res.end(); } catch { /* already gone */ } }
    clients.clear();
    if (stopWatch) { stopWatch(); stopWatch = null; }
  }

  return { addClient, removeClient, endAll };
}

function handleEventsStream(req, res, root, hub) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const events = readEvents(root).slice(-50);
  res.write(`event: snapshot\ndata: ${JSON.stringify(wrap('ledger-snapshot', { events }))}\n\n`);
  const client = hub.addClient(res);
  req.on('close', () => hub.removeClient(client));
}

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

/** The only path that accepts a write, and the only method it accepts. Kept as data next to the
 *  guard so "what can this server mutate" is one line to read, not a grep across handlers. */
const WRITE_ROUTES = new Map([['/api/config', 'POST']]);

function handleRequest(req, res, root, distDir, hub, fetchImpl = fetch) {
  if (!hostAllowed(req.headers.host)) { sendJson(res, 403, { error: 'forbidden host' }); return; }

  // GET stays unconditionally allowed. Everything else must match WRITE_ROUTES exactly *and*
  // clear the full write guard — an anchored loopback Host, a same-authority Origin, and a JSON
  // Content-Type. The blanket `!== 'GET' → 405` this replaces was a stronger sentence but it
  // could not express "one route, one method"; the allowlist keeps the property and names it.
  if (req.method !== 'GET') {
    const writePath = (req.url || '').split('?')[0];
    if (WRITE_ROUTES.get(writePath) !== req.method) {
      sendJson(res, 405, { error: 'method not allowed' }); return;
    }
    // localPort, not the Host header: the bound port is ours to know, and comparing an
    // attacker-supplied value against itself proves nothing.
    const verdict = checkWriteRequest({
      method: req.method, headers: req.headers, boundPort: req.socket?.localPort,
    });
    if (!verdict.ok) { sendJson(res, verdict.status, { error: verdict.error }); return; }
    handleConfigWrite(req, res, root);
    return;
  }

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
  if (pathname === '/api/events/stream') {
    handleEventsStream(req, res, root, hub);
    return;
  }
  if (pathname === '/api/voice/probe') {
    // On-demand only (the "check connection" button), never on a render — see apiVoiceProbe. This
    // is the one GET that may touch the network; every other route stays pure over disk.
    Promise.resolve(apiVoiceProbe(root, fetchImpl))
      .then((payload) => sendJson(res, 200, payload))
      .catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(API_ROUTES, pathname)) {
    // Handlers are usually sync; /api/doctor is async (runDoctor). Promise.resolve covers both.
    Promise.resolve(API_ROUTES[pathname](root, query))
      .then((payload) => sendJson(res, 200, payload))
      .catch((e) => sendJson(res, 500, { error: e.message }));
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
export function createUiServer({ root, distDir = null, fetchImpl = fetch } = {}) {
  if (!root) throw new Error('createUiServer: "root" is required');
  const hub = createLedgerStreamHub(root);
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, root, distDir, hub, fetchImpl);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
  // SSE clients are keep-alive connections http.Server#close() will otherwise wait on forever
  // (its callback only fires once every connection is gone). End our own streams first, then
  // force-drop any lingering socket so close() actually completes — "server close() гасит все
  // стримы" per spec, and the thing that makes the "no hanging handles" test possible.
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    hub.endAll();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return origClose(cb);
  };
  return server;
}

#!/usr/bin/env node
// eval-server.mjs — thin persistent Node bridge for memory-core-eval's Python harness.
//
// Why this exists: memory-core-eval (github.com/Evanyuan-builder/memory-core-eval) is a
// Python retrieval-recall benchmark; samemind is Node/ESM. There is no native "store one raw
// conversation turn" API in samemind (the only MCP write path is memory_write_inbox, which
// appends to a single unstructured file — not discrete, indexable, session/turn-tagged nodes).
// So this bridge writes each Turn as its own markdown node directly into a scratch bundle
// directory (bypassing MCP entirely — real files, real frontmatter, auditable on disk), and
// answers `search` by calling samemind's own default recall path in-process:
// tools/lib/recall.mjs's `rankByKeywords()`, which itself is a thin wrapper over
// tools/lib/bm25.mjs's Okapi BM25 (the exact function samemind's `recallSearch()` falls back to
// when no semantic index/embeddings endpoint is configured — the honest zero-dep default).
//
// Deliberately NOT reusing okf.mjs's `walk()+parse()` on every search: that re-walks and
// re-parses the whole bundle from disk on every call (see recon note — real but tolerable
// per-call overhead for samemind's normal curated-concept scale, not for a few hundred turn
// files per benchmark question re-parsed on every single search). Instead we keep an
// in-memory, per-namespace doc list in lockstep with what's written to disk (write-through:
// every store() both writes the .md file AND appends the equivalent parsed-doc shape to the
// in-memory list used for search), so `rankByKeywords` runs against the same in-process data
// structure samemind's real recall path consumes — just without a redundant disk re-read.
//
// Deliberately NOT setting `fm.timestamp` on Turn nodes: tools/lib/hygiene.mjs's
// `decayMultiplier()` applies a rank *penalty* once a doc's `fm.timestamp` is older than 180
// days (floors at 0.6x by 720 days) — a mechanism designed to age out stale curated concepts,
// not raw conversation turns. LongMemEval sessions are dated ~2023; against a 2026 wall clock
// that's >180 days for every single turn, so this multiplier would apply near-uniformly across
// a question's whole haystack — not clearly wrong, but exactly the failure class the recon
// flagged (old-but-gold sessions penalized for age, not relevance). Turn timestamps are kept
// in frontmatter as `session_date` (inert, ignored by hygiene.mjs) instead — see RESULTS.md
// "what this benchmark doesn't see" for the honest accounting of what that costs us
// (as_of_date / temporal-reasoning support).
//
// Protocol: newline-free JSON over local HTTP (127.0.0.1 only), one request per adapter call.
//   GET  /health                                  -> { status, namespaces }
//   POST /reset       { namespace }                -> { ok: true }
//   POST /store       { namespace, turn }           -> { id }
//   POST /store_batch { namespace, turns: [...] }   -> { ids: [...] }
//   POST /search      { namespace, query, top_k }   -> { memories: [...] }
//
// turn = { content, role, session_id, turn_idx, session_idx, timestamp? } (mirrors mceval's
// Turn dataclass). as_of_date is accepted on /search for protocol symmetry but ignored (see
// above) — same stance bm25_baseline.py in the harness itself takes ("time-agnostic by design").
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const { rankByKeywords, recallSearch, fetchEmbedding } = await import(join(REPO_ROOT, 'tools/lib/recall.mjs'));

const PORT = Number(process.env.EVAL_BRIDGE_PORT || 8799);
const BUNDLE_ROOT = process.env.SAMEMIND_BENCH_BUNDLE_DIR
  ? (mkdirSync(process.env.SAMEMIND_BENCH_BUNDLE_DIR, { recursive: true }), process.env.SAMEMIND_BENCH_BUNDLE_DIR)
  : mkdtempSync(join(tmpdir(), 'samemind-mceval-'));

// Ф3 (hybrid retrieval bench): default is unchanged pure-BM25 (rankByKeywords), exactly as before
// this addition — set EVAL_SEARCH_MODE=hybrid to instead fuse BM25+semantic via RRF
// (tools/lib/recall.mjs recallSearch mode='hybrid') for an honest bm25-vs-hybrid comparison run.
// Needs OKF_EMBED_URL (+ optionally OKF_EMBED_MODEL/OKF_EMBED_KEY) — same env the rest of
// samemind's semantic path uses. Falls back to bm25 (with a one-time console warning) if hybrid
// was requested but no embeddings endpoint is configured — never silently changes the metric.
const SEARCH_MODE = (process.env.EVAL_SEARCH_MODE || 'bm25').toLowerCase();
const EMBED_URL = process.env.OKF_EMBED_URL || null;
const EMBED_MODEL = process.env.OKF_EMBED_MODEL || 'bge-m3';
const EMBED_KEY = process.env.OKF_EMBED_KEY;
const EMBED_BATCH_SIZE = 32; // matches the local omlx server's configured embedding_batch_size — no oversized batches
const hybridReady = SEARCH_MODE === 'hybrid' && !!EMBED_URL;
if (SEARCH_MODE === 'hybrid' && !EMBED_URL) {
  console.error('EVAL_SEARCH_MODE=hybrid requested but OKF_EMBED_URL is unset — running bm25 instead');
}
console.error(`search mode: ${hybridReady ? 'hybrid (RRF, BM25+semantic)' : 'bm25'}`);

/** Batched turn-ingestion embedding: one HTTP call per EMBED_BATCH_SIZE turns, not one per turn —
 *  LongMemEval sessions run ~490 turns/question, so per-turn requests would be needless HTTP
 *  overhead for no benefit (the OpenAI-compatible endpoint already accepts an array `input`). Best
 *  effort: a failed chunk is logged and skipped (those turns just stay BM25-only — searchNamespace/
 *  RRF tolerate a doc missing from the semantic list), never fatal to the whole eval run. */
async function embedBatch(texts) {
  const vectors = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const chunk = texts.slice(i, i + EMBED_BATCH_SIZE).map(t => (t || '').slice(0, 5000));
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (EMBED_KEY) headers.Authorization = `Bearer ${EMBED_KEY}`;
      const r = await fetch(EMBED_URL, { method: 'POST', headers, body: JSON.stringify({ model: EMBED_MODEL, input: chunk }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = (await r.json())?.data;
      if (!Array.isArray(data) || data.length !== chunk.length) throw new Error('unexpected embeddings response shape');
      data.forEach((d, j) => { vectors[i + j] = d.embedding; });
    } catch (e) {
      console.error(`⚠ embedBatch chunk [${i}, ${i + chunk.length}) failed (${e.message}) — those turns stay BM25-only`);
    }
  }
  return vectors;
}
const embedQuery = text => fetchEmbedding(text, { url: EMBED_URL, model: EMBED_MODEL, key: EMBED_KEY });

// namespace -> { dir, docs: [{id, reserved:false, fm:{visibility,type}, body, file}], meta: Map(id -> {session_id, turn_idx, session_idx}), counter, idx: {items:{}} }
const STORE = new Map();

function safeSlug(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

function ensureNamespace(namespace) {
  let ns = STORE.get(namespace);
  if (!ns) {
    const dir = join(BUNDLE_ROOT, safeSlug(namespace) || 'ns');
    mkdirSync(dir, { recursive: true });
    ns = { dir, docs: [], meta: new Map(), counter: 0, idx: { items: {} } };
    STORE.set(namespace, ns);
  }
  return ns;
}

function resetNamespace(namespace) {
  const ns = STORE.get(namespace);
  if (ns) {
    try { rmSync(ns.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  STORE.delete(namespace);
}

function storeTurn(namespace, turn) {
  const ns = ensureNamespace(namespace);
  const i = ns.counter++;
  const id = `${namespace}#${i}`;
  const sessionSlug = safeSlug(turn.session_id);
  const filename = `t${String(i).padStart(6, '0')}-s${turn.session_idx ?? 0}-${sessionSlug}-turn${turn.turn_idx}.md`;
  const file = join(ns.dir, filename);

  const fmLines = [
    '---',
    'type: Turn',
    `role: ${turn.role || 'user'}`,
    `session: ${turn.session_id}`,
    `session_idx: ${turn.session_idx ?? 0}`,
    `turn: ${turn.turn_idx}`,
  ];
  if (turn.timestamp) fmLines.push(`session_date: ${turn.timestamp}`); // inert — see header note
  fmLines.push('visibility: internal', 'source: longmemeval-bench', '---', '');
  writeFileSync(file, fmLines.join('\n') + (turn.content || ''), 'utf8');

  const doc = {
    id,
    reserved: false,
    fm: { visibility: 'internal', type: 'Turn' },
    body: turn.content || '',
    file,
  };
  ns.docs.push(doc);
  ns.meta.set(id, {
    session_id: turn.session_id ?? null,
    turn_idx: turn.turn_idx ?? null,
    session_idx: turn.session_idx ?? 0,
  });
  return id;
}

/** Embeds every not-yet-indexed doc in the namespace (batched) into ns.idx.items — called right
 *  before a hybrid search, not at store time: the runner stores all of a question's turns in a
 *  tight loop then searches once (see samemind_adapter.py), so embedding once per question here
 *  is the same total cost as embedding at store time, with one fewer place doing it. */
async function ensureNamespaceIndexed(ns) {
  const missing = ns.docs.filter(d => !ns.idx.items[d.id]);
  if (!missing.length) return;
  const vectors = await embedBatch(missing.map(d => d.body));
  missing.forEach((d, i) => {
    if (vectors[i]) ns.idx.items[d.id] = { vector: vectors[i], title: d.id, type: 'Turn', visibility: 'internal' };
  });
}

async function searchNamespace(namespace, query, topK) {
  const ns = STORE.get(namespace);
  if (!ns || !ns.docs.length) return [];
  // includeMirror:true is a no-op here (no doc ever has visibility:'mirror'); kept explicit to
  // match recallSearch()'s own default rather than silently relying on rankByKeywords' default.
  if (hybridReady) {
    await ensureNamespaceIndexed(ns);
    const { hits } = await recallSearch({
      docs: ns.docs, query, mode: 'hybrid', embed: embedQuery, idx: ns.idx,
      k: topK, includeSecret: false, includeMirror: true,
    });
    return hits.map(h => {
      const m = ns.meta.get(h.id) || {};
      return {
        id: h.id,
        content: h.body ?? ns.docs.find(d => d.id === h.id)?.body ?? '',
        score: h.score,
        session_id: m.session_id ?? null,
        turn_idx: m.turn_idx ?? null,
        session_idx: m.session_idx ?? null,
      };
    });
  }
  const hits = rankByKeywords(ns.docs, query, { k: topK, includeSecret: false, includeMirror: true });
  return hits.map(h => {
    const m = ns.meta.get(h.id) || {};
    return {
      id: h.id,
      content: h.body ?? '',
      score: h.score,
      session_id: m.session_id ?? null,
      turn_idx: m.turn_idx ?? null,
      session_idx: m.session_idx ?? null,
    };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { status: 'ok', namespaces: STORE.size, bundle_root: BUNDLE_ROOT });
    }
    if (req.method === 'POST' && req.url === '/reset') {
      const { namespace } = await readBody(req);
      resetNamespace(namespace);
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/store') {
      const { namespace, turn } = await readBody(req);
      const id = storeTurn(namespace, turn || {});
      return send(200, { id });
    }
    if (req.method === 'POST' && req.url === '/store_batch') {
      const { namespace, turns } = await readBody(req);
      const ids = (turns || []).map(t => storeTurn(namespace, t));
      return send(200, { ids });
    }
    if (req.method === 'POST' && req.url === '/search') {
      const { namespace, query, top_k } = await readBody(req);
      const memories = await searchNamespace(namespace, query || '', top_k || 10);
      return send(200, { memories });
    }
    send(404, { error: `not found: ${req.method} ${req.url}` });
  } catch (e) {
    send(500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`samemind eval-bridge listening on http://127.0.0.1:${PORT} (bundle root: ${BUNDLE_ROOT})`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

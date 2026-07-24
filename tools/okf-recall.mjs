#!/usr/bin/env node
// okf-recall.mjs — search over an OKF bundle: semantic (any OpenAI-compatible embeddings endpoint)
//   or a local BM25 fallback with no network and no dependencies. The embeddings index is local.
//   node tools/okf-recall.mjs index [--include-mirror] [--include-secret] [--include-inbox]   # build the semantic index (needs OKF_EMBED_URL)
//   node tools/okf-recall.mjs "<query>" [-k N] [--mode bm25|semantic|hybrid|auto] [--include-mirror] [--include-secret] [--include-inbox] [--no-global]
// Modes: auto (default) — semantic if an index exists and the endpoint answers, otherwise BM25;
//        bm25 — always local keyword/BM25; semantic — strictly semantic (no silent fallback);
//        hybrid (Ф3) — BM25 ⊕ semantic fused via Reciprocal Rank Fusion (k=60, see lib/recall.mjs
//        rrfFuse); falls back to BM25 (never throws) if the index/endpoint is unavailable.
// Tiers: curated (default) · mirror (live-memory mirror) · secret (/secret) · inbox (raw notes
//   awaiting curation, opt-in — mainly for tools/consolidate.mjs, see issue #4).
// Multi-root (U5/G-B, "Same mind"): query results also fold in the global personal bundle
// ($HOME/.samemind/bundle by default, override via OKF_GLOBAL_ROOT — empty value disables it) —
// its hits print with a `global:` id prefix. `--no-global` skips the second load entirely. No
// global bundle on disk and no OKF_GLOBAL_ROOT set → output is byte-identical to project-only
// search (see tools/lib/compose-roots.mjs).
// Endpoint/model/key: OKF_EMBED_URL / OKF_EMBED_MODEL / OKF_EMBED_KEY (Bearer).
//
// Ф4 — index backend: sqlite-vec (tools/.index/index.db, binary Float32 vectors, KNN in C) is
// tried first; a clean fallback to the flat-JSON index (tools/.index/embeddings.json, linear
// cosine scan) kicks in whenever sqlite-vec isn't available (optionalDependency not installed, no
// prebuilt native binary for this platform, or any load error) — never a crash, just a one-line
// stderr note. An existing embeddings.json is migrated into index.db on first sqlite-backed run,
// with no re-embedding (see lib/sqlite-index.mjs migrateJsonIndex). Force a backend for testing/
// troubleshooting via OKF_INDEX_BACKEND=sqlite|json (default: auto).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, syncIndex, indexKey, recallSearch,
} from './lib/recall.mjs';
import {
  openVecStore, closeVecStore, syncVecStore, searchVecStore, vecStoreCount, migrateJsonIndex,
} from './lib/sqlite-index.mjs';
import { readEvents } from './lib/ledger.mjs';
import { resolveGlobalRoot, searchGlobalHalf, mergeWithGlobal } from './lib/compose-roots.mjs';
import { atomicWriteJsonSync } from '../lib/atomic-write.mjs';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
const IDX_DIR = join(ROOT, 'tools', '.index');
const IDX = join(IDX_DIR, 'embeddings.json');
const IDX_DB = join(IDX_DIR, 'index.db');
const INDEX_BACKEND = process.env.OKF_INDEX_BACKEND || 'auto'; // auto | sqlite | json

const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: MODEL });

/** Opens the sqlite-vec store unless OKF_INDEX_BACKEND=json, migrating an existing embeddings.json
 *  in on first use. Returns null (with an honest one-line stderr note) on ANY unavailability —
 *  callers then use the unchanged JSON loadIdx()/saveIdx() path below. Never throws. */
async function openBackend() {
  if (INDEX_BACKEND === 'json') return null;
  const store = await openVecStore({ dbPath: IDX_DB, model: MODEL });
  if (!store.ok) {
    console.error(`sqlite-vec unavailable, JSON fallback (${store.reason})`);
    return null;
  }
  if (vecStoreCount(store) === 0 && existsSync(IDX)) {
    const jsonIdx = loadIdx();
    const n = Object.keys(jsonIdx.items).length;
    if (n) {
      migrateJsonIndex(store, jsonIdx);
      console.error(`migrated ${n} item(s) from embeddings.json → index.db`);
    }
  }
  return store;
}

export function loadIdx() {
  if (!existsSync(IDX)) return { model: MODEL, items: {} };
  try {
    const idx = JSON.parse(readFileSync(IDX, 'utf8'));
    if (!idx || typeof idx.items !== 'object') throw new Error('invalid index schema');
    return idx;
  } catch (e) {
    console.warn(`corrupt index ${IDX} — rebuild it: node tools/okf-recall.mjs index (${e.message})`);
    return { model: MODEL, items: {} };
  }
}

export function saveIdx(idx) {
  mkdirSync(IDX_DIR, { recursive: true });
  atomicWriteJsonSync(IDX, idx);
}

const MODES = ['bm25', 'semantic', 'hybrid', 'auto'];

export function parseArgs(argv = process.argv.slice(2)) {
  const includeSecret = argv.includes('--include-secret');
  const includeMirror = argv.includes('--include-mirror');
  const includeInbox = argv.includes('--include-inbox');
  const includeSuperseded = argv.includes('--include-superseded');
  const noGlobal = argv.includes('--no-global');
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 5 : 5;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'auto';
  if (!MODES.includes(mode)) {
    throw new Error(`unknown --mode: ${mode} (allowed: ${MODES.join('|')})`);
  }
  const ei = argv.indexOf('--exclude-source');
  const excludeSource = ei >= 0 ? argv[ei + 1] : null;
  const ai = argv.indexOf('--as-of');
  const asOf = ai >= 0 ? argv[ai + 1] : null;
  if (ai >= 0 && !asOf) throw new Error('--as-of requires an ISO date (e.g. 2025-06-01)');
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(mi >= 0 && i === mi + 1)
    && !(ei >= 0 && i === ei + 1)
    && !(ai >= 0 && i === ai + 1));
  return {
    positional, k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal,
    includeSuperseded, asOf,
  };
}

async function buildIndex(includeSecret, includeMirror, includeInbox) {
  const docs = load({ includeSecret, includeMirror, includeInbox }).filter(d => !d.reserved);
  const store = await openBackend();
  if (store) {
    const { built, reused, total } = await syncVecStore(store, docs, embed, { includeSecret, includeMirror });
    closeVecStore(store);
    console.log(`index (sqlite-vec): ${built} new/changed, ${reused} unchanged, ${total} total (model ${MODEL})`);
    return;
  }
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const { built, reused, total } = await syncIndex(idx, docs, embed, { includeSecret, includeMirror });
  saveIdx(idx);
  console.log(`index (json): ${built} new/changed, ${reused} unchanged, ${total} total (model ${MODEL})`);
}

async function query(q, k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal, {
  includeSuperseded = false, asOf = null,
} = {}) {
  // BM25 ranks over concept bodies, so we load the bundle in every mode.
  const docs = load({ includeSecret, includeMirror, includeInbox }).filter(d => !d.reserved);
  const store = await openBackend();
  const idx = store ? null : loadIdx();
  const projectResult = await recallSearch({
    docs, query: q, mode, embed, idx: idx || { items: {} }, k, includeSecret, includeMirror, excludeSource,
    vecStore: store, vecSearch: store ? searchVecStore : null, vecCount: store ? vecStoreCount : null,
    events: readEvents(ROOT), // Ф5: tiered heat, same hygiene pass
    includeSuperseded, asOf,
  });
  if (store) closeVecStore(store);

  // U5/G-B: "Same mind" — merge in the optional global personal bundle. resolveGlobalRoot()
  // returns null on --no-global / OKF_GLOBAL_ROOT='' / unset+missing-on-disk, in which case
  // searchGlobalHalf short-circuits and mergeWithGlobal passes projectResult through UNCHANGED —
  // byte-identical to pre-G-B output.
  const globalRoot = resolveGlobalRoot({ noGlobal });
  const globalHalf = await searchGlobalHalf(globalRoot, docs, {
    loadOpts: { includeSecret, includeMirror, includeInbox },
    query: q, mode, embed, k, includeSecret, includeMirror, excludeSource, model: MODEL,
    includeSuperseded, asOf,
  });
  const { hits, mode: used, warning, dedupWarnings } = mergeWithGlobal(projectResult, globalHalf, k);

  if (warning) console.error(`⚠ ${warning}`);
  if (dedupWarnings) for (const w of dedupWarnings) console.error(`⚠ ${w}`);
  // Score scale differs by mode — bm25 is unbounded BM25, semantic is cosine (-1..1), hybrid is
  // an RRF-fused rank score (Σ 1/(k+rank+1), k=60) that is SMALL BY DESIGN (~0.01-0.03 for a
  // top hit) and must never be read as a cosine value — label it so nobody mistakes a healthy
  // hybrid result for a broken/near-zero embedding.
  const scoreKind = { bm25: 'bm25', semantic: 'cos', hybrid: 'rrf' }[used] || used;
  console.log(`# "${q}" → top-${k} [${used}, score=${scoreKind}]`);
  for (const r of hits) {
    const idOut = r.source === 'global' ? `global:${r.id}` : r.id;
    console.log(`${r.score.toFixed(3)}  ${(r.type || '').padEnd(10)} ${idOut} — ${r.title || ''}${r.label ? '  ' + r.label : ''}`);
  }
  if (!hits.length) console.log('(nothing found)');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const {
    positional, k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal,
    includeSuperseded, asOf,
  } = parseArgs();
  try {
    if (positional[0] === 'index') await buildIndex(includeSecret, includeMirror, includeInbox);
    else if (positional.length) {
      await query(positional.join(' '), k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal, {
        includeSuperseded, asOf,
      });
    } else {
      console.log('Usage: okf-recall.mjs index | "<query>" [-k N] [--mode bm25|semantic|hybrid|auto] [--include-mirror] [--include-secret] [--include-inbox] [--include-superseded] [--as-of <ISO>] [--exclude-source <id>] [--no-global]');
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (mode !== 'bm25') console.error('Hint: --mode bm25 searches without an endpoint; --mode auto (default) enables semantic search when OKF_EMBED_URL is set.');
    process.exit(1);
  }
}

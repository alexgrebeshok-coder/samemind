#!/usr/bin/env node
// gde.mjs — "where did I write about X": human-readable search over an OKF bundle.
//   semantic (if an index exists and OKF_EMBED_URL answers), otherwise a local BM25 fallback.
//   node tools/gde.mjs "where did I write about ..." [-k N] [--secret] [--reindex] [--no-global]
// mirror is included by default; secret — only with --secret.
// Multi-root (U5/G-B, "Same mind"): also searches the global personal bundle ($HOME/.samemind/
// bundle, override OKF_GLOBAL_ROOT) — its hits are marked "global: " in the output. --no-global
// skips it. No global bundle / OKF_GLOBAL_ROOT unset → output byte-identical to before G-B.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, syncIndex, indexKey,
  checkIndexStale, extractSnippet, recallSearch,
} from './lib/recall.mjs';
import {
  openVecStore, closeVecStore, syncVecStore, searchVecStore, vecStoreCount, migrateJsonIndex,
} from './lib/sqlite-index.mjs';
import { readEvents } from './lib/ledger.mjs';
import { resolveGlobalRoot, searchGlobalHalf, mergeWithGlobal } from './lib/compose-roots.mjs';
import { atomicWriteJsonSync } from '../lib/atomic-write.mjs';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
export const IDX_DIR = join(ROOT, 'tools', '.index');
export const IDX = join(IDX_DIR, 'embeddings.json');
const IDX_DB = join(IDX_DIR, 'index.db');
const INDEX_BACKEND = process.env.OKF_INDEX_BACKEND || 'auto'; // auto | sqlite | json

const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: MODEL });

/** Opens the sqlite-vec store unless OKF_INDEX_BACKEND=json, migrating an existing embeddings.json
 *  in on first use. Returns null (never throws) on ANY unavailability — same DI-pattern as
 *  okf-recall.mjs's openBackend(); callers then use the unchanged JSON loadIdx()/saveIdx() path. */
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
    console.warn(`corrupt index ${IDX} — rebuild it: node tools/gde.mjs "…" --reindex (${e.message})`);
    return { model: MODEL, items: {} };
  }
}

export function saveIdx(idx) {
  mkdirSync(IDX_DIR, { recursive: true });
  atomicWriteJsonSync(IDX, idx);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const includeSecret = argv.includes('--secret');
  const reindex = argv.includes('--reindex');
  const noGlobal = argv.includes('--no-global');
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 7 : 7;
  const ei = argv.indexOf('--exclude-source');
  const excludeSource = ei >= 0 ? argv[ei + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(ei >= 0 && i === ei + 1));
  const query = positional.join(' ').trim();
  return { query, k, includeSecret, includeMirror: true, reindex, excludeSource, noGlobal };
}

export async function buildIndex({ includeSecret, includeMirror }) {
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
  const store = await openBackend();
  if (store) {
    const stats = await syncVecStore(store, docs, embed, { includeSecret, includeMirror });
    closeVecStore(store);
    return stats;
  }
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const stats = await syncIndex(idx, docs, embed, { includeSecret, includeMirror });
  saveIdx(idx);
  return stats;
}

/** Enriches a hit with a snippet + absolute path. */
export function enrichResults(hits, docById, query) {
  return hits.map(h => {
    const doc = docById.get(h.id);
    const file = resolve(doc?.file || join(ROOT, `${h.id}.md`));
    const body = doc?.body || '';
    return {
      ...h,
      file,
      snippet: extractSnippet(body, query, { contextLines: 1 }),
    };
  });
}

export function formatResults(query, results, { k, mode, staleWarning }) {
  const lines = [];
  if (staleWarning) lines.push(`⚠ ${staleWarning}`);
  lines.push(`# "${query}" → top-${k} [${mode}]`);
  if (!results.length) {
    lines.push('(nothing found)');
    return lines.join('\n');
  }
  results.forEach((r, i) => {
    lines.push('');
    const prefix = r.source === 'global' ? 'global: ' : '';
    lines.push(`${i + 1}. ${prefix}${r.title || r.id}${r.label ? '  ' + r.label : ''}`);
    lines.push(`   ${r.type || '—'} · score ${r.score.toFixed(3)}`);
    lines.push(`   ${r.file}`);
    if (r.snippet) {
      for (const line of r.snippet.split('\n')) lines.push(`   │ ${line}`);
    }
  });
  return lines.join('\n');
}

export async function search(query, opts) {
  const {
    k, includeSecret, includeMirror, reindex, mode = 'auto', excludeSource = null, noGlobal = false,
  } = opts;
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
  const docById = new Map(docs.map(d => [d.id, d]));
  let staleWarning = null;

  if (reindex) {
    try {
      const stats = await buildIndex({ includeSecret, includeMirror });
      console.error(`index updated: ${stats.built} new/changed, ${stats.reused} unchanged, ${stats.total} total`);
    } catch (e) {
      console.error(`⚠ reindex failed (${e.message}) — falling back to BM25`);
    }
  }

  const store = await openBackend();
  // checkIndexStale is a flat-JSON-index freshness check (mtime + sampled content-hash against
  // embeddings.json) — meaningless once sqlite-vec is the active backend (syncVecStore already
  // keeps index.db current per-doc on every --reindex); only run it on the JSON fallback path.
  if (!store) {
    const { stale, reasons } = checkIndexStale(loadIdx(), docs, { idxPath: IDX });
    if (stale) staleWarning = `index is stale (${reasons.join('; ')}), add --reindex`;
  }

  // Единый механизм поиска/фолбэка — из lib (разделяется с okf-recall).
  const idx = store ? null : loadIdx();
  const projectResult = await recallSearch({
    docs, query, mode, embed, idx: idx || { items: {} }, k, includeSecret, includeMirror, excludeSource,
    vecStore: store, vecSearch: store ? searchVecStore : null, vecCount: store ? vecStoreCount : null,
    events: readEvents(ROOT), // Ф5: tiered heat, same hygiene pass
  });
  if (store) closeVecStore(store);

  // U5/G-B: "Same mind" — fold in the optional global personal bundle (null globalRoot →
  // searchGlobalHalf short-circuits, mergeWithGlobal passes projectResult through UNCHANGED).
  const globalRoot = resolveGlobalRoot({ noGlobal });
  const globalHalf = await searchGlobalHalf(globalRoot, docs, {
    loadOpts: { includeSecret, includeMirror }, query, mode, embed, k, includeSecret, includeMirror,
    excludeSource, model: MODEL,
  });
  const { hits, mode: used, warning, dedupWarnings } = mergeWithGlobal(projectResult, globalHalf, k);
  if (warning) console.error(`⚠ ${warning}`);
  if (dedupWarnings) for (const w of dedupWarnings) console.error(`⚠ ${w}`);

  const combinedDocById = globalHalf ? new Map([...docById, ...globalHalf.docs.map(d => [d.id, d])]) : docById;
  const results = enrichResults(hits, combinedDocById, query);
  return { results, mode: used, staleWarning };
}

async function main() {
  const opts = parseArgs();
  if (!opts.query) {
    console.log('Usage: node tools/gde.mjs "<query>" [-k N] [--secret] [--reindex] [--exclude-source <id>] [--no-global]');
    console.log('  mirror is included by default; secret — only with --secret');
    process.exit(0);
  }
  const { results, mode, staleWarning } = await search(opts.query, opts);
  console.log(formatResults(opts.query, results, { k: opts.k, mode, staleWarning }));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// okf-recall.mjs — search over an OKF bundle: semantic (any OpenAI-compatible embeddings endpoint)
//   or a local BM25 fallback with no network and no dependencies. The embeddings index is local.
//   node tools/okf-recall.mjs index [--include-mirror] [--include-secret] [--include-inbox]   # build the semantic index (needs OKF_EMBED_URL)
//   node tools/okf-recall.mjs "<query>" [-k N] [--mode bm25|semantic|auto] [--include-mirror] [--include-secret] [--include-inbox]
// Modes: auto (default) — semantic if an index exists and the endpoint answers, otherwise BM25;
//        bm25 — always local keyword/BM25; semantic — strictly semantic (no silent fallback).
// Tiers: curated (default) · mirror (live-memory mirror) · secret (/secret) · inbox (raw notes
//   awaiting curation, opt-in — mainly for tools/consolidate.mjs, see issue #4).
// Endpoint/model/key: OKF_EMBED_URL / OKF_EMBED_MODEL / OKF_EMBED_KEY (Bearer).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, syncIndex, indexKey, recallSearch,
} from './lib/recall.mjs';
import { atomicWriteJsonSync } from '../lib/atomic-write.mjs';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
const IDX_DIR = join(ROOT, 'tools', '.index');
const IDX = join(IDX_DIR, 'embeddings.json');

const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: MODEL });

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

const MODES = ['bm25', 'semantic', 'auto'];

export function parseArgs(argv = process.argv.slice(2)) {
  const includeSecret = argv.includes('--include-secret');
  const includeMirror = argv.includes('--include-mirror');
  const includeInbox = argv.includes('--include-inbox');
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 5 : 5;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'auto';
  if (!MODES.includes(mode)) {
    throw new Error(`unknown --mode: ${mode} (allowed: ${MODES.join('|')})`);
  }
  const ei = argv.indexOf('--exclude-source');
  const excludeSource = ei >= 0 ? argv[ei + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(mi >= 0 && i === mi + 1)
    && !(ei >= 0 && i === ei + 1));
  return { positional, k, includeSecret, includeMirror, includeInbox, mode, excludeSource };
}

async function buildIndex(includeSecret, includeMirror, includeInbox) {
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const docs = load({ includeSecret, includeMirror, includeInbox }).filter(d => !d.reserved);
  const { built, reused, total } = await syncIndex(idx, docs, embed, { includeSecret, includeMirror });
  saveIdx(idx);
  console.log(`index: ${built} new/changed, ${reused} unchanged, ${total} total (model ${MODEL})`);
}

async function query(q, k, includeSecret, includeMirror, includeInbox, mode, excludeSource) {
  // BM25 ranks over concept bodies, so we load the bundle in every mode.
  const docs = load({ includeSecret, includeMirror, includeInbox }).filter(d => !d.reserved);
  const idx = loadIdx();
  const { hits, mode: used, warning } = await recallSearch({
    docs, query: q, mode, embed, idx, k, includeSecret, includeMirror, excludeSource,
  });
  if (warning) console.error(`⚠ ${warning}`);
  console.log(`# "${q}" → top-${k} [${used}]`);
  for (const r of hits) {
    console.log(`${r.score.toFixed(3)}  ${(r.type || '').padEnd(10)} ${r.id} — ${r.title || ''}${r.label ? '  ' + r.label : ''}`);
  }
  if (!hits.length) console.log('(nothing found)');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { positional, k, includeSecret, includeMirror, includeInbox, mode, excludeSource } = parseArgs();
  try {
    if (positional[0] === 'index') await buildIndex(includeSecret, includeMirror, includeInbox);
    else if (positional.length) await query(positional.join(' '), k, includeSecret, includeMirror, includeInbox, mode, excludeSource);
    else console.log('Usage: okf-recall.mjs index | "<query>" [-k N] [--mode bm25|semantic|auto] [--include-mirror] [--include-secret] [--include-inbox] [--exclude-source <id>]');
  } catch (e) {
    console.error('Error:', e.message);
    if (mode !== 'bm25') console.error('Hint: --mode bm25 searches without an endpoint; --mode auto (default) enables semantic search when OKF_EMBED_URL is set.');
    process.exit(1);
  }
}

#!/usr/bin/env node
// gde.mjs — "where did I write about X": human-readable search over an OKF bundle.
//   semantic (if an index exists and OKF_EMBED_URL answers), otherwise a local BM25 fallback.
//   node tools/gde.mjs "where did I write about ..." [-k N] [--secret] [--reindex]
// mirror is included by default; secret — only with --secret.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, syncIndex, indexKey,
  checkIndexStale, extractSnippet, recallSearch,
} from './lib/recall.mjs';
import { atomicWriteJsonSync } from '../lib/atomic-write.mjs';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
export const IDX_DIR = join(ROOT, 'tools', '.index');
export const IDX = join(IDX_DIR, 'embeddings.json');

const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: MODEL });

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
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 7 : 7;
  const ei = argv.indexOf('--exclude-source');
  const excludeSource = ei >= 0 ? argv[ei + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(ei >= 0 && i === ei + 1));
  const query = positional.join(' ').trim();
  return { query, k, includeSecret, includeMirror: true, reindex, excludeSource };
}

export async function buildIndex({ includeSecret, includeMirror }) {
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
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
    lines.push(`${i + 1}. ${r.title || r.id}${r.label ? '  ' + r.label : ''}`);
    lines.push(`   ${r.type || '—'} · score ${r.score.toFixed(3)}`);
    lines.push(`   ${r.file}`);
    if (r.snippet) {
      for (const line of r.snippet.split('\n')) lines.push(`   │ ${line}`);
    }
  });
  return lines.join('\n');
}

export async function search(query, opts) {
  const { k, includeSecret, includeMirror, reindex, mode = 'auto', excludeSource = null } = opts;
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
  } else {
    const { stale, reasons } = checkIndexStale(loadIdx(), docs, { idxPath: IDX });
    if (stale) staleWarning = `index is stale (${reasons.join('; ')}), add --reindex`;
  }

  // Единый механизм поиска/фолбэка — из lib (разделяется с okf-recall).
  const { hits, mode: used, warning } = await recallSearch({
    docs, query, mode, embed, idx: loadIdx(), k, includeSecret, includeMirror, excludeSource,
  });
  if (warning) console.error(`⚠ ${warning}`);
  const results = enrichResults(hits, docById, query);
  return { results, mode: used, staleWarning };
}

async function main() {
  const opts = parseArgs();
  if (!opts.query) {
    console.log('Usage: node tools/gde.mjs "<query>" [-k N] [--secret] [--reindex] [--exclude-source <id>]');
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

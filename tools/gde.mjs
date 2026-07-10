#!/usr/bin/env node
// gde.mjs — «где я писал про X»: человекочитаемый поиск по OKF-bundle.
//   semantic (если есть индекс и отвечает OKF_EMBED_URL), иначе локальный BM25-фолбэк.
//   node tools/gde.mjs "где я писал про ..." [-k N] [--secret] [--reindex]
// mirror включён по умолчанию; secret — только с --secret.
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
    if (!idx || typeof idx.items !== 'object') throw new Error('неверная схема индекса');
    return idx;
  } catch (e) {
    console.warn(`битый индекс ${IDX} — пересобери: node tools/gde.mjs "…" --reindex (${e.message})`);
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
  const positional = argv.filter((a, i) => !a.startsWith('-') && !(ki >= 0 && i === ki + 1));
  const query = positional.join(' ').trim();
  return { query, k, includeSecret, includeMirror: true, reindex };
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

/** Обогащает hit snippet + абсолютный путь. */
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
  lines.push(`# «${query}» → топ-${k} [${mode}]`);
  if (!results.length) {
    lines.push('(ничего не найдено)');
    return lines.join('\n');
  }
  results.forEach((r, i) => {
    lines.push('');
    lines.push(`${i + 1}. ${r.title || r.id}`);
    lines.push(`   ${r.type || '—'} · score ${r.score.toFixed(3)}`);
    lines.push(`   ${r.file}`);
    if (r.snippet) {
      for (const line of r.snippet.split('\n')) lines.push(`   │ ${line}`);
    }
  });
  return lines.join('\n');
}

export async function search(query, opts) {
  const { k, includeSecret, includeMirror, reindex, mode = 'auto' } = opts;
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
  const docById = new Map(docs.map(d => [d.id, d]));
  let staleWarning = null;

  if (reindex) {
    try {
      const stats = await buildIndex({ includeSecret, includeMirror });
      console.error(`индекс обновлён: ${stats.built} новых/изменённых, ${stats.reused} без изменений, всего ${stats.total}`);
    } catch (e) {
      console.error(`⚠ reindex не удался (${e.message}) — продолжаю BM25`);
    }
  } else {
    const { stale, reasons } = checkIndexStale(loadIdx(), docs, { idxPath: IDX });
    if (stale) staleWarning = `индекс устарел (${reasons.join('; ')}), добавь --reindex`;
  }

  // Единый механизм поиска/фолбэка — из lib (разделяется с okf-recall).
  const { hits, mode: used, warning } = await recallSearch({
    docs, query, mode, embed, idx: loadIdx(), k, includeSecret, includeMirror,
  });
  if (warning) console.error(`⚠ ${warning}`);
  const results = enrichResults(hits, docById, query);
  return { results, mode: used, staleWarning };
}

async function main() {
  const opts = parseArgs();
  if (!opts.query) {
    console.log('Usage: node tools/gde.mjs "<запрос>" [-k N] [--secret] [--reindex]');
    console.log('  mirror включён по умолчанию; secret — только с --secret');
    process.exit(0);
  }
  const { results, mode, staleWarning } = await search(opts.query, opts);
  console.log(formatResults(opts.query, results, { k: opts.k, mode, staleWarning }));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Ошибка:', e.message);
    process.exit(1);
  });
}

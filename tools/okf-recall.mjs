#!/usr/bin/env node
// okf-recall.mjs — поиск по OKF-bundle: семантика (любой OpenAI-совместимый embeddings-эндпоинт)
//   или локальный BM25-фолбэк без сети и без зависимостей. Индекс эмбеддингов локальный.
//   node tools/okf-recall.mjs index [--include-mirror] [--include-secret]   # построить семантический индекс (нужен OKF_EMBED_URL)
//   node tools/okf-recall.mjs "<запрос>" [-k N] [--mode bm25|semantic|auto] [--include-mirror] [--include-secret]
// Режимы: auto (дефолт) — семантика если есть индекс и отвечает эндпоинт, иначе BM25;
//         bm25 — всегда локальный keyword/BM25; semantic — строго семантика (без тихого фолбэка).
// Тиры: курированное (дефолт) · mirror (зеркало живой памяти) · secret (/secret).
// Эндпоинт/модель/ключ: OKF_EMBED_URL / OKF_EMBED_MODEL / OKF_EMBED_KEY (Bearer).
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
    if (!idx || typeof idx.items !== 'object') throw new Error('неверная схема индекса');
    return idx;
  } catch (e) {
    console.warn(`битый индекс ${IDX} — пересобери: node tools/okf-recall.mjs index (${e.message})`);
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
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 5 : 5;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'auto';
  if (!MODES.includes(mode)) {
    throw new Error(`неизвестный --mode: ${mode} (допустимо: ${MODES.join('|')})`);
  }
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(mi >= 0 && i === mi + 1));
  return { positional, k, includeSecret, includeMirror, mode };
}

async function buildIndex(includeSecret, includeMirror) {
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
  const { built, reused, total } = await syncIndex(idx, docs, embed, { includeSecret, includeMirror });
  saveIdx(idx);
  console.log(`индекс: ${built} новых/изменённых, ${reused} без изменений, всего ${total} (model ${MODEL})`);
}

async function query(q, k, includeSecret, includeMirror, mode) {
  // BM25-ранжируем по телу концептов, поэтому грузим bundle в любом режиме.
  const docs = load({ includeSecret, includeMirror }).filter(d => !d.reserved);
  const idx = loadIdx();
  const { hits, mode: used, warning } = await recallSearch({
    docs, query: q, mode, embed, idx, k, includeSecret, includeMirror,
  });
  if (warning) console.error(`⚠ ${warning}`);
  console.log(`# «${q}» → топ-${k} [${used}]`);
  for (const r of hits) console.log(`${r.score.toFixed(3)}  ${(r.type || '').padEnd(10)} ${r.id} — ${r.title || ''}`);
  if (!hits.length) console.log('(ничего не найдено)');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { positional, k, includeSecret, includeMirror, mode } = parseArgs();
  try {
    if (positional[0] === 'index') await buildIndex(includeSecret, includeMirror);
    else if (positional.length) await query(positional.join(' '), k, includeSecret, includeMirror, mode);
    else console.log('Usage: okf-recall.mjs index | "<запрос>" [-k N] [--mode bm25|semantic|auto] [--include-mirror] [--include-secret]');
  } catch (e) {
    console.error('Ошибка:', e.message);
    if (mode !== 'bm25') console.error('Подсказка: --mode bm25 ищет без эндпоинта; --mode auto (дефолт) включает семантику при OKF_EMBED_URL.');
    process.exit(1);
  }
}

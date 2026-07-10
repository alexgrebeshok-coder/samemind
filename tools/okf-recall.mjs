#!/usr/bin/env node
// okf-recall.mjs — семантический поиск по OKF-bundle (bge-m3 @ локальный embeddings-эндпоинт). Индекс локальный.
//   node tools/okf-recall.mjs index [--include-mirror] [--include-secret]   # (пере)строить индекс (инкрементально по хэшу)
//   node tools/okf-recall.mjs "<запрос>" [-k N] [--include-mirror] [--include-secret]
// Тиры: курированное (дефолт) · mirror (зеркало живой памяти других движков) · secret (/secret).
// Эндпоинт/модель переопределяются через OKF_EMBED_URL / OKF_EMBED_MODEL.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, rankByQuery, syncIndex, indexKey,
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

async function query(q, k, includeSecret, includeMirror) {
  if (!existsSync(IDX)) { console.log('нет индекса — сначала: node tools/okf-recall.mjs index'); return; }
  const idx = loadIdx();
  const qv = await embed(q);
  const ranked = rankByQuery(idx.items, qv, { k, includeSecret, includeMirror });
  console.log(`# «${q}» → топ-${k}`);
  for (const r of ranked) console.log(`${r.score.toFixed(3)}  ${(r.type || '').padEnd(10)} ${r.id} — ${r.title || ''}`);
}

const args = process.argv.slice(2);
const includeSecret = args.includes('--include-secret');
const includeMirror = args.includes('--include-mirror');
const ki = args.indexOf('-k');
const k = ki >= 0 ? parseInt(args[ki + 1], 10) || 5 : 5;
const positional = args.filter((a, i) => !a.startsWith('-') && !(ki >= 0 && i === ki + 1));

try {
  if (positional[0] === 'index') await buildIndex(includeSecret, includeMirror);
  else if (positional.length) await query(positional.join(' '), k, includeSecret, includeMirror);
  else console.log('Usage: okf-recall.mjs index | "<запрос>" [-k N] [--include-mirror] [--include-secret]');
} catch (e) {
  console.error('Ошибка:', e.message);
  console.error(`Check embeddings endpoint: ${EMBED_URL} (model ${MODEL}); override with OKF_EMBED_URL.`);
  process.exit(1);
}

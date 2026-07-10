// recall.mjs — чистая логика recall-индекса (okf-recall + gde + тесты).
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { buildCorpus, bm25Score } from './bm25.mjs';

// Размерность проверяется только если OKF_EMBED_DIM задана явно. Иначе принимаем любую
// (OpenAI text-embedding-3-* — 1536/3072, bge-m3 — 1024, …): требование фиксированной dim
// ломало бы «любой OpenAI-совместимый эндпоинт». Несоответствие ловится через indexKey.
const DIM_EXPLICIT = Object.prototype.hasOwnProperty.call(process.env, 'OKF_EMBED_DIM');
export const EMBED_VECTOR_DIM = DIM_EXPLICIT ? parseInt(process.env.OKF_EMBED_DIM, 10) : null;
// Эндпоинт эмбеддингов по умолчанию (локальный embeddings-сервер: bge-m3 через LM Studio / Ollama / и т.п.).
// Переопределяется через OKF_EMBED_URL — любой OpenAI-совместимый /v1/embeddings-сервер
// (Ollama / LM Studio / OpenAI / локальный). Авторизация опционально через OKF_EMBED_KEY (Bearer).
export const DEFAULT_EMBED_URL = process.env.OKF_EMBED_URL || 'http://127.0.0.1:8000/v1/embeddings';
export const DEFAULT_MODEL = process.env.OKF_EMBED_MODEL || 'bge-m3';
export const MAX_EMBED_CHARS = 5000;

export function indexKey(model, url = DEFAULT_EMBED_URL) {
  return `${model}@${sha16(url)}`;
}

/** Убираем URL ссылок и code blocks — иначе общий хвост кросс-ссылок размывает скоры. */
export const stripLinks = s => (s || '').replace(/\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/```[\s\S]*?```/g, ' ');

/** Текст документа для эмбеддинга: frontmatter-суть + body без link-URL. */
export function docText(d) {
  return [
    d.fm.title,
    d.fm.description,
    (d.fm.tags || []).join(', '),
    stripLinks(d.body).replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join('\n');
}

/** Текст для эмбеддинга (truncated) — hash и embed должны использовать одно и то же. */
export function embedText(d) {
  return docText(d).slice(0, MAX_EMBED_CHARS);
}

export function contentHash(d) {
  return sha16(embedText(d));
}

export function sha16(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Фильтр тиров recall: secret/mirror скрыты без явных флагов; missing visibility = internal. */
export function passesTier(visibility, { includeSecret = false, includeMirror = false } = {}) {
  const vis = visibility || 'internal';
  if (vis === 'secret' && !includeSecret) return false;
  if (vis === 'mirror' && !includeMirror) return false;
  return true;
}

/** Ранжирование по косинусу с учётом тиров. */
export function rankByQuery(items, queryVector, { k = 5, includeSecret = false, includeMirror = false } = {}) {
  return Object.entries(items)
    .filter(([, v]) => passesTier(v.visibility, { includeSecret, includeMirror }))
    .map(([id, v]) => ({ id, title: v.title, type: v.type, score: cosine(queryVector, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Источник узла в bundle по пути: canon (корневые концепты), mirror/<engine>/…, или secret/. */
export function storageOf(id) {
  if (id.startsWith('mirror/claude-code/')) return 'claude-code';
  if (id.startsWith('mirror/openclaw/')) return 'openclaw';
  if (id.startsWith('secret/')) return 'secret';
  return 'canon';
}

/** Какие хранилища представлены в наборе id. */
export function storagesPresent(ids) {
  return new Set(ids.map(storageOf));
}

/** Инкрементальная синхронизация индекса с bundle. embed(text) → vector[]. */
export async function syncIndex(idx, docs, embed, { includeSecret = false, includeMirror = false } = {}) {
  const seen = new Set();
  let built = 0, reused = 0;
  for (const d of docs) {
    const h = contentHash(d);
    seen.add(d.id);
    if (idx.items[d.id]?.hash === h) { reused++; continue; }
    const visibility = d.fm.visibility || 'internal';
    idx.items[d.id] = {
      hash: h,
      type: d.fm.type,
      title: d.fm.title,
      visibility,
      vector: await embed(embedText(d)),
    };
    built++;
  }
  for (const id of Object.keys(idx.items)) {
    if (seen.has(id)) continue;
    const vis = idx.items[id].visibility || 'internal';
    if (vis === 'mirror' && !includeMirror) continue;
    if (vis === 'secret' && !includeSecret) continue;
    delete idx.items[id];
  }
  return { built, reused, total: Object.keys(idx.items).length };
}

export async function fetchEmbedding(text, {
  url = DEFAULT_EMBED_URL, model = DEFAULT_MODEL, key = process.env.OKF_EMBED_KEY, dim = EMBED_VECTOR_DIM,
} = {}) {
  const input = text.slice(0, MAX_EMBED_CHARS);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  // Стандартный OpenAI /v1/embeddings: { model, input }, ответ { data: [{ embedding: [...] }] }.
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const emb = (await r.json())?.data?.[0]?.embedding;
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error(`embedding: ожидался непустой vector, получен ${Array.isArray(emb) ? `length ${emb.length}` : typeof emb}`);
  }
  if (dim && emb.length !== dim) {
    throw new Error(`embedding: dim ${emb.length} ≠ ожидаемой ${dim} (переопредели OKF_EMBED_DIM или снимите ограничение)`);
  }
  return emb;
}

const TERM_RE = /[^\p{L}\p{N}-]+/u;

/** Токены запроса для keyword/snippet (слова ≥2 символов). */
export function queryTerms(query) {
  return (query || '').toLowerCase().split(TERM_RE).filter(t => t.length >= 2);
}

/** 2–3 строки вокруг лучшего совпадения запроса в теле документа. */
export function extractSnippet(body, query, { contextLines = 1 } = {}) {
  const terms = queryTerms(query);
  const lines = (body || '').split('\n');
  if (!lines.length) return '';
  if (!terms.length) return lines.slice(0, Math.min(3, lines.length)).join('\n').trim();

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lineLower.includes(t)) score += t.length + (lineLower.split(t).length - 1) * 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const start = Math.max(0, bestIdx - contextLines);
  const end = Math.min(lines.length, bestIdx + contextLines + 1);
  return lines.slice(start, end).join('\n').trim();
}

/** Простой по-тексту скор (покрытие терминов + плотность). Лёгкий однодоковый эвристический
 *  scorer; основной фолбэк-ранкер rankByKeywords использует полноценный корпусный BM25. */
export function keywordScore(text, query) {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const lower = (text || '').toLowerCase();
  const len = Math.max(lower.length, 1);
  let hits = 0;
  let matched = 0;
  for (const t of terms) {
    const count = lower.split(t).length - 1;
    if (count > 0) matched++;
    hits += count;
  }
  if (matched === 0) return 0;
  const density = Math.min(hits / len * 800, 1);
  const coverage = matched / terms.length;
  return coverage * 0.65 + density * 0.35;
}

/** Единый fallback-ранкер: BM25 по title/description/tags/телу концептов (docText).
 *  Без сети, без зависимостей. Используется и gde, и okf-recall — один механизм фолбэба. */
export function rankByKeywords(docs, query, { k = 5, includeSecret = false, includeMirror = true } = {}) {
  const pool = docs
    .filter(d => !d.reserved)
    .filter(d => passesTier(d.fm.visibility, { includeSecret, includeMirror }));
  if (!pool.length) return [];
  const corpus = buildCorpus(pool, { textOf: docText });
  return pool
    .map(d => ({
      id: d.id,
      title: d.fm.title,
      type: d.fm.type,
      score: bm25Score(query, d.id, corpus),
      file: d.file,
      body: d.body,
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const FALLBACK_WARN_OFF = 'semantic off, BM25 fallback — set OKF_EMBED_URL for semantic search';

/**
 * Единый поиск recall: режимы bm25 | semantic | auto (дефолт auto).
 * Возвращает { hits, mode, warning }. warning — честное одноразовое пояснение фолбэка
 * (клиент печатает его в stderr); в semantic-режиме при неготовности — бросает.
 *   mode='auto': индекс есть и embed отвечает → semantic; иначе BM25 (с warning).
 *   mode='semantic': требует индекс и embed (без тихого фолбэка).
 *   mode='bm25': всегда BM25, без сети.
 */
export async function recallSearch({
  docs, query, mode = 'auto', embed = null, idx = { items: {} },
  k = 5, includeSecret = false, includeMirror = false,
}) {
  const bm25 = () => rankByKeywords(docs, query, { k, includeSecret, includeMirror });
  const hasIndex = !!(idx && idx.items && Object.keys(idx.items).length > 0);

  if (mode === 'bm25') return { hits: bm25(), mode: 'bm25', warning: null };

  if (mode === 'semantic') {
    if (!hasIndex) throw new Error('semantic-режим требует индекс: запусти `okf-recall.mjs index` (нужен OKF_EMBED_URL)');
    if (!embed) throw new Error('semantic-режим требует эндпоинт эмбеддингов (OKF_EMBED_URL)');
    const qv = await embed(query);
    return { hits: rankByQuery(idx.items, qv, { k, includeSecret, includeMirror }), mode: 'semantic', warning: null };
  }

  // auto
  if (hasIndex && embed) {
    try {
      const qv = await embed(query);
      return { hits: rankByQuery(idx.items, qv, { k, includeSecret, includeMirror }), mode: 'semantic', warning: null };
    } catch (e) {
      return { hits: bm25(), mode: 'bm25', warning: `semantic недоступен (${e.message}) — BM25 fallback` };
    }
  }
  const embedUrlSet = !!process.env.OKF_EMBED_URL;
  const warning = embedUrlSet
    ? 'BM25 fallback — нет индекса: запусти `okf-recall.mjs index` для семантики'
    : FALLBACK_WARN_OFF;
  return { hits: bm25(), mode: 'bm25', warning };
}

const DEFAULT_STALE_AGE_MS = 86_400_000;

/** Быстрая проверка свежести индекса: mtime + выборочный content-hash. */
export function checkIndexStale(idx, docs, { idxPath, maxAgeMs = DEFAULT_STALE_AGE_MS, sampleSize = 10 } = {}) {
  const reasons = [];
  if (!idxPath || !existsSync(idxPath)) {
    return { stale: true, reasons: ['индекс отсутствует'] };
  }
  const age = Date.now() - statSync(idxPath).mtimeMs;
  if (age > maxAgeMs) {
    reasons.push(`индекс старше ${Math.round(age / 86_400_000)} суток`);
  }
  const sample = docs.filter(d => !d.reserved).slice(0, sampleSize);
  let mismatches = 0;
  for (const d of sample) {
    const h = contentHash(d);
    const item = idx.items?.[d.id];
    if (!item || item.hash !== h) mismatches++;
  }
  if (mismatches > 0) reasons.push(`${mismatches}/${sample.length} документов изменились`);
  return { stale: reasons.length > 0, reasons };
}

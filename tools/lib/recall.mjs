// recall.mjs — чистая логика recall-индекса (okf-recall + gde + тесты).
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { buildCorpus, bm25Score } from './bm25.mjs';
import { buildSupersededMap, buildHeatIndex, hygieneMultiplier, hygieneLabel } from './hygiene.mjs';

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

/** Совпадает ли источник концепта (frontmatter `source`) с id? source может быть строкой или
 *  списком (см. demo — `source: demo` или `source: [docs/a.md, docs/b.md]`). Анти-эхо: движок,
 *  только что записавший в bundle, исключает своё через excludeSource, чтобы не получить своё же. */
export function sourceMatches(doc, source) {
  if (!source) return false;
  const s = doc?.fm?.source;
  if (Array.isArray(s)) return s.some(x => String(x) === source);
  return s != null && String(s) === source;
}

/**
 * Shared post-processing for a list of raw semantic candidates ({id, title, type, visibility,
 * rawScore}): tier filter, anti-echo (excludeSource), hygiene multiplier (supersedes/deprecated/
 * importance/decay — see docs/memory-hygiene.md), sort, slice to k. Used by BOTH the in-memory
 * JSON-index path (rankByQuery, below — candidates = every item, cosine over all of them) and the
 * sqlite-vec backend (lib/sqlite-index.mjs searchVecStore — candidates = the overfetched KNN pool
 * already scored by vec0's own distance metric). Keeping this in one place means the two backends
 * can never drift on tier/hygiene semantics, only on how `rawScore` gets computed.
 * `docs` — full parsed concepts (for fm.supersedes etc.); without them (or for an id outside docs)
 * the hygiene multiplier is neutral (1) — same backward-compat contract as before this was split out.
 * `events` (Ф5, optional) — ledger events (tools/lib/ledger.mjs `readEvents()`); grouped into a
 * heatIndex ONCE per call (not per candidate) and folded into the same hygieneMultiplier pass —
 * no separate heat-ranking step, so bm25/semantic/hybrid all pick it up for free. Omitted (default
 * []) → heat is a no-op, byte-for-byte identical to before Ф5.
 */
export function finalizeRanked(candidates, {
  k = 5, includeSecret = false, includeMirror = false, docs = [], excludeSource = null, events = [],
} = {}) {
  const docsById = new Map(docs.map(d => [d.id, d]));
  const supersededMap = buildSupersededMap(docs);
  const heatIndex = events.length ? buildHeatIndex(events) : null;
  return candidates
    .filter(c => passesTier(c.visibility, { includeSecret, includeMirror }))
    .filter(c => !sourceMatches(docsById.get(c.id), excludeSource))
    .map(c => {
      const doc = docsById.get(c.id);
      const score = doc ? c.rawScore * hygieneMultiplier(doc, supersededMap, { heatIndex }) : c.rawScore;
      const label = doc ? hygieneLabel(doc, supersededMap) : '';
      return { id: c.id, title: c.title, type: c.type, score, rawScore: c.rawScore, label };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Ранжирование по косинусу с учётом тиров + гигиены памяти — the flat-JSON index path (linear
 * scan: cosine against every item). See finalizeRanked() for the shared tier/hygiene/sort logic.
 */
export function rankByQuery(items, queryVector, opts = {}) {
  const candidates = Object.entries(items).map(([id, v]) => ({
    id, title: v.title, type: v.type, visibility: v.visibility, rawScore: cosine(queryVector, v.vector),
  }));
  return finalizeRanked(candidates, opts);
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
    throw new Error(`embedding: expected a non-empty vector, got ${Array.isArray(emb) ? `length ${emb.length}` : typeof emb}`);
  }
  if (dim && emb.length !== dim) {
    throw new Error(`embedding: dim ${emb.length} != expected ${dim} (override OKF_EMBED_DIM or remove the constraint)`);
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

/** Единый fallback-ранкер: BM25 по title/description/tags/телу концептов (docText), с той же
 *  гигиеной ранга, что и rankByQuery (supersedes/deprecated/importance/decay/heat — Ф5).
 *  Без сети, без зависимостей. Используется и gde, и okf-recall — один механизм фолбэба. */
export function rankByKeywords(docs, query, { k = 5, includeSecret = false, includeMirror = true, excludeSource = null, events = [] } = {}) {
  const pool = docs
    .filter(d => !d.reserved)
    .filter(d => passesTier(d.fm.visibility, { includeSecret, includeMirror }))
    .filter(d => !sourceMatches(d, excludeSource));
  if (!pool.length) return [];
  const corpus = buildCorpus(pool, { textOf: docText });
  const supersededMap = buildSupersededMap(docs);
  const heatIndex = events.length ? buildHeatIndex(events) : null;
  return pool
    .map(d => {
      const rawScore = bm25Score(query, d.id, corpus);
      return {
        id: d.id,
        title: d.fm.title,
        type: d.fm.type,
        score: rawScore * hygieneMultiplier(d, supersededMap, { heatIndex }),
        rawScore,
        file: d.file,
        body: d.body,
        label: hygieneLabel(d, supersededMap),
      };
    })
    .filter(r => r.rawScore > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const FALLBACK_WARN_OFF = 'semantic off, BM25 fallback — set OKF_EMBED_URL for semantic search';

// --- hybrid (Ф3): RRF fusion of BM25 + semantic rank, optional cross-encoder rerank -----------

/** Standard RRF constant (Cormack, Clarke & Buettcher 2009). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion — score(doc) = Σ 1/(k + rank_i) over each ranked list's POSITION, not
 * its raw score: BM25 (unbounded) and cosine (-1..1) live on incomparable scales, so summing raw
 * scores would let whichever ranker happens to produce bigger numbers dominate. Fusing by rank
 * sidesteps that entirely. Each input list's hygiene/temporal multiplier (Ф2 — supersedes/
 * deprecated/importance/decay) is already baked into ITS OWN ordering before this runs
 * (rankByKeywords/rankByQuery both sort by hygiene-adjusted score) — so a superseded doc ranks
 * low in both inputs and stays low after fusion; no separate hygiene pass needed here.
 * A doc missing from one list (e.g. BM25 found zero keyword overlap) simply gets no contribution
 * from that list — still fusable from whichever list(s) it appears in.
 */
export function rrfFuse(rankedLists, { k = RRF_K } = {}) {
  const fused = new Map(); // id -> { item, rrfScore }
  for (const list of rankedLists) {
    list.forEach((item, i) => {
      const add = 1 / (k + i + 1);
      const prev = fused.get(item.id);
      if (prev) prev.rrfScore += add;
      else fused.set(item.id, { item, rrfScore: add });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore, rrfScore }));
}

export const DEFAULT_RERANK_MODEL = 'bge-reranker-v2-m3';
const RERANK_POOL = 20; // how many post-RRF candidates get sent to the reranker

/**
 * Optional cross-encoder rerank over RRF-fused top-N. Same simple JSON/HTTP shape as
 * fetchEmbedding (POST {model, query, documents}, Bearer via OKF_EMBED_KEY) — the common
 * rerank-endpoint convention (Cohere/Jina/TEI): response `{ results: [{index, relevance_score}] }`.
 * Strictly opt-in (see maybeRerank/recallSearch — only called when OKF_RERANK_URL is set); no
 * reranker model runs on omlx today, so this path has no live server to hit here — covered by
 * mocked-fetch unit tests instead (see recall.test.mjs).
 */
export async function fetchRerank(query, documents, {
  url, model = process.env.OKF_RERANK_MODEL || DEFAULT_RERANK_MODEL, key = process.env.OKF_EMBED_KEY,
} = {}) {
  if (!url) throw new Error('fetchRerank: url required');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, query, documents }),
  });
  if (!r.ok) throw new Error(`rerank HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const results = (await r.json())?.results;
  if (!Array.isArray(results)) throw new Error('rerank: expected { results: [...] }');
  return results;
}

/** Applies fetchRerank to the top RERANK_POOL hits when OKF_RERANK_URL is set; a no-op (identity)
 *  otherwise, and fails OPEN (keeps RRF order) if the reranker errors — a broken/unreachable
 *  reranker must never take hybrid search down with it, since it's an optional add-on. */
async function maybeRerank(query, hits, docs) {
  const url = process.env.OKF_RERANK_URL;
  if (!url || hits.length === 0) return hits;
  const pool = hits.slice(0, RERANK_POOL);
  const rest = hits.slice(RERANK_POOL);
  const docsById = new Map(docs.map(d => [d.id, d]));
  const documents = pool.map(h => embedText(docsById.get(h.id) || { fm: { title: h.title }, body: '' }));
  try {
    const results = await fetchRerank(query, documents, { url });
    const byIndex = new Map(results.map(r => [r.index, r.relevance_score]));
    const reranked = pool
      .map((h, i) => (byIndex.has(i) ? { ...h, score: byIndex.get(i) } : h))
      .sort((a, b) => b.score - a.score);
    return [...reranked, ...rest];
  } catch (e) {
    console.error(`⚠ rerank failed (${e.message}) — keeping RRF order`);
    return hits;
  }
}

/**
 * Единый поиск recall: режимы bm25 | semantic | hybrid | auto (дефолт auto).
 * Возвращает { hits, mode, warning }. warning — честное одноразовое пояснение фолбэка
 * (клиент печатает его в stderr); в semantic-режиме при неготовности — бросает.
 *   mode='auto': индекс есть и embed отвечает → semantic; иначе BM25 (с warning).
 *   mode='semantic': требует индекс и embed (без тихого фолбэка).
 *   mode='hybrid' (Ф3): BM25 ⊕ semantic слиты через RRF (rrfFuse, k=60), топ-N опционально
 *     прогнан через rerank (см. maybeRerank); без индекса/embed или при сбое эндпоинта — тихий
 *     фолбэк на BM25 (никогда не падает).
 *   mode='bm25': всегда BM25, без сети.
 */
export async function recallSearch({
  docs, query, mode = 'auto', embed = null, idx = { items: {} },
  // Ф4 (opt-in, see lib/sqlite-index.mjs): when a caller passes an open sqlite-vec store + its
  // search function, semantic ranking runs as a sqlite KNN query instead of the in-memory linear
  // cosine scan over idx.items. Both `vecStore` and `vecSearch` must be given together (dependency
  // injection, not a direct import — keeps this module backend-agnostic and avoids a lib/recall.mjs
  // <-> lib/sqlite-index.mjs import cycle). Neither existing caller passes them, so every call site
  // that predates Ф4 behaves byte-for-byte as before.
  vecStore = null, vecSearch = null, vecCount = null,
  k = 5, includeSecret = false, includeMirror = false, excludeSource = null, events = [],
}) {
  const bm25 = () => rankByKeywords(docs, query, { k, includeSecret, includeMirror, excludeSource, events });
  const useVec = !!(vecStore && vecSearch);
  const hasIndex = useVec
    ? (vecCount ? vecCount(vecStore) > 0 : true)
    : !!(idx && idx.items && Object.keys(idx.items).length > 0);
  const semanticRank = (qv, kk) => (useVec
    ? vecSearch(vecStore, qv, { k: kk, includeSecret, includeMirror, docs, excludeSource, events })
    : rankByQuery(idx.items, qv, { k: kk, includeSecret, includeMirror, docs, excludeSource, events }));

  if (mode === 'bm25') return { hits: bm25(), mode: 'bm25', warning: null };

  if (mode === 'semantic') {
    if (!hasIndex) throw new Error('semantic mode requires an index: run `okf-recall.mjs index` (needs OKF_EMBED_URL)');
    if (!embed) throw new Error('semantic mode requires an embeddings endpoint (OKF_EMBED_URL)');
    const qv = await embed(query);
    return { hits: semanticRank(qv, k), mode: 'semantic', warning: null };
  }

  if (mode === 'hybrid') {
    if (!hasIndex || !embed) {
      const embedUrlSet = !!process.env.OKF_EMBED_URL;
      const warning = !hasIndex
        ? (embedUrlSet
          ? 'BM25 fallback — no index: run `okf-recall.mjs index` for hybrid search'
          : FALLBACK_WARN_OFF)
        : 'hybrid unavailable — no embeddings endpoint (OKF_EMBED_URL) — BM25 fallback';
      return { hits: bm25(), mode: 'bm25', warning };
    }
    try {
      const poolK = Math.max(docs.length, 1);
      const bm25Full = rankByKeywords(docs, query, { k: poolK, includeSecret, includeMirror, excludeSource });
      const qv = await embed(query);
      const semFull = semanticRank(qv, poolK);
      const fused = rrfFuse([bm25Full, semFull]);
      const reranked = await maybeRerank(query, fused, docs);
      return { hits: reranked.slice(0, k), mode: 'hybrid', warning: null };
    } catch (e) {
      return { hits: bm25(), mode: 'bm25', warning: `hybrid unavailable (${e.message}) — BM25 fallback` };
    }
  }

  // auto
  if (hasIndex && embed) {
    try {
      const qv = await embed(query);
      return { hits: semanticRank(qv, k), mode: 'semantic', warning: null };
    } catch (e) {
      return { hits: bm25(), mode: 'bm25', warning: `semantic unavailable (${e.message}) — BM25 fallback` };
    }
  }
  const embedUrlSet = !!process.env.OKF_EMBED_URL;
  const warning = embedUrlSet
    ? 'BM25 fallback — no index: run `okf-recall.mjs index` for semantic search'
    : FALLBACK_WARN_OFF;
  return { hits: bm25(), mode: 'bm25', warning };
}

const DEFAULT_STALE_AGE_MS = 86_400_000;

/** Быстрая проверка свежести индекса: mtime + выборочный content-hash. */
export function checkIndexStale(idx, docs, { idxPath, maxAgeMs = DEFAULT_STALE_AGE_MS, sampleSize = 10 } = {}) {
  const reasons = [];
  if (!idxPath || !existsSync(idxPath)) {
    return { stale: true, reasons: ['index missing'] };
  }
  const age = Date.now() - statSync(idxPath).mtimeMs;
  if (age > maxAgeMs) {
    reasons.push(`index older than ${Math.round(age / 86_400_000)} days`);
  }
  const sample = docs.filter(d => !d.reserved).slice(0, sampleSize);
  let mismatches = 0;
  for (const d of sample) {
    const h = contentHash(d);
    const item = idx.items?.[d.id];
    if (!item || item.hash !== h) mismatches++;
  }
  if (mismatches > 0) reasons.push(`${mismatches}/${sample.length} documents changed`);
  return { stale: reasons.length > 0, reasons };
}

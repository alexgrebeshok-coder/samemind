// proactive.mjs — Active Memory: auto-pull relevant facts BEFORE an agent answers,
// without an explicit `samemind recall` call. Reuses lib/recall.mjs (BM25 / semantic /
// hybrid). Pure library — no network side effects beyond whatever embed() does.
//
// Pattern (OpenClaw Active Memory / harness pre-context):
//   user message → proactiveRecall(query) → { hits, pack, tokens, latencyMs }
//   agent answers with pack already in context.
//
//   import { proactiveRecall, formatPack } from './lib/proactive.mjs';
//   const pack = await proactiveRecall({ docs, query, rank: rankByKeywords, k: 5 });
import { extractSnippet, rankByKeywords, queryTerms } from './recall.mjs';

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_K = 5;
/** @deprecated use minScoreAbsolute/minScoreRatio */
export const DEFAULT_MIN_SCORE = 0;
// B3b calibration on 15 golden cases + adversarial «рецепт борща» (soul-memory, 2026-07-23):
// golden tops ≥9 (post-stem); irrelevant borscht top ≈5.2; dative miss pre-stem was 4.9.
export const DEFAULT_MIN_SCORE_ABSOLUTE = 6.0;
export const DEFAULT_MIN_SCORE_RATIO = 0.30;
export const DEFAULT_SNIPPET_LINES = 3;
export const DEFAULT_MAX_CHARS = 6000; // ~1500 tokens hard cap for injected pack

function hitScore(h) {
  return h?.score ?? h?.rawScore ?? 0;
}

/** Filter ranked hits: relative floor + absolute min; detect weak top for skip. */
export function filterProactiveHits(rawHits, {
  k = DEFAULT_K,
  minScoreAbsolute = DEFAULT_MIN_SCORE_ABSOLUTE,
  minScoreRatio = DEFAULT_MIN_SCORE_RATIO,
} = {}) {
  if (!rawHits?.length) return { hits: [], weakMatch: false };
  const topScore = hitScore(rawHits[0]);
  if (minScoreAbsolute > 0 && topScore < minScoreAbsolute) {
    return { hits: [], weakMatch: true };
  }
  const relativeThreshold = minScoreRatio > 0 ? minScoreRatio * topScore : 0;
  const hits = rawHits
    .filter(h => hitScore(h) >= relativeThreshold)
    .slice(0, k);
  return { hits, weakMatch: false };
}

/**
 * Rough token estimate (same heuristic as brief.mjs: 4 chars/token).
 * Not a tokenizer — good enough for budget / cost comparisons.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

/**
 * Heuristic: is this message a question / fact-lookup that benefits from recall?
 * Short affirmations, pure code dumps, and "ok" skip proactive pull.
 */
export function shouldProactive(query, { minTerms = 2 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 8) return false;
  const terms = queryTerms(q);
  if (terms.length < minTerms) return false;
  // Skip pure shell/path-looking blobs without natural language
  if (/^[./~\w\-]+\.(mjs|js|ts|py|sh|json|md)\s*$/i.test(q)) return false;
  return true;
}

/**
 * Rank docs for a query. `rank` is injectable for tests (defaults to BM25 via rankByKeywords).
 * Returns ranked hits with id/score/title/type (same shape as recall.mjs).
 */
export function rankForProactive(docs, query, {
  k = DEFAULT_K,
  minScoreAbsolute = DEFAULT_MIN_SCORE_ABSOLUTE,
  minScoreRatio = DEFAULT_MIN_SCORE_RATIO,
  rank = null,
  events = [],
} = {}) {
  const rankFn = rank || ((d, q, opts) => rankByKeywords(d, q, opts));
  const raw = rankFn(docs, query, { k: Math.max(k * 3, k), events }) || [];
  if (minScoreAbsolute === 0 && minScoreRatio === 0) return raw.slice(0, k);
  return filterProactiveHits(raw, { k, minScoreAbsolute, minScoreRatio }).hits;
}

/**
 * Build a compact context pack from ranked hits (title + snippet).
 * Caps total chars so proactive injection can't blow the session budget.
 */
export function formatPack(hits, docsById, {
  snippetLines = DEFAULT_SNIPPET_LINES,
  maxChars = DEFAULT_MAX_CHARS,
  query = '',
} = {}) {
  const blocks = [];
  let used = 0;
  for (const h of hits) {
    const doc = docsById.get(h.id) || docsById.get(String(h.id).replace(/^global:/, ''));
    const title = h.title || doc?.fm?.title || h.id;
    const body = doc?.body || '';
    const snip = extractSnippet(body, query, { contextLines: snippetLines })
      || body.slice(0, 400).replace(/\s+/g, ' ').trim();
    // Э6/6.1: surface conflict / supersede labels from rank hits so proactive pack shows the fight.
    const label = h.label ? ` ${h.label}` : '';
    const block = `### ${h.id} — ${title}${label}\n${snip}`.trim();
    if (used + block.length + 2 > maxChars && blocks.length) break;
    blocks.push(block);
    used += block.length + 2;
  }
  const text = blocks.length
    ? `# Proactive memory (auto-recall, top-${hits.length})\n\n${blocks.join('\n\n')}`
    : '';
  return { text, chars: text.length, tokens: estimateTokens(text), included: blocks.length };
}

/**
 * Full proactive path: decide → rank → pack. Returns a structured result the CLI / MCP
 * can print or inject. Does NOT call an LLM.
 *
 * @param {object} opts
 * @param {Array} opts.docs - OKF docs from load()
 * @param {string} opts.query - incoming user message
 * @param {number} [opts.k=5]
 * @param {function} [opts.rank] - optional ranker(docs, query, opts) → hits
 * @param {number} [opts.minScore=0] — legacy alias for minScoreAbsolute
 * @param {number} [opts.minScoreAbsolute=6]
 * @param {number} [opts.minScoreRatio=0.30]
 * @param {number} [opts.maxChars=6000]
 * @param {Array} [opts.events=[]] - ledger events for heat (optional)
 */
export async function proactiveRecall({
  docs,
  query,
  k = DEFAULT_K,
  rank = null,
  minScoreAbsolute = DEFAULT_MIN_SCORE_ABSOLUTE,
  minScoreRatio = DEFAULT_MIN_SCORE_RATIO,
  maxChars = DEFAULT_MAX_CHARS,
  snippetLines = DEFAULT_SNIPPET_LINES,
  events = [],
  force = false,
} = {}) {
  const t0 = performance.now();
  const q = String(query || '').trim();
  if (!force && !shouldProactive(q)) {
    return {
      skipped: true,
      reason: 'query too short / not fact-shaped',
      query: q,
      hits: [],
      pack: '',
      tokens: 0,
      chars: 0,
      latencyMs: Math.round(performance.now() - t0),
      manualRecallsSaved: 0,
    };
  }

  const rankFn = rank || ((d, q, opts) => rankByKeywords(d, q, opts));
  const rawHits = rankFn(docs, q, { k: Math.max(k * 3, k), events }) || [];
  const { hits, weakMatch } = filterProactiveHits(rawHits, {
    k,
    minScoreAbsolute,
    minScoreRatio,
  });

  if (weakMatch) {
    return {
      skipped: true,
      reason: 'weak match',
      query: q,
      hits: [],
      pack: '',
      tokens: 0,
      chars: 0,
      latencyMs: Math.round(performance.now() - t0),
      manualRecallsSaved: 0,
    };
  }

  const docsById = new Map((docs || []).map(d => [d.id, d]));
  const pack = formatPack(hits, docsById, { snippetLines, maxChars, query: q });
  const latencyMs = Math.round(performance.now() - t0);

  const manualRecallsSaved = hits.length ? 1 : 0;

  return {
    skipped: false,
    reason: null,
    query: q,
    hits: hits.map(h => ({
      id: h.id,
      score: h.score,
      title: h.title || docsById.get(h.id)?.fm?.title || '',
      type: h.type || docsById.get(h.id)?.fm?.type || '',
      // Э6: pass through supersede/conflict labels from rank (empty string if clean)
      label: h.label || '',
    })),
    pack: pack.text,
    tokens: pack.tokens,
    chars: pack.chars,
    included: pack.included,
    latencyMs,
    manualRecallsSaved,
    k,
  };
}

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
export const DEFAULT_MIN_SCORE = 0; // BM25 unbounded; 0 = keep all top-k
export const DEFAULT_SNIPPET_LINES = 3;
export const DEFAULT_MAX_CHARS = 6000; // ~1500 tokens hard cap for injected pack

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
  minScore = DEFAULT_MIN_SCORE,
  rank = null,
  events = [],
} = {}) {
  const rankFn = rank || ((d, q, opts) => rankByKeywords(d, q, opts));
  const hits = rankFn(docs, query, { k: Math.max(k * 2, k), events }) || [];
  return hits
    .filter(h => (h.score ?? 0) >= minScore)
    .slice(0, k);
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
    const block = `### ${h.id} — ${title}\n${snip}`.trim();
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
 * @param {number} [opts.minScore=0]
 * @param {number} [opts.maxChars=6000]
 * @param {Array} [opts.events=[]] - ledger events for heat (optional)
 */
export async function proactiveRecall({
  docs,
  query,
  k = DEFAULT_K,
  rank = null,
  minScore = DEFAULT_MIN_SCORE,
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

  const hits = rankForProactive(docs, q, { k, minScore, rank, events });
  const docsById = new Map((docs || []).map(d => [d.id, d]));
  const pack = formatPack(hits, docsById, { snippetLines, maxChars, query: q });
  const latencyMs = Math.round(performance.now() - t0);

  // One proactive pack = one manual `samemind recall` the agent no longer has to fire.
  // If top hit is strong enough that agent would also have called `get` — count as 1 still
  // (honest lower bound; multi-hop saves are out of scope for the prototype).
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

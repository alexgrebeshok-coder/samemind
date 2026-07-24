#!/usr/bin/env node
// proactive.mjs — CLI for Active Memory prototype.
//   node tools/proactive.mjs "<user message>" [-k N] [--json] [--force] [--mode bm25]
//
// Loads OKF_ROOT (default cwd), runs proactiveRecall, prints top-k facts + pack + metrics.
// Does not answer the question itself — only the memory side of the pre-context step.
import { fileURLToPath } from 'node:url';
import { load, ROOT } from './lib/okf.mjs';
import { rankByKeywords, recallSearch, fetchEmbedding, DEFAULT_EMBED_URL, DEFAULT_MODEL } from './lib/recall.mjs';
import { readEvents } from './lib/ledger.mjs';
import { proactiveRecall } from './lib/proactive.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 5 : 5;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'bm25';
  const json = argv.includes('--json');
  const force = argv.includes('--force');
  const packOnly = argv.includes('--pack');
  const positional = argv.filter((a, i) => !a.startsWith('-')
    && !(ki >= 0 && i === ki + 1)
    && !(mi >= 0 && i === mi + 1));
  return { query: positional.join(' ').trim(), k, mode, json, force, packOnly };
}

async function makeRanker(mode) {
  if (mode === 'bm25') {
    return (docs, query, opts) => rankByKeywords(docs, query, opts);
  }
  // semantic / hybrid / auto — go through recallSearch (needs embed for non-bm25)
  const embed = text => fetchEmbedding(text, {
    url: process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL,
    model: process.env.OKF_EMBED_MODEL || DEFAULT_MODEL,
  });
  return async (docs, query, opts) => {
    const { hits } = await recallSearch({
      docs, query, mode, embed, idx: { items: {} }, k: opts?.k || 5, events: opts?.events || [],
    });
    return hits;
  };
}

async function main() {
  const { query, k, mode, json, force, packOnly } = parseArgs();
  if (!query) {
    console.log('Usage: proactive.mjs "<user message>" [-k N] [--mode bm25|auto|hybrid] [--json] [--force] [--pack]');
    console.log(`OKF_ROOT=${ROOT}`);
    process.exit(1);
  }

  const docs = load({ includeMirror: false, includeSecret: false, includeInbox: false })
    .filter(d => !d.reserved);
  const events = readEvents(ROOT);
  const rank = await makeRanker(mode);

  // rankForProactive expects sync or async? currently sync — wrap async rankers
  const rankSyncOrAsync = async (d, q, opts) => {
    const r = rank(d, q, opts);
    return r && typeof r.then === 'function' ? await r : r;
  };

  // proactiveRecall uses sync rank; for async modes rank via pre-call path
  let result;
  if (mode === 'bm25') {
    result = await proactiveRecall({
      docs, query, k, force, events,
      rank: (d, q, opts) => rankByKeywords(d, q, opts),
    });
  } else {
    const t0 = performance.now();
    const hits = await rankSyncOrAsync(docs, query, { k, events });
    const { formatPack, shouldProactive } = await import('./lib/proactive.mjs');
    if (!force && !shouldProactive(query)) {
      result = {
        skipped: true, reason: 'query too short / not fact-shaped', query, hits: [],
        pack: '', tokens: 0, chars: 0, latencyMs: Math.round(performance.now() - t0),
        manualRecallsSaved: 0,
      };
    } else {
      const docsById = new Map(docs.map(d => [d.id, d]));
      const pack = formatPack(hits, docsById, { query });
      result = {
        skipped: false, reason: null, query,
        hits: hits.map(h => ({
          id: h.id, score: h.score,
          title: h.title || docsById.get(h.id)?.fm?.title || '',
          type: h.type || '',
          label: h.label || '',
        })),
        pack: pack.text, tokens: pack.tokens, chars: pack.chars,
        included: pack.included,
        latencyMs: Math.round(performance.now() - t0),
        manualRecallsSaved: hits.length ? 1 : 0, k, mode,
      };
    }
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (packOnly) {
    process.stdout.write(result.pack || '');
    return;
  }

  if (result.skipped) {
    console.log(`# proactive skipped — ${result.reason}`);
    console.log(`latency_ms=${result.latencyMs}`);
    return;
  }

  console.log(`# proactive recall for: "${result.query}"`);
  console.log(`mode=${mode}  k=${k}  hits=${result.hits.length}  tokens≈${result.tokens}  latency_ms=${result.latencyMs}  manual_recalls_saved=${result.manualRecallsSaved}`);
  console.log('');
  for (const h of result.hits) {
    console.log(`  ${(h.score ?? 0).toFixed(3)}  ${String(h.type || '').padEnd(10)} ${h.id} — ${h.title || ''}`);
  }
  console.log('');
  console.log(result.pack || '(empty pack)');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

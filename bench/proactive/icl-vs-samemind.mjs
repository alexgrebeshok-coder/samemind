#!/usr/bin/env node
// icl-vs-samemind.mjs — adversarial ICL baseline vs samemind recall on the real soul-memory corpus.
//
//   OKF_ROOT=~/.claude/projects/.../memory node bench/proactive/icl-vs-samemind.mjs
//   node bench/proactive/icl-vs-samemind.mjs --json > /tmp/icl-bench.json
//
// Strategies compared per case:
//   1. icl-full          — entire corpus in context (upper-bound accuracy, max tokens)
//   2. icl-memory-index  — only MEMORY.md (cheap "index in context")
//   3. icl-budget-8k     — first ~8k tokens by file path order (naive long-context fill)
//   4. icl-budget-32k    — first ~32k tokens by path order
//   5. samemind-bm25-k5  — BM25 top-5 full bodies packed
//   6. samemind-proactive — proactive pack (snippets, ~1.5k tok cap) — Active Memory prototype
//
// Metrics: fact_hit (all must-keywords present in pack), doc_hit (golden id in pack/hits),
// tokens, latency_ms. No LLM generation — retrieval/context-assembly only (honest CL-Bench angle).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CASES, DEFAULT_MEMORY_ROOT } from './cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');

// Freeze OKF_ROOT BEFORE importing okf/recall (ROOT is module-level const).
const MEMORY_ROOT = process.env.OKF_ROOT || DEFAULT_MEMORY_ROOT;
process.env.OKF_ROOT = MEMORY_ROOT;

const CHARS_PER_TOKEN = 4;
const tok = s => Math.ceil(String(s || '').length / CHARS_PER_TOKEN);

function hasAll(text, keywords) {
  const t = String(text || '');
  // case-insensitive for latin; keep cyrillic as-is (toLowerCase is fine for RU)
  const low = t.toLowerCase();
  return keywords.every(k => low.includes(String(k).toLowerCase()));
}

function hasAnyGolden(text, golden) {
  const t = String(text || '');
  return golden.some(g => t.includes(g));
}

function packDocs(docs, { maxTokens = Infinity, order = 'path' } = {}) {
  let list = [...docs];
  if (order === 'path') list.sort((a, b) => a.id.localeCompare(b.id));
  if (order === 'size-desc') list.sort((a, b) => (b.body || '').length - (a.body || '').length);
  const maxChars = maxTokens === Infinity ? Infinity : maxTokens * CHARS_PER_TOKEN;
  const parts = [];
  let used = 0;
  const ids = [];
  for (const d of list) {
    const block = `# ${d.id}\n${d.fm?.title || ''}\n${d.body || ''}\n`;
    if (used + block.length > maxChars && parts.length) break;
    parts.push(block);
    ids.push(d.id);
    used += block.length;
  }
  const text = parts.join('\n');
  return { text, tokens: tok(text), ids, docs: parts.length };
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const outPath = (() => {
    const i = process.argv.indexOf('--out');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  if (!existsSync(MEMORY_ROOT)) {
    console.error(`memory root missing: ${MEMORY_ROOT}`);
    process.exit(1);
  }

  // Dynamic import AFTER OKF_ROOT is set
  const { load } = await import(join(PACKAGE_ROOT, 'tools/lib/okf.mjs'));
  const { rankByKeywords, extractSnippet } = await import(join(PACKAGE_ROOT, 'tools/lib/recall.mjs'));
  const { proactiveRecall, formatPack } = await import(join(PACKAGE_ROOT, 'tools/lib/proactive.mjs'));

  const docs = load({ includeMirror: false, includeSecret: false, includeInbox: false })
    .filter(d => !d.reserved);
  const docsById = new Map(docs.map(d => [d.id, d]));
  const corpusTokens = tok(docs.map(d => d.body || '').join(''));

  console.error(`corpus: ${docs.length} docs, ~${corpusTokens} tokens, root=${MEMORY_ROOT}`);

  // Pre-build ICL packs (shared across cases — packing cost amortized; we still time per-case lookup)
  const tFull0 = performance.now();
  const iclFull = packDocs(docs, { maxTokens: Infinity });
  const tFull = Math.round(performance.now() - tFull0);

  const memDoc = docs.find(d => d.id === 'MEMORY' || d.id.endsWith('/MEMORY'));
  const iclIndex = memDoc
    ? { text: `# MEMORY\n${memDoc.body || ''}`, tokens: tok(memDoc.body || ''), ids: [memDoc.id], docs: 1 }
    : packDocs(docs.slice(0, 1));

  const icl8k = packDocs(docs, { maxTokens: 8000, order: 'path' });
  const icl32k = packDocs(docs, { maxTokens: 32000, order: 'path' });

  const strategies = [
    { name: 'icl-full', pack: iclFull, latencyBase: tFull, kind: 'icl' },
    { name: 'icl-memory-index', pack: iclIndex, latencyBase: 1, kind: 'icl' },
    { name: 'icl-budget-8k', pack: icl8k, latencyBase: 1, kind: 'icl' },
    { name: 'icl-budget-32k', pack: icl32k, latencyBase: 1, kind: 'icl' },
  ];

  const rows = [];

  for (const c of CASES) {
    // --- samemind BM25 k=5 (full bodies of hits) ---
    const tB0 = performance.now();
    const hits = rankByKeywords(docs, c.query, { k: 5 });
    const bm25Bodies = hits.map(h => {
      const d = docsById.get(h.id);
      return d ? `# ${d.id}\n${d.fm?.title || ''}\n${d.body || ''}` : '';
    }).join('\n\n');
    const tBm25 = Math.round(performance.now() - tB0);
    const bm25Ids = hits.map(h => h.id);

    // --- proactive (snippets) ---
    const tP0 = performance.now();
    const pro = await proactiveRecall({
      docs, query: c.query, k: 5, force: true,
      rank: (d, q, opts) => rankByKeywords(d, q, opts),
    });
    const tPro = Math.round(performance.now() - tP0);

    const perStrategy = [];

    for (const s of strategies) {
      const factHit = hasAll(s.pack.text, c.must) ? 1 : 0;
      const docHit = hasAnyGolden(s.pack.text, c.golden) ? 1 : 0;
      perStrategy.push({
        strategy: s.name,
        fact_hit: factHit,
        doc_hit: docHit,
        tokens: s.pack.tokens,
        latency_ms: s.latencyBase,
        top_ids: (s.pack.ids || []).slice(0, 5),
      });
    }

    perStrategy.push({
      strategy: 'samemind-bm25-k5',
      fact_hit: hasAll(bm25Bodies, c.must) ? 1 : 0,
      doc_hit: c.golden.some(g => bm25Ids.includes(g)) ? 1 : 0,
      tokens: tok(bm25Bodies),
      latency_ms: tBm25,
      top_ids: bm25Ids,
    });

    perStrategy.push({
      strategy: 'samemind-proactive',
      fact_hit: hasAll(pro.pack, c.must) ? 1 : 0,
      doc_hit: c.golden.some(g => pro.hits.some(h => h.id === g)) ? 1 : 0,
      tokens: pro.tokens,
      latency_ms: tPro,
      top_ids: pro.hits.map(h => h.id),
      manual_recalls_saved: pro.manualRecallsSaved,
    });

    rows.push({ case: c.id, query: c.query, golden: c.golden, must: c.must, results: perStrategy });
  }

  // Aggregate
  const stratNames = [
    'icl-full', 'icl-memory-index', 'icl-budget-8k', 'icl-budget-32k',
    'samemind-bm25-k5', 'samemind-proactive',
  ];
  const summary = {};
  for (const name of stratNames) {
    const cells = rows.map(r => r.results.find(x => x.strategy === name)).filter(Boolean);
    const n = cells.length || 1;
    summary[name] = {
      fact_hit_rate: +(cells.reduce((s, c) => s + c.fact_hit, 0) / n).toFixed(3),
      doc_hit_rate: +(cells.reduce((s, c) => s + c.doc_hit, 0) / n).toFixed(3),
      avg_tokens: Math.round(cells.reduce((s, c) => s + c.tokens, 0) / n),
      avg_latency_ms: +(cells.reduce((s, c) => s + c.latency_ms, 0) / n).toFixed(1),
      n,
    };
  }

  const report = {
    meta: {
      date: new Date().toISOString(),
      memory_root: MEMORY_ROOT,
      docs: docs.length,
      corpus_tokens_approx: corpusTokens,
      cases: CASES.length,
      chars_per_token: CHARS_PER_TOKEN,
      note: 'fact_hit = all must-keywords present in packed context; no LLM generation',
    },
    summary,
    rows,
  };

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote ${outPath}`);
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human table
  console.log('# ICL vs samemind recall — soul memory corpus');
  console.log(`docs=${docs.length}  corpus_tokens≈${corpusTokens}  cases=${CASES.length}`);
  console.log('');
  console.log('| strategy | fact@hit | doc@hit | avg tokens | avg latency ms |');
  console.log('|----------|----------|---------|------------|----------------|');
  for (const name of stratNames) {
    const s = summary[name];
    console.log(
      `| ${name} | ${(s.fact_hit_rate * 100).toFixed(0)}% | ${(s.doc_hit_rate * 100).toFixed(0)}% | ${s.avg_tokens} | ${s.avg_latency_ms} |`,
    );
  }
  console.log('');
  console.log('## Per-case (samemind-bm25-k5 vs icl-budget-8k vs icl-full)');
  console.log('| case | bm25 fact | bm25 doc | top-1 | icl-8k fact | icl-full fact | bm25 tok |');
  console.log('|------|-----------|----------|-------|-------------|---------------|----------|');
  for (const r of rows) {
    const bm = r.results.find(x => x.strategy === 'samemind-bm25-k5');
    const i8 = r.results.find(x => x.strategy === 'icl-budget-8k');
    const ifull = r.results.find(x => x.strategy === 'icl-full');
    console.log(
      `| ${r.case} | ${bm.fact_hit} | ${bm.doc_hit} | ${bm.top_ids[0] || '—'} | ${i8.fact_hit} | ${ifull.fact_hit} | ${bm.tokens} |`,
    );
  }
  console.log('');
  console.log('## Where memory wins / where ICL ties');
  const wins = [];
  const ties = [];
  const losses = [];
  for (const r of rows) {
    const bm = r.results.find(x => x.strategy === 'samemind-bm25-k5');
    const i8 = r.results.find(x => x.strategy === 'icl-budget-8k');
    const ifull = r.results.find(x => x.strategy === 'icl-full');
    if (bm.fact_hit && !i8.fact_hit) wins.push(r.case);
    else if (bm.fact_hit === i8.fact_hit) ties.push(r.case);
    else losses.push(r.case);
    // note full ICL
    void ifull;
  }
  console.log(`memory wins vs icl-8k (fact): ${wins.join(', ') || '—'}`);
  console.log(`tie vs icl-8k: ${ties.join(', ') || '—'}`);
  console.log(`memory loses vs icl-8k: ${losses.join(', ') || '—'}`);
  console.log(`icl-full fact_hit_rate: ${(summary['icl-full'].fact_hit_rate * 100).toFixed(0)}% @ ${summary['icl-full'].avg_tokens} tokens (always has the file if in corpus)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

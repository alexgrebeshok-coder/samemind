#!/usr/bin/env node
// bench-recall.mjs — mini BM25-vs-grep recall benchmark over the demo bundle.
// Fixed golden set (paraphrases WITHOUT exact title words). Prints a table to stdout.
// Methodology + numbers: docs/benchmark.md
//
//   OKF_ROOT=demo node tools/bench-recall.mjs
//   node tools/bench-recall.mjs          # defaults OKF_ROOT to ./demo
//
// Note: lib/okf.mjs freezes ROOT at first import, so we set OKF_ROOT *before*
// dynamically importing load().
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// rankByKeywords/queryTerms come from ./lib/recall.mjs, but we do NOT import it statically
// here (demo-harness fix 20.07, see docs/benchmark.md). ./lib/recall.mjs statically imports
// ./lib/hygiene.mjs, which statically imports ./lib/okf.mjs — and okf.mjs's `ROOT` export is
// a plain top-level `const` frozen the first time the module is evaluated. A static top-of-file
// import here would evaluate okf.mjs (transitively) before this file's own code ever runs —
// i.e. before the demo-default OKF_ROOT assignment below/in runBench() — permanently locking
// ROOT to the real package root instead of demo/. That silently emptied the doc pool for every
// query, so rankByKeywords always returned [] (BM25 hit@1/3 read 0% even though the engine
// itself was fine — verified independently via --synthetic and okf-recall.mjs). Deferring the
// import via getRecall() (called only after OKF_ROOT is set) avoids the freeze.
let _recall = null;
async function getRecall() {
  return _recall || (_recall = await import('./lib/recall.mjs'));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const DEMO_ROOT = resolve(PACKAGE_ROOT, 'demo');

/**
 * Fixed golden set. Queries are natural-language paraphrases that avoid exact title tokens
 * (no "Context budget", "Lumen", "Nova", "Atlas", "Acme Labs", …) so BM25 must score body
 * terms, and a naive multi-word grep has no free title hit.
 */
export const BENCH_CASES = [
  {
    query: 'finite window high-signal nodes truncate',
    golden: 'concepts/context-budget',
  },
  {
    query: 'cosine embedding index keyword when endpoint unavailable',
    golden: 'concepts/retrieval-strategy',
  },
  {
    query: 'local-first notes clean graph of backlinks',
    golden: 'projects/lumen',
  },
  {
    query: 'searchable graph of sources claims and notes',
    golden: 'projects/atlas',
  },
  {
    query: 'small fictional research lab sponsors internal tools',
    golden: 'entities/acme-labs',
  },
  {
    query: 'designer frequent collaborator owns the UX',
    golden: 'entities/iris-vale',
  },
  {
    query: 'reads edits runs and verifies directly in the repo',
    golden: 'concepts/engine-claude-code',
  },
  {
    query: 'receives chat requests dispatches work reports back',
    golden: 'concepts/engine-openclaw',
  },
  {
    query: 'longer autonomous coding passes worked to completion',
    golden: 'concepts/engine-opencode',
  },
  {
    query: 'software engineer power user of LLMs prefers evenings',
    golden: 'entities/alex-doe',
  },
  {
    query: 'same mind across engines dry wit no filler phrases',
    golden: 'concepts/nova',
  },
  {
    query: 'prefer fewer denser higher-signal nodes over shallow',
    golden: 'concepts/context-budget',
  },
];

/** Walk all .md files under root (skip tools/, .git/, node_modules). */
function walkMd(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'tools') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkMd(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * Naive baseline A — phrase grep: paste the whole paraphrase into `grep -il`.
 * No tokenization. Multi-word natural queries almost never match as a substring.
 * Returns matching ids (alpha order), capped at k.
 */
export function naiveGrepPhrase(query, bundleRoot, { k = 3 } = {}) {
  const files = walkMd(bundleRoot);
  if (!files.length || !String(query || '').trim()) return [];
  const res = spawnSync('grep', ['-il', '--', query, ...files], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.status !== 0 && res.status !== 1) return [];
  return (res.stdout || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(f => relative(bundleRoot, f).replace(/\.md$/, ''))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, k)
    .map(id => ({ id, score: 1 }));
}

/**
 * Naive baseline B — per-word `grep -il`, rank by how many query terms hit the file
 * (raw term-count, no IDF / length norm). Still weaker than BM25 on ranking quality
 * (often elevates index.md / common-word files).
 */
export async function naiveGrepTerms(query, bundleRoot, { k = 3 } = {}) {
  const { queryTerms } = await getRecall();
  const terms = queryTerms(query);
  const files = walkMd(bundleRoot);
  if (!files.length || !terms.length) return [];
  const termHits = new Map();

  for (const term of terms) {
    const res = spawnSync('grep', ['-il', '--', term, ...files], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status !== 0 && res.status !== 1) continue;
    for (const f of (res.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      const rel = relative(bundleRoot, f).replace(/\.md$/, '');
      if (!termHits.has(rel)) termHits.set(rel, new Set());
      termHits.get(rel).add(term);
    }
  }

  return [...termHits.entries()]
    .map(([id, set]) => ({ id, score: set.size }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

/** Default naive baseline used in the table: phrase grep (honest «paste into grep»). */
export function naiveGrepTop(query, bundleRoot, opts = {}) {
  return naiveGrepPhrase(query, bundleRoot, opts);
}

function hitAt(rankedIds, golden, k) {
  const i = rankedIds.indexOf(golden);
  return i >= 0 && i < k;
}

/**
 * Run the fixed golden bench.
 * @param {{ bundleRoot?: string, k?: number, loadFn?: Function }} opts
 *   loadFn — optional pre-bound load({includeSecret, includeMirror}) for tests;
 *   when omitted, dynamically imports lib/okf.mjs after ensuring OKF_ROOT.
 */
export async function runBench({ bundleRoot, k = 3, loadFn } = {}) {
  const root = resolve(bundleRoot || process.env.OKF_ROOT || DEMO_ROOT);
  if (!process.env.OKF_ROOT) process.env.OKF_ROOT = root;

  const { rankByKeywords } = await getRecall();

  let load = loadFn;
  if (!load) {
    // Dynamic import so ROOT is resolved *after* OKF_ROOT is set.
    const okf = await import('./lib/okf.mjs');
    load = okf.load;
  }

  const docs = load({ includeSecret: false, includeMirror: false }).filter(d => !d.reserved);
  const rows = [];

  for (const c of BENCH_CASES) {
    const bm25 = rankByKeywords(docs, c.query, { k, includeSecret: false, includeMirror: false });
    const bm25Ids = bm25.map(r => r.id);
    // Primary naive: whole-query phrase (what you get pasting into grep -il).
    const grepPhrase = naiveGrepPhrase(c.query, root, { k });
    const grepPhraseIds = grepPhrase.map(r => r.id);
    // Secondary: per-word term-count rank (still no IDF).
    const grepTerms = await naiveGrepTerms(c.query, root, { k });
    const grepTermIds = grepTerms.map(r => r.id);

    rows.push({
      query: c.query,
      golden: c.golden,
      bm25: bm25Ids,
      grep: grepPhraseIds,
      grep_terms: grepTermIds,
      bm25_hit1: hitAt(bm25Ids, c.golden, 1),
      bm25_hit3: hitAt(bm25Ids, c.golden, 3),
      grep_hit1: hitAt(grepPhraseIds, c.golden, 1),
      grep_hit3: hitAt(grepPhraseIds, c.golden, 3),
      grep_terms_hit1: hitAt(grepTermIds, c.golden, 1),
      grep_terms_hit3: hitAt(grepTermIds, c.golden, 3),
    });
  }

  const n = rows.length;
  const sum = key => rows.reduce((a, r) => a + (r[key] ? 1 : 0), 0);
  const metrics = {
    n,
    bm25_hit1: sum('bm25_hit1') / n,
    bm25_hit3: sum('bm25_hit3') / n,
    grep_hit1: sum('grep_hit1') / n,
    grep_hit3: sum('grep_hit3') / n,
    grep_terms_hit1: sum('grep_terms_hit1') / n,
    grep_terms_hit3: sum('grep_terms_hit3') / n,
  };

  return { rows, metrics, root };
}

// =========================================================================================
// Synthetic bench (N=1000+ generated concepts) — see bench/longmemeval/RESULTS.md
// "N=1000 synthetic" section for a recorded run. The fixed 12-query demo bench above is a
// micro-corpus smoke check; this exercises rankByKeywords() at a realistic personal-memory-
// bundle scale (BM25 corpus rebuild cost grows with N — the demo bench never shows that).
//
//   node tools/bench-recall.mjs --synthetic              # N=1000, 200 sampled queries
//   node tools/bench-recall.mjs --synthetic --n=5000 --queries=300
// =========================================================================================

/** Tiny seeded PRNG (mulberry32, public domain) — deterministic corpus/queries, no dependency. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Filler vocabulary shared across every synthetic doc — same role real prose's connective
// words play: high document-frequency, so BM25's IDF should discount them relative to a doc's
// own signature words.
const COMMON_WORDS = [
  'system', 'project', 'update', 'report', 'meeting', 'review', 'status', 'progress',
  'issue', 'plan', 'note', 'session', 'discussion', 'decision', 'team', 'client',
  'schedule', 'result', 'summary', 'context', 'detail', 'draft', 'version', 'topic',
];

function randPseudoWord(rng) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const len = 4 + Math.floor(rng() * 6); // 4-9 chars
  let w = '';
  for (let i = 0; i < len; i++) w += letters[Math.floor(rng() * letters.length)];
  return w;
}

/**
 * Generate N synthetic concept docs, shape-compatible with docText()/buildCorpus() (needs
 * `id`, `fm.{title,description,tags,visibility}`, `body`; `reserved: false` so rankByKeywords
 * doesn't filter them out). Each doc carries:
 *   - a 4-word "signature" unique to that doc (the query anchor — never shared with another doc)
 *   - 3 words from a shared cluster pool (~`clusterSize` docs per cluster) — realistic
 *     near-duplicate distractors, so recall isn't trivially 100% just because every doc is
 *     lexically isolated
 *   - repeated common filler words (see COMMON_WORDS) — gives BM25's IDF something to discount
 * `_signature` is carried on the doc for query generation only; it is not read by
 * docText()/buildCorpus() (they only look at fm.* and body) so it doesn't skew scoring.
 */
export function generateSyntheticCorpus(n, { seed = 42, clusterSize = 12 } = {}) {
  const rng = mulberry32(seed);
  const numClusters = Math.max(1, Math.ceil(n / clusterSize));
  const clusterWords = Array.from({ length: numClusters }, () => (
    Array.from({ length: 5 }, () => randPseudoWord(rng))
  ));
  const docs = [];
  for (let i = 0; i < n; i++) {
    const cluster = clusterWords[i % numClusters];
    const signature = Array.from({ length: 4 }, () => randPseudoWord(rng));
    const filler = Array.from({ length: 6 }, () => COMMON_WORDS[Math.floor(rng() * COMMON_WORDS.length)]);
    const bag = [...signature, ...signature, ...cluster.slice(0, 3), ...filler, ...filler];
    const sentences = [];
    for (let s = 0; s < 4; s++) {
      const pick = [];
      for (let w = 0; w < 6; w++) pick.push(bag[Math.floor(rng() * bag.length)]);
      sentences.push(pick.join(' '));
    }
    docs.push({
      id: `synthetic/doc-${String(i).padStart(6, '0')}`,
      fm: { title: `Synthetic note ${i}`, description: '', tags: [], visibility: 'internal' },
      body: `${sentences.join('. ')}.`,
      reserved: false,
      _signature: signature,
    });
  }
  return docs;
}

/** Query for one doc: 2 of its 4 signature words (partial — not the full signature, so
 *  recall isn't a guaranteed 100%), framed like a natural-language note lookup. */
function queryForDoc(doc, rng) {
  const sig = doc._signature;
  const a = sig[Math.floor(rng() * sig.length)];
  const b = sig[Math.floor(rng() * sig.length)];
  return `notes about ${a} and ${b}`;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Run BM25 recall@1/5/10 + latency p50/p95 over a synthetic corpus of `n` docs. `queryCount`
 * queries are sampled evenly across the corpus (deterministic given `seed` — reproducible
 * without needing all N docs queried). Each query calls rankByKeywords() end-to-end (corpus
 * rebuild + score), the same per-invocation cost a real single-shot CLI call pays — that's
 * what "latency" means here, not a warmed/cached corpus.
 */
export async function runSyntheticBench({ n = 1000, queryCount = 200, seed = 42 } = {}) {
  const { rankByKeywords } = await getRecall();
  const docs = generateSyntheticCorpus(n, { seed });
  const rng = mulberry32(seed + 1); // separate stream from corpus generation
  const step = Math.max(1, Math.floor(n / queryCount));
  const sampleIdx = [];
  for (let i = 0; i < n && sampleIdx.length < queryCount; i += step) sampleIdx.push(i);

  const latencies = [];
  let hit1 = 0, hit5 = 0, hit10 = 0;
  for (const i of sampleIdx) {
    const doc = docs[i];
    const query = queryForDoc(doc, rng);
    const t0 = performance.now();
    const ranked = rankByKeywords(docs, query, { k: 10 });
    latencies.push(performance.now() - t0);
    const ids = ranked.map(r => r.id);
    if (hitAt(ids, doc.id, 1)) hit1++;
    if (hitAt(ids, doc.id, 5)) hit5++;
    if (hitAt(ids, doc.id, 10)) hit10++;
  }
  latencies.sort((a, b) => a - b);
  const qn = sampleIdx.length;
  return {
    n,
    queryCount: qn,
    recallAt1: hit1 / qn,
    recallAt5: hit5 / qn,
    recallAt10: hit10 / qn,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  };
}

export function formatSyntheticResult(r) {
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const ms = x => `${x.toFixed(2)}ms`;
  return [
    `# samemind synthetic bench — BM25, N=${r.n} generated concepts, ${r.queryCount} queries`,
    '',
    `recall@1:  ${pct(r.recallAt1)}`,
    `recall@5:  ${pct(r.recallAt5)}`,
    `recall@10: ${pct(r.recallAt10)}`,
    `latency p50: ${ms(r.latencyP50Ms)}   p95: ${ms(r.latencyP95Ms)}`,
  ].join('\n');
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

export function formatTable({ rows, metrics }) {
  const lines = [];
  lines.push(`# samemind mini-bench — BM25 vs naive grep (demo bundle, n=${metrics.n})`);
  lines.push('');
  lines.push(
    pad('golden', 28) +
    pad('bm25@1', 8) +
    pad('bm25@3', 8) +
    pad('gphr@1', 8) +
    pad('gphr@3', 8) +
    'query',
  );
  lines.push('-'.repeat(100));
  for (const r of rows) {
    const yn = v => (v ? 'Y' : '.');
    lines.push(
      pad(r.golden, 28) +
      pad(yn(r.bm25_hit1), 8) +
      pad(yn(r.bm25_hit3), 8) +
      pad(yn(r.grep_hit1), 8) +
      pad(yn(r.grep_hit3), 8) +
      r.query,
    );
  }
  lines.push('-'.repeat(100));
  const pct = x => `${(x * 100).toFixed(0)}%`;
  lines.push(
    `hit@1  BM25 ${pct(metrics.bm25_hit1)}  (${Math.round(metrics.bm25_hit1 * metrics.n)}/${metrics.n})` +
    `   grep-phrase ${pct(metrics.grep_hit1)}  (${Math.round(metrics.grep_hit1 * metrics.n)}/${metrics.n})` +
    `   grep-terms ${pct(metrics.grep_terms_hit1)}  (${Math.round(metrics.grep_terms_hit1 * metrics.n)}/${metrics.n})`,
  );
  lines.push(
    `hit@3  BM25 ${pct(metrics.bm25_hit3)}  (${Math.round(metrics.bm25_hit3 * metrics.n)}/${metrics.n})` +
    `   grep-phrase ${pct(metrics.grep_hit3)}  (${Math.round(metrics.grep_hit3 * metrics.n)}/${metrics.n})` +
    `   grep-terms ${pct(metrics.grep_terms_hit3)}  (${Math.round(metrics.grep_terms_hit3 * metrics.n)}/${metrics.n})`,
  );
  lines.push('');
  lines.push('Per-query top-3 (BM25 | grep-phrase | grep-terms):');
  for (const r of rows) {
    lines.push(`  Q: ${r.query}`);
    lines.push(`     golden: ${r.golden}`);
    lines.push(`     bm25:        ${r.bm25.join(', ') || '—'}`);
    lines.push(`     grep-phrase: ${r.grep.join(', ') || '—'}`);
    lines.push(`     grep-terms:  ${r.grep_terms.join(', ') || '—'}`);
  }
  lines.push('');
  lines.push('Caveat: micro-corpus (demo ~11 concepts). Not BrainBench. See docs/benchmark.md.');
  return lines.join('\n');
}

function flagValue(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split('=')[1]) : fallback;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--synthetic')) {
    const result = await runSyntheticBench({
      n: flagValue('n', 1000),
      queryCount: flagValue('queries', 200),
      seed: flagValue('seed', 42),
    });
    console.log(formatSyntheticResult(result));
    process.exit(0);
  }
  if (!process.env.OKF_ROOT) process.env.OKF_ROOT = DEMO_ROOT;
  const result = await runBench({ bundleRoot: process.env.OKF_ROOT });
  console.log(formatTable(result));
  process.exit(0);
}

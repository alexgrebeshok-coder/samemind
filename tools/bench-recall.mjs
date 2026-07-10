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

import { rankByKeywords, queryTerms } from './lib/recall.mjs';

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
export function naiveGrepTerms(query, bundleRoot, { k = 3 } = {}) {
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
    const grepTerms = naiveGrepTerms(c.query, root, { k });
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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.env.OKF_ROOT) process.env.OKF_ROOT = DEMO_ROOT;
  const result = await runBench({ bundleRoot: process.env.OKF_ROOT });
  console.log(formatTable(result));
  process.exit(0);
}

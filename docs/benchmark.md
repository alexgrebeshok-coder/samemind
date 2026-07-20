# Mini-benchmark: BM25 vs naive grep

Small fixed recall bench over the **demo bundle** (`demo/`, ~11 non-reserved concepts).
Not a public leaderboard. Not [BrainBench](https://github.com/) / MTEB / BEIR.
Purpose: show that local BM25 (zero deps, no embeddings) already beats paste-into-`grep`
on natural paraphrases — and document the numbers honestly.

## How to run

```sh
OKF_ROOT=demo node tools/bench-recall.mjs
# or simply (defaults OKF_ROOT to ./demo):
node tools/bench-recall.mjs
```

Stdout = summary table + per-query top-3. Exit code is always 0 (observational, not a CI gate).
CI still runs `node --test tools/*.test.mjs` only.

## Methodology

| Piece | Detail |
|-------|--------|
| Corpus | `demo/**/*.md` concepts/entities/projects (reserved `index.md` / `log.md` excluded from BM25) |
| Queries | 12 fixed natural-language paraphrases (**no exact title tokens** — no «Lumen», «Nova», «Context budget», …) |
| Golden | One concept id per query (hand-labeled) |
| BM25 | `rankByKeywords` → `lib/bm25.mjs` over title+description+tags+body (`docText`), top-3 |
| grep-phrase | single `grep -il '<full query string>'` over demo markdown (no tokenization) |
| grep-terms | per-word `grep -il`, rank files by count of matching query terms (no IDF) |
| Metrics | hit@1 / hit@3 = golden appears in the first 1 / 3 ranked ids |

**Why both greps?** Pasting a multi-word paraphrase into `grep -il` is the real naive baseline
(phrase almost never occurs verbatim). Per-word term-count is a slightly stronger
hand-rolled baseline — still no IDF or length norm, and it often ranks `index.md` high.

## Current numbers

Recorded on `auto/n7-ci` against the demo bundle shipped in-tree (re-run the script to refresh).

> **demo-harness fix 20.07:** `tools/bench-recall.mjs` had a pre-existing bug (not a regression,
> not in the BM25 engine) that made a plain `node tools/bench-recall.mjs` run print **BM25
> hit@1/3 = 0%** instead of the numbers below. Root cause: the file's top-level `import ... from
> './lib/recall.mjs'` transitively (via `lib/hygiene.mjs`) loaded `lib/okf.mjs` — whose `ROOT`
> export is a top-level `const` frozen at first import — *before* the script ever set `OKF_ROOT`
> to the demo bundle, so `okf.load()` silently read the wrong (real, near-empty) package root
> instead of `demo/`, leaving BM25's doc pool empty for every query. `naiveGrepTerms`/
> `naiveGrepPhrase` were unaffected (they walk `bundleRoot` directly, no `okf.mjs` dependency),
> which is why grep-terms still read 100% while BM25 read 0% — the tell that the bug was in the
> harness's import order, not the ranker. Confirmed via `--synthetic` (95% recall@1, N=1000,
> unaffected — no filesystem/`okf.mjs` path) and the live `okf-recall.mjs` (finds facts
> correctly) both working throughout. Fixed by deferring the `./lib/recall.mjs` import behind a
> lazy `getRecall()` (dynamic `import()`, same pattern already used for `./lib/okf.mjs`),
> resolved only after `OKF_ROOT` is set — no change to `lib/bm25.mjs`, `lib/recall.mjs`, or
> `lib/hygiene.mjs`. The table below reflects the harness's *correct* output, matching what it
> was always meant to document.

| Method | hit@1 | hit@3 |
|--------|------:|------:|
| **BM25** | **100%** (12/12) | **100%** (12/12) |
| grep-phrase | 0% (0/12) | 0% (0/12) |
| grep-terms | 100% (12/12) | 100% (12/12) |

### Fixed queries (golden)

1. `finite window high-signal nodes truncate` → `concepts/context-budget`
2. `cosine embedding index keyword when endpoint unavailable` → `concepts/retrieval-strategy`
3. `local-first notes clean graph of backlinks` → `projects/lumen`
4. `searchable graph of sources claims and notes` → `projects/atlas`
5. `small fictional research lab sponsors internal tools` → `entities/acme-labs`
6. `designer frequent collaborator owns the UX` → `entities/iris-vale`
7. `reads edits runs and verifies directly in the repo` → `concepts/engine-claude-code`
8. `receives chat requests dispatches work reports back` → `concepts/engine-openclaw`
9. `longer autonomous coding passes worked to completion` → `concepts/engine-opencode`
10. `software engineer power user of LLMs prefers evenings` → `entities/alex-doe`
11. `same mind across engines dry wit no filler phrases` → `concepts/nova`
12. `prefer fewer denser higher-signal nodes over shallow` → `concepts/context-budget`

### Reading the numbers honestly

- **Phrase grep fails completely** — none of the paraphrases appear as a contiguous
  substring in any demo file. BM25 tokenizes and ranks; that is the whole point of a
  keyword ranker over raw `grep`.
- **Term-count grep also hits 100% on this micro-corpus** when queries reuse body words.
  On ~11 docs, overlapping content words + simple count is enough. Ranking quality still
  differs (grep-terms frequently elevates `index` / generic files into top-3; BM25 keeps
  concept nodes on top via IDF + length norm).
- **Do not cite these % as general IR quality.** A dozen synthetic concepts is not a
  retrieval benchmark. For real evaluation you want a larger labeled set (and, when
  embeddings are available, a semantic lane). This file exists so the demo claim
  «BM25 works out of the box» is backed by a reproducible micro-check, not vibes.

## Caveats (read these)

1. **Micro-corpus.** Demo size by design. Percentages inflate.
2. **Not BrainBench / not semantic.** No embeddings path in this bench (`--mode bm25` only).
3. **Goldens are author-chosen** for the demo story (Nova, Lumen, engines, …), not sampled from production memory.
4. **No statistical significance.** n=12, one run, deterministic.
5. **Secret / mirror tiers** are out of scope here (see `tools/secret-isolation.test.mjs`).

## Related

- Implementation: [`tools/bench-recall.mjs`](../tools/bench-recall.mjs)
- BM25: [`tools/lib/bm25.mjs`](../tools/lib/bm25.mjs)
- Recall API: [`tools/lib/recall.mjs`](../tools/lib/recall.mjs) (`rankByKeywords`)

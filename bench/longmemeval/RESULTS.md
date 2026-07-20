# Results — samemind on LongMemEval-S (memory-core-eval)

Full run: 500/500 questions, LongMemEval-S split, `--workers 4`, no sampling, no `as_of_date`
handling, no semantic index (`OKF_EMBED_URL` unset — pure BM25 fallback, samemind's zero-dep
default). Wall time: **47.1s** end-to-end (dataset load + indexing + search for all 500
questions). Zero API calls, zero LLM tokens spent — see "What this benchmark measures" below.

Raw output: [`results/samemind_s_2026-07-12_22-47-08_n500.json`](./results/samemind_s_2026-07-12_22-47-08_n500.json).
Smoke run (n=10, same split): [`results/smoke/samemind_s_2026-07-12_22-45-47_n10.json`](./results/smoke/samemind_s_2026-07-12_22-45-47_n10.json).
Reproduce: [`README.md`](./README.md).

## What this benchmark measures (read before the numbers)

`memory-core-eval` is a **pure retrieval benchmark**: Recall@k on `session_id`, computed as the
intersection of the top-k retrieved sessions with the gold `answer_session_ids`. There is no LLM
call anywhere in the harness — no RAG answer generation, no LLM-as-judge. `QuestionResult.hypothesis`
(best-matching retrieved text) exists in the data model "for a QA judge" but the harness itself
never uses it.

This means **the numbers below are not comparable to published Mem0/Zep/Letta LongMemEval numbers**,
which use the *original* LongMemEval protocol (retrieval → RAG generation → GPT-4o-as-judge
accuracy). Two different metrics on the same dataset. The harness's own README is explicit about
this and only publishes its **own** BM25 / Dense / Hybrid-RRF / Memory Core numbers as the
apples-to-apples comparison set (same code, same metric, same dataset revision) — that is the
only comparison drawn here. For context only, independent replication has shown vendor
self-reported LongMemEval numbers for competing memory products can diverge from independent
reproductions by roughly 2x (Mem0 self-report 94.8% vs. an independent replication at ~49% on
GPT-4o, per public write-ups) — one more reason not to cross-compare metrics that were never
designed to be compared.

Also note the harness indexes at **turn level** (a session counts as a hit if any one of its
turns lands in the top-k) rather than whole-session level, which is why its own BM25 anchor here
(96.2% R@10) reads much higher than the 86.2% the original LongMemEval paper reports for BM25 —
that's a deliberate granularity choice by the harness authors ("matches how production memory
systems actually operate"), not a discrepancy in this run.

## Overall Recall@k — samemind vs. the harness's own anchors

Same code, same metric, same dataset (`xiaowu0162/longmemeval-cleaned`, `s` split, full n=500,
470 answerable + 30 abstention questions in every row below — verified identical `by_type` counts
across all four runs).

| System | R@1 | R@5 | R@10 |
|---|---:|---:|---:|
| BM25 (harness anchor) | 84.7% | 93.2% | 96.2% |
| **samemind (BM25, this run)** | **85.7%** | **92.8%** | **96.4%** |
| Dense MiniLM (harness anchor) | 86.8% | 94.7% | 97.2% |
| Hybrid-RRF (harness anchor) | 89.8% | 96.0% | 97.9% |
| Memory Core (harness anchor, self-hosted) | 94.3% | 98.3% | 99.6% |

samemind's default recall lands within noise of the harness's own BM25 anchor (±1pt on every
column) — expected: samemind's fallback ranker (`tools/lib/bm25.mjs`) is the same Okapi BM25
family (k1=1.2, b=0.75, same as the harness's `rank-bm25`-based baseline) tokenizing the same raw
turn text, over the same haystack. It does not reach Dense/Hybrid-RRF/Memory Core levels, which is
also expected: samemind's zero-dep default has no semantic embeddings active in this run (no
`OKF_EMBED_URL` configured — see "Scope" below), no cross-encoder rerank, and no RRF fusion.

## By question type

| Type | n | samemind R@1 | BM25 anchor R@1 | samemind R@10 | BM25 anchor R@10 |
|---|---:|---:|---:|---:|---:|
| single-session-assistant | 56 | 100.0% | 100.0% | 100.0% | 100.0% |
| single-session-user | 64 | 95.3% | 93.8% | 100.0% | 100.0% |
| knowledge-update | 72 | 94.4% | 95.8% | 100.0% | 100.0% |
| temporal-reasoning | 127 | 83.5% | 80.3% | 93.7% | 93.7% |
| multi-session | 121 | 82.6% | 83.5% | 98.3% | 97.5% |
| single-session-preference | 30 | 40.0% | 33.3% | 76.7% | 76.7% |
| abstention (precision, no-answer) | 30 | 100.0% | 100.0% | 100.0% | 100.0% |

Two things worth calling out honestly, in both directions:

- **temporal-reasoning did not fall off a cliff without `as_of_date` support.** samemind ties or
  beats the BM25 anchor on this category at every k (R@1 83.5% vs. 80.3%, R@10 93.7% vs. 93.7%
  exactly). The BM25 anchor also ignores `as_of_date` by design (see its own adapter code), so
  this is an apples-to-apples "no temporal reasoning at all" comparison, not evidence that
  samemind secretly handles time — it doesn't (see below). Memory Core's own `as_of_date`-aware
  boost pushes this category further (90.6% R@1 in the harness's published numbers), which is the
  gap a real temporal mechanism would close.
- **single-session-preference is the weak category for everyone without semantic search** — BM25
  anchor 33.3%/76.7%, samemind 40.0%/76.7%, Dense anchor 70.0%/96.7%. samemind's raw-BM25 number
  here is a few points *above* the harness's own BM25 anchor (likely just tokenizer differences —
  samemind's `bm25.mjs` tokenizes on Unicode letter/number classes, the harness's `rank-bm25`
  path on `[A-Za-z0-9_]+`; not a meaningful edge, noise on n=30), but both sit far below what
  semantic retrieval reaches on this category. This is the one place in this dataset where turning
  on `OKF_EMBED_URL` would plausibly matter most for samemind — untested here (see Scope).

## Scope — what was run, what wasn't, and why

- **BM25 only, no semantic pass.** samemind's semantic recall requires an OpenAI-compatible
  `/v1/embeddings` endpoint (`OKF_EMBED_URL`); none was available in this environment. Per the
  task instructions, this run does not "invent" a semantic comparison against no real endpoint —
  BM25-only is samemind's honest, zero-dependency default, and it's what's reported.
- **LongMemEval-S only, not LoCoMo or LongMemEval-M.** As scoped by the task. LongMemEval-M is
  a multi-GB, multi-hour download/run per the harness's own docs — out of scope here.
- **No `as_of_date` / temporal-window logic.** The bridge accepts and ignores it (matching the
  harness's own BM25 baseline stance: "time-agnostic by design"). samemind's actual mechanism in
  this space — `tools/lib/hygiene.mjs`'s decay multiplier — is designed for aging out stale
  *curated concepts* by their own `fm.timestamp`, not for resolving relative-time phrases in a
  *query* against candidate timestamps. Turn nodes in this bench deliberately do **not** set
  `fm.timestamp` (kept in a separate, inert `session_date` field instead) — LongMemEval sessions
  are dated ~2023, which against a 2026 wall clock would trip the decay penalty near-uniformly
  across every turn in a haystack, exactly the failure mode the pre-run recon flagged (old-but-gold
  sessions penalized for age, not relevance). Using the escape hatch honestly (not setting the
  field) rather than gaming it (e.g. mislabeling turns with a timeless type) seemed like the
  correct call; it does mean samemind gets no credit here for date-aware reasoning it doesn't have.

## What this benchmark cannot see

LongMemEval/LoCoMo (via memory-core-eval) test one thing: given a haystack of raw, unstructured
conversation turns, can you retrieve the session(s) containing the answer. That is a real and
useful primitive, and turn-level ingestion is a **forced, non-native mode** for samemind — its
actual design target is hand-curated, typed concept graphs (`Concept`/`Entity`/`Project`/`Decision`
markdown nodes with YAML frontmatter and typed relations), at a scale of hundreds to low thousands
of concepts, not tens of thousands of undifferentiated chat turns. This benchmark is structurally
blind to everything that is actually the point of samemind:

- **Identity brief** — a stable, engine-portable sense of "who am I / who do I work with"
  (`IDENTITY.md`/`USER.md`-style nodes), not retrieved-per-query at all.
- **Cross-engine handoff** — structured session handoff between different AI engines/tools
  sharing one bundle.
- **Work-discipline board** — typed `Plan`/`Task` status lifecycle with validation
  (`tools/lib/okf.mjs`'s `disciplineChecks`), kanban-style, not a retrieval query.
- **Typed relation graph** — `relations:` edges between concepts (supersedes, relates-to, etc.),
  traversable structure that raw turn-recall has no equivalent of.
- **Memory hygiene** — supersedes/deprecated/importance/decay on *curated* facts (the mechanism
  this bench deliberately avoided tripping on raw turns, see above) — a real feature for its
  actual use case, just not one this benchmark can exercise or reward.

A fair one-line summary: this bench measured samemind's simplest, most generic capability
(keyword recall over undifferentiated text) on a workload it wasn't built for, using its cheapest
possible configuration (no embeddings), and it came out statistically tied with a reference BM25
implementation on the same metric. That is a real, useful data point about the floor — it says
nothing about the ceiling, which lives in the capabilities this benchmark cannot observe.

## N=1000 synthetic (separate harness — not memory-core-eval, read this scope note first)

Everything above this section is the LongMemEval/memory-core-eval run (Python harness, real
dataset, turn-level session recall). This section is a **different, self-contained bench**:
`tools/bench-recall.mjs --synthetic`, pure Node/ESM, zero deps, no external dataset — it
generates its own synthetic OKF-shaped concept corpus to see how `rankByKeywords()` (samemind's
BM25 fallback, `tools/lib/bm25.mjs`) behaves at a scale the 12-query demo bench (`docs/benchmark.md`)
is too small to expose: corpus-rebuild cost grows with N (BM25 in this codebase rebuilds its
corpus stats on every call — see `tools/lib/recall.mjs`'s `rankByKeywords`), so latency at
N=1000 is a real number the demo bench (n=12) cannot show.

**Corpus generator** (`generateSyntheticCorpus`, seeded `mulberry32` PRNG — deterministic,
reproducible): each doc gets a 4-word signature unique to it (the query anchor), 3 words from a
shared ~12-doc cluster pool (realistic near-duplicate distractors so recall isn't a trivial
100%), and repeated common filler words (`system`, `project`, `update`, …) so BM25's IDF has
something to discount, the way real prose's connective words do. Queries: 200 sampled evenly
across the 1000 docs, each built from 2 of that doc's 4 signature words (a partial paraphrase,
not the full signature) — golden = the source doc's id.

Reproduce:

```sh
node tools/bench-recall.mjs --synthetic                      # N=1000, 200 queries, seed=42
node tools/bench-recall.mjs --synthetic --n=5000 --queries=300 --seed=7   # override any of the three
```

Recorded run (`node tools/bench-recall.mjs --synthetic`, default N=1000/200 queries/seed=42):

| Metric | Value |
|---|---:|
| N (corpus size) | 1000 |
| Queries | 200 |
| Recall@1 | 95.0% (190/200) |
| Recall@5 | 95.0% (190/200) |
| Recall@10 | 95.0% (190/200) |
| Latency p50 | ~5.8ms / query |
| Latency p95 | ~6.6ms / query |

Recall is flat across k=1/5/10 because when `rankByKeywords()` finds the golden doc at all, its
two matching signature words plus BM25's length-normalized IDF put it in rank 1 essentially every
time on this corpus (isolated per-doc vocabulary, no semantic ambiguity) — the ~5% miss rate is
queries whose 2 sampled signature words happen to collide more with a same-cluster distractor's
shared words than with their own doc's remaining, unsampled signature words; k barely matters
because it's rank-1-or-not-found, not a long tail of near-misses. Latency (a single
`rankByKeywords()` call: tokenize + corpus rebuild over all 1000 docs + score) sits a couple
milliseconds — for reference, `tools/lib/mcp.mjs`'s `readableDocs()` (used by every MCP tool
call) rebuilds the full doc list from `tools/lib/okf.mjs` `load()` on top of this on every
invocation; see the per-file parse cache added to `load()` (this Ф1 pass) for the walk+parse
half of that cost — this section only measures the BM25 ranking half.

**Caveats** (same spirit as the demo bench's, see above): synthetic pseudo-word vocabulary, not
real language — no semantic ambiguity, no synonymy, no polysemy, so this is a **structural**
recall/latency check (does BM25 hold up when N grows, not "how good is BM25 at real natural-
language recall" — that question is what the LongMemEval run above and the demo bench in
`docs/benchmark.md` are for). Numbers will shift run-to-run for `--seed` values other than the
recorded 42, though recall stays close given the fixed generation scheme.

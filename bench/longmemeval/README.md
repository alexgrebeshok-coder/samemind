# samemind × memory-core-eval (LongMemEval)

Runs samemind's default (zero-dep, BM25) recall path through
[memory-core-eval](https://github.com/Evanyuan-builder/memory-core-eval) — a **retrieval-recall**
benchmark (Recall@k over session_id, no LLM calls, no answer generation, no judge) built around
[LongMemEval](https://arxiv.org/abs/2410.10813) and LoCoMo. Full findings and honest caveats:
[`RESULTS.md`](./RESULTS.md).

## Why a bridge, not a native adapter

memory-core-eval is Python (`mceval/`); samemind is Node/ESM. samemind also has no native
"store one raw conversation turn" API — the only MCP write path (`memory_write_inbox`) appends
unstructured prose to a single file, not the discrete, session/turn-tagged nodes turn-level Recall@k
needs. So this directory ships:

- **`bridge/eval-server.mjs`** — a small persistent Node HTTP server. On `store`, it writes each
  `Turn` as a real markdown node (with frontmatter) directly into a scratch OKF-shaped bundle
  directory — bypassing MCP entirely. On `search`, it calls samemind's own default recall
  function in-process: `tools/lib/recall.mjs`'s `rankByKeywords()`, itself a thin wrapper over
  `tools/lib/bm25.mjs`'s Okapi BM25 — the exact code path samemind's `recallSearch()` falls back
  to when no semantic index / embeddings endpoint is configured. See the file's header comment
  for the two deliberate design calls (write-through in-memory doc list instead of re-walking the
  bundle on every search; keeping turn timestamps out of `fm.timestamp` to avoid tripping
  `hygiene.mjs`'s stale-concept decay penalty on 2023-dated raw turns).
- **`adapter/samemind_adapter.py`** — a `MemoryAdapter` (per `mceval.adapters.base`) that talks
  HTTP to the bridge, modeled on the harness's own built-in `mceval/adapters/memory_core.py`
  (same per-namespace store-buffer-then-flush-before-search pattern).
- **`adapter/test_samemind_adapter.py`** — a stdlib-only mirror of the harness's own
  `tests/test_adapter_contract.py` (the harness doesn't ship this adapter, so its contract test
  can't parametrize over it; this reproduces the same assertions instead of forking the harness).
- **`run_eval.py`** — drives `mceval.eval.runner.run_eval()` directly (same dataset loader /
  runner / scorer the harness's own CLI uses) instead of going through `mceval`'s CLI, whose
  `ADAPTERS` registry is hardcoded to six built-in names and doesn't know about samemind.

Nothing here touches samemind's core (`lib/`, `tools/*.mjs` outside of the read-only imports
above) or its root `package.json` — no new npm dependency was added anywhere in the repo.
`bench/` uses only Python stdlib + `httpx`/`huggingface_hub` (already memory-core-eval's own
dependencies) on the Python side, and Node core modules (`node:http`, `node:fs`, `node:os`,
`node:path`) plus samemind's *existing* `tools/lib/recall.mjs`/`bm25.mjs` on the Node side.

## Reproduce it

**1. Get the harness** (not vendored here — it's a separate, independent project):

```bash
git clone https://github.com/Evanyuan-builder/memory-core-eval.git /tmp/memory-core-eval
export MCEVAL_ROOT=/tmp/memory-core-eval
```

No `pip install` is required: `mceval/` is a plain importable package and its only non-stdlib
runtime dependency on this path is `httpx` + `huggingface_hub` (for the dataset download) — both
already present in any environment that's run memory-core-eval before. If you don't have them:

```bash
python3 -m pip install httpx huggingface_hub
```

(`mceval.cli` and the `bm25`/`dense`/`hybrid-rrf` baseline adapters need `rank-bm25` /
`sentence-transformers` too, but `run_eval.py` here never imports `mceval.cli` or those baseline
adapters, so it doesn't need them.)

**2. Start the Node bridge** (from the samemind repo root, in its own terminal — it stays up for
the whole eval run):

```bash
node bench/longmemeval/bridge/eval-server.mjs
# samemind eval-bridge listening on http://127.0.0.1:8799 (bundle root: /tmp/samemind-mceval-XXXXXX)
```

**3. Contract check** (optional but recommended — confirms the bridge and adapter actually
satisfy `MemoryAdapter` before spending time on a real dataset run):

```bash
PYTHONPATH="$MCEVAL_ROOT" python3 bench/longmemeval/adapter/test_samemind_adapter.py
# 7/7 passed
```

**4. Smoke run** (n=10, LongMemEval-S — same split as the full run, just tiny; confirms the
mechanics work at the real ~500-turns/question scale before committing to the full 500):

```bash
PYTHONPATH="$MCEVAL_ROOT" python3 bench/longmemeval/run_eval.py \
    --split s --sample 10 --seed 0 --workers 2 --verbose \
    --out-dir bench/longmemeval/results/smoke
```

First run downloads `longmemeval_s_cleaned.json` from
`xiaowu0162/longmemeval-cleaned` on HuggingFace (cached under
`~/.cache/memory-core-eval/` after that).

**5. Full run** (LongMemEval-S is exactly 500 questions — no `--sample` needed for the full
split; this is what `RESULTS.md` reports):

```bash
PYTHONPATH="$MCEVAL_ROOT" python3 bench/longmemeval/run_eval.py \
    --split s --workers 4 \
    --out-dir bench/longmemeval/results
```

Took 47s end-to-end (dataset load + 500 questions × ~490 turns indexed + 1 search each) on a
single M-series laptop. No API calls, no LLM tokens, no network beyond the one-time HuggingFace
dataset download — this is a pure retrieval benchmark (see `RESULTS.md` §"What this benchmark
measures").

**Don't do this (out of scope, not what was asked):** running `--dataset locomo`, running a
second pass with `OKF_EMBED_URL` set to compare BM25 vs semantic, or wiring an
`as_of_date`-aware temporal boost into the bridge. All three are real, honestly-scoped follow-ups
(see `RESULTS.md`), not silently-invented extras.

## Files

```
bench/longmemeval/
├── README.md                    — this file
├── RESULTS.md                   — numbers + honest limitations
├── bridge/
│   └── eval-server.mjs          — Node HTTP bridge (writes Turn .md nodes, searches via recall.mjs/bm25.mjs in-process)
├── adapter/
│   ├── samemind_adapter.py      — Python MemoryAdapter → bridge HTTP client
│   └── test_samemind_adapter.py — contract check (stdlib unittest-style, no pytest needed)
├── run_eval.py                  — drives mceval's runner directly (bypasses mceval.cli's adapter registry)
└── results/
    ├── samemind_s_*_n500.json   — full-run summary + per-question results (committed)
    └── smoke/samemind_s_*_n10.json — smoke-run summary (committed)
```

Per-question JSONL traces (`--trace`) are NOT committed — a full n=500 trace is ~290 MB of
audit scratch, gitignored (`bench/longmemeval/results/**/*.jsonl`). Regenerate locally if needed.

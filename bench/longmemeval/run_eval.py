#!/usr/bin/env python3
"""Drive memory-core-eval's runner directly against SamemindAdapter.

Why not `mceval run --adapter samemind ...`: the harness's CLI (`mceval/cli.py`) has a hardcoded
`ADAPTERS` registry (bm25/dense/hybrid-rrf/memory-core/hindsight/m-flow) and SamemindAdapter isn't
in it. Rather than fork/patch the third-party harness to register a seventh adapter, this script
calls the same public building blocks the CLI itself uses — `mceval.datasets.longmemeval.
load_longmemeval`, `mceval.eval.runner.run_eval`, `mceval.eval.metrics` — directly. Same dataset
loader, same runner, same scorer, same metrics; just no CLI registry indirection.

Requires:
  - memory-core-eval importable: PYTHONPATH pointed at its repo root (no pip install needed —
    it's a plain `mceval/` package with stdlib + httpx + huggingface_hub deps, all already
    satisfied by a normal environment; see README).
  - the Node bridge running: `node bench/longmemeval/bridge/eval-server.mjs`

Usage:
  PYTHONPATH=/path/to/memory-core-eval python3 bench/longmemeval/run_eval.py \\
      --split s --sample 100 --stratified --seed 0 --out-dir bench/longmemeval/results

See README.md for the full reproduction recipe (dataset download size/time, bridge startup, etc).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "adapter"))

from mceval.datasets.longmemeval import SPLIT_FILENAMES, load_longmemeval  # noqa: E402
from mceval.eval.runner import run_eval  # noqa: E402
from mceval.eval.scorer import QuestionResult  # noqa: E402
from mceval.eval.trace import TraceWriter  # noqa: E402

from samemind_adapter import SamemindAdapter, bridge_available  # noqa: E402


def _print_summary(adapter_name: str, out) -> None:
    m = out.metrics
    ov = m.get("overall", {})
    print("")
    print("-" * 62)
    print(f"  {adapter_name} -- n={m['n_total']} ({out.meta['elapsed_s']:.0f}s)")
    print(f"  Answerable: {m['n_answerable']}  |  Abstention: {m['n_abstention']}")
    print("-" * 62)
    parts = "  ".join(f"R@{k}={ov.get(f'recall@{k}', 0):5.1f}%" for k in [1, 5, 10])
    print(f"  Overall (answerable)  {parts}")
    print("-" * 62)
    for qtype, x in m.get("by_type", {}).items():
        parts = "  ".join(f"@{k}={x.get(f'recall@{k}', 0):5.1f}%" for k in [1, 5, 10])
        print(f"  {qtype:<30} n={x['n']:3d}  {parts}")
    abs_m = m.get("abstention", {})
    if abs_m:
        parts = "  ".join(f"@{k}={abs_m.get(f'precision@{k}', 0):5.1f}%" for k in [1, 5, 10])
        print(f"  {'abstention (no-answer)':<30} n={m['n_abstention']:3d}  {parts}  [x=correct]")
    print("-" * 62)


def _result_to_dict(r: QuestionResult) -> dict:
    d = asdict(r)
    d["recall"] = {str(k): v for k, v in r.recall.items()}
    return d


def _save_output(out, out_dir: Path, adapter_name: str, split: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    path = out_dir / f"{adapter_name}_{split}_{ts}_n{out.meta['n_questions']}.json"
    payload = {
        "meta": out.meta,
        "metrics": out.metrics,
        "results": [_result_to_dict(r) for r in out.results],
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Run SamemindAdapter through memory-core-eval's LongMemEval runner")
    p.add_argument("--split", default="oracle", choices=sorted(SPLIT_FILENAMES))
    p.add_argument("--sample", type=int, default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--stratified", action="store_true")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--out-dir", default="bench/longmemeval/results")
    p.add_argument("--trace", default=None)
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--bridge-url", default=None, help="override SAMEMIND_BRIDGE_URL")
    args = p.parse_args(argv)

    if not bridge_available(args.bridge_url):
        print(
            "ERROR: samemind eval bridge not reachable "
            f"({args.bridge_url or 'http://127.0.0.1:8799'}). "
            "Start it first: node bench/longmemeval/bridge/eval-server.mjs",
            file=sys.stderr,
        )
        return 2

    tag = "stratified" if args.stratified else (f"seed={args.seed}" if args.seed is not None else "head")
    dataset = load_longmemeval(split=args.split, sample=args.sample, seed=args.seed, stratified=args.stratified)
    print(f"Loaded {len(dataset)} LongMemEval-{args.split} questions ({tag})")

    adapter = SamemindAdapter(base_url=args.bridge_url)
    print(f"Running adapter: {adapter.name}  (workers={args.workers})")

    def _progress(done: int, total: int, r: QuestionResult) -> None:
        hits = "".join("v" if r.recall.get(k) else "x" for k in sorted(r.recall))
        print(f"  [{done:3d}/{total}] {r.question_id[:32]:<32} {r.question_type[:22]:<22} "
              f"idx={r.n_indexed:3d}  {hits}  ({r.elapsed_s:.1f}s)", flush=True)

    trace_writer = TraceWriter(args.trace) if args.trace else None
    try:
        out = run_eval(
            adapter=adapter,
            dataset=dataset,
            workers=args.workers,
            on_progress=_progress if args.verbose else None,
            trace_writer=trace_writer,
            dataset_name=f"longmemeval-{args.split}",
        )
    finally:
        if trace_writer:
            trace_writer.close()
        adapter.close()

    _print_summary("samemind", out)

    if args.out_dir:
        path = _save_output(out, Path(args.out_dir), "samemind", args.split)
        print(f"\n  Saved -> {path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

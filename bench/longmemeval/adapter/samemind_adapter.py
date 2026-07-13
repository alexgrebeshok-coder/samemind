"""SamemindAdapter — memory-core-eval MemoryAdapter for samemind.

samemind (github.com/alexgrebeshok-coder/samemind) is Node/ESM; memory-core-eval
(github.com/Evanyuan-builder/memory-core-eval) is Python. This adapter is the Python side of the
bridge: it satisfies the three-method `MemoryAdapter` Protocol (`mceval.adapters.base`) by talking
HTTP to a small persistent Node process — `bench/longmemeval/bridge/eval-server.mjs` — that writes
each Turn as a real markdown node into a scratch OKF bundle and answers `search` via samemind's own
in-process BM25 recall path (`tools/lib/recall.mjs`'s `rankByKeywords`, itself a thin wrapper over
`tools/lib/bm25.mjs`). See eval-server.mjs's module docstring for the design rationale (why a
write-through in-memory doc list instead of re-walking the bundle on every search, why turn
timestamps are kept out of `fm.timestamp`).

Modeled on the harness's own `mceval/adapters/memory_core.py` (the built-in self-hosted HTTP
adapter) — same batching idea: buffer stores per-namespace and flush as one request right before
the first `search()` call in that namespace, since the harness's own runner stores all turns for a
question in a tight sequential loop before issuing a single search (see `mceval/eval/runner.py`).

Usage (mirrors `MemoryCoreAdapter(base_url=...)`):

    from samemind_adapter import SamemindAdapter
    adapter = SamemindAdapter()                              # default: http://127.0.0.1:8799
    adapter = SamemindAdapter(base_url="http://127.0.0.1:9000")

The bridge process itself is NOT started by this adapter — start it separately
(`node bench/longmemeval/bridge/eval-server.mjs`) before running an eval. See
`bench/longmemeval/README.md` for the full reproduction recipe.
"""
from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime
from typing import Optional

import httpx

# mceval.adapters.base is provided by the memory-core-eval harness (added to PYTHONPATH by the
# caller — see README). Not vendored here: keeps this file a pure adapter, no harness fork.
from mceval.adapters.base import Memory, Turn

DEFAULT_BRIDGE_URL = "http://127.0.0.1:8799"


class SamemindAdapter:
    name = "samemind"

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,  # unused; accepted for ADAPTERS-factory signature parity
        timeout: float = float(os.getenv("MCEVAL_HTTP_TIMEOUT", "60")),
        **_,
    ) -> None:
        self.base_url = base_url or os.getenv("SAMEMIND_BRIDGE_URL") or DEFAULT_BRIDGE_URL
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)

        # Per-namespace pending-store buffer, flushed as one HTTP call before the first search()
        # (or dropped on reset()) — avoids one HTTP round trip per turn (~500 turns/question on
        # the LongMemEval-S split). Same rationale as MemoryCoreAdapter._flush.
        self._buffers: dict[str, list[dict]] = defaultdict(list)

    def reset(self, namespace: str) -> None:
        self._buffers.pop(namespace, None)
        r = self._client.post("/reset", json={"namespace": namespace})
        r.raise_for_status()

    def store(self, namespace: str, turn: Turn) -> str:
        payload = {
            "content": turn.content,
            "role": turn.role,
            "session_id": turn.session_id,
            "turn_idx": turn.turn_idx,
            "session_idx": turn.session_idx,
            "timestamp": turn.timestamp.isoformat() if turn.timestamp is not None else None,
        }
        self._buffers[namespace].append(payload)
        # Synthetic id: buffered stores aren't assigned a bridge id until flush. The runner only
        # uses this id for adapters that need it internally; the scorer keys on
        # Memory.session_id/turn_idx from search(), not on this string.
        return f"{namespace}:{turn.session_id}:{turn.turn_idx}"

    def _flush(self, namespace: str) -> None:
        pending = self._buffers.pop(namespace, [])
        if not pending:
            return
        r = self._client.post(
            "/store_batch", json={"namespace": namespace, "turns": pending}
        )
        r.raise_for_status()

    def search(
        self,
        namespace: str,
        query: str,
        top_k: int,
        as_of_date: datetime | None = None,
    ) -> list[Memory]:
        self._flush(namespace)
        body: dict[str, object] = {"namespace": namespace, "query": query, "top_k": top_k}
        if as_of_date is not None:
            # Accepted for protocol symmetry; the bridge ignores it (see eval-server.mjs header
            # note — samemind's default BM25 recall has no query-time temporal reasoning).
            body["as_of_date"] = as_of_date.isoformat()
        r = self._client.post("/search", json=body)
        r.raise_for_status()
        results = r.json().get("memories", [])
        return [
            Memory(
                id=m.get("id", ""),
                content=m.get("content", ""),
                score=float(m.get("score", 0.0)),
                session_id=m.get("session_id"),
                turn_idx=m.get("turn_idx"),
                session_idx=m.get("session_idx"),
                metadata={},
            )
            for m in results
        ]

    def close(self) -> None:
        self._client.close()


def bridge_available(url: Optional[str] = None) -> bool:
    """True iff the Node bridge is reachable. Mirrors memory_core.py's own
    `_memory_core_available()` health check style (used by contract tests to skip cleanly)."""
    target = url or os.getenv("SAMEMIND_BRIDGE_URL") or DEFAULT_BRIDGE_URL
    try:
        return httpx.get(f"{target}/health", timeout=2.0).status_code == 200
    except Exception:
        return False

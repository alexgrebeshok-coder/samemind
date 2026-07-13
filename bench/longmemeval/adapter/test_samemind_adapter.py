"""Contract check for SamemindAdapter — a stdlib-only mirror of the harness's own
`tests/test_adapter_contract.py` (memory-core-eval doesn't ship the SamemindAdapter, so it can't
run this itself; we reproduce the same assertions here instead of forking the harness).

Requires:
  - the memory-core-eval clone importable (PYTHONPATH set to its repo root — see README)
  - the Node bridge running: `node bench/longmemeval/bridge/eval-server.mjs`

Run:
  PYTHONPATH=/path/to/memory-core-eval python3 bench/longmemeval/adapter/test_samemind_adapter.py
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mceval.adapters.base import Memory, MemoryAdapter, Turn  # noqa: E402

from samemind_adapter import SamemindAdapter, bridge_available  # noqa: E402


def _turn(i: int, content: str, session_id: str = "sess-test", role: str = "user", **kw) -> Turn:
    return Turn(content=content, role=role, session_id=session_id, turn_idx=i, session_idx=0, **kw)


def _unique(label: str) -> str:
    return f"{label} [{uuid.uuid4().hex[:8]}]"


def _ns() -> str:
    return "mceval-test-" + uuid.uuid4().hex[:12]


def test_satisfies_protocol(adapter: SamemindAdapter) -> None:
    assert isinstance(adapter, MemoryAdapter), "SamemindAdapter does not satisfy MemoryAdapter Protocol"
    assert adapter.name, "adapter must declare a non-empty name"


def test_store_returns_id(adapter: SamemindAdapter) -> None:
    ns = _ns()
    adapter.reset(ns)
    mem_id = adapter.store(ns, _turn(0, _unique("Alice likes espresso.")))
    assert mem_id, "store() must return a non-empty memory id"
    adapter.reset(ns)


def test_search_returns_relevant_first(adapter: SamemindAdapter) -> None:
    ns = _ns()
    adapter.reset(ns)
    alice = _unique("Alice likes espresso.")
    bob = _unique("Bob went hiking in the Alps.")
    paris = _unique("The weather in Paris was rainy.")
    adapter.store(ns, _turn(0, alice))
    adapter.store(ns, _turn(1, bob))
    adapter.store(ns, _turn(2, paris))

    results = adapter.search(ns, "what does Alice drink?", top_k=3)
    assert results, "search must return at least one result"
    assert all(isinstance(r, Memory) for r in results)
    top = results[0].content.lower()
    assert "alice" in top or "espresso" in top, f"expected Alice/espresso on top, got: {results[0].content!r}"
    adapter.reset(ns)


def test_search_result_shape(adapter: SamemindAdapter) -> None:
    ns = _ns()
    adapter.reset(ns)
    content = _unique("hello world")
    adapter.store(ns, _turn(0, content))
    results = adapter.search(ns, "hello", top_k=1)
    assert len(results) >= 1
    r = results[0]
    assert r.id
    assert r.content
    assert r.score is not None
    assert r.session_id == "sess-test", f"expected session_id='sess-test', got {r.session_id!r}"
    assert r.turn_idx == 0, f"expected turn_idx=0, got {r.turn_idx!r}"
    adapter.reset(ns)


def test_reset_clears_namespace(adapter: SamemindAdapter) -> None:
    ns = _ns()
    adapter.reset(ns)
    adapter.store(ns, _turn(0, _unique("to be cleared")))
    adapter.reset(ns)
    results = adapter.search(ns, "cleared", top_k=5)
    assert results == [], "reset() must remove all memories in the namespace"


def test_namespaces_isolated(adapter: SamemindAdapter) -> None:
    ns_a, ns_b = _ns(), _ns()
    adapter.reset(ns_a)
    adapter.reset(ns_b)
    apple = _unique("apple in namespace A")
    banana = _unique("banana in namespace B")
    adapter.store(ns_a, _turn(0, apple))
    adapter.store(ns_b, _turn(0, banana))

    r_a = adapter.search(ns_a, "apple", top_k=5)
    assert r_a
    assert "apple" in r_a[0].content.lower()
    assert all("banana" not in r.content.lower() for r in r_a)
    adapter.reset(ns_a)
    adapter.reset(ns_b)


def test_as_of_date_accepted_without_error(adapter: SamemindAdapter) -> None:
    # Bridge ignores as_of_date (no temporal reasoning), but the call must not raise —
    # protocol symmetry, see eval-server.mjs header note.
    ns = _ns()
    adapter.reset(ns)
    adapter.store(ns, _turn(0, _unique("time-agnostic turn")))
    results = adapter.search(ns, "time-agnostic", top_k=5, as_of_date=datetime.now(timezone.utc))
    assert results
    adapter.reset(ns)


def main() -> int:
    if not bridge_available():
        print(
            "SKIP: Node bridge not reachable at "
            f"{__import__('os').getenv('SAMEMIND_BRIDGE_URL', 'http://127.0.0.1:8799')} — "
            "start it with: node bench/longmemeval/bridge/eval-server.mjs",
            file=sys.stderr,
        )
        return 1

    adapter = SamemindAdapter()
    tests = [
        test_satisfies_protocol,
        test_store_returns_id,
        test_search_returns_relevant_first,
        test_search_result_shape,
        test_reset_clears_namespace,
        test_namespaces_isolated,
        test_as_of_date_accepted_without_error,
    ]
    failed = 0
    for t in tests:
        try:
            t(adapter)
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
        except Exception as e:  # noqa: BLE001 — report and continue, contract check not pytest
            failed += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
    adapter.close()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

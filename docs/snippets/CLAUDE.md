<!-- samemind memory protocol — paste into project or user CLAUDE.md -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

When a question needs past context (owner, people, projects, decisions):

1. **Search first (cheap):** `samemind recall "<q>" -k 5` or MCP `memory_search`.
2. **Read top 3–5 fully:** `samemind query get <id>` or MCP `memory_get`. Optional one-hop on direct relations if still within budget.
3. **Answer with path citations** like `/entities/x.md`, `/projects/y.md`.
4. **Always end with** `## What the memory doesn't cover` — topic-specific gaps + staleness from each node’s `timestamp`.
5. **New facts/decisions** → MCP `memory_write_inbox` only. Never write into `concepts/` / `entities/` / `projects/` as the agent.

Token rule: search → rank → full-read top-N only. Do not dump the whole bundle.

Tools: `samemind query|recall|gde|serve` · bundle root = `OKF_ROOT` or cwd.

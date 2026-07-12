<!-- samemind memory protocol — paste into project or user CLAUDE.md -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

On session start, run `memory_handoff` (or `samemind handoff`) — work state before re-explaining.

When a question needs past context (owner, people, projects, decisions):

1. **Search first (cheap):** `samemind recall "<q>" -k 5` or MCP `memory_search`.
2. **Read top 3–5 fully:** `samemind query get <id>` or MCP `memory_get`. Optional one-hop on direct relations if still within budget.
3. **Answer with path citations** like `/entities/x.md`, `/projects/y.md`.
4. **Always end with** `## What the memory doesn't cover` — topic-specific gaps + staleness from each node’s `timestamp`.
5. **New facts/decisions** → MCP `memory_write_inbox` only. Never write into `concepts/` / `entities/` / `projects/` as the agent.

Token rule: search → rank → full-read top-N only. Do not dump the whole bundle.

## Write discipline (MUST)

The bundle holds **work**, not only facts (full spec: `docs/work-discipline.md`).

- Agreed a plan/position with the owner → write a `Plan`/`Decision` to `inbox/` **now** (MCP `memory_write_inbox`). "Later" = didn't happen.
- Plan changed → write a **new** `Plan` with `relations.supersedes: /projects/<old>.md`; mark old `status: superseded`. Plans/Decisions are append-only.
- Session ended → write a `Session` to `inbox/` (`engine`, `date`, `## Done` / `## Decided` / `## Next`).
- Task changed status → edit the `Task` **in place**. `status: blocked` requires a non-empty `blocked_reason`.

`samemind query validate` warns on Plan/Task missing `status`, bad `status`, or blocked Task without reason.

## Knowledge cycle (SHOULD)

`Analysis` / `Research` / `Idea` are concepts too (`docs/knowledge-cycle.md`), linked via `informs` / `spawned_by` / `led_to`.

- See an immature `Idea` (`status: spark|incubating`) in your domain → write a reflection to **your own inbox** (`memory_write_inbox`), `target: /concepts/<idea>.md`, proposing a path forward. Never edit the Idea directly — curation merges reflections into its `## Reflections`.
- `validate` warns on `Idea` missing `status`, bad `status`, or `rejected` without `rejected_reason`.

Tools: `samemind query|recall|gde|serve` · bundle root = `OKF_ROOT` or cwd.

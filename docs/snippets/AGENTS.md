<!-- samemind memory protocol — paste into AGENTS.md (Codex, Cursor, etc.) -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

Use the local samemind bundle for owner/project/past context. No cloud memory service.

On session start, run `memory_handoff` (or `samemind handoff`) — work state before re-explaining.

**On questions about the past, people, projects, or decisions:**

1. Search cheaply: `samemind recall "<query>" -k 5` (or MCP `memory_search`).
2. Full-read only the top 3–5 hits: `samemind query get <id>` (or MCP `memory_get`). At most one relation hop if needed and within budget.
3. Answer with path citations (`/concepts/…`, `/entities/…`, `/projects/…`).
4. Close every such answer with **What the memory doesn't cover**: explicit gaps for *this* question + fact age from frontmatter `timestamp`.
5. Persist new facts only via `memory_write_inbox` — never mutate canon nodes as the agent.

Prefer search over loading the whole tree. Bundle root: `OKF_ROOT` or process cwd.

## Write discipline (MUST)

The bundle stores **work**, not only facts (spec: `docs/work-discipline.md`).

- Agreed a plan/position → write a `Plan`/`Decision` to `inbox/` **immediately** (MCP `memory_write_inbox`). No deferred notes.
- Plan changed → new `Plan` with `relations.supersedes: /projects/<old>.md`, old marked `status: superseded`. Plans/Decisions are append-only.
- Session ended → `Session` in `inbox/` (`engine`, `date`, `## Done` / `## Decided` / `## Next`).
- Task status changed → edit the `Task` **in place**. `status: blocked` needs a non-empty `blocked_reason`.

`samemind query validate` warns on Plan/Task without `status`, out-of-dictionary `status`, or blocked Task lacking a reason.

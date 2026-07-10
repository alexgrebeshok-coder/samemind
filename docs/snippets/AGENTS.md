<!-- samemind memory protocol — paste into AGENTS.md (Codex, Cursor, etc.) -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

Use the local samemind bundle for owner/project/past context. No cloud memory service.

**On questions about the past, people, projects, or decisions:**

1. Search cheaply: `samemind recall "<query>" -k 5` (or MCP `memory_search`).
2. Full-read only the top 3–5 hits: `samemind query get <id>` (or MCP `memory_get`). At most one relation hop if needed and within budget.
3. Answer with path citations (`/concepts/…`, `/entities/…`, `/projects/…`).
4. Close every such answer with **What the memory doesn't cover**: explicit gaps for *this* question + fact age from frontmatter `timestamp`.
5. Persist new facts only via `memory_write_inbox` — never mutate canon nodes as the agent.

Prefer search over loading the whole tree. Bundle root: `OKF_ROOT` or process cwd.

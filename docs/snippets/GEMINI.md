<!-- samemind memory protocol — paste near the top of GEMINI.md -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

You have a local markdown memory (samemind / OKF bundle). Use it for past context.

On session start, run `memory_handoff` (or `samemind handoff`) — work state before re-explaining.

When the user asks about people, projects, decisions, or prior work:

1. Run search first: `samemind recall "<q>" -k 5` or MCP tool `memory_search`.
2. Read the top 3–5 results completely (`samemind query get <id>` / `memory_get`). Stay within ~5 full reads (one relation hop max if needed).
3. Ground the reply in path citations: `/entities/name.md`, `/projects/name.md`.
4. Always finish with a section **What the memory doesn't cover** — missing agenda/facts for this question and staleness from each `timestamp`.
5. Write new notes only with `memory_write_inbox`. Do not edit canon paths as the agent.

Search is cheap; full bodies are not. Never load the entire bundle for one question.

## Write discipline (MUST)

The bundle holds **work**, not only facts (spec: `docs/work-discipline.md`).

- Agreed a plan/position with the owner → write a `Plan`/`Decision` to `inbox/` **now** (`memory_write_inbox`). Postponed = lost.
- Plan changed → write a **new** `Plan`, `relations.supersedes: /projects/<old>.md`, old `status: superseded`. Plans/Decisions are append-only.
- Session ended → `Session` in `inbox/` (`engine`, `date`, `## Done` / `## Decided` / `## Next`).
- Task status changed → edit the `Task` **in place**; `status: blocked` needs a non-empty `blocked_reason`.

`samemind query validate` warns on Plan/Task missing `status`, bad `status`, or a blocked Task without reason.

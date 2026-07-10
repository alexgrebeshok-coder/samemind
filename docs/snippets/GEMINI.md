<!-- samemind memory protocol — paste near the top of GEMINI.md -->
<!-- Full doc: docs/memory-protocol.md -->

## samemind memory

You have a local markdown memory (samemind / OKF bundle). Use it for past context.

When the user asks about people, projects, decisions, or prior work:

1. Run search first: `samemind recall "<q>" -k 5` or MCP tool `memory_search`.
2. Read the top 3–5 results completely (`samemind query get <id>` / `memory_get`). Stay within ~5 full reads (one relation hop max if needed).
3. Ground the reply in path citations: `/entities/name.md`, `/projects/name.md`.
4. Always finish with a section **What the memory doesn't cover** — missing agenda/facts for this question and staleness from each `timestamp`.
5. Write new notes only with `memory_write_inbox`. Do not edit canon paths as the agent.

Search is cheap; full bodies are not. Never load the entire bundle for one question.

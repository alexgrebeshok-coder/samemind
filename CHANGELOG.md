# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — 2026-07-12 «The Chronicle»

### Added

- **Session capture (#1)** — `samemind capture --engine <id> [--source <path>] [--since <ts>]
  [--dry-run]` (`tools/capture.mjs`, `docs/session-capture.md`): read-only adapter framework
  that pulls a live engine's own session store into `inbox/<engine>.md`, closing the last
  bespoke per-engine sync bridge from dogfooding. MVP adapters: `claude-code` (distills each
  JSONL transcript's final assistant text + session id/project/message-count meta) and
  `generic-markdown` (any directory of `.md` diaries → title + first lines + path pointer
  notes, e.g. OpenClaw's `memory/*.md`). Idempotent via `.samemind-capture-state.json` in the
  bundle root; secret shapes (`npm_`/`sk-`/`ghp_`/`AKIA`) masked before writing; distilled text
  runs through the same injection-quarantine as `memory_write_inbox`; `--dry-run` writes
  nothing. Adding an engine is one more `ADAPTERS` entry.
- **Event ledger (#3)** — `samemind ledger append|status|read` (`tools/ledger.mjs`,
  `tools/lib/ledger.mjs`, `docs/event-ledger.md`): an append-only, fine-grained event log
  (`ledger/events.jsonl`) complementing the coarse work-discipline layer where `Task.status`
  is edited in place. `append --actor <id> --topic <t> --phase start|step|done|fail|block|note
  [--status ok|wip|partial|fail] --action "..." [--artifact <a>] [--ref <r>]` validates both
  dictionaries (rejects, never silently coerces); `status` surfaces 🔥 open failures — the last
  fail/block event of a topic not yet closed by a later `done` or `status: ok` event — before
  every topic's current stage; `read --topic <t>` prints one topic's full history. MCP gains
  `memory_ledger_append`/`memory_ledger_status` (same `SAMEMIND_AGENT`-as-actor and
  injection-quarantine contract as `memory_write_inbox`). `samemind board` gains a
  🔥 Open failures section above 🔴 Blocked (capped at 5, freshest first, full count in the
  heading), in both markdown and `--html`. `ledger/` is a reserved tier like `inbox/`/`secret/`/
  `mirror/` — never walked as graph concepts, so `query validate/list/get` stay unaffected.

## [0.2.1] — 2026-07-12

### Added

- **Exclude-by-source (anti-echo, #2)** — an engine no longer gets back what it just wrote.
  MCP `memory_search` accepts `exclude_source` (validated to `[a-z0-9-]`); `recall`/`gde`/`brief`
  gain `--exclude-source <id>`. Concepts whose frontmatter `source` matches the id are filtered
  from the result (works for both string and list `source`, in BM25 and semantic paths).
- **Smooth brief budget** — `brief --budget` no longer drops whole sections in a step curve.
  After tier selection, the last kept tier-1/2 section is trimmed by *paragraphs* to land within
  ±10% of the budget, marked `…truncated`. Tier-0 (boundaries / owner rules / engine role) is
  never trimmed. Size now grows monotonically with the budget instead of jumping.
- **Generic install** — `install --agent <any-id> --file <path>` installs into any instruction
  file for an unsupported agent (generic brief + protocol block, idempotent between the markers).
  `--file` is required for an unknown id; `--list` advertises `+ any id via --file`.

## [0.2.0] — 2026-07-12 «The Flywheel»

### Added

- **Knowledge-cycle layer** — three new concept types close the loop from facts to plans
  (`docs/knowledge-cycle.md`): `Analysis` (facts → pattern → implications), `Research`
  (question → findings → verdict, with `source` citations), `Idea` with a maturity status
  (`spark → incubating → adopted / rejected`, `rejected_reason` required). Edge conventions
  over existing `relations`: `informs` (Analysis/Research → Idea), `spawned_by`
  (Research → Analysis), `led_to` (Idea → Plan).
- **Ideas on the board** — `samemind board` gains a 💡 Ideas section: incubating first,
  then sparks; adopted collapse into an "Adopted → Plans" line via `led_to`; rejected hidden.
- **Agent reflection protocol** — memory-protocol and all three snippets teach agents to
  write reflections on immature Ideas through their own inbox (`target: <idea path>`),
  never editing the idea file directly; curation merges into `## Reflections`.
- **HTML projections** — `samemind board --html [--out <file>]` and
  `samemind handoff --html`: self-contained pages (inline CSS, light/dark via
  `prefers-color-scheme`, zero JS, zero external resources) with code-generated SVG
  visualizations (kanban bars, ideas strip, decisions timeline). Markdown stays the canon;
  HTML is always a generated projection. Board/handoff internals split into
  model + renderers so both outputs share one data path.
- Validator warnings for the new types (Idea without `status`, rejected without
  `rejected_reason`); scaffold templates for all three types in `samemind init`;
  demo bundle gains a linked Analysis → Research → Idea working example.

## [0.1.2] — 2026-07-12

### Fixed

- `inbox/` is now a proper reserved tier in `walk()`/`load()` (`tools/lib/okf.mjs`), on the same
  footing as `secret/`/`mirror/`: excluded by default, opt-in via `includeInbox` /
  `--include-inbox` (`okf-query`, `okf-recall`). Before this fix, the first ever write through
  `memory_write_inbox` (MCP) — whose frontmatter carries only `okf_version`, no `type` — made
  `samemind query validate` permanently non-conformant, because raw inbox notes were treated as
  ordinary graph concepts. (#4)
  - `validate`/`list`/`links`/`rel`/`get` no longer see `inbox/` by default.
  - `tools/consolidate.mjs` keeps reading `inbox/` (opts in explicitly — that's its whole
    purpose: mapping raw notes to canon gaps).
  - MCP `memory_search`/`memory_get`/`memory_list` never returned inbox content and still don't.
  - Added a regression test: a fresh bundle → `memory_write_inbox` → `validate` stays conformant.

## [0.1.1]

### Fixed

- `npx`/`.bin` symlink: resolve `argv[1]` through `realpath` so the CLI's `isMain` check
  recognizes itself when invoked via a symlinked bin (e.g. `npx samemind`).

## [0.1.0]

- Initial release.

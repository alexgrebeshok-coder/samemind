# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

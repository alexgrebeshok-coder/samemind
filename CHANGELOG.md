# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] — 2026-07-20

_UX track: onboarding used to be a 6-step manual protocol (`INSTALL_FOR_AGENTS.md`) even
for the common case. `samemind setup` composes it into one command; a new CI smoke gate
now installs and runs the actual `npm pack` tarball before every publish, catching the
class of packaging bug that shipped in 0.1.0 past a fully green `node --test` run._

### Added

- **`samemind setup [--target <dir>] [--yes] [--dry-run]`** (`tools/setup.mjs`) — one-shot
  onboarding: detect engine → scaffold bundle if needed → install the identity+memory
  brief into that engine's own instruction file → register the MCP server → probe for a
  local embeddings endpoint → print a summary. Default is interactive (asks before every
  write into a file setup doesn't own outright); `--yes` skips every prompt; `--dry-run`
  only prints the plan, proven byte-for-byte to write nothing.
- **Engine auto-detect** (`tools/lib/detect-engines.mjs` + env-var signals in `setup.mjs`)
  — scans a target dir for instruction files already present (`CLAUDE.md`, `AGENTS.md`,
  `.cursor/rules/`, …) and cross-checks a small env-var allowlist (`CLAUDECODE`,
  `CURSOR_TRACE_ID`, `CODEX_HOME`/`CODEX_SANDBOX`) for the "fresh clone, engine already
  running, no instruction file yet" case. An env signal is only trusted without a file
  behind it when it's the sole signal detected at all — two simultaneous, uncorroborated
  env signals (e.g. an ambient `CODEX_HOME` leaked in from an unrelated launcher, alongside
  a real one) are ambiguous noise and get dropped rather than guessed at, closing a false
  "codex detected" report (and its accompanying warning-noise) on machines where `CODEX_HOME`
  happens to be set for reasons unrelated to this project.
- **Local embeddings probe** (`tools/lib/probe-embed.mjs`) — GET-only discovery of a
  running omlx (`:8000`) or Ollama (`:11434`) server exposing an embedding-shaped model;
  never touches admin/settings endpoints, never loads/warms a model. `setup` wires a live
  result straight into `.samemind/config.json` (`embedUrl`/`embedModel`, merged — other
  keys preserved); a dead/absent server yields an honest BM25-fallback hint, never a
  silent failure.
- **`.samemind/config.json`** — per-bundle config file (currently `embedUrl`/`embedModel`
  from the embeddings probe above); read by `resolveEmbedConfig()` (`tools/lib/recall.mjs`)
  so semantic search turns on automatically once `setup` finds a local server, no manual
  `OKF_EMBED_URL` export needed.
- **CI smoke gate** (`scripts/smoke-tarball.sh` + `smoke` job in
  `.github/workflows/release.yml`) — `npm pack`s the repo, installs the resulting tarball
  (not the source tree) into a throwaway project, and runs `init --demo` / `query validate`
  / `recall` (BM25 path, no network) / `setup --dry-run` against it. `publish` now
  `needs: [test, smoke]` — a packaging break (missing `files` entry, a broken `bin`
  symlink, a path that only resolves relative to the repo) fails the gate before
  publish, not after a user's `npx samemind` silently does nothing.

### Docs

- README **Quick start** leads with `npx samemind setup` (real output, honest-BM25 case)
  ahead of the previous manual `init`/`install` walkthrough, now demoted to "Manual, step
  by step" underneath it.
- `INSTALL_FOR_AGENTS.md` gains a **Fast path** section ahead of Step 0, pointing an
  installing agent at `samemind setup` first; the original 6-step manual protocol is
  unchanged below it as the fallback for when `setup` can't detect the engine or finer
  control is needed.

## [0.4.1] — 2026-07-20

_Four post-0.4.0 tails found running the memory roadmap against real (non-demo) data: a
CLI exit-code bug, empty title/type in recall output, two tools that never got the Ф4
sqlite-vec backend, and a binary-diff footgun in the hygiene module._

### Fixed

- **`samemind --help`/bare invocation now exits 0** (`bin/samemind.mjs`) — usage output was
  correct but the process exited 1, making `--help`/no-args look like an error in scripts
  and CI. An unknown command still exits 1.
- **Empty title/type in recall output on real (non-OKF-native) memory bundles**
  (`tools/lib/okf.mjs`, `tools/lib/recall.mjs`, `tools/lib/sqlite-index.mjs`) — frontmatter
  using samemind's own memory schema (`name:`/`description:`/`metadata.type` instead of
  OKF's `title:`/`type:`) showed up as blank in `okf-recall`/`gde` hits. The `metadata:`
  block (previously silently dropped by the frontmatter parser) is now parsed into
  `fm.metadata`; new `displayTitle`/`displayType` helpers fall back onto
  `description`/`name`/`metadata.type`/`metadata.node_type` — never overriding an existing
  OKF-native value — wired into the BM25, flat-JSON and sqlite-vec paths alike. Also fixes
  a latent sqlite bind crash when migrating an older JSON index with `undefined` title/type.
- **`gde.mjs`/`consolidate.mjs` still read the flat-JSON index directly** — Ф4's sqlite-vec
  backend never touched them. Both now share the same sqlite-vec-first/JSON-fallback
  DI-pattern as `okf-recall.mjs`'s `openBackend()`; `consolidate.mjs` (and `reflect.mjs`,
  its caller) needed a new `readAllItems()` export on `lib/sqlite-index.mjs` since it does an
  all-pairs cosine scan rather than a single KNN query.
- **Binary `git diff` on `tools/lib/hygiene.mjs`** — `detectSupersedeCycles()`'s cycle-key
  dedup used a literal embedded NUL byte as a join separator, which made every diff touching
  the file show up as "Binary files differ". Swapped for the `\x1f` unit-separator escape;
  cycle-detection logic and its tests are unchanged.

## [0.4.0] — 2026-07-20

_Memory roadmap Ф0–Ф5: search wired to real working memory, bi-temporal supersede,
hybrid BM25⊕semantic RRF, sqlite-vec scale index (~40× at N=5000), tiered heat + reflection._

### Added

- **Tiered heat + reflection (Ф5)** — `tools/lib/hygiene.mjs` gains
  `heatMultiplier`/`heatScore`/`heatTier`/`buildHeatIndex`: a use-driven rank
  signal (recency × frequency, from `ledger/events.jsonl` — a ledger `topic`
  matched against a concept `id`) folded into the SAME `hygieneMultiplier`
  pass as supersede/importance/decay — one ranking pass for bm25/semantic/
  hybrid, no separate heat step. Heat only ever boosts (≥1.0); a doc with no
  ledger activity is neutral (1.0), byte-for-byte unchanged from before this
  landed — cold facts sink only relative to hot peers, never hidden, never
  penalized below their prior score. Tiers (`hot`/`warm`/`cold`) surface via
  MCP `memory_health` → `heatTiers`. New `tools/reflect.mjs [--write]`: runs
  `reconcile.mjs` + `consolidate.mjs` + a heat re-evaluation and fuses them
  into ONE markdown proposal report (supersede / merge / cooled-off facts).
  Same human-gate as `reconcile.mjs`/`consolidate.mjs` — never writes to a
  concept's frontmatter, `forget.mjs` (soft-deprecate, never delete) stays
  the one tool a human runs to act on a proposal. Not wired into cron/
  launchd. See docs/memory-hygiene.md § Tiered heat (Ф5).

- **Concurrent-write safety** — `lib/file-lock.mjs`: a zero-dependency mkdir-based mutual-
  exclusion lock (atomic exclusive-create, no npm lockfile package) with automatic stale-lock
  takeover (dead pid → immediate; merely old → after 30s) and a bounded, backoff-retried wait
  (gives up after 10s rather than hang). Guards the three read-modify-write paths a fleet of
  agents actually hits concurrently on the same bundle: `memory_ledger_append`
  (`tools/lib/ledger.mjs`), `memory_write_inbox` / `samemind capture`
  (`tools/lib/mcp.mjs`, `tools/capture.mjs` — both key the lock off the same target path, so
  they mutually exclude each other too), and `samemind forget` (`tools/forget.mjs`). Closes a
  real lost-update race: two writers reading the same "before" state and one silently
  overwriting the other's contribution on rename — reproduced with real OS child processes
  (8 processes × 15 writes lost ~85% of writes pre-fix; 0 lost across 80+ repeated runs
  post-fix) in `tools/concurrency.test.mjs`, which also covers the stale-lock-takeover case
  and a subtler TOCTOU bug found and fixed during development (a "lock already gone" observation
  must never trigger a delayed removal — see the module header in `lib/file-lock.mjs`). See
  README § Concurrency.

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

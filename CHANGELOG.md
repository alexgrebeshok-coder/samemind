# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.4] — 2026-07-21

### Fixed

- **fix: OIDC trusted publishing — remove token-based .npmrc auth that shadowed the OIDC
  exchange** — `v0.6.3`'s tag push got a green `test`/`smoke`, a successfully signed provenance
  statement, and then `npm publish` failed with `E404 ... could not be found or you do not have
  permission`. Root cause: the `publish` job's `actions/setup-node@v4` step passed
  `registry-url: 'https://registry.npmjs.org'`, which makes setup-node write
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`. With no `NODE_AUTH_TOKEN`
  secret configured (the entire point of trusted publishing — see 0.6.2), that placeholder
  expands to an empty string; npm CLI treats the (empty) `_authToken` line as "auth is already
  configured" and never starts the OIDC token exchange, so the actual publish PUT goes out
  unauthenticated and the registry answers 404 rather than leak whether the package/version
  exists. Fix: drop `registry-url` from that step — the registry defaults to npmjs.org anyway,
  and the job never installs anything from it that would need a token. Confirmed against
  docs.npmjs.com/trusted-publishers (its own example workflow omits `registry-url`) and matches
  the exact "provenance signs, then 404" failure mode reported in npm/cli#8730, npm/cli#8976,
  actions/setup-node#1551 and npm/documentation#1960.

## [0.6.3] — 2026-07-21

### Fixed

- **fix: sqlite-backend tests now skip when the optional backend is unavailable** — CI was red
  on node 20 / no-prebuild since 0.4; product path unchanged. Root cause was in
  `tools/gde-sqlite.test.mjs`: its `{ skip: skipReason }` guards referenced a variable only
  assigned inside an async `before()` hook, but `describe()`'s `it(...)` calls (and their option
  objects) are evaluated synchronously as the suite registers — *before* `before()` ever runs —
  so `skipReason` was always still `undefined` (falsy) at that point and the sqlite-only
  assertions ran unconditionally. In CI, the optional sqlite-vec backend is never installed
  (zero-npm-deps test job) — node 20 lacks `node:sqlite`, node 22 lacks the `sqlite-vec`
  `optionalDependency` prebuild — so `buildIndex()` honestly falls back to the JSON index (the
  documented, tested contract), and the test asserting "sqlite path must not also write JSON"
  failed for real work happening correctly. Moved the availability probe to a top-level `await`
  ahead of `describe()`, mirroring the pattern `tools/sqlite-index.test.mjs` already used for the
  same trap. Does **not** add sqlite-vec to CI or otherwise touch the zero-dep JSON fallback —
  the fix only makes the test honestly skip the sqlite-specific assertions it can't exercise in
  that environment.

## [0.6.2] — 2026-07-21

Release hardening — no runtime code changes.

### Changed

- **`npm publish` now uses trusted publishing (OIDC)** instead of a long-lived `NPM_TOKEN`
  secret. `.github/workflows/release.yml`'s `publish` job drops `NODE_AUTH_TOKEN` — npm
  exchanges the workflow's `id-token: write` OIDC token for a short-lived publish credential.
  Requires npm ≥ 11.5.1 for the OIDC exchange, so the job now runs `npm install -g npm@latest`
  right before `npm publish` (setup-node's bundled npm can be older). The trusted publisher
  (this repo + `release.yml`) is configured on npmjs.com under the package's Settings, not in
  this repo.

## [0.6.1] — 2026-07-21

UAT fixes on 0.6.0.

### Fixed

- **`reconcile`/`reflect` were missing from the CLI router** (`bin/samemind.mjs` `ROUTES`) —
  both tools were complete and correct when run directly (`node tools/reconcile.mjs`), but
  `npx samemind reconcile`/`reflect` fell through to the unknown-command path (help + exit 1).
  Wired both into `ROUTES` and `usage()`, same pattern as `forget`/`board`. Added a smoke-gate
  step (`scripts/smoke-tarball.sh`) that runs `samemind reconcile`/`reflect` against the
  installed tarball and checks for their report headers — this is the class of bug the gate
  didn't catch before (a feature complete as a module but never reachable via the CLI); it
  does now. Also added a direct CLI-routing regression test in `tools/reconcile.test.mjs` /
  `tools/reflect.test.mjs`.
- **Multi-root recall ranking**: `tools/lib/compose-roots.mjs` `mergeWithGlobal` merged project
  and global hits by raw BM25 score, which is corpus-size/length-dependent — a small global
  bundle's exact unique hit could rank below a big local bundle's merely-incidental hit. Each
  side is now normalized to its own `[0,1]` scale (divide by that corpus's own max score) before
  the cross-corpus sort; a single-root search (no global bundle / `--no-global`) is untouched —
  the normalization only runs inside the two-corpora merge branch, so the existing
  byte-identical no-global regression guarantee (`multiroot-cli.test.mjs`) still holds.
- **`samemind brief` printed an empty `<!-- samemind:brief:start -->`/`:end` blob** when a
  bundle had no `Identity`/`User`/`EngineRule` concepts at all (design is unchanged — brief IS
  the identity layer, see `docs/identity-layer.md`) — now prints a clear inline notice instead
  ("no Identity/User concept in this bundle — brief is identity-layer only; add one"), so an
  `--inject` caller (which never sees the tool's stderr warnings) gets something legible instead
  of blank markers.

## [0.6.0] — 2026-07-21

_"Same mind" track: samemind used to be one bundle per project. `setup --global` connects
it to the whole machine instead — one personal bundle, one MCP registration, one embeddings
config — and `recall`/`gde`/`memory_search` fold that personal bundle into every project's
own search automatically, with project always winning on an id collision._

### Added

- **`samemind setup --global [--yes] [--dry-run] [--home <dir>]`** (`tools/setup.mjs`
  `runGlobalSetup`) — machine-wide connection instead of a per-project one: scaffolds a
  personal OKF bundle at `~/.samemind/bundle`, installs the identity+memory brief into
  Claude Code's own global `~/.claude/CLAUDE.md`, registers samemind as a user-scope MCP
  server, and probes for a local embeddings endpoint into a global config. Same
  interactive/`--yes`/`--dry-run` semantics as project `setup`. `--home <dir>` (env/flag,
  test/manual override only) points the whole flow at a different home directory.
- **MCP user-scope registration** (`tools/lib/mcp-register.mjs` `ensureMcpRegistered`
  gains `scope:'user'`) — tries the native `claude mcp add --scope user` first; falls back
  to merging `{mcpServers:{samemind:...}}` into `~/.claude.json` by hand
  (`tools/lib/global-json-merge.mjs`, new) when the `claude` binary is missing or errors,
  preserving every other server already registered there (exa, context7, playwright, …)
  and taking a timestamped backup before touching the file. Malformed JSON is never
  written to — left byte-for-byte untouched, backup still taken.
  **Safety fix:** native `claude mcp add --scope user` writes to the *real* machine's user
  config regardless of what `--home` was passed — it has no concept of a fake home. The
  native path is now only attempted when `--home` resolves to the actual machine home
  (`os.userInfo().homedir`, immune to a `HOME` env override); any custom/test `--home`
  forces the JSON-merge fallback instead, so `setup --global --home <fixture>` can never
  register against the real `~/.claude.json`.
- **Multi-root recall, "Same mind"** (`tools/lib/compose-roots.mjs`, new) — `okf-recall.mjs`,
  `gde.mjs`, and the MCP `memory_search` tool now also search the optional global personal
  bundle (`$HOME/.samemind/bundle` by default, override via `OKF_GLOBAL_ROOT`, disable via
  `--no-global`/`no_global`) alongside the project bundle, merging both by score. Each root
  keeps its own index and its own ledger-derived heat (hygiene never crosses bundles). An
  id collision (same relative path in both bundles) drops the global copy with a warning —
  **project always wins**. Global hits print with a `global:` id prefix. No personal bundle
  on disk / `--no-global` / `OKF_GLOBAL_ROOT=''` → output is byte-identical to pre-0.6.0
  project-only search (proven by regression tests, not just asserted).
- **Global embeddings-config tier** (`tools/lib/recall.mjs` `resolveEmbedConfig`) — gains a
  third precedence tier: env > project `.samemind/config.json` > `$HOME/.samemind/config.json`
  (global, written by `setup --global`'s embed probe) > hardcoded default. A global
  embeddings server set up once is now honored from any project that hasn't configured its
  own.
- **Fix: `walk()`/`parse()`/`load()` root-scoping** (`tools/lib/okf.mjs`) — found while
  wiring multi-root recall: these always computed the bundle-root prefix and doc `id`
  against the module-level `ROOT` regardless of which `root`/`dir` was actually passed in,
  which only ever matched by coincidence (the default `dir = ROOT`). A genuinely different
  root — exactly what loading the global personal bundle needs — would have miscomputed
  both. `root` is now threaded explicitly through all three; byte-identical for every
  existing caller (`root === ROOT`, the untouched default).

### Docs

- README gains a **Global mode** section (after Quick start): what `setup --global` does,
  real dry-run output, how `recall` composes project + global with a worked `global:`
  example, and the project-beats-global priority rule stated plainly.
- `INSTALL_FOR_AGENTS.md` **Fast path** gains a one-line pointer to `setup --global` for an
  agent installing itself machine-wide instead of per-project.
- CI smoke gate (`scripts/smoke-tarball.sh`) gains a `setup --global --dry-run --home
  <fixture>` step and a multi-root `recall` run against an `OKF_GLOBAL_ROOT` fixture,
  asserting the `global:` prefix actually appears in the installed tarball's output — not
  just in the source-tree test suite.

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

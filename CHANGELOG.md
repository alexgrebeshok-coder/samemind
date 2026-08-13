# Changelog

All notable changes to this project are documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.1] — 2026-08-13

A patch. No JSON form changed: the `{ contract, kind, generatedAt, data }` envelope and every
key under `data` for `board` and `handoff`, CLI and HTTP, are byte-identical to 1.0.0 — checked
against the 1.0.0 tree rather than asserted.

### Fixed

- **`--root` in `board` and `handoff` did not select a bundle.** Everywhere else in the CLI
  (`status`, `nudge`, `serviced`, `service`, `ui`, `dogfood`) `--root <dir>` means "the physical
  OKF-bundle root to work on". In these two commands it meant nothing: `board` read concepts,
  `ledger/events.jsonl` and `fleet/registry.json` from `OKF_ROOT` regardless, and `--write`
  always put `DASHBOARD.md` there. So `board --root ./other-bundle` reported on whatever
  `OKF_ROOT` pointed at, under the name of the bundle you asked for — the wrong board, with no
  sign it was wrong.

  `--root <dir>` now picks **which** bundle to read, and `--project <id>` still filters **within**
  it. They are independent and combine: `board --root ./b --project lumen` reads `./b` and scopes
  its task columns to lumen. In `board` one root serves the whole run — concepts, ledger, fleet
  registry and the `--write` target — so a run rooted at B can no longer show A's open failures
  or overdue engines. In `handoff` the docs come from the selected root; `--project` stays a filter.
- **A `--root` that is not a directory produced an empty board instead of an error.** A missing
  path was already refused, but an existing *file* passed the check and then failed the directory
  read silently, leaving zero documents — output indistinguishable from a real but empty bundle.
  Both `board` and `handoff` now refuse a non-directory root by name. A symlink to a directory is
  accepted (bundles get symlinked into place); a symlink to a file, or a dangling one, is not.
- **A missing flag value passed silently.** `board --root` at the end of a command line, or
  `--root --json` where the next flag would have become the value, resolved to "no value given"
  and the run quietly fell back to `OKF_ROOT`. Both now exit non-zero and say which flag needs a
  value. Same for `--project`, `--out`, and `handoff --days`.
- **`samemind --version` / `-v` printed the usage banner.** The same defect class as the `nudge
  --help` fix in 0.18.0: the flag was never routed, fell through to an unknown command, and
  printed help. A script asking for the installed version got a page of prose. It now prints the
  version and exits 0.
- **`handoff`'s last-session pick could depend on input order.** Sessions were compared with
  `a.ts < b.ts ? 1 : -1`, which never returns 0 — an invalid comparator on ties. Two sessions
  sharing a timestamp are ordinary (same-millisecond writes, or a hand-written `date` with no
  time), and V8's sort resolved such ties inconsistently once enough of them collided. The
  comparator now falls back to `id`, which is unique per document, so the winner is the same
  regardless of the order the bundle happened to be walked in.

### Changed

- **An unknown flag on `board` / `handoff` is now an error.** Previously any unrecognized
  `-`-prefixed argument was silently ignored, which is how a mistyped or unsupported flag looked
  like it had been accepted. Positional arguments are still left alone. A script that passes a
  flag these commands never supported will now fail instead of quietly doing something else.

## [1.0.0] — 2026-08-13

No new features. 1.0 marks that the JSON contract stopped moving and that a dogfood week
ran clean on a live bundle — the two conditions set for the tag.

### Frozen

- **JSON contract**, per `docs/json-contract.md`: changing the *form* of an existing field
  (type, nesting, value semantics, name) after this release is a **major** version bump;
  adding an optional field stays **minor**.
- **Errors stay bare** — `{ error }` / `{ error, errors }`, not wrapped in the `{ contract,
  kind, generatedAt, data }` envelope. Wrapping them later is itself a breaking change.
- Covers CLI and HTTP `/api/*`, which share one envelope. **MCP tools are a second,
  separate contract** under the same discipline — their result shape is not the CLI
  envelope and must not silently become it.

### Fixed

- **HTTP `board` and `handoff` still shipped the machine and the whole corpus.** 0.17.0
  announced this closed; it was closed in the CLI only. `GET /api/board` and
  `GET /api/handoff` wrapped the raw model — absolute host paths and the full markdown body
  of every document — because they skipped the `projectBoardJson` / `projectHandoffJson`
  step their CLI twins apply. Both surfaces now return the same keys, byte for byte, and a
  regression test fails if either drops the projection. Landing this **before** the tag was
  the point: frozen, the fix would have been a major. Consumers that read `body` or `file`
  off these two routes should fetch per document via `GET /api/concept/<id>`.
- **Two places treated a timestamp as if it were unique.** It is not: two ledger writes in
  the same millisecond carry the same stamp, and both defects only appear when they collide.
  1. `summarizeLedger` compared timestamp *strings* with `>=`, so a `fail` and the `done`/`ok`
     that closes it, written in the same millisecond, left the topic open forever. Order
     inside one millisecond now comes from position in the stream.
  2. The health ledger's dedup `ref` was built from the destination state and the stamp
     (`health:fail:<ts>`) but not from the transition, so in a `fail → ok → fail` sequence
     inside one millisecond the third event collided with the first and was silently dropped
     as a retry. The `ref` now carries the transition (`health:ok->fail:<ts>`); a genuine
     retry still dedups, a genuine new transition no longer does.

  This is the metric `dogfood` reports, and `dogfood` is the gate that decides whether a
  release may ship — a phantom open failure breaks the instrument that measures readiness.
  Defect 1 was one-directional (it could invent an open failure, never hide a real one), so
  past clean-week verdicts stand. Both were caught by the release gate itself on Node 20,
  after passing on Node 22 where the writes never collided. The rest of the tree was swept
  for the same class — timestamps used as identity, dedup key, map key or filename — and the
  remaining sites are display ordering, where ties are equivalent by construction.
- **The contract document had drifted from the wire.** Re-check before signing found
  `generatedAt` marked missing on five surfaces that all carry it since 0.17.0, `proactive`
  described as envelope-less when it is enveloped, `sessionsTotal` / `sessionNextTotal`
  marked absent, and the SSE `ledger-snapshot` frame undocumented. Corrected.

### Verified

- **`samemind dogfood`** on the live bundle: 9 days without an open failure, first event
  2026-08-03, nothing open since.
- **Contract re-checked against live runs**, not against itself: 8/8 CLI surfaces, 13 HTTP
  routes plus SSE, 10 error paths, 10/10 MCP tool names.

### Known, not fixed

- `board` / `handoff` silently ignore `--root <dir>` and read `OKF_ROOT` instead. No payload
  shape involved, so it is a patch-level behaviour bug, not a freeze blocker.

### Not in 1.0

- **Graph memory — typed edges and multi-hop expand.** Design decided in
  `docs/graph-design-note.md`, not yet built. Ships in 1.1, not here.

## [0.18.0] — 2026-08-03

Memory that speaks first — without a camera.

Everything up to here answered a question when asked. This release lets samemind raise something
on its own: an unclosed failure nobody came back to, a blocker that stopped moving, a plan that
named itself next. The design decision worth stating is what it does **not** need. Relevance comes
entirely from the board and the ledger — from what the work actually looks like — so the camera
that was on the roadmap turns out to supply only the *moment*, not the *reason*. The moment comes
from a pluggable trigger source; today the only source is a schedule, and a camera can become a
second one later without changing anything downstream. That was worth finding out before building
any of it.

**Nothing is on by default.** `vision.enabled` ships `false`, and `nudge` answers *disabled* until
someone turns it on. No camera, no microphone, no capture of any kind in this release.

### Added

- **`samemind nudge`** — one candidate plus the policy verdict, `--json` in the standard envelope,
  `--dry-run` computes the identical decision and mutates nothing.
- **`samemind nudge respond --outcome accepted|deferred|dismissed|muted`** — the human's answer,
  idempotent on `--ref`, mirrored to the ledger under topic `nudge`.
- **`GET /api/nudge`** and **`POST /api/nudge/respond`** — the second write route in the project,
  behind the same host/origin/content-type guard as `POST /api/config`.
- **The card on the dashboard** — what it would say and why, with *Понял / Не сейчас / Не надо /
  Хватит на сегодня*. When it is quiet, it says which of the ten reasons applies, and when it will
  speak again if the silence is temporary.
- **Policy gates**, in order: feature on, mode `proactive`, allowed hours, do-not-disturb, "enough
  for today", room pause, cooldown after "not now", daily cap, and finally *is there anything worth
  saying*. Exactly one nudge is ever delivered — never a fan of proposals.
- **Candidate selection reads relevance from the data**: a topic with events today is dropped,
  because work that is moving does not need a reminder. Every candidate carries a human `why`,
  which is the answer to "why did you ask" rather than a second string written for the button.

### Notes

- An unanswered nudge is not repeated verbatim on the next tick; the next candidate takes its turn.
  Measured before the guard existed, the same sentence consumed all three daily slots.
- "Хватит на сегодня" is recorded without a zone, so it expires at local midnight. Recorded *with*
  a zone it would have been a room pause lasting until an explicit unmute — a button promising one
  evening must not silence the assistant permanently.
- `dogfood` continues to count the week toward 1.0; this release does not tag it.

## [0.17.0] — 2026-08-02

The release before the freeze. 1.0's defining promise is that the JSON shape stops moving — after
it, a changed field is a major version. So this release does the thing that has to happen first:
it writes the contract down, locks it with tests, cleans up the shapes we would have regretted,
and builds the instrument that can actually answer "has it run clean for a week?".

Three findings drove it, each measured rather than assumed.

**The contract existed in eight modules and in no document.** `ui/src/api.ts` was the de-facto
schema — a file that does not ship, and that already disagreed with the wire on two fields.

**Almost nothing held the shape.** Renaming `handoff.plansInForce`, `board.columnTotals` or
`ledger.topics[].evs` left the suite green. Two surfaces out of twenty-three were genuinely
guarded, one of them by accident.

**"A week without failures" was unmeasurable.** `health.json` remembers a single run; no layer
wrote samemind's own failure to the ledger; there was no `samemind` entry in the fleet registry.
A clean week and a week with a silent failure looked identical.

### Added

- **`docs/json-contract.md`** — every surface, its `kind`, the keys of `data`, the error shape,
  and what counts as a breaking change. Verified against live responses, not against the types.
- **`tools/contract-shape.test.mjs`** — key-presence assertions for every payload. Verified by
  breaking it: renaming `handoff.plansInForce` now fails with the exact missing key, restoring it
  goes green.
- **`samemind dogfood`** — days without an open failure of our own, what the last one was, and
  whether it is closed. On a bundle with no history it says **"nothing to measure"**, never
  "0 failures": the whole product rests on telling *no problems* apart from *not checked*, and an
  instrument that confuses the two would undo two releases of work.
- **Self-failures reach the ledger.** `writeHealth` now also appends to topic `samemind-health`,
  so `summarizeLedger` yields "days since the last unclosed failure" for free. Success is written
  too — otherwise nothing closes a failure — and only on a **state change**, because a run every
  half hour would put 48 junk events a day into an append-only ledger the board reads.
- **A `samemind` entry in the fleet registry**, `heartbeatSec` 604800 — one dogfood week, so
  silence is itself a signal.
- `generatedAt` on `status`, `fleet status`, `ledger status`, `query links`, and `proactive --json`
  in the envelope. Additive now; after 1.0 both would be major.

### Fixed

- **Payloads carried the machine and the whole corpus.** `board` and `handoff` shipped absolute
  paths and the full markdown body of every document. On the live bundle `board` went from
  **160,833 to 23,123 bytes** — seven times smaller. A screen needs titles, not bodies.
- **Truncated arrays now state their totals.** `board.sessions`, `handoff.sessionNext`, the SSE
  snapshot and `ledger.topics[].evs` were silently capped — a consumer could not tell a tail from
  the whole. Same class of defect as `columnTotals`, which 0.16 fixed.
- **One key set per payload.** `assessAvailability` returned three different sets depending on the
  branch; `doctor.active` two; `doctor.states.verified` three. Absence is now an explicit `null`.
- **`node` and `platform` left the doctor payload** — a frozen contract must not carry machine
  specifics, or consumers start matching on them. They stay in the human output, which is not
  frozen and where the runtime is often the answer to "why won't my server start".
- **A test wrote into the shipped demo bundle.** `POST /api/config` was aimed at `demo/`, leaving a
  `config.json` behind on every run — and `demo/` ships in the tarball, so the fixture would have
  drifted into the package carrying settings nobody chose.
- README claimed four screens where there are seven and zero write endpoints where `POST
  /api/config` exists, and never mentioned `doctor` at all. It now also states the versioning
  policy: what is breaking, what is not, and that the MCP tools are a separate surface.

### Not yet

1.0 is not tagged. The owner's condition — a clean dogfood week — is now measurable for the first
time, and the clock starts when the instrument starts recording, not retroactively.

## [0.16.0] — 2026-08-01

The switchboard. 0.15 made connection honest — an engine was either provably reaching memory or
plainly told it was not. But the person who owns that memory still had a window with no handles:
the dashboard showed everything and could touch nothing, and every action meant leaving for a
terminal. This release gives it controls, and a screen that answers "what am I standing on".

The design question was where a button is allowed to write. Toggling a capability is a *setting*,
not a memory: idempotent, reversible, touching no canon. Consequential work — dispatching to an
engine, writing a fact, merging — is not, and stays behind a command the card shows and copies but
never runs. So exactly one write route exists, and everything else is still 405.

### Added

- **`samemind doctor`-grade honesty for capabilities** — a `voice`/`vision` section in
  `.samemind/config.json` alongside `projection`, with the same discipline: frozen defaults
  (everything **off**), field-by-field normalization that warns and falls back rather than
  throwing, two-tier global←project merge, and a read that never writes. Voice's three consents
  are deliberately separate — microphone access ≠ storing transcripts ≠ sending text to an LLM
  are three different human decisions.
- **`GET /api/settings`** — effective state plus, for every value, the **layer it came from**
  (default / global / project). A settings screen showing an effective value without its origin
  cannot answer "why is this on?", and the user edits the wrong file.
- **`POST /api/config`** — the single write route, and the only non-GET the dashboard accepts.
  Guarded by `tools/lib/http-guard.mjs`: an **anchored** loopback match (a prefix test lets
  `127.0.0.1.evil.com` through — a documented path to RCE elsewhere), a missing `Host` treated as
  untrusted, full `hostname:port` authority comparison (a page on another loopback port is
  *same-site*, so `Sec-Fetch-Site` does not catch it), a same-authority `Origin` requirement, and
  `application/json` only — without which a CORS-safelisted `text/plain` POST reaches the handler
  with no preflight. `withFileLock` around read-modify-write, because this file is machine-wide
  and `setup` writes it too: atomic write protects a reader from a torn file, not either writer
  from a lost update.
- **Settings screen** — a capability with no runner renders as **unavailable**, never as an
  unchecked box: an empty checkbox says "you chose this" when the truth is "nothing here can do
  it". After saving, the screen draws the **server's re-read state**, not the click; on error it
  leaves the last known truth alone.
- **Today screen** — in-flight and stuck work, what to do next, recent decisions, and a recovery
  card that shows the exact command and copies it. Built on `/api/board`, not `/api/handoff`: on a
  real bundle handoff came back completely empty (work lives as ledger topics, which handoff never
  reads) while the board showed 123 in flight and 40 blocked. Counts come from `columnTotals`;
  the arrays are capped at eight, so their length would have understated by 15×.
- **`GET /api/status` / `GET /api/doctor`** — projection liveness and engine connection health,
  wrapping the existing pure functions; `probe:false` so a GET never spawns a server.
- **Voice loop** — `tools/lib/probe-voice.mjs` (the `probe-embed` pattern: 2s abort, injectable
  fetch, `null` on every failure, never throws), `tools/lib/voice-intent.mjs` (a pure gate:
  below-threshold speech yields a re-ask, never a best guess; `assign` demands a verification
  criterion because the ledger refuses an assignment without one; a deterministic `ref` minted
  from the utterance), and **`GET /api/voice/route`**, which serves that gate from the core so the
  browser never owns a second copy of it.
- **Voice panel** — five attention states with **microphone-off in red and in words**, transcript
  preview with confidence, and a confirmation card carrying the quarantine verdict and the
  required verification field. No `getUserMedia`: this release makes state visible; capturing
  audio is a separate, explicit decision.
- **`docs/voice-companion.md`** — the core ships no speech recognition and will not. It talks to
  any OpenAI-compatible endpoint via `voice.serviceUrl`, exactly as it talks to embeddings, so the
  companion is a port rather than a dependency and zero-dependency survives. Documents the traps
  other projects already hit: a SpeechAnalyzer binary must be ad-hoc signed with entitlements or
  it `SIGTRAP`s on first use, `swift run` skips that step, and macOS grants speech-recognition
  permission only to an app bundle carrying privacy metadata.
- **`Cmd`** — a command with one-click copy. The dashboard shows commands and never runs them;
  that boundary is what makes recovery affordances safe on a read-only screen.

### Fixed

- **Voice availability was the 0.15 defect in new clothes.** `assessAvailability` reported a
  capability available because a `serviceUrl` was *set* — "a config entry counts as a working
  connection", the exact lie this project cleaned up a release earlier, reintroduced in its own
  code. Now three states: `unavailable` / `configured` / `reachable`, where only a probe produces
  the last. The probe stays out of the render path: `GET /api/settings` is polled every tick, and
  a network call there would make a slow companion a slow dashboard.
- **A re-heard utterance could dispatch twice.** `memory_fleet_assign` never passed `ref`, so the
  ledger's idempotency key did nothing for it. It does now; the actor stays the target engine so
  heartbeat keeps working, and the issuer is recorded in the event.
- **`board.byId` shipped as `{}`** on every response — a `Map` through `JSON.stringify`.
- **`npm run dev` was broken**: the Vite proxy pointed at 7804 while the server listens on 7787.
- **The first-ever save threw `ENOENT`** on a bundle with no `.samemind/` — the lock directory is
  created beside the target file, and a fresh bundle is the ordinary case, not an edge one.
- Docs stopped contradicting the code: the control-centre spec no longer claims there are no write
  endpoints, and the voice spec carries three constraints the primitives actually impose. One
  claim in it — that the injection scanner fires on dictation like "run the script" — was measured
  and found **false** (the patterns are English; Russian speech never trips them), and is now a
  table of measurements rather than an assertion.

## [0.15.0] — 2026-08-01

Honest connection. Until now a config entry counted as "connected" — samemind wrote a file and
reported success without ever checking that an agent could reach memory. It could not: the entry
carried no `OKF_ROOT`, so the server resolved a root from whatever directory the engine happened
to start in, and `lib/okf.mjs` silently fell back to the installed package directory when that
was not a bundle. Reproduced live during this work: the server answered `initialize` and
`tools/list` with all ten tools while holding **zero facts**, and nothing anywhere reported a
problem. This release closes that hole and makes the remaining failure modes visible.

### Added

- **`samemind doctor`** — inspect-first connection health across five distinct states:
  *supported → installed → connected → verified → active*. `connected` (an entry exists in the
  engine's config) never implies `verified` (a real JSON-RPC `initialize` + `tools/list` +
  `memory_health` round-trip succeeded against a sane corpus). Human and `--json`
  (`contract: 1`) output; `--engine`, `--root`, `--no-probe`, `--timeout`, `--repair`.
  Exit 0 when nothing failed, 1 otherwise. Reads by default, writes only under `--repair`.
- **Corpus verification** — `tools/list` answering proves the server runs, not that it found
  your memory, so `memory_health` (which computes its answer from a real `load()` over disk)
  gates the verdict: `serving-package-dir` catches the fallback red-handed even when no root was
  configured to compare against; `empty-corpus` catches a bundle with no readable facts;
  `root-mismatch` applies `realpath` to **both** sides so a symlinked bundle
  (`~/.samemind/bundle`) is not a false alarm; a count gap is a FAIL at equal versions and a WARN
  across versions, since a different release may walk differently.
- **Cross-engine consistency** — groups engines by resolved root and server version, and says
  plainly when your engines are not sharing one memory.
- **`tools/lib/mcp-probe.mjs`** — bounded JSON-RPC probe distinguishing eight outcomes rather
  than "it failed": `spawn-failed`, `crashed`, `not-jsonrpc`, `timeout`, `handshake-error`,
  `not-samemind`, `no-tools`, `ok`. Separating *stdout arrived but no parseable frame* from
  *no stdout at all* turns "it hangs" into "your launcher prints a banner on stdout". Children
  are spawned into their own process group and killed as a tree, because `npx samemind serve`
  makes node a grandchild holding the pipes; an `exit` hook guarantees no orphaned server
  survives a crash or Ctrl-C.
- **`tools/lib/engine-mcp.mjs`** — reads the five real config shapes (`mcpServers`,
  `mcpServers-nested`, `vscode-servers`, `opencode`'s array-`command`/`environment`, and Codex
  TOML) with `home`/`target` always explicit so tests never touch a real config. The TOML reader
  is a deliberate subset scanner: when a `[mcp_servers.samemind]` header is present but
  unreadable it reports UNKNOWN rather than "not configured" — a parser that degrades to silence
  is a lie shaped like a diagnosis. Secret redaction is allowlist-based (keys always shown,
  values only for known-safe keys, `*_URL` reduced to `scheme://host:port` because tokens hide
  in query strings), applied structurally so `--json` is safe to paste into an issue.
- **`scripts/clean-room.sh`** — installs the packed tarball into an isolated environment, drives
  real JSON-RPC against the packaged server, then recall/handoff/doctor. Runs against a fixture
  HOME and asserts no real engine config was read.
- **Engine MCP descriptor** — `ENGINE_FILES[id].mcp` is now the single source for config shape
  and paths. `ENGINE_MCP_HINTS` was **deleted**; hints are generated from the descriptor, so the
  hint and what doctor reads cannot drift. `mcp: null` is explicit, and a test forbids adding a
  13th engine without deciding.

### Fixed

- **MCP registration pins `OKF_ROOT`** (`tools/lib/mcp-register.mjs`) — the root cause above.
  Project scope pins the project bundle; `setup --global` pins the personal bundle for both the
  JSON-merge fallback and native `claude mcp add` (via `-e`).
- **`setup` verifies instead of asserting** — the closing summary used to be assembled from the
  return strings of earlier steps ("wrote samemind → .mcp.json" meant *we called writeFile*).
  It now re-reads the files from disk through doctor's config-only pass and reports what is
  actually there, naming any problem that would stop memory from working, plus the exact next
  command. Verification is a report, never a gate: a doctor bug cannot fail a good setup.
- **`opencode` descriptor was missing its user-scope path** — a correctly configured
  `~/.config/opencode/opencode.json` read as "not connected". Found by running the readers
  against a real machine; guarded by a test over every user-scoped engine.
- Docs tell one story: `docs/adapters.md` carries the auto/projection freshness tier,
  `docs/hooks/` no longer claims nothing is wired, the README states Node ≥ 20 and drops the
  "every AI agent" claim its own 12-engine matrix contradicted.

### Changed

- `prepublishOnly` runs the UI build and the suite — every release guarantee lived only in CI, so
  a manual `npm publish` shipped whatever stale `dist/` was on disk.
- `CHANGELOG.md` now ships in the tarball; the README linked it three times and it was excluded.
- `scripts/smoke-tarball.sh` asserts the packaged `doctor` routes and emits `contract: 1`.
- `samemind project` gained independent `maxFactChars` / `maxBlockChars` budgets (previously one
  `--budget` drove both the per-fact clamp and the whole-block cap). Both optional and
  back-compatible.

### Specs (no code)

`docs/spec/voice.md`, `docs/spec/control-center.md`, `docs/spec/ambient-vision.md` — the 0.16
surface, written while the reasoning is fresh. Ambient sensing is specified as opt-in with camera
and microphone off by default, no identity or emotion inference, suggestion-only authority, and
interruptibility as release criteria rather than polish.

## [0.14.0] — 2026-07-27

Phase 4: the memory keeps itself current, live. An event-driven daemon re-projects on change,
memory is reachable over a local HTTP MCP while an engine is connected and via a cold-start
digest file when it isn't, and engines that support lifecycle hooks get true auto recall/persist.

### Added

- **`samemind serviced`** — long-running daemon: one recursive `fs.watch` + debounced coalescing
  + stat-settle (no half-written reads) + periodic mtime full-rescan backstop (fs.watch drops
  events under load) + overlap-guard (single-flight) + bounded backoff→degrade (loud, no
  hot-loop) + heartbeat each cycle. Self-wake loop closed: the projection writing into engine
  files no longer re-triggers its own watcher (ignore filter mirrors `load()`).
- **`samemind serve --http [--port N]`** — Streamable HTTP MCP on 127.0.0.1, same ten tools as
  stdio (reuses the stdio tool handlers — no duplicated logic), exact-match Host guard, secret
  isolation inherited. Default `serve` (stdio) unchanged.
- **`samemind hooks list|install --agent <id>`** — per-engine lifecycle hooks with an honest
  tier: `auto` (Claude Code / Codex / OpenCode — real hook APIs, verified) does SessionStart→
  recall and SessionEnd→persist; `projection` (Cursor, Gemini CLI, …) has no hook API and stays
  on `samemind project`. Merges without clobbering foreign hooks.
- **`samemind service --daemon`** — installs the OS unit against `serviced` (launchd KeepAlive,
  systemd `Restart=always`, Windows restart-on-failure) instead of a periodic `project`.
- **Cold-start digest** (`.samemind/digest.md`) — the daemon materializes the current projection
  each cycle so an engine starting without an MCP connection reads a fresh file.
- `intervalSec` unified in `projection-config` (daemon backstop and `status` liveness share one).

## [0.13.0] — 2026-07-27

Memory projection becomes a service you install once, and a thing you can check on. Phase 2 of
making cross-engine memory reliable out of the box: the projection from Phase 1 now runs on a
schedule the OS keeps alive, writes a heartbeat every run, and answers `samemind status`.

### Added

- **`samemind service install|status|uninstall`** — registers a per-user OS unit that runs
  `samemind project` on a schedule: macOS LaunchAgent, Linux systemd `--user` service+timer,
  Windows per-user Scheduled Task — generated from zero-dep templates, no admin, no sudo.
  Explicit command only (never a postinstall hook — npm v12 blocks install scripts, and silent
  scheduler registration on `npm i` is user-hostile). Linux without a user bus prints a
  ready-to-paste `nohup` fallback instead of failing silently.
- **`samemind status`** — reads a heartbeat (`<root>/.samemind/health.json`, written by every
  real `project` run) and reports liveness folded with outcome: `✅ ok` / `⚠️ stale` (the run
  stopped happening) / `❌ failed` (last run errored) / `❓ unknown` (never ran). A fresh but
  failed run reads as ❌, never a silent green. `--json` (`{contract:1, kind:'status'}`).
- **`tools/lib/health.mjs`** — external heartbeat write/read + pure `assessLiveness` (fresh
  within 2× the expected interval = live).

### Changed

- `.samemind/health.json` and `.samemind/logs/` are runtime artifacts — gitignored and kept
  out of the npm tarball.

## [0.12.0] — 2026-07-27

Memory projection becomes a first-class, tested part of the product. Until now the logic that
renders curated facts into an engine's instruction file lived only in a private orchestrator —
untested here, which is exactly how a stale snapshot once reached a downstream engine. That
core now ships in samemind, under tests, behind a new command.

### Added

- **`samemind project`** — projects a fact block into an engine's instruction file (its own
  `<!-- samemind:project:start/end -->` markers, coexisting with the `install` identity block).
  Config-driven via a new `projection` section in `.samemind/config.json`
  (`budgetTokens`/`factSource`/`coreFresh`/`indexTail`/`targets[]`), or ad-hoc `--engine`;
  `--dry-run`, `--source canon|bundle`, `--budget`, `--core-fresh`. Ranks canon by recency,
  bundle by hygiene score; anti-echo per target (`sourceMatches`); dedup-by-name (the direct
  fix for the stale-snapshot bug class); hard budget with marker-preserving truncation. Fails
  loud — non-zero exit with an actionable message, never a silent log.
- **`tools/lib/project.mjs`** — pure, side-effect-free projection core (`renderFactEntries`,
  `dedupeByName`, `truncateBlock`, `stripSections`, `stripMarkerBlocks`), lifted from the
  private bridge and put under tests.
- **`tools/lib/projection-config.mjs`** — pure `readProjectionConfig` (in-memory merge
  global←project) + explicit `migrateProjectionConfig` (schema_version, preserves foreign keys).

### Changed

- `install`/`brief` injection refactored onto one shared `injectBetweenMarkers`
  (`tools/lib/inject.mjs`) — behavior byte-identical, existing tests unchanged.

## [0.11.0] — 2026-07-26

The board fills itself: when a bundle has a ledger but no Task docs (the common case for
multi-engine fleets — the work-truth lives in the event log), the kanban now synthesizes
cards from ledger topics. Pure projection; the canon is never written.

### Added

- **Interactive graph (Obsidian-style)** — the Memory graph is now a live force layout:
  wheel zoom at the cursor (0.2–4x), background pan, draggable nodes (the simulation keeps
  running around the grabbed node), neighbor highlight on hover, zoom-aware labels, fit
  button. Hand-rolled simulation, zero new dependencies; >300 nodes falls back to the
  static layout; `prefers-reduced-motion` starts settled.
- **Live orchestration** — `GET /api/events/stream` (SSE): snapshot of the last 50 ledger
  events on connect, then one event per new ledger line, 25s heartbeats. The dashboard
  holds one EventSource with its own reconnect/backoff: a live-dot in the header, a live
  feed on Fleet (fail rows red, `sub:*` subagent events badged), and the board/fleet
  refresh themselves within seconds of an event — no Refresh button.
- **Projects that say something** — project cards carry the doc's status, a description
  snippet, a linked-concepts count and last activity (task strip only when tasks exist);
  cards open a full project view: frontmatter, body, linked concepts, and the project's
  task board when there is one.
- **Derived kanban** — a ledger topic with no matching Task doc becomes a card: last
  `start/step/note` → In progress, `done` (inside the recent window) → Done, `fail/block` →
  Blocked. A real Task doc with the topic's name always wins. Cards carry `source: 'ledger'`
  in JSON, a ` _(ledger)_` suffix in markdown, and a grey `ledger` chip in the dashboard.
  Capped at 8 per column with an honest `…and N more from the ledger` overflow line.
- **Honest column totals** — `columnTotals` in the board model: KPI tiles and column
  headings report the true count (e.g. `In progress (93)`) while rendering the capped 8;
  hover says `8 shown of 93`. Ledger-free bundles: totals equal lengths, output
  byte-identical to 0.10.0.

### Fixed

- The SPA no longer assumes every kanban card is a document — a card without frontmatter
  used to blank the whole page (TypeError during render).

## [0.10.0] — 2026-07-26

The memory gets a face: `samemind ui` — a local, read-only web dashboard over the bundle —
plus the versioned JSON contract it stands on. Runtime stays zero-dependency; the SPA ships
prebuilt in `dist/` and is served from 127.0.0.1 only.

### Added

- **`samemind ui [--port] [--root] [--open]`** — local dashboard: 4 screens (Overview with
  kanban and alert tiles, Memory with concept browser / BM25 search / link graph, Fleet with
  engine heartbeat bars and naryad timeline, Projects), light+dark themes, hash-routed
  deep links, virtualized lists. Server: `node:http` with an exact-match Host guard
  (DNS-rebinding defense) and hand-parsed paths so traversal never hides behind URL
  normalization. Secret isolation inherited from `load()`.
- **Versioned JSON contract** — `--json` on `board`, `handoff`, `fleet status`,
  `ledger status`, `query links` (`{ contract: 1, kind, generatedAt, data }`), and the same
  shapes on `/api/board|handoff|fleet|ledger|concepts|concept/<id>|graph|health`.
- **`fleet set --engine <id> --status|--role|--heartbeat|--zone`** — edit the registry
  without hand-editing JSON.
- **`init` scaffolds `ledger/` + `fleet/`**; the demo bundle ships a live fleet fixture
  (non-empty Open failures and Overdue engines out of the box).

### Fixed

- **Ledger append is O(1) and idempotent by `ref`** — no more whole-file rewrite per event;
  a repeated `ref` returns `deduped` instead of writing a duplicate (the safety the
  journal→ledger bridge needs).
- **Graph edges under `--root`** — all three edge resolvers (markdown links, typed
  relations, supersedes) now thread the bundle root explicitly; previously every edge was
  reported broken when the root came from `--root` instead of `OKF_ROOT`.
- **`fleet/` excluded from the graph walk unconditionally**, as the docs already promised.
- `ledger status` speaks English; MCP errors carry a machine-readable code
  (`Error [NOT_FOUND]: …`); capture-state keys are `~`-portable across machines.

## [0.9.0] — 2026-07-26

Graph-aware recall and a human gate on bulk capture — plus the suite now stays green on a
machine that actually dogfoods a global bundle, not only in CI. All additive; with no new
flags, output is byte-identical to 0.8.0.

### Added

- **`recall --expand`** (`--expand-hops 1`, `--expand-budget N`, default 5) — 1-hop graph
  expand after top-k: pulls in docs connected to a hit via a typed `relations` edge (either
  direction) or a **reverse wikilink** (who cites the hit). Budget-capped, deduped, and behind
  the same hygiene gate as live recall — superseded/expired/deprecated docs are never pulled
  in. Printed after the primary hits as `+hop … (+1 hop from <id>)`, never folded into their
  ranking. Off by default.
- **Capture human gate** — `capture` landing 20+ *new* items now shows a plan (count, date
  span, destination, size) and asks first; `--yes` is the informed opt-in for cron/scripts,
  `--limit N` narrows the set instead of all-or-nothing. `--dry-run` always previews.

### Fixed

- **Frontmatter `visibility: secret` is now filtered centrally in `load()`** — a secret-marked
  concept living *outside* `secret/` used to leak into `memory_list`, board, handoff, brief and
  the `--expand` neighbor pool. It now behaves identically to a file in `secret/`; callers
  passing `includeSecret: true` are unaffected.
- **Test-suite isolation from the host** — tests asserting "no global root" no longer pick up
  the developer's real `~/.samemind/bundle` (explicit `OKF_GLOBAL_ROOT=''` off-switch or a
  throwaway `HOME`). 713/713 green on a dogfooding machine, not only in CI.
- **npm tarball hygiene** — `*.before-*` editor backup files can no longer ride into the
  package (`files` guard).

## [0.8.0] — 2026-07-25

Fleet layer — a declared registry of the engines that share one memory bundle, plus the two things
multi-engine operation needs and no memory layer can infer on its own: **who is supposed to report,
and who has gone quiet**. All additive; bundles and callers from 0.7.x behave exactly as before.

### Added

- **`samemind fleet`** (`init` | `status` | `assign`) — the engine registry as a first-class,
  declared artifact (`fleet/registry.json` in the bundle). `init` seeds it from the engines actually
  present in the target directory, reusing `detectEngines()` (`tools/lib/detect-engines.mjs`) rather
  than re-declaring a second detection table. `status` prints the roster plus overdue engines;
  `assign` records a naryad (goal + boundaries + verify + reporting topic) against one engine.
- **Heartbeat / overdue detection** (`tools/lib/fleet.mjs`) — an engine declares the cadence it is
  expected to report at; anything silent past that cadence is *overdue*. Pure functions with `now`
  injected, exactly like the board's aging — so tests never need a real clock or a real ledger.
- **Board section `🔥 Overdue engines`** — rendered above all columns, right after Open failures, same shape and cap as
  `🔥 Open failures`, carried into the `--html` projection. An engine that stopped reporting is a
  sharper signal than a task sitting at `blocked`, so it reads first.
- **MCP tools `memory_fleet_status` / `memory_fleet_assign`** — same contract as
  `memory_ledger_status` / `memory_ledger_append`: read-only status never mutates, dictionaries are
  validated (not coerced), `actor` comes from `SAMEMIND_AGENT`, and free text runs through the same
  prompt-injection scan every writable tier in this package uses.
- **`docs/fleet.md`** — the layer's contract, the reporting-ownership rule (one summary owner, event
  owners per engine), and Design decisions, including why the registry is declared rather than
  inferred at read time.

### Why

A memory bundle shared by several engines answers "what do we know". It cannot answer "is everyone
still working, and did anyone stop telling us". Ours stopped for two days before anyone noticed —
the layer exists so that failure mode is visible by construction, not by luck.

## [0.7.0] — 2026-07-24

Э6 — proactive + conflict-aware memory. All additive and backward-compatible: bundles without
`supersedes`/`valid_from`/`authority` and callers without the new flags behave exactly as in 0.6.5.

### Added

- **Proactive memory (`samemind proactive "<msg>"`)** — Active Memory pattern: auto top-k recall
  pack assembled *before* an agent answers, no explicit `recall` call. Compact snippet pack with a
  hard char cap; skips non-fact-shaped / weak-match queries. On the reference corpus: comparable
  hit-rate to full-body recall at ~6× fewer tokens.
- **Conflict-aware recall (Э6/6.3)** — recall/proactive exclude superseded and time-expired facts
  by default (`superseded_by` resolved · `invalid_at` past · `valid_from` future). Opt-in
  `--include-superseded` (audit: kept, demoted, labeled) and `--as-of <ISO>` (point-in-time recall
  respecting `valid_from`/`invalid_at`). Works across BM25, semantic and hybrid paths.
- **Authority/recency tiebreak + conflict highlight (Э6/6.1)** — optional `authority` frontmatter
  (`canon`/`derived`/`observed` or a number). Within a *detected* contradiction pair recall orders
  by authority → recency → score and labels the loser `⚔ conflicts with <id>`. Non-conflicting
  results are untouched.

### Changed

- **RU-aware BM25 tokenizer** — a light built-in Russian stemmer (no new dependency) applied in the
  single tokenization point, so query and documents normalize the same way (fixes case/declension
  misses, e.g. dative). Relative `minScore` floor for the proactive pack drops weak matches instead
  of injecting noise.
- **Contradiction detector reads the flat memory schema** — groups by `metadata.type` (via
  `displayType`) and tokenizes `name`/`description` when OKF `title`/`tags` are absent. One honest
  similarity bar for every schema (no lowered/manufactured threshold); `reconcile`/`reflect` stay
  human-gated and never write canon.

## [0.6.5] — 2026-07-21

### Fixed

- **fix: revert to NPM_TOKEN auth for release — OIDC trusted publishing did not authenticate;
  provenance still attested via id-token** — `0.6.4`'s OIDC trusted-publishing switch got a
  green `test`/`smoke` and then `npm publish` failed with `ENEEDAUTH` before it ever reached the
  registry: the trusted-publisher config on npmjs.com (owner/repo/workflow-filename match) never
  matched what GitHub Actions sent, so the OIDC token exchange for publish credentials never
  happened at all. Reverted the `publish` job to the token-auth path that shipped `0.6.0`-`0.6.1`:
  `actions/setup-node@v4` gets `registry-url: 'https://registry.npmjs.org'` back (it writes
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`), and the `npm publish`
  step gets `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` back. `id-token: write` and
  `npm publish --provenance --access public` stay — provenance attestation runs its own OIDC
  exchange with Sigstore independent of publish auth, so token-based publish auth + OIDC-attested
  provenance is the standard npm combination, not a fallback that loses provenance. Dropped the
  `npm install -g npm@latest` step added for OIDC trusted publishing's stricter version
  requirement (npm >= 11.5.1) — plain token auth + `--provenance` has worked since npm 9.5, well
  below what `actions/setup-node`'s node 22 already bundles, so the upgrade step was dead weight
  once trusted publishing was off the table.

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

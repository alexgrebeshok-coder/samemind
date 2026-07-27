# Fleet — a declared registry of the engines working on a bundle

> Multi-agent setups (several coding-agent engines rotating over the same
> repo/bundle) need a place to write down *who's in the rotation, what they're
> trusted to do, and how long they may go quiet before that's a problem* —
> and a way to hand a topic to one of them without inventing a task tracker.
> `fleet` is that declaration, plus two pure checks over it (heartbeat,
> assignment) — it never runs, schedules, or supervises anything itself.

Related code: `tools/lib/fleet.mjs` (pure logic), `tools/fleet.mjs` (CLI).
Prior art this feature generalizes: an internal, single-organization fleet
registry built to coordinate a specific person's rotation of agent engines
(cron schedules per recurring job, a fixed hardcoded engine list, Telegram
routing per engine, obligations written in prose) — see "Design decisions"
below for exactly what carried over and what deliberately didn't.

```sh
npx samemind fleet init [--target <dir>]
npx samemind fleet status
npx samemind fleet assign --engine <id> --topic <t> --goal "..." --verify "..." [--boundary "..."]... [--stop <s>]...
npx samemind fleet set --engine <id> --status active|reserve|dead [--role r] [--heartbeat N] [--zone "..."]
```

## Fleet vs. Ledger vs. Task

Three layers, three questions:

- **`Task`** (`docs/work-discipline.md`) — "what is the *current* state of
  this unit of work?" One mutable field (`status`), edited in place.
- **Ledger** (`docs/event-ledger.md`) — "what actually *happened*, step by
  step, and who did it?" Append-only, fine-grained, per-topic.
- **Fleet** (this doc) — "*who* is allowed to do work here, and what do we
  expect of them?" A registry, not a log — it changes rarely (an engine
  joins or retires), while the ledger changes constantly (every step any
  engine takes).

Fleet doesn't duplicate the ledger's job of recording events — it *reads*
the ledger to answer "who's gone quiet" (`heartbeat`), and *writes* to it
(one `start` event) when `fleet assign` hands a topic to an engine. There is
no second event log.

## The registry shape

One JSON object, `fleet/registry.json`:

```json
{
  "version": 1,
  "stopPoints": ["prod-deploy", "money", "publish", "external-signature", "delete", "push-or-merge"],
  "engines": [
    {
      "id": "claude-code",
      "role": "director",
      "chain": false,
      "heartbeatSec": 86400,
      "status": "active",
      "zone": "planning, acceptance, risk"
    },
    {
      "id": "cursor",
      "role": "executor",
      "chain": true,
      "heartbeatSec": 86400,
      "status": "active",
      "zone": "code by assignment"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | lowercase `[a-z0-9-]+` — the engine's actor id (matches the `actor` an engine uses when it writes to the ledger) |
| `role` | `director \| executor \| reserve` |
| `chain` | is this engine part of an automatic rotation/waterfall, or only invoked directly? |
| `heartbeatSec` | how long this engine may go silent (no ledger event as `actor`) before `fleet status` flags it |
| `status` | `active \| reserve \| dead` — `reserve`/`dead` engines are never flagged for silence (silence is expected, not a fault) |
| `zone` | free text — what this engine is trusted to own (informational only, not enforced) |
| `stopPoints` (registry-level) | categories of action that should halt any pipeline built on this fleet for an explicit human go-ahead — default: `prod-deploy, money, publish, external-signature, delete, push-or-merge` |

**Dictionaries are validated, not coerced** — an invalid `role`/`status` is a
hard error (CLI: non-zero exit + message), never silently mapped to a
fallback. Same convention `tools/lib/ledger.mjs` (`PHASES`/`STATUSES`) and
`tools/lib/okf.mjs` (`disciplineChecks`/`knowledgeChecks`) already use in
this package.

## `fleet init` — reuses `detectEngines()`, never re-detects

```
samemind fleet init [--target <dir>]
```

Scans `--target` (default: the bundle root) with the same
`tools/lib/detect-engines.mjs` used by `samemind setup`/`samemind install`
— the one place in this package that knows which instruction file belongs to
which engine id. Any detected engine not already in the registry is added
with defaults (`role: executor`, `status: active`, `heartbeatSec`: the
package default). Running it again is safe: already-registered engines
(and any hand-edited `role`/`zone`/`heartbeatSec`) are never overwritten —
only new detections are appended.

`fleet init` deliberately does **not** invent its own director/role
guesswork: every engine it adds starts as a plain `executor`. Promoting one
to `director`, tightening its `heartbeatSec`, or writing its `zone` is a
manual edit to `fleet/registry.json` — the same "curated, not auto-derived"
posture `samemind install`'s per-engine templates already take.

## `fleet status` — registry + who's overdue

```
samemind fleet status
```

Reads the registry and every engine's most recent ledger event (`actor` ==
`id`), then reports:

```
fleet: 3 engine(s) — stop-points: prod-deploy, money, publish, external-signature, delete, push-or-merge

  ✅ claude-code      director   active   2026-07-25 11:52 (620s silent, limit 86400s)
  🔥 grok             executor   active   never seen in the ledger
  💤 antigravity      executor  reserve  never seen in the ledger

🔥 1 engine(s) overdue: grok
```

- `✅` — active, within its `heartbeatSec`.
- `🔥` — active but silent longer than `heartbeatSec` (or never seen at all —
  an engine the registry expects to be working, with zero record of it ever
  writing to the ledger, is exactly as overdue as one that stopped).
- `💤` — `reserve`/`dead`: silence is the expected state, never flagged.

A missing or corrupt `fleet/registry.json` never crashes the command — it
prints a one-line "no registry yet" message and exits `0`, the same
tolerant-read contract `tools/lib/ledger.mjs`'s `readEvents` uses for a
corrupt ledger line.

## `fleet assign` — declare, then log to the existing ledger

```
samemind fleet assign --engine <id> --topic <t> --goal "..." --verify "..." [--boundary "..."]... [--stop <s>]...
```

Four required parts — `engine`, `topic`, `goal`, `verify` — mirroring the
minimum shape a hand-off to another engine needs: *who*, *what thread of
work*, *why*, and *how it will be checked*. `--boundary` (repeatable) and
`--stop` (repeatable) are optional; `--stop` defaults to the registry's own
`stopPoints` when omitted.

`fleet assign` refuses to log anything if:
- the engine isn't in the registry (`fleet init` / a manual edit adds it
  first — an assignment to an unknown engine is a typo, not a task), or
- the engine's `status` isn't `active` (a `reserve`/`dead` engine is not
  assignable), or
- `verify` is missing — an assignment without a verification step is a wish,
  not a task (the same principle `docs/event-ledger.md`'s phase dictionary
  enforces: nothing here is allowed to be "trust me, it's done").

On success, it appends **one** event to the existing event ledger
(`tools/lib/ledger.mjs`'s `appendEvent`) — `actor: <engine>`, `topic: <t>`,
`phase: start`, `action: "assigned: <goal> — verify: <verify>"`,
`artifact: <boundaries joined>` — rather than writing a second,
fleet-specific assignment file. `fleet status`'s heartbeat and
`samemind ledger read --topic <t>` both then see the same event: an
assignment *is* a ledger event, not a parallel record of one.

## `fleet set` — edit an existing engine in place

```
samemind fleet set --engine <id> --status active|reserve|dead [--role r] [--heartbeat N] [--zone "..."]
```

The manual-edit counterpart to `fleet init`'s additive detection: change an
already-registered engine's `status` (promote it out of `reserve`, retire it
to `dead`, bring it back to `active`), and optionally `role`/`heartbeatSec`
(`--heartbeat`)/`zone` in the same call. `--status` is required — every other
field, if omitted, keeps its current value.

Runs the update through the same `buildEngine` validation `fleet init` uses
(invalid `role`/`status`/`heartbeatSec` is a hard error, never silently
coerced) and writes the registry back atomically (`writeRegistry`), same as
every other command that touches `fleet/registry.json`. Refuses, not
guesses, on:
- no registry yet (`fleet init` first), or
- an engine id not already in the registry (`fleet set` edits, it doesn't
  add — that's what `fleet init`/a manual edit is for), or
- an invalid `role`/`status`/`heartbeatSec`.

## CLI reference

```sh
samemind fleet init [--target <dir>]
#   scaffolds/refreshes fleet/registry.json from detectEngines(--target); additive, never
#   overwrites an already-registered engine's settings

samemind fleet status
#   registry + heartbeat: 🔥 overdue, ✅ on time, 💤 reserve/dead (never flagged)

samemind fleet assign --engine <id> --topic <t> --goal "..." --verify "..." [--boundary "..."]... [--stop <s>]...
#   engine, topic, goal, verify all required; logs one `start` event to the ledger

samemind fleet set --engine <id> --status active|reserve|dead [--role r] [--heartbeat N] [--zone "..."]
#   edits an already-registered engine in place; --status required, same dictionary validation
#   as fleet init/buildEngine; unknown engine or invalid value → hard error
```

`OKF_ROOT` picks the bundle, exactly like every other `samemind` subcommand
(defaults to the current directory).

## Design decisions

- **A registry, not a scheduler.** The internal fleet registry this feature
  generalizes ties each engine to cron expressions and named recurring jobs
  (`tacts`) — because that system also *runs* those jobs. `samemind fleet`
  only declares expectations (`heartbeatSec`) and checks them against
  whatever already landed in the ledger; it has no launchd/cron integration
  and never will — scheduling recurring work is squarely outside what a
  git-native memory bundle should own.
- **`heartbeatSec` per engine, not per named job.** The prior art tracks a
  separate expected-silence window for each of a dozen-plus named jobs per
  engine (`svod`, `brief`, `nightly-council`, …), because it needs to alert
  on a specific job going quiet. A samemind bundle has no job list to
  attach that to — it only has ledger topics, which are already open-ended
  free text — so `fleet` collapses this to one number per engine: "how long
  may *this engine* stay silent, across everything it might be doing."
  Simpler, and it's the one number `fleet status`'s heartbeat actually needs.
- **No Telegram/reporting routing.** The prior art's registry doubles as a
  routing table (which engine may post to which chat, what it's allowed to
  say there) because it drives a live notification pipeline. That concern
  doesn't exist for a portable memory package with no messaging integration
  of its own — `zone` is free text for a human to read, nothing here parses
  or acts on it.
- **`role` is a 3-value enum (`director`/`executor`/`reserve`), not a
  hardcoded list of named engines.** The internal registry names each
  engine's role in prose per-engine ("director", "intake+executor",
  "executor+research", …) tuned to one organization's workflow. A published
  package can't assume any of that vocabulary applies elsewhere, so `role`
  stays the smallest enum that still lets `heartbeat` (and any future
  consumer) tell "the one holding strategy/acceptance" apart from "does
  assigned work" apart from "not currently in rotation."
- **`assign` writes to the existing ledger instead of a new assignment
  file.** An assignment is, semantically, the *first* event of a topic's
  life (`phase: start`) — `tools/lib/ledger.mjs` already has validated
  append/read/summarize for exactly that shape. Building a second
  JSON(L) format to hold "who was assigned what" would duplicate
  `readEvents`/`summarizeLedger`/atomic-append machinery this package
  already ships and tests, for no gain: `fleet status`'s heartbeat and
  `ledger read --topic` both want the same fact.
- **`stopPoints` are a flat list of category strings, not enforced gates.**
  The internal contract this generalizes ties each stop-point to a concrete
  organizational policy (who signs off, which chat gets pinged). A portable
  package can declare the *categories* worth pausing a pipeline for
  (`prod-deploy`, `money`, `publish`, `external-signature`, `delete`,
  `push-or-merge`) as sensible defaults and attach them to an assignment for
  a human/agent to honor — it cannot itself know what "pausing" means in an
  arbitrary caller's environment, so nothing in this package blocks on them;
  they are declared, not enforced.
- **`fleet init` is additive, never destructive.** Re-running it after a
  registry already exists only adds newly detected engines; it never removes
  an engine, never resets a hand-tuned `heartbeatSec`/`role`/`zone`. The
  registry is meant to be curated over time (per "Fleet init" above), and a
  detection re-scan should never silently discard that curation.
- **`fleet/` is excluded from `walk()` unconditionally, not opt-in** — same
  reasoning as `ledger/` (`docs/event-ledger.md`): nothing in samemind ever
  treats a fleet registry as a graph concept, so there is no
  `--include-fleet` escape hatch, unlike `inbox/`'s `--include-inbox`.

## Security

- **Write paths are fixed.** `fleet init`/`writeRegistry` can only ever
  write `fleet/registry.json` inside the bundle root; `fleet assign` can
  only ever append to `ledger/events.jsonl` via the existing, already-audited
  `appendEvent` — no other target is reachable from either command's
  arguments.
- **A corrupt registry degrades to "no registry", never a crash.**
  `readRegistry` catches a parse failure or a shape that doesn't have an
  `engines` array and returns `null` — every CLI command treats that
  identically to "run `fleet init` first," rather than throwing.
- **Assignments are refused, not guessed, when incomplete.** Missing
  `verify`, an unknown `engine`, or a non-`active` engine are hard errors —
  `fleet assign` never falls back to assigning "something" to "someone."

## MCP

Two tools, alongside the eight already documented in the
[docs/full-guide.md § MCP](full-guide.md#mcp) / [docs/event-ledger.md → MCP](event-ledger.md#mcp) —
thin wrappers over the same pure `tools/lib/fleet.mjs` this document covers, no logic
duplicated:

| Tool | Purpose |
|------|---------|
| `memory_fleet_status` | `{}` → registry + heartbeat rows (who's silent). Read-only, never mutates. No registry yet → `{ registry: false }`. |
| `memory_fleet_assign` | `{engine, topic, goal, verify, boundaries?, stopPoints?}` → declares an assignment, logs it as a ledger `start` event — same storage `memory_ledger_append` uses, no second format. |

`memory_fleet_assign` refuses, not guesses, exactly like `fleet assign` (CLI):
missing registry, unknown engine, or a non-`active` engine are hard errors. The
constructed `action` text runs through `appendEvent`'s own injection scan
(`tools/lib/ledger.mjs`), the same guarantee `memory_ledger_append` gets — nothing
special has to be added at the MCP layer for that, since both paths converge on
the same `appendEvent`.

## Board integration

`samemind board` (`docs/work-discipline.md`) gains a **🔥 Overdue engines**
section, the fleet analogue of the ledger's 🔥 Open failures
(`docs/event-ledger.md` → "Board integration"): same mechanics — a pure
`buildBoardModel`/`buildBoard` (`tools/board.mjs`) option (`overdueEngines`,
default `[]`), capped at `OVERDUE_ENGINES_LIMIT` (5), same `--html` styling
(reuses the blocked/red badge). One deliberate difference: this section is
**omitted entirely** when there are no overdue engines — unlike Open
failures, which always shows a `(0)` heading — because most bundles have no
fleet registry at all, and a standing empty heading on every board would be
noise for them. `board.mjs`'s `main()` is the only place that reads
`fleet/registry.json` and calls `heartbeat()`; the model-building functions
stay pure functions of their arguments, same as `now`/`openFailures`.

## Future: role-aware heartbeat thresholds

Not built here (flagged, not shipped, per this naryad's scope): heartbeat
thresholds that vary by `role` (a `director` going silent may warrant a
shorter fuse than a `reserve` engine) rather than the flat per-engine
`heartbeatSec` this registry already supports.

## See also

- [docs/event-ledger.md](event-ledger.md) — the append-only layer `fleet`
  reads (heartbeat) and writes to (assign), rather than duplicating.
- [docs/work-discipline.md](work-discipline.md) — `Task`/`Plan`, the
  coarse-grained layer neither `fleet` nor the ledger replaces.

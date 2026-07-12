# Event ledger — append-only, fine-grained, cross-engine

> "Task/Plan/Decision/Session (`docs/work-discipline.md`) are deliberately
> coarse-grained, and `Task.status` is edited *in place*." What's missing for
> multi-agent operations is a fine-grained, append-only record: who did what
> step, when, with explicit failure events that stay visible until resolved.
> Closes [alexgrebeshok-coder/samemind#3](https://github.com/alexgrebeshok-coder/samemind/issues/3).

Related code: `tools/lib/ledger.mjs` (pure logic), `tools/ledger.mjs` (CLI).
Prior art this issue names: `~/.claude/memory-bridge/journal.mjs` (an
external, single-purpose dispatcher journal this feature is modeled on, not
copied from — see "Design decisions" below for where it differs).

```sh
npx samemind ledger append --actor <id> --topic <t> --phase <p> [--status <s>] --action "..." [--artifact <a>] [--ref <r>]
npx samemind ledger status
npx samemind ledger read --topic <t> [--limit N]
```

## Task vs. Ledger

`Task.status` (work-discipline layer) answers "what is the *current* state of
this unit of work?" — one mutable field, edited in place. The ledger answers
a different question: "what actually *happened*, step by step, and who did
it?" A `Task` can sit at `status: in-progress` for a week while five engines
take turns on it; the ledger is the only place that records each of those
turns, and — critically — a **failure that nobody has resolved yet**. Neither
replaces the other: a `Task` still exists as the coarse-grained handle a
human skims; the ledger is the fine-grained trail underneath it. They are not
linked by a formal relation (a ledger `topic` is a free-text string, not a
bundle path) — see "Future: linking to Task" below.

## The event shape

One JSON object per line (JSONL), written to `ledger/events.jsonl`:

```json
{
  "ts": "2026-07-12T15:36:55.480Z",
  "actor": "sonnet-ledger",
  "topic": "event-ledger",
  "phase": "fail",
  "status": "fail",
  "action": "tests red after the board.mjs refactor",
  "artifact": "auto/event-ledger@a1b2c3d",
  "ref": "#3",
  "quarantine": false,
  "matches": []
}
```

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 timestamp, set at append time |
| `actor` | who did it — an engine or agent id (CLI: `--actor`; MCP: `SAMEMIND_AGENT`, see below) |
| `topic` | a free-text work-item id (a naryad, an issue, a feature name) — the ledger's grouping key |
| `phase` | `start \| step \| done \| fail \| block \| note` |
| `status` | `ok \| wip \| partial \| fail` (default `ok` if omitted) |
| `action` | one line: what happened |
| `artifact` | optional — a branch, commit, file, or URL |
| `ref` | optional — an external reference (issue id, PR, ticket) |
| `quarantine` / `matches` | set by the same prompt-injection scan every writable tier in this package runs (see Security below) |

**Dictionaries are validated, not coerced.** An invalid `--phase`/`--status`
is a hard error (CLI: non-zero exit + message; MCP: `isError: true`) — it is
never silently mapped to a fallback value. This is a deliberate difference
from `journal.mjs`'s own convention (which defaults an unrecognized phase to
`step`); samemind's own validate-not-coerce pattern already used by
`disciplineChecks`/`knowledgeChecks` (`tools/lib/okf.mjs`) won out here
instead, so bad input surfaces immediately rather than silently miscategorizing.

## Open failures

`samemind ledger status` groups events by `topic` and reports two things:

1. **Open failures** — the last `fail` or `block`-phase event of each topic
   that has **not since been closed**. A closing event is `phase: done` **or**
   `status: ok`, on any phase — wider than "must be phase done", because an
   agent logging a plain `phase: step, status: ok` after a failure is itself
   evidence the topic recovered (see "Design decisions" for the reasoning).
   Shown newest-first.
2. **Current stage** — every topic's *last* event, newest-first, so an
   incoming agent sees where each thread of work actually stands.

```
🔥 ОТКРЫТЫЕ СБОИ:
  [2026-07-12 15:36] sonnet · event-ledger — tests failed

ТОПИКИ — текущая стадия (свежие сверху):
  🔥 event-ledger        fail/fail [sonnet] 2026-07-12 15:36 — tests failed
```

`samemind ledger read --topic <t>` prints one topic's full chronological
history — the "what actually happened here, in order" view.

## Board integration

`samemind board` (`docs/work-discipline.md`) gains a **🔥 Open failures**
section, placed **above** 🔴 Blocked (event-ledger failures are a sharper,
more current signal than a `Task` sitting at `status: blocked`). Capped at 5
shown, freshest first, with the full count in the heading and a
`…and N more — samemind ledger status` note when truncated. The `--html`
projection carries the same section (reusing the blocked/red badge style).

```
## 🔥 Open failures (2)

- **event-ledger** — tests red after the board.mjs refactor _(sonnet, fail/fail, 2026-07-12 15:36)_ `auto/event-ledger@a1b2c3d`
- **video-fact-mlx** — VLM keep-warm dropped _(grok, block/wip, 2026-07-11 09:02)_

## 🔴 Blocked (1)
...
```

`buildBoardModel`/`buildBoard` (`tools/board.mjs`) take an `openFailures`
option (default `[]`) — a plain array `summarizeLedger()` already produced.
`board.mjs`'s `main()` is the only place that reads `ledger/events.jsonl` and
calls `summarizeLedger()`; the model-building functions stay pure functions
of their arguments, exactly like `now` being injectable for aging/davnost —
so the board's own tests never need a real ledger file, only a synthetic
`openFailures` array.

## MCP

Two tools, alongside the six already documented in the [README → MCP](../README.md#mcp):

| Tool | Purpose |
|------|---------|
| `memory_ledger_append` | `{topic, phase, status?, action, artifact?, ref?}` → append one event. `actor` comes from env `SAMEMIND_AGENT` (default `mcp`), sanitized to `[a-z0-9-]` — the same contract `memory_write_inbox` uses. |
| `memory_ledger_status` | `{}` → read-only `{topics, openFailures}` summary (never mutates the ledger). |

`action` runs through the same `scanForInjection` heuristic
(`tools/lib/injection.mjs`) `memory_write_inbox` uses: flagged text is never
dropped, only recorded with `quarantine: true` and the matched pattern
labels — an event is a fact that happened, and quarantining doesn't change
that it happened, it only stops a downstream reader from executing it blindly.

## CLI reference

```sh
samemind ledger append --actor <id> --topic <t> --phase <p> [--status <s>] --action "..." [--artifact <a>] [--ref <r>]
#   phase:  start|step|done|fail|block|note   (required)
#   status: ok|wip|partial|fail               (optional, default: ok)

samemind ledger status
#   🔥 open failures first, then every topic's current stage, freshest first

samemind ledger read --topic <t> [--limit N]
#   full chronological history of one topic (default limit: 200 events)
```

`OKF_ROOT` picks the bundle, exactly like every other `samemind` subcommand
(defaults to the current directory).

## Design decisions

A few calls this feature made that are not obvious from the issue text alone:

- **Single flat file, no monthly rotation.** `journal.mjs` (the dispatcher-wide
  worklog this issue names as prior art) rotates `journal-YYYY-MM.jsonl`
  because it accumulates events from *every* engine, forever, across every
  project. A samemind bundle's ledger is scoped to *one* project/repo — far
  lower volume — and git already handles line-append history well (line-based
  diffs, `git blame` per event). Rotation adds a second file to read on
  `status`/`read`, a "which month is this event in" question nobody asked,
  and buys nothing at this volume. If a bundle's ledger ever grows large
  enough that a flat file becomes unwieldy, monthly rotation is one function
  away (`readEvents` already reads "all events"; splitting that into
  "read + merge N month files" is a contained change) — but building it now
  would be solving a problem this project doesn't have yet.
- **`ledger/` is excluded from `walk()` unconditionally, not opt-in.**
  `inbox/` is excluded by default but has an `--include-inbox` escape hatch,
  because raw inbox notes are curation material — `consolidate.mjs` promotes
  them into the canon, so there's a real reason to walk them on request.
  Nothing in samemind ever treats ledger content as a graph concept (there is
  no ledger-to-canon promotion path), so `ledger/` is grouped with the
  unconditionally-skipped `tools/`/`demo`/`docs` instead — one fewer flag,
  and no consumer has ever needed `--include-ledger`.
- **The injection scan runs in the shared library, not only at the MCP
  entry point.** The issue's MCP section names the scan explicitly
  (`memory_ledger_append (тот же контракт, что write_inbox: ... injection-скан
  on action)`); this implementation runs the same scan inside
  `buildEvent()` in `tools/lib/ledger.mjs`, so the CLI `append` path gets the
  identical guarantee for free instead of having two divergent code paths
  (one scanned, one not) depending on how an event arrived.
- **"Closing" a failure is `phase: done` *or* `status: ok`, not `phase: done`
  alone.** `journal.mjs`'s own `summarize()` only treats `phase: done` as a
  resolution. Here, a topic that logs a plain `step/ok` after a `fail` has
  visibly recovered — a human or engine reading `ledger status` shouldn't
  see a stale 🔥 next to work that's clearly moving again just because nobody
  wrote a formal `done`. This is the one place this implementation
  deliberately widens the semantics beyond the exact prior art.
- **`atomicWriteFileSync` (temp file + rename over the whole file's new
  content), not a lock file.** `journal.mjs` uses an `mkdir`-based lock plus
  a single `O_APPEND` write to survive genuinely concurrent writers.
  `appendEvent()` here instead reads the existing file, appends the new
  line, and writes the result back through this package's own
  `lib/atomic-write.mjs` — the same read-modify-write pattern
  `memory_write_inbox` already uses for `inbox/<agent>.md`. It is atomic
  against partial/corrupted writes (a crash mid-write never leaves a
  half-written file — the rename is atomic on one filesystem), but two truly
  simultaneous writers can still race and one append can be lost. That
  tradeoff already exists elsewhere in this codebase (`memory_write_inbox`);
  this feature accepts the same one rather than introducing a new locking
  primitive samemind doesn't otherwise have. Worth revisiting if concurrent
  multi-engine writes to one bundle turn out to be common in practice.

## Future: linking to Task, handoff enrichment

Not built here (flagged, not shipped, per the naryad's scope):

- **`Task` ↔ ledger topic.** Right now a ledger `topic` is a free-text
  string with no formal link to a `Task`'s bundle path. A natural next step
  would be a convention — e.g. `topic` matching a `Task`'s id, or a
  `relations.ledger_topic` field on `Task` — so the board could show a
  task's open-failure count inline instead of only in its own section.
- **`memory_handoff` enrichment with open failures.** `docs/work-discipline.md`
  and the MCP `memory_handoff` tool already summarize active tasks, recent
  decisions, and the last session; folding in "open failures touching this
  project" would give an incoming agent one brief that covers both layers.
  Deferred here to keep this naryad's surface to what issue #3 asked for.

## Security

- **Write path is fixed.** `memory_ledger_append` can only ever append to
  `ledger/events.jsonl` inside the bundle root — no other target is
  reachable from the tool's arguments.
- **`actor` sanitization** reuses `sanitizeAgentName` (`lib/safe-path.mjs`),
  the same function `memory_write_inbox` uses for its agent id.
- **Prompt-injection content is quarantined, not dropped** — see "MCP" above;
  identical contract to `memory_write_inbox` and `samemind capture`.
- **Events are never deleted or rewritten.** `ledger append` only ever grows
  the file; there is no `ledger` command that edits or removes a past event —
  consistent with "if it isn't written down, it didn't happen" applying in
  reverse: once written, it stays on record.

## See also

- [docs/work-discipline.md](work-discipline.md) — `Plan`/`Task`/`Decision`/`Session`,
  the coarse-grained layer this complements.
- [README → MCP → Security](../README.md#security) — the injection-quarantine
  and path-safety guarantees shared across every write path in this package.
- [alexgrebeshok-coder/samemind#3](https://github.com/alexgrebeshok-coder/samemind/issues/3) — the issue this closes.

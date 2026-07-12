# Knowledge cycle — Analysis / Research / Idea

> "Ideas die in someone's head, not in the bundle." The work-discipline layer
> (`docs/work-discipline.md`) answers "what did we agree, decide, owe, and
> finish?" This layer answers the question one step earlier: **how did we get
> the idea in the first place, and is it mature enough to become a `Plan`?**

The flywheel this layer makes visible: **Analysis → Research → Idea → Plan.**
Facts get noticed (`Analysis`), sometimes get dug into further (`Research`),
crystallize into a candidate (`Idea`), and — once adopted — become a
coordinated `Plan`. Any agent working the bundle should be able to see an
immature `Idea` sitting in the graph and *react to it*: read it, reflect on
it, push it toward adoption or rejection. See "Reflection protocol" below.

There is **no new file format**. These are ordinary OKF concepts — normal
frontmatter, normal markdown body, normal `relations`. All three live in
`concepts/` (cross-cutting state, like `Decision`/`Session` in the
work-discipline layer — not attached to one initiative the way `Plan`/`Task`
are).

## The three types at a glance

| Type | Folder | Answers | Status lifecycle |
|------|--------|---------|------------------|
| `Analysis` | `concepts/` | What pattern did we notice in observed facts? | no (point-in-time) |
| `Research` | `concepts/` | What did a deeper dig into one question conclude? | no (point-in-time) |
| `Idea` | `concepts/` | What candidate is this, and how mature is it? | yes |

`Analysis` and `Research` are point-in-time write-ups — like `Decision`/
`Session` — no `status` field, never edited in place; a revised conclusion is
a **new** node. `Idea` is the one type here you edit in place, the same way
`Task` is the one work-discipline type you edit in place: `status` is its
*current* maturity, not its history.

## `Analysis`

A conclusion drawn from observed facts — the first turn of the flywheel.

```markdown
---
type: Analysis
title: <analysis name>
description: <one line — the pattern this analysis surfaces>
visibility: internal
period: 2026-06-15/2026-07-10     # date range the facts below were observed over
tags: [analysis]
timestamp: 2026-07-10T00:00:00Z
source:
relations:
  informs: [/concepts/<idea>.md]  # the Idea(s) this analysis feeds
---

# <analysis name>

## Facts observed

- Concrete, dated observations — not interpretation yet.

## Pattern

What the facts above have in common; the shape of the problem.

## Implications

What this means going forward — the seed of an Idea (or several).
```

## `Research`

A deeper dig into one question — the flywheel's optional second turn, spent
when an `Analysis`'s pattern isn't enough to act on yet.

```markdown
---
type: Research
title: <research name>
description: <one line — the question this research answers>
visibility: internal
tags: [research]
timestamp: 2026-07-10T00:00:00Z
source: [docs/some-doc.md, https://example.com/paper]   # citations — scalar or list, same field every OKF node already has
relations:
  spawned_by: [/concepts/<analysis>.md]   # the Analysis whose pattern triggered this dig
  informs: [/concepts/<idea>.md]          # the Idea(s) this research feeds
---

# <research name>

## Question

The single question this research answers.

## Findings

- Finding, with its source (a URL, a paper, a bundle path) right next to it.

## Verdict

The answer, stated as a position — and what it feeds into (an Idea, a Decision).
```

`source` is the ordinary OKF `source` field every node already carries; for a
`Research` node it is where the citations live — a scalar or a list, resolved
the same way `asPathList` resolves any other frontmatter list. It is **not**
validated as a bundle relation (a citation can be an external URL), so a
Research node with dead links is not flagged by `validate` — cite carefully.

## `Idea`

A candidate — the thing an `Analysis`/`Research` node informed, sitting in
the graph waiting to mature.

```markdown
---
type: Idea
title: <idea name>
description: <one line — what this idea is>
visibility: internal
status: spark                    # spark | incubating | adopted | rejected
rejected_reason:                 # REQUIRED (non-empty) when status is rejected
tags: [idea]
timestamp: 2026-07-10T00:00:00Z
source:
relations:
  led_to: []
  # filled once adopted: led_to: /projects/<plan>.md — the Plan this idea became
---

# <idea name>

## Essence

One or two sentences: what this idea is.

## Why now

The fact, pattern, or gap (usually from an `Analysis`/`Research` node's
`relations.informs`) that makes this worth considering now.

## Reflections

- Agents append dated notes here when they curate a reflection about this
  idea out of the inbox (see "Reflection protocol" below and
  `docs/memory-protocol.md`) — never edited by hand mid-thought, only appended.
```

**`status` dictionary:** `spark → incubating → adopted`, or `rejected` at
any point. `spark` is a first mention, barely more than a sentence.
`incubating` means it has at least one `Analysis`/`Research` informing it, or
an agent reflection in `## Reflections`, and is being actively weighed.
`adopted` means it graduated into a `Plan` — set `relations.led_to` to that
Plan. `rejected` requires a non-empty `rejected_reason`: what killed it, so
the next agent doesn't re-propose the same dead idea next week.

## How relations are used here

Three conventions, all ordinary OKF `relations` edges — the relation code in
`tools/lib/okf.mjs` (`collectRelationEdges`, `resolveRelationPath`, the `rel`
query command) already handles arbitrary edge types, so nothing new was
built for this layer, only documented:

- **`informs`** (`Analysis`/`Research` → `Idea`) — this write-up feeds that
  candidate. Both `Analysis` and `Research` nodes use it; an `Idea` can have
  several inbound `informs` edges (e.g. an `Analysis` and the `Research` it
  spawned both informing the same `Idea` — see the demo).
- **`spawned_by`** (`Research` → `Analysis`) — this deeper dig exists because
  that `Analysis`'s pattern wasn't enough to act on alone.
- **`led_to`** (`Idea` → `Plan`) — set only once `status: adopted`; the
  work-discipline `Plan` this idea became. Query it either direction:
  `samemind query rel led_to <idea-id>` (outbound) or
  `samemind query rel led_to <plan-id> --inbound` (which idea led here).

None of these are in a closed dictionary — `relations` edge types are open by
design (`docs/work-discipline.md` documents the same for `agreed_with` /
`covers` / `about` / `decided` / `next` / `project`). `validate` still checks
every edge resolves to a real bundle path, regardless of its type name.

## Reflection protocol — how an agent reacts to an immature `Idea`

This is the point of making ideas first-class: any agent, on any engine,
should notice one and *do something about it*, not just read past it.

1. **Trigger.** While reading the bundle (recall, board, a relation walk),
   an agent lands on an `Idea` with `status: spark` or `status: incubating`
   that touches its own domain (its `EngineRule`, the project it's working,
   a concept it already depends on).
2. **Write a reflection to your own inbox — not the Idea file.** Same rule as
   the rest of the memory protocol: agents never edit canon nodes directly.
   `memory_write_inbox` (or a plain file in `inbox/`) with a `target:`
   frontmatter field pointing at the idea's bundle path, and a body that
   proposes a path forward — adopt, reject, or what evidence would decide it:

   ```markdown
   ---
   target: /concepts/idea-cron-sync-adapters.md
   engine: openclaw
   timestamp: 2026-07-10T00:00:00Z
   ---
   Same staleness pattern on the Telegram-facing engine — cron pull should
   run more often there since chat traffic is bursty, not idle-shaped.
   ```
3. **Curation merges it in.** A human (or a curation pass, same step that
   promotes any inbox note into the canon — `tools/consolidate.mjs`) appends
   the reflection into the Idea's `## Reflections` section, dated and
   attributed. The Idea file itself is still only ever edited by that
   curation step — an agent proposes, curation writes.
4. **Don't invent status changes.** An agent's reflection can *recommend*
   `adopted`/`rejected`, but only the curation step (or the owner) actually
   flips `status` and, for `adopted`, opens the `Plan` and sets `led_to`.

## Validation (warnings, not errors)

`samemind query validate` runs these knowledge-cycle checks as **warnings** —
they never fail the bundle, exactly like the work-discipline checks:

- an `Idea` with no `status` field → warning;
- an `Idea` whose `status` is outside its dictionary → warning;
- an `Idea` with `status: rejected` and no non-empty `rejected_reason` →
  warning.

`Analysis` and `Research` carry no `status`, so they are never warned about —
same reasoning as `Decision`/`Session` in the work-discipline layer.
Dictionary: `Idea` = `spark|incubating|adopted|rejected`.

## Board

`samemind board` renders a `💡 Ideas` section: `incubating` first (actively
being weighed), then `spark` (first mentions), each newest-first. `adopted`
ideas move out of the main list into a compact "Adopted → Plans" line linking
the `Plan` they became (via `relations.led_to`) — the idea graduated, the
`Plan` is now where the work lives. `rejected` ideas are hidden entirely
(dead, but not deleted — still on record, just off the board). See
`docs/work-discipline.md` → Board and the README's "The knowledge flywheel"
section.

## Getting started

```sh
npx samemind init                 # scaffold now includes the three templates:
                                   #   concepts/_analysis-template.md,
                                   #   concepts/_research-template.md,
                                   #   concepts/_idea-template.md
npx samemind query validate       # green = conformant; ⚠️ lines = knowledge-cycle hints
npx samemind board                # 💡 Ideas section — incubating/spark visible, adopted → Plans, rejected hidden
```

See `demo/` for a live, linked example in the fictional Nova world:
`demo/concepts/analysis-mirror-staleness.md` (facts: engine mirrors go stale
in proportion to how long that engine sits idle) spawns
`demo/concepts/research-mirror-sync-mechanism.md` (question: cron pull vs.
push adapter?) and both `informs` `demo/concepts/idea-cron-sync-adapters.md`
(`status: incubating`, one worked `## Reflections` entry already curated in).

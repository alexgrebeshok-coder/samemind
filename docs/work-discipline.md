# Work discipline — Plan / Decision / Task / Session

> "If it isn't written down, it didn't happen." A samemind bundle is a system of
> **work**, not only facts. Four concept types capture *what is being done*, not
> just *what is known*.

The memory protocol (`docs/memory-protocol.md`) answers "what do we know about
the past?" These four types answer "what did we agree, decide, owe, and finish?"
They are the substrate the next layer (a kanban board over the bundle) reads.

There is **no new file format**. These are ordinary OKF concepts: normal
frontmatter, normal markdown body, normal `relations`. What makes them the
"work-discipline layer" is a convention for which frontmatter fields carry the
load, so `samemind query validate` (and the future board) can find the same
state in the same place every node.

## The four types at a glance

| Type | Folder | Answers | Status lifecycle |
|------|--------|---------|------------------|
| `Plan` | `projects/` | What course of action did we agree on? | yes |
| `Decision` | `concepts/` | What did we decide, and under which context? | no (append-only) |
| `Task` | `projects/` | What concrete unit of work is owed, and is it blocked? | yes |
| `Session` | `concepts/` | What happened in this working session? | no (point-in-time) |

`Plan` and `Task` live under `projects/` because they are work items attached to
an initiative (a project bundle path). `Decision` and `Session` live under
`concepts/` because they are cross-cutting state — a decision may touch several
projects, a session summarizes a span of work regardless of folder.

## `Plan`

A *coordinated* course of action — work that was agreed with someone. Frontmatter
holds its lifecycle; the body holds the stages and risks.

```markdown
---
type: Plan
title: <plan name>
description: <one line — what this plan achieves>
visibility: internal
status: draft                # draft | agreed | in-progress | done | superseded
agreed_on: 2026-07-10        # ISO date the current status was agreed
tags: [plan]
timestamp: 2026-07-10T00:00:00Z
source:
relations:
  agreed_with: [/entities/<person>.md]   # who the plan was coordinated with
  covers: /projects/<name>.md            # the initiative this plan is for
  supersedes: [/projects/<old-plan>.md]  # filled only when replacing a prior plan
---

# <plan name>

One line: what this plan achieves and who it was agreed with.

## Stages

1. First stage — concrete and verifiable.
2. Second stage.

## Risks

- Risk, and the mitigation that keeps it from derailing the plan.
```

**`status` dictionary:** `draft → agreed → in-progress → done`. A plan that gets
replaced is `superseded` — and the replacement is a **new** `Plan` node whose
`relations.supersedes` points at the old one (append-only spirit: the old plan
stays on record, the supersession edge is the history). Never edit an agreed plan
in place to mean something different; supersede it.

## `Decision`

A decision and the context it was made in. No `status` field — a decision is a
point on the timeline, not a moving target. Changing a decision means writing a
**new** `Decision` (append-only), not editing the old one.

```markdown
---
type: Decision
title: <decision name>
description: <one line — what was decided>
visibility: internal
agreed_on: 2026-07-10
tags: [decision]
timestamp: 2026-07-10T00:00:00Z
source:
relations:
  agreed_with: [/entities/<person>.md]   # who made/approved the call
  about: /projects/<name>.md             # the subject (project, concept, entity)
  supersedes: [/concepts/<old-decision>.md]   # only when reversing a prior decision
---

# <decision name>

One line: the decision itself, stated as a position ("we will …", "we will not …").

## Context

Why this call, what alternatives were weighed, what would change it.
```

## `Task`

A concrete unit of work. This is the **only** discipline type whose `status` you
edit **in place**: status is the *current* state of the task, not its history. A
task that cannot proceed says so via `blocked_reason`.

```markdown
---
type: Task
title: <task name>
description: <one line>
visibility: internal
status: backlog              # backlog | in-progress | done | blocked
blocked_reason:              # REQUIRED and non-empty when status is blocked
project: /projects/<name>.md # the initiative this task belongs to
tags: [task]
timestamp: 2026-07-10T00:00:00Z
source:
---

# <task name>

What "done" looks like for this task — verifiable, one or two sentences.
```

**`status` dictionary:** `backlog → in-progress → done`, plus `blocked`. When
`status: blocked`, `blocked_reason` is mandatory (a non-empty explanation — what
is blocking, and what would unblock). A task with no status, or a blocked task
with no reason, is malformed.

## `Session`

A summary of one working session — what got done, what got decided, what's next.
Point-in-time: write one at the end of a session, never rewrite it.

```markdown
---
type: Session
title: <session name>
description: <one line>
visibility: internal
engine: claude-code           # the engine this session ran on
date: 2026-07-10              # ISO date of the session
tags: [session]
timestamp: 2026-07-10T00:00:00Z
source:
relations:
  decided: [/concepts/<decision>.md]      # decisions made in this session
  next: [/projects/<task>.md]             # tasks queued as "next"
---

# <session name>

One line: the span of work this session covered.

## Done

- What was finished or shipped this session.

## Decided

- Decisions reached (link the `Decision` nodes if any were written).

## Next

- What the next session should pick up.
```

## How relations are used here

`agreed_with`, `covers`, `about`, `supersedes`, `decided`, `next`, and `project`
all hold bundle paths, so they live under `relations:` as typed, queryable edges
(`samemind query rel <type> <id>`) and are checked by `validate` for broken
links — exactly like any other OKF relation. `status`, `blocked_reason`,
`agreed_on`, `engine`, and `date` are plain scalar fields.

> `project` on a `Task` is documented above as a frontmatter field; in practice
> it is stored under `relations:` (`relations.project: /projects/<name>.md`) so
> the task is a real edge of the project node. Same graph, same validation.

## Validation (warnings, not errors)

`samemind query validate` runs these discipline checks as **warnings** — they
never fail the bundle, so a foreign bundle without these types stays green:

- a `Plan` or `Task` with no `status` field → warning;
- a `Plan`/`Task` whose `status` is outside its dictionary → warning;
- a `Task` with `status: blocked` and no non-empty `blocked_reason` → warning.

`Decision` and `Session` carry no `status`, so they are never warned about.
Dictionaries: `Plan` = `draft|agreed|in-progress|done|superseded`;
`Task` = `backlog|in-progress|done|blocked`.

## Getting started

```sh
npx samemind init                 # scaffold now includes the four templates:
                                   #   projects/_plan-template.md,
                                   #   projects/_task-template.md,
                                   #   concepts/_decision-template.md,
                                   #   concepts/_session-template.md
npx samemind query validate       # green = conformant; ⚠️ lines = discipline hints
```

See `demo/` for live examples (`plan-lumen-sync.md`, three `task-*.md`,
`decision-lumen-local-first.md`, `session-*.md`) — all in the fictional
Nova / Atlas / Lumen world.

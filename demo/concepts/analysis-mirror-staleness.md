---
type: Analysis
title: Mirror staleness tracks engine idle time
description: Each engine's mirror/ snapshot goes stale in proportion to how long that engine sits idle, not to bundle size.
visibility: internal
period: 2026-06-15/2026-07-10
tags: [analysis, mirror, sync]
timestamp: 2026-07-10T00:00:00Z
source: demo
relations:
  informs: [/concepts/idea-cron-sync-adapters.md]
---

# Mirror staleness tracks engine idle time

Nova ([identity](/concepts/nova.md)) checked her three engine mirrors
([claude-code](/concepts/engine-claude-code.md), [openclaw](/concepts/engine-openclaw.md),
[opencode](/concepts/engine-opencode.md)) against the canon.

## Facts observed

- `mirror/openclaw/` last touched 2026-06-20 — 20 days behind the canon updates
  made to `concepts/` and `projects/` since then.
- `mirror/opencode/` only re-synced when a batch job happened to run; three
  canon changes (the local-first decision, the Atlas task going blocked, the
  sync plan) never reached it in between runs.
- `mirror/claude-code/` stayed fresh the whole period — that engine is used
  daily, so every session's sync call happens to touch it.
- No engine re-syncs its own mirror on a schedule; sync only fires as a side
  effect of that engine's own tool calls touching the bundle (see
  `docs/interop.md` on the `mirror` visibility tier).

## Pattern

Staleness correlates with **idle time**, not with how much changed: an engine
that hasn't run in N days has a mirror exactly N days stale, because sync is
pull-on-use, not push-on-write. A quiet engine wakes up to a stale
self-picture — identity, board, handoff — until it happens to touch the
bundle again.

## Implications

Fixing this needs either a scheduled pull per engine (independent of that
engine being used) or a push from the canon side when a write lands. Worth a
deeper look before picking one — see the
[sync-mechanism research](/concepts/research-mirror-sync-mechanism.md) this
spawned.

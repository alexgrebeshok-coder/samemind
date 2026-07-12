---
type: Research
title: Mirror sync mechanism — cron pull vs. push adapter
description: Whether a per-engine cron pull or a canon-side push adapter better fixes the mirror-staleness pattern.
visibility: internal
tags: [research, mirror, sync]
timestamp: 2026-07-10T00:00:00Z
source: [docs/interop.md, docs/adapters.md]
relations:
  spawned_by: [/concepts/analysis-mirror-staleness.md]
  informs: [/concepts/idea-cron-sync-adapters.md]
---

# Mirror sync mechanism — cron pull vs. push adapter

Follows on from the [mirror-staleness analysis](/concepts/analysis-mirror-staleness.md):
given staleness = idle time, what actually keeps a mirror fresh without a daemon?

## Question

Is a per-engine cron pull, or a canon-side push adapter, the better fix for
keeping each engine's `mirror/` fresh — for engines with no idle-time
scheduler of their own (openclaw is chat-triggered; opencode runs in batches)?

## Findings

- **Cron pull** (each engine's own scheduler triggers a sync on a fixed
  interval): needs no coordination from the canon side, works even without
  event hooks — but wastes cycles when nothing changed, and assumes every
  engine *has* a working scheduler, which a purely chat-triggered engine does
  not (`docs/adapters.md`'s per-engine matrix shows several with "none —
  resets every session").
- **Push adapter** (a canon write fans out to every mirror): more timely, no
  polling — but every write path (`memory_write_inbox`, `consolidate`,
  `forget`, `board --write`) has to know about every engine's mirror
  location. More coupling, more places to forget one.
- `docs/interop.md`'s `mirror` visibility tier already treats mirrors as
  local, engine-owned, and excluded from export by design — any fix should
  respect that boundary, not turn mirrors into a shared write target.

## Verdict

Recommend a **hybrid**: a cheap cron pull as the safety net for engines
without hooks, plus opportunistic push on the write paths that already touch
memory-bridge. Neither extreme alone covers every engine in the matrix. This
is the shape the [cron-sync-adapters idea](/concepts/idea-cron-sync-adapters.md)
below turns into something adoptable.

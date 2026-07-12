---
type: Idea
title: Cron-sync adapters for engine mirrors
description: A lightweight per-engine cron/timer that periodically re-runs the existing sync path, so no mirror goes more than one interval stale.
visibility: internal
status: incubating
tags: [idea, mirror, sync]
timestamp: 2026-07-10T00:00:00Z
source: demo
---

# Cron-sync adapters for engine mirrors

## Essence

A lightweight per-engine cron job (or launchd/systemd timer) that periodically
calls the same sync path each engine already uses on demand
(memory-bridge's sync step) — no daemon, no new write path, just a scheduled
pull of the adapter that already exists. Covers the engines with no idle-time
hooks of their own (openclaw, opencode) with the cron floor the
[sync-mechanism research](/concepts/research-mirror-sync-mechanism.md)
recommended.

## Why now

The [mirror-staleness analysis](/concepts/analysis-mirror-staleness.md) showed
staleness tracks idle time, not bundle size; the
[sync-mechanism research](/concepts/research-mirror-sync-mechanism.md) it
spawned came back recommending a cron floor plus opportunistic push. This idea
is the concrete shape of that cron floor — small enough to try before
committing to the heavier push-adapter half of the hybrid.

## Reflections

- 2026-07-10 (openclaw): Same staleness pattern shows up on the Telegram-facing
  engine — worth running its cron pull more often than the others (every
  15 min, not daily) since chat traffic is bursty, not idle-shaped like the
  terminal engines. Doesn't change the verdict, just the interval per engine.

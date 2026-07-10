---
type: Plan
title: Lumen multi-device sync
description: Agreed plan to ship end-to-end sync for Lumen after the backlink editor.
visibility: internal
status: agreed
agreed_on: 2026-07-08
tags: [plan, lumen, sync]
timestamp: 2026-07-10T00:00:00Z
source: demo
relations:
  agreed_with: [/entities/alex-doe.md, /entities/iris-vale.md]
  covers: /projects/lumen.md
---

# Lumen multi-device sync

Agreed with [Alex Doe](/entities/alex-doe.md) and [Iris Vale](/entities/iris-vale.md):
Lumen ([project](/projects/lumen.md)) ships sync right after the backlink editor.
Nova ([identity](/concepts/nova.md)) helps via her [retrieval strategy](/concepts/retrieval-strategy.md).

## Stages

1. Backlink editor landed (prerequisite) — see [task](/projects/task-lumen-backlinks.md).
2. CRDT conflict model picked and prototyped on the notes graph.
3. Transport layer (local-first, no server account) over the sync channel.
4. Conflict UX reviewed by Iris — see [task](/projects/task-iris-ux-review.md).

## Risks

- Merge conflicts on simultaneous edits across devices — mitigated by CRDT choice in stage 2.
- Sync latency feeling "broken" — mitigated by Iris's conflict UX in stage 4 before launch.

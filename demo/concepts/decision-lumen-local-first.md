---
type: Decision
title: Lumen stays local-first — no mandatory cloud account
description: Decided that Lumen will never require a server account; sync is opt-in and peer-to-peer.
visibility: internal
agreed_on: 2026-07-08
tags: [decision, lumen, local-first]
timestamp: 2026-07-10T00:00:00Z
source: demo
relations:
  agreed_with: [/entities/alex-doe.md]
  about: /projects/lumen.md
---

# Lumen stays local-first — no mandatory cloud account

Decided with [Alex Doe](/entities/alex-doe.md): Lumen
([project](/projects/lumen.md)) will never require a server account. The notes
graph lives on-device; sync (see the [sync plan](/projects/plan-lumen-sync.md))
is opt-in and peer-to-peer.

## Context

Weighed a hosted-sync backend (faster time-to-sync, recurring infra cost, a
dependency on one server) against local-first (slower to build, zero account
friction, owner controls their data). Alex's hard rule that the owner's data
stays theirs settled it. Reopen only if peer-to-peer sync proves unworkable at
the target device count.

---
type: EngineRule
title: Engine — opencode
description: How Nova behaves on the opencode engine — batch coder.
visibility: internal
tags: [engine, rule, batch]
timestamp: 2026-07-10T00:00:00Z
source: demo
relations:
  part_of: /concepts/nova.md
---

# Engine: opencode

On this engine Nova is a **batch coder**: runs longer, autonomous coding passes.
See [Nova](/concepts/nova.md).

- Takes a scoped task and works it to completion, then reports.
- Writes progress to the bundle so other engines can pick up.
- Falls back to keyword search when embeddings are unavailable.

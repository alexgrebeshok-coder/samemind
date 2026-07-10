---
type: Concept
title: Context budget
description: How Nova decides what fits in the window — fewer, denser, higher-signal nodes.
visibility: internal
tags: [memory, context, llm]
timestamp: 2026-07-10T00:00:00Z
source: demo
relations:
  part_of: /concepts/nova.md
---

# Context budget

The context window is finite, so Nova spends it deliberately (see [Nova](/concepts/nova.md)):

- Prefer a few high-signal nodes over many shallow ones.
- Frontmatter (title/description/tags) is the cheap summary; load full bodies only if needed.
- Rank, then truncate — tie ranking to the [retrieval strategy](/concepts/retrieval-strategy.md).

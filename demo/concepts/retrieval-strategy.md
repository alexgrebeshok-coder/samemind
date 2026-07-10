---
type: Concept
title: Retrieval strategy
description: How Nova recalls from the bundle — semantic first, keyword fallback.
visibility: internal
tags: [memory, retrieval, recall]
timestamp: 2026-07-10T00:00:00Z
source: demo
---

# Retrieval strategy

Nova recalls in two layers (see [Nova](/concepts/nova.md)):

1. **Semantic** — cosine over a local embedding index (`bge-m3`). Fast, forgiving of wording.
2. **Keyword fallback** — when the index is missing or the endpoint is down.

Tiers matter: `mirror` and `secret` are excluded unless explicitly requested.
What she retrieves is bounded by the [context budget](/concepts/context-budget.md).

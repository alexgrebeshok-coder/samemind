---
type: Concept
title: Embedding model — Qwen3-Embedding
description: The embedding model Nova switched to for semantic recall — better ranking quality than bge-m3.
visibility: internal
tags: [memory, retrieval, embeddings]
timestamp: 2026-07-10T00:00:00Z
source: demo
importance: 4
supersedes: /concepts/embed-model-bge-m3.md
relations:
  depends_on: /concepts/retrieval-strategy.md
---

# Embedding model — Qwen3-Embedding

Nova switched semantic recall to `Qwen3-Embedding` — noticeably better
ranking quality on the kind of short, jargon-heavy notes this bundle holds,
still servable locally through the same OpenAI-compatible `/v1/embeddings`
endpoint. See [retrieval strategy](/concepts/retrieval-strategy.md) for how
the index fits into recall as a whole.

This replaces the earlier [bge-m3 choice](/concepts/embed-model-bge-m3.md) —
that note is kept for history (`supersedes` above), not deleted; recall still
finds it, just ranked below this one and labeled accordingly.

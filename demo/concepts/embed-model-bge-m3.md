---
type: Concept
title: Embedding model — bge-m3
description: The embedding model Nova used for semantic recall before switching to Qwen3-Embedding.
visibility: internal
tags: [memory, retrieval, embeddings]
timestamp: 2025-09-01T00:00:00Z
source: demo
---

# Embedding model — bge-m3

Nova's first semantic recall index used `bge-m3` served locally (LM Studio /
Ollama) — good multilingual coverage, 1024-dim vectors, ran fine on a laptop.

Chosen mainly because it was already available locally and needed no API key.
See [retrieval strategy](/concepts/retrieval-strategy.md) for how the index
fits into recall as a whole.

---
okf_version: "0.1"
---

# Demo bundle — Nova

A small, **fully fictional** worked example of a samemind bundle. It documents an AI agent
named [Nova](/concepts/nova.md) and the world around her. Copy this folder to bootstrap your
own bundle, or validate it standalone:

```sh
OKF_ROOT=demo node tools/okf-query.mjs validate
OKF_ROOT=demo node tools/okf-query.mjs links
```

## The agent & her owner

- [Nova](/concepts/nova.md) — the agent (Identity)
- [Alex Doe](/entities/alex-doe.md) — owner (User)

## How Nova runs on each engine (EngineRule)

- [claude-code](/concepts/engine-claude-code.md) — terminal development
- [openclaw](/concepts/engine-openclaw.md) — chat orchestrator
- [opencode](/concepts/engine-opencode.md) — batch coder

## Projects

- [Lumen](/projects/lumen.md) — a note-taking app
- [Atlas](/projects/atlas.md) — a research knowledge base

## Entities

- [Acme Labs](/entities/acme-labs.md) — organization
- [Iris Vale](/entities/iris-vale.md) — collaborator

## Concepts (linked)

- [Retrieval strategy](/concepts/retrieval-strategy.md) ↔ [Context budget](/concepts/context-budget.md)

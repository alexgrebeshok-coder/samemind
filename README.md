# samemind

**Your personal universal memory for every AI agent. Switch engines. Same mind.**

Git-native, zero-infra, plain markdown. One OKF-shaped bundle that every agent
you run — Claude Code, OpenClaw, Hermes, opencode, Codex, Cursor, and the rest —
can read and write.

## Quick start

```sh
# clone or copy this repo, then:
node tools/okf-query.mjs validate          # this empty starter bundle
OKF_ROOT=demo node tools/okf-query.mjs validate   # fictional Nova demo

node tools/okf-query.mjs list
node tools/okf-query.mjs type Project
node tools/okf-query.mjs links

# semantic recall (needs a local OpenAI-compatible embeddings endpoint)
export OKF_EMBED_URL=http://127.0.0.1:8000/v1/embeddings   # optional override
node tools/okf-recall.mjs index
node tools/okf-recall.mjs "how does Nova handle retrieval" -k 5

# human-readable search with keyword fallback
node tools/gde.mjs "where did I write about context budget"
```

Copy a concept template, fill the frontmatter, link nodes with
`[title](/path.md)`. Path = identity.

## Format

OKF-shaped markdown bundle:

| Path | Role |
|------|------|
| `concepts/` | Ideas, rules, identity (`Concept`, `EngineRule`, `Identity`, …) |
| `entities/` | People & orgs (`User`, `Entity`) |
| `projects/` | Initiatives (`Project`) |
| `inbox/` | Raw notes awaiting curation |
| `secret/` | Sensitive nodes (gitignored; `--include-secret`) |
| `mirror/` | Live-memory mirrors per engine (gitignored; `--include-mirror`) |
| `index.md` | Human map of the graph |
| `log.md` | Append-only change timeline |

Every node has YAML frontmatter:

```yaml
---
type: Concept
title: …
description: …
visibility: internal   # public | internal | secret | mirror
tags: []
timestamp: 2026-07-10T00:00:00Z
source: …
---
```

See `demo/` for a complete fictional worked example (agent **Nova**, owner
**Alex Doe**, three engine rules, two projects, linked concepts).

## Tools

| Tool | Purpose |
|------|---------|
| `tools/okf-query.mjs` | Structural queries: `list`, `type`, `tag`, `get`, `links`, `validate` |
| `tools/okf-recall.mjs` | Semantic search (local embeddings; env: `OKF_EMBED_URL`, `OKF_EMBED_MODEL`) |
| `tools/gde.mjs` | Human search: semantic + keyword fallback |
| `tools/consolidate.mjs` | Gap map: inbox/mirror → candidates for promotion into the canon |

Shared libraries: `tools/lib/` (okf + recall), `lib/` (atomic write, safe paths, mirror sync).

Root of the bundle is the checkout by default; override with `OKF_ROOT`.

## Compatibility

Designed to sit under any agent that can read a folder of markdown and run Node:

- Claude Code / Cursor / Codex / Gemini CLI / opencode — point at this tree
- OpenClaw / Hermes / chat orchestrators — same bundle, different engine rules
- Any OpenAI-compatible embeddings server for recall (LM Studio, Ollama, …)

Adapters that import live memory into `mirror/` are out of scope for this public
skeleton; the format and tools are ready.

## License

MIT © 2026 Aleksandr Grebeshok

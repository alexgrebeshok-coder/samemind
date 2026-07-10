# samemind

**Your personal universal memory for every AI agent. Switch engines. Same mind.**

Git-native, zero-infra, plain markdown. One OKF-shaped bundle that every agent
you run — Claude Code, OpenClaw, Hermes, opencode, Codex, Cursor, and the rest —
can read and write.

## Quick start

```sh
npx samemind init --demo      # scaffold a bundle here + the fictional Nova demo content
npx samemind query list       # see what's in it
npx samemind gde "where did I write about context budget"   # human-readable search
```

`init` refuses to touch a non-empty directory — run it in a fresh folder, or pass
a path: `npx samemind init ./my-memory`. Drop `--demo` once you're ready for a real,
empty bundle. It also runs `git init` + a first commit when git is available.

Copy a concept template, fill the frontmatter, link nodes with
`[title](/path.md)`. Path = identity.

<details>
<summary>Working from a checkout instead (dev mode)</summary>

```sh
node tools/okf-query.mjs validate          # this empty starter bundle
OKF_ROOT=demo node tools/okf-query.mjs validate   # fictional Nova demo

node tools/okf-query.mjs list
node tools/okf-query.mjs type Project
node tools/okf-query.mjs links

# typed relations (demo): who works at Acme Labs?
OKF_ROOT=demo node tools/okf-query.mjs rel works_at acme-labs --inbound
OKF_ROOT=demo node tools/okf-query.mjs rel depends_on projects/atlas

# semantic recall (needs a local OpenAI-compatible embeddings endpoint)
export OKF_EMBED_URL=http://127.0.0.1:8000/v1/embeddings   # optional override
node tools/okf-recall.mjs index
node tools/okf-recall.mjs "how does Nova handle retrieval" -k 5

# human-readable search with keyword fallback
node tools/gde.mjs "where did I write about context budget"
```

</details>

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
relations:             # optional SameMind extension (typed graph edges)
  works_at: /entities/acme-labs.md
  depends_on: [/projects/atlas.md, /concepts/retrieval-strategy.md]
---
```

See `demo/` for a complete fictional worked example (agent **Nova**, owner
**Alex Doe**, three engine rules, two projects, linked concepts).

## Relations

Typed edges in frontmatter (`relations`) are a SameMind profile extension on top
of OKF v0.1. Edge types are open — no fixed vocabulary. Values are
bundle-absolute paths (`/entities/…md`) or lists of them; the parser always
normalizes to arrays.

```sh
# outbound: what does Alex depend on / work at?
OKF_ROOT=demo node tools/okf-query.mjs rel works_at entities/alex-doe

# inbound: who works at Acme Labs?
OKF_ROOT=demo node tools/okf-query.mjs rel works_at acme-labs --inbound
```

`links` counts relation edges alongside markdown links; `validate` reports
broken relation targets as **warnings** (path missing) without failing
conformant type checks.

## Tools

| Command | Purpose |
|------|---------|
| `samemind init [dir] [--demo]` | Scaffold a fresh bundle (empty dir only; `--demo` adds the Nova example) |
| `samemind query <cmd>` | Structural queries: `list`, `type`, `tag`, `get`, `links`, `rel`, `validate` |
| `samemind recall <cmd>` | Semantic search (local embeddings; env: `OKF_EMBED_URL`, `OKF_EMBED_MODEL`) |
| `samemind gde "<query>"` | Human search: semantic + keyword fallback |
| `tools/consolidate.mjs` | Gap map: inbox/mirror → candidates for promotion into the canon (dev-mode only, run from a checkout) |

`query`/`recall`/`gde` run against `OKF_ROOT` if set, otherwise your current directory —
so they operate on your own bundle, not on the samemind package itself.

Under the hood: `bin/samemind.mjs` routes to `tools/okf-query.mjs`, `tools/okf-recall.mjs`,
`tools/gde.mjs`, `tools/init.mjs`. Shared libraries: `tools/lib/` (okf + recall), `lib/`
(atomic write, safe paths, mirror sync).

## Compatibility

Designed to sit under any agent that can read a folder of markdown and run Node:

- Claude Code / Cursor / Codex / Gemini CLI / opencode — point at this tree
- OpenClaw / Hermes / chat orchestrators — same bundle, different engine rules
- Any OpenAI-compatible embeddings server for recall (LM Studio, Ollama, …)

Adapters that import live memory into `mirror/` are out of scope for this public
skeleton; the format and tools are ready.

## License

MIT © 2026 Aleksandr Grebeshok

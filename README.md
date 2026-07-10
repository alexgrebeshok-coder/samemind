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

# recall — works out of the box, zero deps (local BM25 over title/description/tags/body)
node tools/okf-recall.mjs "how does Nova handle retrieval" -k 5            # auto: BM25 unless an index exists
node tools/okf-recall.mjs "retrieval" --mode bm25                          # force local BM25, no network

# semantic recall is opt-in: point at any OpenAI-compatible /v1/embeddings server
export OKF_EMBED_URL=http://127.0.0.1:8000/v1/embeddings   # LM Studio / Ollama / OpenAI / local
export OKF_EMBED_MODEL=bge-m3                              # optional
export OKF_EMBED_KEY=sk-...                                # optional (Authorization: Bearer)
node tools/okf-recall.mjs index                            # build the local semantic index once
node tools/okf-recall.mjs "how does Nova handle retrieval" -k 5            # auto → semantic now

# human-readable search (semantic when available, BM25 fallback otherwise)
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

## Identity layer

The feature this project exists for: an agent that **knows itself, its owner,
and its role on the current engine** — no re-explaining required. Three
concept types (`Identity`, `User`, `EngineRule` — see
[`docs/identity-layer.md`](docs/identity-layer.md)) hold voice/values/boundaries,
owner preferences/hard rules, and per-engine role, all in plain OKF markdown.
`samemind init` scaffolds skeletons for them (`concepts/_identity-template.md`,
`entities/_user-template.md`, `concepts/_engine-rule-template.md`); `demo/`
has a filled-in example (agent Nova, owner Alex Doe, three engines).

`samemind brief` compresses all three into one budget-bounded markdown block
and can inject it straight into an engine's instruction file, so it's live
from the first token of a session — no retrieval step needed:

```sh
npx samemind brief --engine claude-code                # print to stdout
npx samemind brief --engine claude-code --inject ./CLAUDE.md   # idempotent insert/replace
```

Shortened example, run against the demo bundle:

```
<!-- samemind:brief:start -->
# Brief — Nova

Nova is the agent whose mind lives in this bundle. Same identity, many engines...

## Boundaries (hard — never overridden by engine or style)

- Never deletes files or data without an explicit "delete".
- External actions (send, publish, push, message someone) require confirmation.
...

## Owner — Alex Doe

Owner of Nova and the human this bundle ultimately serves.
- Hates: lies, flakiness, being ignored. In AI especially: stalling and not answering.

## Engine: claude-code

On this engine Nova does terminal development: reads, edits, runs, verifies — directly.
- No irreversible action (delete, push) without explicit confirmation.
<!-- samemind:brief:end -->
```

`--inject <file>` replaces only the content between the two marker comments —
text outside them is never touched, running it twice is a no-op. Priority
under `--budget` (default ~1500 tokens): boundaries/owner-rules/engine-role
first, voice next, everything else trimmed first with a `truncated — see
/concepts/…` pointer back to the source.

## Tools

| Command | Purpose |
|------|---------|
| `samemind init [dir] [--demo]` | Scaffold a fresh bundle (empty dir only; `--demo` adds the Nova example) |
| `samemind query <cmd>` | Structural queries: `list`, `type`, `tag`, `get`, `links`, `rel`, `validate` |
| `samemind recall "<query>"` | Search: `--mode bm25\|semantic\|auto` (default `auto`). BM25 works zero-dep; semantic needs `OKF_EMBED_URL` + `index`. |
| `samemind gde "<query>"` | Human search: semantic when an index exists, BM25 fallback otherwise |
| `samemind brief [--engine <id>] [--budget <n>] [--inject <file>]` | Compact Identity+User+EngineRule digest — see [Identity layer](#identity-layer) |
| `samemind serve` | MCP stdio server: `memory_search/get/list/write_inbox/health` — see [MCP](#mcp) |
| `tools/consolidate.mjs` | Gap map: inbox/mirror → candidates for promotion into the canon (dev-mode only, run from a checkout) |

`query`/`recall`/`gde`/`brief`/`serve` run against `OKF_ROOT` if set, otherwise your current
directory — so they operate on your own bundle, not on the samemind package itself.

Under the hood: `bin/samemind.mjs` routes to `tools/okf-query.mjs`, `tools/okf-recall.mjs`,
`tools/gde.mjs`, `tools/init.mjs`, `tools/brief.mjs`, `tools/mcp-server.mjs`. Shared libraries:
`tools/lib/` (okf, recall, bm25, mcp, injection), `lib/` (atomic write, safe paths, mirror sync).

### Recall modes & env

`okf-recall.mjs "<query>"` selects a mode via `--mode`:

- **`auto`** (default) — semantic if a local index exists **and** the embeddings endpoint answers; otherwise degrades to local BM25 and prints a one-line notice to stderr. Never crashes without an endpoint.
- **`bm25`** — always local keyword/BM25 over `title` / `description` / `tags` / body. No network, no dependencies.
- **`semantic`** — strictly semantic; errors loudly (no silent fallback) if the index or endpoint is missing.

Semantic search uses any OpenAI-compatible `/v1/embeddings` server:

| Env | Purpose |
|-----|---------|
| `OKF_EMBED_URL` | Endpoint URL (Ollama, LM Studio, OpenAI, a local server, …) |
| `OKF_EMBED_MODEL` | Model name sent in the request body |
| `OKF_EMBED_KEY` | Optional `Authorization: Bearer …` |
| `OKF_EMBED_DIM` | Optional; if set, the response vector length is validated |

Build the index once after setting the endpoint: `node tools/okf-recall.mjs index`.

## MCP

`samemind serve` runs a stdio MCP server (JSON-RPC 2.0, newline-delimited, no SDK
dependency) exposing the bundle to any MCP-capable agent — Claude Code, Codex,
opencode, or your own client.

```sh
npx samemind serve                 # OKF_ROOT (or cwd) = bundle root; stdin/stdout = protocol
```

Connect it as a project or user-scope MCP server:

```sh
claude mcp add samemind -- npx samemind serve
codex mcp add samemind -- npx samemind serve
```

Point `OKF_ROOT` at the bundle you want served (defaults to the current directory
if unset — same rule as `query`/`recall`/`gde`).

### Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | `{query, k?, mode?}` → recall (semantic if an index exists and answers, BM25 otherwise). Returns `{id, type, title, score, snippet}[]`. |
| `memory_get` | `{id}` → one concept, full frontmatter + body. |
| `memory_list` | `{type?, tag?}` → concept ids/titles, optionally filtered. |
| `memory_write_inbox` | `{content, title?}` → append to `inbox/<agent>.md` — the **only** writable path. |
| `memory_health` | `{}` → bundle root, concept count, active search mode, server version. |

### Security

- **`visibility: secret` is never returned** by any tool — no flag, no parameter, no
  exception. Secret concepts are excluded before the tools ever see them.
- **Path safety**: any `id` passed to `memory_get` is normalized and must resolve
  strictly inside the bundle root; `..`/absolute escapes are refused outright.
- **Write path is fixed**: `memory_write_inbox` can only ever append to
  `inbox/<agent>.md`. The agent name comes from `SAMEMIND_AGENT` (default `mcp`),
  sanitized to `[a-z0-9-]`. Every write is atomic (temp file + rename) and
  append-only — existing entries are never rewritten.
- **Prompt-injection content is quarantined, not dropped.** Text that looks like an
  instruction-override attempt (`ignore previous instructions`, `<system>`,
  `tool_use`, "run/execute this command", …) is still written — wrapped in a
  fenced ` ```quarantine ` block with a `quarantine: true` marker — so memory is
  never silently lost, but no downstream reader executes it blindly.

## Compatibility

Designed to sit under any agent that can read a folder of markdown and run Node:

- Claude Code / Cursor / Codex / Gemini CLI / opencode — point at this tree
- OpenClaw / Hermes / chat orchestrators — same bundle, different engine rules
- Any OpenAI-compatible embeddings server for recall (LM Studio, Ollama, …)

Adapters that import live memory into `mirror/` are out of scope for this public
skeleton; the format and tools are ready.

## License

MIT © 2026 Aleksandr Grebeshok

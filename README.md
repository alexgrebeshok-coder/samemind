# samemind

[![ci](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml/badge.svg)](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml)

**Your personal universal memory for every AI agent. Switch engines. Same mind.**

Git-native, zero-infra, plain markdown. One OKF-shaped bundle that every agent
you run — Claude Code, OpenClaw, Hermes, opencode, Codex, Cursor, and the rest —
can read and write.

## Quick start

```sh
npx samemind init --demo      # scaffold a bundle here + the fictional Nova demo content
npx samemind query list       # see what's in it
npx samemind gde "where did I write about context budget"   # human-readable search
npx samemind install --agent claude-code   # wire brief+protocol straight into CLAUDE.md
```

`install` supports 12 engines out of the box (`--list` to see them) — Claude
Code, Cursor, Copilot, Codex, Gemini CLI, opencode, Cline, Roo Code, Windsurf,
Goose, Kiro, Antigravity — writing into whichever instruction file(s) that
engine reads. See [Compatibility](#compatibility) and
[docs/adapters.md](docs/adapters.md) for the full matrix, and
[`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) if you're an agent installing
this for yourself, end to end.

`init` refuses to touch a non-empty directory — run it in a fresh folder, or pass
a path: `npx samemind init ./my-memory`. Drop `--demo` once you're ready for a real,
empty bundle. It also runs `git init` + a first commit when git is available.

Copy a concept template, fill the frontmatter, link nodes with
`[title](/path.md)`. Path = identity.

### A session, start to finish

Real output, trimmed for length — no gif needed:

```sh
$ npx samemind init --demo
✓ bundle created: ./samemind-demo
  --demo: copied 22 demo concepts
  git init + initial commit done

$ npx samemind brief --engine claude-code
<!-- samemind:brief:start -->
# Brief — Nova

Nova is the agent whose mind lives in this bundle. Same identity, many engines —
she carries her voice, values and memory across all of them.

## Boundaries (hard — never overridden by engine or style)

- Never deletes files or data without an explicit "delete".
- External actions (send, publish, push, message someone) require confirmation.
- Doesn't hand back half-finished work — finishes, then answers.
...

$ npx samemind recall "where did I write about context budget"
⚠ semantic off, BM25 fallback — set OKF_EMBED_URL for semantic search
# "where did I write about context budget" → top-5 [bm25]
5.559  Concept    concepts/context-budget — Context budget
3.693  Concept    concepts/retrieval-strategy — Retrieval strategy
1.366  User       entities/alex-doe — Alex Doe
1.266  Decision   concepts/decision-lumen-local-first — Lumen stays local-first — no mandatory cloud account

$ npx samemind board
# Dashboard

## 🔧 In progress (1)
- **Ship Lumen backlink editor** — Land the bidirectional backlink editor so Lumen's note graph is navigable.

## 🔴 Blocked (1)
- **Wire retrieval strategy over the Atlas corpus**
  - ⛔ Corpus ingestion paused — waiting on Alex to confirm the source license list.

## 📋 Plans (1)
- **Lumen multi-device sync** · agreed — ship end-to-end sync after the backlink editor.
...
```

No daemon, no API key, no network call. `brief` and `board` read straight off
the markdown `init --demo` just wrote; `recall` degrades to local BM25 because
`OKF_EMBED_URL` isn't set. Four commands, zero infra — that's the whole pitch.

## The protocol

Agents **synthesize** answers themselves — search → read top hits → cite paths →
name gaps. No synthesis daemon, no API keys. Full steps and a live demo Q→A:
[docs/memory-protocol.md](docs/memory-protocol.md). Paste-ready rules:
[docs/snippets/](docs/snippets/).

**Session start:** run `samemind handoff` (or MCP `memory_handoff`) for work state —
active tasks, last decisions, plans in force — so a new session continues without
re-explaining. Before `/compact`, flush Decision/Session/Task to inbox first; see
[docs/compaction-recipe.md](docs/compaction-recipe.md).

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
| `inbox/` | Raw notes awaiting curation — excluded from the graph by default (`validate`/`list`/`links`/`rel`/`get` don't see it); `--include-inbox` opt-in |
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
supersedes: /concepts/old-idea.md   # optional — memory hygiene, see below
importance: 3                      # optional — 1..5, default 3 (neutral)
---
```

See `demo/` for a complete fictional worked example (agent **Nova**, owner
**Alex Doe**, three engine rules, two projects, linked concepts).

**Stale vs. current isn't automatic** — a fact from six months ago and one
from today rank equally unless you say otherwise. `supersedes`,
`samemind forget`, `importance`, and gentle time-decay fix that without ever
deleting history: see [docs/memory-hygiene.md](docs/memory-hygiene.md).

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
first, voice next, everything else trimmed first. When the budget still
overflows after tier selection, the last kept tier-1/2 section is trimmed
*by paragraph* to land within ±10% (marked `…truncated`) instead of being
dropped whole — tier-0 is never trimmed. Pass `--exclude-source <id>` to
omit concepts authored by that source (anti-echo).

## Board

A kanban over the work-discipline layer (Plan / Task / Decision / Session — see
[`docs/work-discipline.md`](docs/work-discipline.md)) plus the knowledge-cycle
`💡 Ideas` section (see "The knowledge flywheel" below): what's queued, what's
moving, what's **blocked** (and for how long — blocks older than 7 days are
flagged `aging`), what just landed, what was recently agreed, and what candidate
ideas are incubating. Pure markdown — reads in the terminal, renders on GitHub.
`--write` atomically refreshes `DASHBOARD.md` in the bundle root (a committed
artifact; `samemind init` seeds a placeholder); `--project` scopes the four
task columns to one project (Plans / Ideas / Recent / Sessions stay portfolio-wide).

```sh
npx samemind board                              # print the kanban to stdout
npx samemind board --write                      # refresh DASHBOARD.md (idempotent — safe in a hook/cron)
npx samemind board --project /projects/lumen.md # only Lumen's tasks
```

Shortened example, run against the demo bundle:

```
# Dashboard

## 🔧 In progress (1)
- **[Ship Lumen backlink editor](/projects/task-lumen-backlinks.md)** — Land the bidirectional backlink editor…

## 🔴 Blocked (1)
- **[Wire retrieval strategy over the Atlas corpus](/projects/task-atlas-retrieval.md)** — Connect Nova's retrieval…
  - ⛔ Corpus ingestion paused — waiting on Alex to confirm the source license list…
  - ⏳ 0d

## 📋 Plans (1)
- **[Lumen multi-device sync](/projects/plan-lumen-sync.md)** · agreed — Agreed plan to ship end-to-end sync…

### Recent sessions (1)
- [Lumen sync kickoff (2026-07-09)](/concepts/session-2026-07-09-lumen-sync.md) · 2026-07-09 — Working session that agreed the sync plan…
```

## The knowledge flywheel

Ideas die in someone's head, not in the bundle. Three more concept types —
`Analysis`, `Research`, `Idea` (see [`docs/knowledge-cycle.md`](docs/knowledge-cycle.md))
— make the cycle **Analysis → Research → Idea → Plan** visible in the graph
instead of in a chat transcript. An `Analysis` notices a pattern in observed
facts and `informs` an `Idea`; an `Idea` sometimes needs a deeper dig first —
a `Research` node `spawned_by` the `Analysis`, which also `informs` the same
`Idea`; an `Idea` matures (`spark → incubating`) with agents appending
`## Reflections` as they encounter it, until it's `adopted` (`led_to` a
`Plan`) or `rejected` (with a reason, so it isn't re-proposed next week). Any
agent on any engine can spot an immature `Idea` in its domain and react —
write a reflection to its own inbox rather than reading past it (full
protocol: [`docs/memory-protocol.md`](docs/memory-protocol.md)). `samemind
board` surfaces it: incubating ideas first, then sparks, adopted ideas
pointing at the Plan they became, rejected ones off the board but not
deleted. See `demo/` for a linked, worked example (mirror-staleness →
sync-mechanism research → cron-sync-adapters idea).

## Tools

| Command | Purpose |
|------|---------|
| `samemind init [dir] [--demo]` | Scaffold a fresh bundle (empty dir only; `--demo` adds the Nova example) |
| `samemind query <cmd>` | Structural queries: `list`, `type`, `tag`, `get`, `links`, `rel`, `validate` |
| `samemind recall "<query>"` | Search: `--mode bm25\|semantic\|auto` (default `auto`). BM25 works zero-dep; semantic needs `OKF_EMBED_URL` + `index`. `--exclude-source <id>` drops an engine's own concepts (anti-echo). |
| `samemind gde "<query>"` | Human search: semantic when an index exists, BM25 fallback otherwise. `--exclude-source <id>` supported. |
| `samemind brief [--engine <id>] [--budget <n>] [--inject <file>] [--exclude-source <id>]` | Compact Identity+User+EngineRule digest — see [Identity layer](#identity-layer) |
| `samemind handoff [--project <path>] [--days N] [--html [--out <file>]]` | Work-state brief (tasks/plans/decisions/session) — see [docs/compaction-recipe.md](docs/compaction-recipe.md); `--html` → self-contained page (no CDN/JS, light+dark) |
| `samemind forget <id>` | Soft-deprecate a concept (`deprecated: true` in frontmatter) — never deletes the file. See [Memory hygiene](docs/memory-hygiene.md) |
| `samemind board [--write] [--project <path>] [--html [--out <file>]]` | Kanban over the work-discipline layer (Backlog / In progress / Done / Blocked+aging, Plans, Recent) plus knowledge-cycle Ideas — `--write` → `DASHBOARD.md`, `--html` → self-contained page with an SVG kanban chart — see [Board](#board) |
| `samemind install --agent <id>\|all [--target <dir>]` | Wire brief+protocol into an engine's instruction file(s), idempotently — see [Compatibility](#compatibility), [docs/adapters.md](docs/adapters.md). Unknown id needs `--file <path>` for a generic install. |
| `samemind export <dir> [--visibility public\|internal] [--dry-run] [--to-gbrain]` | Shareable OKF-bundle (strips `secret/`/`mirror/`/`inbox/`); gbrain page mapping — see [docs/interop.md](docs/interop.md) |
| `samemind import <dir> [--into inbox\|concepts]` | Accept a foreign OKF-bundle (default → curated `inbox/import-<date>.md`; never overwrites) — see [docs/interop.md](docs/interop.md) |
| `samemind serve` | MCP stdio server: `memory_search/get/list/write_inbox/handoff/health` — see [MCP](#mcp) |
| `tools/consolidate.mjs` | Gap map: inbox/mirror → candidates for promotion into the canon, plus a same-type "contradictions" section (dev-mode only, run from a checkout) |

`query`/`recall`/`gde`/`brief`/`board`/`handoff`/`forget`/`install`/`export`/`import`/`serve` run against `OKF_ROOT` if set, otherwise your
current directory — so they operate on your own bundle, not on the samemind package itself.

Under the hood: `bin/samemind.mjs` routes to `tools/okf-query.mjs`, `tools/okf-recall.mjs`,
`tools/gde.mjs`, `tools/init.mjs`, `tools/brief.mjs`, `tools/board.mjs`, `tools/handoff.mjs`,
`tools/forget.mjs`, `tools/install.mjs`, `tools/export.mjs`, `tools/import.mjs`,
`tools/mcp-server.mjs`. Shared libraries: `tools/lib/` (okf, recall, bm25, hygiene, mcp,
injection, **html-render** — the `--html` projection for board/handoff), `lib/` (atomic write,
safe paths, mirror sync).

### HTML projections (`--html`)

`board` and `handoff` are markdown by default (git-native, terminal-readable); `--html` renders
the *same* data model (`buildBoardModel`/`buildHandoffModel` — one source of truth, no
re-parsing) as a self-contained page instead: inline CSS, light+dark via
`prefers-color-scheme`, zero JavaScript, zero external resources, plus a small SVG chart (a
kanban bar chart + Ideas strip for the board, a decision timeline for handoff). The canon stays
markdown — HTML is always a generated face, never storage (see
[gbrain/concepts/idea-html-projections.md](https://github.com/alexgrebeshok-coder/gbrain)).

```sh
npx samemind board --html --out DASHBOARD.html      # write a self-contained kanban page
npx samemind handoff --html | pbcopy                # pipe the handoff page anywhere
```

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
| `memory_search` | `{query, k?, mode?, exclude_source?}` → recall (semantic if an index exists and answers, BM25 otherwise). Returns `{id, type, title, score, snippet}[]`. `exclude_source` (`[a-z0-9-]`) drops an engine's own concepts — anti-echo. |
| `memory_get` | `{id}` → one concept, full frontmatter + body. |
| `memory_list` | `{type?, tag?}` → concept ids/titles, optionally filtered. |
| `memory_write_inbox` | `{content, title?}` → append to `inbox/<agent>.md` — the **only** writable path. |
| `memory_handoff` | `{project?, days?}` → work-state markdown (active tasks, decisions, plans, last session, open questions). |
| `memory_health` | `{}` → bundle root, concept count, active search mode, server version. |

### Security

- **`visibility: secret` is never returned** by any tool — no flag, no parameter, no
  exception. Secret concepts are excluded before the tools ever see them.
  Perimeter covered by `tools/secret-isolation.test.mjs` (query / recall / gde / MCP / brief).
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

**Zero-level fallback, true for everything below:** the bundle is plain markdown
on disk. Any agent with a shell can read it via `cat`/`grep`/`find` with no
adapter at all — MCP and `samemind install` are conveniences on top of a format
that already works with anything that has a filesystem.

`samemind install --agent <id>` wires the identity brief + memory protocol
straight into the instruction file each engine reads on its own, and `samemind
serve` exposes the bundle as an MCP server for everything that speaks MCP.
Checked, current as of 10.07.2026 — full commands and notes in
[docs/adapters.md](docs/adapters.md):

- Any OpenAI-compatible embeddings server for recall (LM Studio, Ollama, …)
- **Google OKF v0.1** wire shape — `samemind export` / `import` exchange shareable packs (`okf_version: "0.1"`); `--to-gbrain` maps concepts to [garrytan/gbrain](https://github.com/garrytan/gbrain) pages — see [docs/interop.md](docs/interop.md)

| Engine | Instruction file | MCP |
|---|---|---|
| Claude Code | `CLAUDE.md` | ✅ `claude mcp add` |
| Cursor | `AGENTS.md` + `.cursor/rules/` | ✅ `.cursor/mcp.json` |
| GitHub Copilot (agent mode) | `.github/copilot-instructions.md` + `AGENTS.md` | ✅ VS Code `mcp.json` |
| Codex CLI | `AGENTS.md` | ✅ `codex mcp add` |
| Gemini CLI | `GEMINI.md` | ✅ `settings.json` |
| opencode | `AGENTS.md` | ✅ `opencode.json` |
| Cline | `.clinerules` | ✅ `cline_mcp_settings.json` |
| Roo Code | `.roo/rules/` | ✅ `.roo/mcp.json` |
| Windsurf | `.windsurf/rules/` + `AGENTS.md` | ✅ `mcp_config.json` |
| Goose | `.goosehints` | ✅ native extension |
| Kiro | `.kiro/steering/` | ✅ `kiro-cli mcp add` |
| Antigravity | `AGENTS.md` / `GEMINI.md` | ✅ IDE config / Gemini API |
| Aider | — (`--read` a snippet manually) | ⚠️ community-only, unofficial |
| OpenClaw / Hermes | — (own `MEMORY.md`/`USER.md`, bootstrap note) | ✅ same MCP shape as any client |

`samemind install --list` prints this table live from the code. `--agent all`
refreshes whichever of these files already exist in a project, without blindly
creating all twelve. `INSTALL_FOR_AGENTS.md` is a step-by-step self-install
protocol written for an agent to run against its own project, no human typing.

Adapters that import *live* engine memory into `mirror/` (e.g. syncing an
engine's own session notes back into the bundle) are out of scope for this
public skeleton; the format and tools to build one are ready.

## samemind vs. gbrain (Garry Tan) — when to use which

[gbrain](https://github.com/garrytan/gbrain) is a real, serious product,
solving a different job well: a 24/7 daemon that ingests your whole digital
life (email, voice calls, tweets, meetings) into Postgres/pgvector, auto-wires
an entity graph, and hands back a synthesized, cited answer with gap analysis
(`gbrain think`) instead of a list of hits. If you want an always-on brain for
a person or a company at 100K+ pages, it's a strong choice — read its README.
samemind is aimed at a narrower, adjacent job: a portable identity + memory
layer *for your coding agent*, with nothing to run and nothing to pay for.

| | samemind | gbrain |
|---|---|---|
| Infra | none — markdown + git | Postgres/pgvector (or PGLite) + an embedding provider + a 24/7 "dream cycle" daemon |
| Setup | `npx samemind init` — seconds | ~30 min guided install, API keys, DB bring-up |
| Answer shape | you (or your agent) read ranked hits and synthesize, with cited gaps | `gbrain think` returns an already-synthesized, cited answer + gap analysis |
| Scale target | hand-curated — hundreds to low thousands of concepts | built for continuous ingestion at 100K+ pages |
| Entities/graph | you write typed `relations:` by hand | auto-extracted entity graph (zero LLM calls) + LLM-driven enrichment on a nightly cron |
| Querying it | plain markdown — `cat`/`grep`/`find` work with zero tooling | git repo is the source of truth, but querying needs the Postgres/PGLite engine + embeddings running |

Use samemind if you want a memory that travels with you across every coding
engine you touch, costs nothing to run, and you're fine doing (or trusting
your agent to do) the synthesis yourself. Use gbrain if you want an always-on
brain that ingests your whole life or your team's and hands back a written
answer, and you're fine running a database and paying for embeddings/rerank
to get it. Nothing here is a knock on gbrain — different scope, different
bill of materials.

**vs. SQLite/vector-DB memory tools** for coding agents (Memorix, agentmemory,
claude-mem, and similar): your memory is your markdown files in git — not our
database. No binary store to export, no proprietary schema to migrate off of,
`git log` is the audit trail.

## Tests & micro-bench

```sh
node --test tools/*.test.mjs          # CI matrix: Node 20 + 22
OKF_ROOT=demo node tools/bench-recall.mjs   # BM25 vs naive grep on demo goldens
```

Methodology and current hit@1 / hit@3 numbers: [docs/benchmark.md](docs/benchmark.md).
Micro-corpus only — not a public IR leaderboard.

Contributing dev-setup, conventions, and pointers to the format spec:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT © 2026 Aleksandr Grebeshok

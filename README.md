# samemind

samemind is a git-native markdown memory bundle for AI coding agents — identity, search, a work ledger, and a kanban board in one place, portable across engines like Claude Code, Cursor, and OpenClaw. No daemon, no required database; BM25 search always works offline, semantic search is optional.

**Latest: v0.11.0** — the memory gets a face: `npx samemind ui`, a local read-only dashboard — kanban that fills itself from the work ledger, an interactive concept graph, live orchestration feed over SSE. See [CHANGELOG.md](CHANGELOG.md).

[![ci](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml/badge.svg)](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml)

**Your personal universal memory for every AI agent. Switch engines. Same mind.**

Git-native markdown bundle (no daemon, no required DB): identity, search, handoff, an append-only work ledger, and a kanban board in one place. Wire-compatible with [Google OKF v0.1](docs/interop.md). Optional embeddings; **BM25 always works offline**.

## Why not “just markdown + BM25”?

| | Typical git-markdown memory | samemind |
|---|---|---|
| Wire format | ad hoc | [OKF v0.1](docs/interop.md) export/import |
| Identity | flat notes | `Identity` / `User` / `EngineRule` → budgeted `brief` |
| Work | separate tools | [event ledger](docs/event-ledger.md) + board in the same bundle |
| Multi-engine ops | assumed, never checked | [fleet registry](docs/fleet.md) + heartbeat: who reports, who went quiet |
| Engines | often one client | `samemind install` → 12 engines ([adapters](docs/adapters.md)) |
| Capture | — | `samemind capture` (read-only session → inbox) |
| Face | raw files | `samemind ui` — local dashboard: board, graph, fleet, live feed |

## First use

```sh
npx samemind setup
```

Detects the agent, scaffolds a bundle if needed, wires the memory protocol into its instruction file, registers MCP, probes local embeddings (or stays on honest BM25). Interactive by default; `--yes` / `--dry-run` / `--target <dir>` available.

```sh
npx samemind init --demo          # fresh dir only
npx samemind recall "context budget"
npx samemind board
npx samemind brief --engine claude-code
```

Agent self-install protocol: [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md).

## Dashboard

```sh
npx samemind ui          # → http://127.0.0.1:7787 (your bundle; --root <dir>, --open)
```

Local and read-only by design (binds 127.0.0.1, exact-match Host guard, zero write endpoints).
Four screens: **Overview** — kanban with honest totals, synthesized from ledger topics when no
Task docs exist (real Task docs always win); **Memory** — concept browser, BM25 search, and an
interactive graph (wheel-zoom at cursor, pan, draggable nodes, neighbor highlight); **Fleet** —
engine heartbeat bars, naryad timeline, and a live event feed over SSE (`/api/events/stream`) —
the board updates itself seconds after an agent reports; **Projects** — cards with status,
description and linked concepts, opening into the full project doc. Light + dark. The same data
is scriptable: `board`, `handoff`, `fleet status`, `ledger status`, `query links` all take
`--json` (`{ contract: 1, … }`), and the dashboard's `/api/*` serves the same shapes.

**Global personal bundle** (project + global recall, project wins on id collision):

```sh
npx samemind setup --global
```

Details: [docs/full-guide.md § Global mode](docs/full-guide.md#global-mode) (archived long homepage).

## Proof (commands agents actually run)

| Command | Job |
|---------|-----|
| `setup` / `install` | Wire engines + MCP |
| `recall` / `gde` | Search (BM25 / optional semantic) |
| `brief` / `handoff` | Identity + work-state across sessions |
| `board` | Kanban over tasks/plans/ideas |
| `capture` | Pull engine transcripts → `inbox/` |
| `ledger` | Append-only work events |
| `fleet` | Declared engine registry: who reports, who went quiet ([docs/fleet.md](docs/fleet.md)) |
| `ui` | Local read-only dashboard: board, graph, fleet, live SSE feed |
| `serve` | MCP: `memory_search`, `memory_get`, `memory_write_inbox`, … |
| `forget` / `export` / `import` | Hygiene + OKF packs |

Full table and env vars: [docs/full-guide.md § Tools](docs/full-guide.md#tools).

MCP (stdio):

```sh
npx samemind serve
claude mcp add samemind -- npx samemind serve
```

Security perimeter (secret visibility, inbox-only writes, path safety): [docs/full-guide.md § MCP](docs/full-guide.md#mcp).

## Docs map

| Topic | Doc |
|-------|-----|
| **Full previous homepage** (deep dive) | [docs/full-guide.md](docs/full-guide.md) |
| Engine matrix / OpenClaw·Hermes bootstrap | [docs/adapters.md](docs/adapters.md) |
| Memory protocol (recall → cite → inbox) | [docs/memory-protocol.md](docs/memory-protocol.md) |
| Identity + `brief` | [docs/identity-layer.md](docs/identity-layer.md) |
| Hygiene, supersedes, heat | [docs/memory-hygiene.md](docs/memory-hygiene.md) |
| Event ledger | [docs/event-ledger.md](docs/event-ledger.md) |
| Fleet registry + heartbeat | [docs/fleet.md](docs/fleet.md) |
| Session capture | [docs/session-capture.md](docs/session-capture.md) |
| Compaction / handoff | [docs/compaction-recipe.md](docs/compaction-recipe.md) |
| OKF interop | [docs/interop.md](docs/interop.md) |
| Benchmark notes | [docs/benchmark.md](docs/benchmark.md) |

## Limits (honest)

- Canon promotion is **human-gated** (inbox → concepts); not auto-mem that rewrites truth silently.
- Semantic search needs a local/OpenAI-compatible embeddings endpoint (`OKF_EMBED_URL`); without it, BM25 only — by design.
- Hand-curated scale (roughly 10²–10³ concepts), not a 24/7 life-ingestion daemon — see vs [gbrain](docs/full-guide.md#samemind-vs-gbrain-garry-tan--when-to-use-which).

## FAQ

### Does samemind need a database or background daemon?
No. It's git-native markdown with no daemon and no required database. BM25 search always works offline; semantic search is optional and needs a local/OpenAI-compatible embeddings endpoint (`OKF_EMBED_URL`).

### Which AI engines does it work with?
`samemind install` wires the memory protocol into 12 engines (see [docs/adapters.md](docs/adapters.md)), and it exposes an MCP server (`npx samemind serve`) for engines like Claude Code.

### What's new in v0.11.0?

`samemind ui` grew into a real cockpit: the kanban **fills itself** from ledger topics (a fleet
that reports work gets a live board with zero Task-doc bookkeeping), the concept graph is
interactive (zoom/pan/drag, Obsidian-style), and `/api/events/stream` (SSE) drives a live feed —
subagent start/finish events land on the board within seconds. v0.10.0 introduced the dashboard
itself and the versioned `--json` contract; v0.9.0 added `recall --expand` (1-hop graph expand
over relations and reverse wikilinks) and a human gate on bulk `capture`. See [CHANGELOG.md](CHANGELOG.md).

### What's new in v0.8.0?

The **fleet layer**: `samemind fleet init | status | assign` — a declared registry of the engines
sharing one bundle, reporting cadence, and `🔥 Overdue engines` on the board; MCP exposes
`memory_fleet_status` / `memory_fleet_assign`. See [docs/fleet.md](docs/fleet.md).

### What are the current limits?
Canon promotion is human-gated (inbox → concepts, not a silent auto-rewrite); semantic search needs an embeddings endpoint or falls back to BM25 by design; scale is hand-curated (roughly 10²–10³ concepts), not a 24/7 ingestion daemon.

## Tests

```sh
node --test tools/*.test.mjs
```

## License

MIT © 2026 Aleksandr Grebeshok

# samemind

**Switch engines, same mind: file-based memory for AI coding agents.** A git-native markdown bundle — identity, search, a work ledger, and a kanban board in one place — portable across Claude Code, Cursor, Codex, OpenClaw and other engines. No daemon or database required; BM25 search always works offline, semantic search is optional. Wire-compatible with [Google OKF v0.1](docs/interop.md).

[![ci](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml/badge.svg)](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml)

## Why not "just markdown + BM25"?

| | Typical git-markdown memory | samemind |
|---|---|---|
| Wire format | ad hoc | [OKF v0.1](docs/interop.md) export/import |
| Identity | flat notes | `Identity` / `User` / `EngineRule` → budgeted `brief` |
| Work | separate tools | [event ledger](docs/event-ledger.md) + board in the same bundle |
| Multi-engine ops | assumed, never checked | [fleet registry](docs/fleet.md) + heartbeat: who reports, who went quiet |
| Engines | often one client | `samemind install` → 12 engines ([adapters](docs/adapters.md)) |
| Freshness | manual copy-paste into context | opt-in daemon + [lifecycle hooks](docs/service.md), honest per-engine tier |
| Face | raw files | `samemind ui` — local dashboard: board, graph, fleet, live feed |

## Proof (measured, not promised)

**Golden-40 recall bench** — 40 natural-language paraphrase questions (no title tokens) with hand-labeled golden ids, run against the live samemind development bundle (212 indexed docs, bge-m3 embeddings):

| mode | recall@5 | precision |
|---|---:|---:|
| bm25 | **0.925** | 0.900 |
| semantic | **0.925** | 0.900 |
| hybrid | **0.925** | 0.875 |

Independently verified at release (separate engine, branch replay): hit@3 0.90–0.925 across all three modes; test suite 1386/1386 green.

The road to 0.925: in 1.1.0 the hybrid mode scored **0.275** on the same set — below plain BM25. Retrieval was fine; the ranker was broken (hygiene modulation could outrank pure relevance, and a tiebreak scrambled RRF legs before fusion). [1.1.2](CHANGELOG.md) fixes both; full history in the [CHANGELOG](CHANGELOG.md).

**Third-party harness:** on LongMemEval-S (500 questions, BM25-only default) samemind scores R@1/5/10 = 85.7 / 92.8 / 96.4 — within noise of that harness's own BM25 anchor. Method and caveats: [bench/longmemeval/RESULTS.md](bench/longmemeval/RESULTS.md).

## First 5 minutes

Requires Node.js ≥ 20.

```sh
npx samemind setup            # wire the current project: detect engine, scaffold bundle, register MCP
npx samemind init --demo      # demo bundle (fresh empty dir only)
npx samemind recall "context budget" -k 3
npx samemind board
npx samemind brief --engine claude-code
```

`recall` on the demo bundle (BM25 without an embeddings endpoint — demo ids are stable):

```text
# "context budget" → top-3 [bm25, score=bm25]
6.161  Concept    concepts/context-budget — Context budget
4.284  Concept    concepts/retrieval-strategy — Retrieval strategy
1.630  User       entities/alex-doe — Alex Doe
```

Same bundle root = same mind: engine A drops a note in `inbox/`, engine B finds it via `recall --include-inbox`, and `handoff` shows the same work state everywhere. Agents can self-install: [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md).

## Commands agents actually run

| Command | Job |
|---|---|
| `setup` / `install` | Wire engines + MCP |
| `recall` / `query` | Search — bm25 / semantic / hybrid; `--expand` for 1-hop neighbors |
| `brief` / `handoff` | Identity + work state across sessions |
| `board` | Kanban over tasks/plans/ideas |
| `capture` | Pull engine transcripts → `inbox/` |
| `ledger` / `fleet` | Append-only work events; engine registry + heartbeat |
| `project` / `service` / `hooks` / `status` | Keep engine instruction files fresh ([docs](docs/service.md)) |
| `doctor` | Connection health: config vs live MCP + corpus — `connected` ≠ `verified` |
| `ui` | Local dashboard (127.0.0.1; memory itself is read-only from the UI) |
| `serve` | MCP server: `memory_search`, `memory_get`, `memory_write_inbox`, … (stdio; `--http`) |
| `nudge` / `proactive` | One thing worth raising; auto recall pack before an answer |
| `forget` / `export` / `import` | Hygiene + OKF packs |

Full table, env vars, JSON contract: [docs/full-guide.md](docs/full-guide.md).

## Engines

`samemind install` wires 12 engines ([matrix](docs/adapters.md)): Claude Code, Cursor, GitHub Copilot, Codex CLI, Gemini CLI, opencode, Cline, Roo Code, Windsurf, Goose, Kiro, Antigravity. Three get real lifecycle hooks (**auto**: `claude-code`, `codex`, `opencode`); the rest stay on file **projection** — honestly labeled by `samemind hooks list`. Any MCP-capable engine can use `npx samemind serve`.

## Keeping memory fresh

Nothing runs in the background by default. Opt in, in order of autonomy:

```sh
npx samemind project --engine claude-code       # one-shot write into the engine's file
npx samemind service install [--daemon]         # OS-scheduled re-projection (LaunchAgent/systemd/Task Scheduler)
npx samemind hooks install --agent claude-code  # real SessionStart/SessionEnd hooks — no polling
```

`samemind status` reads the heartbeat any real run leaves behind (`✅ ok` / `⚠️ stale` / `❌ failed`). Details: [docs/service.md](docs/service.md).

## Limits (honest)

- Personal/team scale (roughly 10²–10³ concepts, hand-curated) — no hosted service, not a 24/7 life-ingestion daemon ([vs gbrain](docs/full-guide.md#samemind-vs-gbrain-garry-tan--when-to-use-which)).
- Semantic search needs your own OpenAI-compatible embeddings endpoint (`OKF_EMBED_URL`); without it, BM25 only — by design.
- Canon promotion is human-gated (inbox → concepts): no auto-memory that rewrites truth silently.
- The dashboard writes only settings (`POST /api/config`) and nudge answers — never the memory itself.

## Docs

[full guide](docs/full-guide.md) (deep dive) · [adapters](docs/adapters.md) · [memory protocol](docs/memory-protocol.md) · [identity](docs/identity-layer.md) · [hygiene](docs/memory-hygiene.md) · [event ledger](docs/event-ledger.md) · [fleet](docs/fleet.md) · [service & hooks](docs/service.md) · [OKF interop](docs/interop.md) · [JSON contract](docs/json-contract.md) · [voice companion](docs/voice-companion.md) · [dashboard spec](docs/ui-spec.md) · [machine specs](docs/spec/)

Release thread (1.1.2): [x.com/ALEKSANDRGrb/status/2089451388224803211](https://x.com/ALEKSANDRGrb/status/2089451388224803211).

## Tests

```sh
node --test tools/*.test.mjs
```

## License

MIT © 2026 Aleksandr Grebeshok

# samemind

samemind is a git-native markdown memory bundle for AI coding agents — identity, search, a work ledger, and a kanban board in one place, portable across engines like Claude Code, Cursor, and OpenClaw. No daemon or database required; BM25 search always works offline, semantic search is optional.

**Latest: v1.0.1** — a patch, no JSON form changed. `--root <dir>` now actually selects which bundle `board` and `handoff` read (it used to be ignored, so `board --root ./other-bundle` printed the wrong bundle's board under the right bundle's name), `--project <id>` still filters within it, and the two combine. Also: a flag missing its value fails instead of falling back to `OKF_ROOT`, `samemind --version` prints a version instead of the help banner, and an unknown flag on these two commands is now an error. See [CHANGELOG.md](https://github.com/alexgrebeshok-coder/samemind/blob/main/CHANGELOG.md) and [docs/json-contract.md](https://github.com/alexgrebeshok-coder/samemind/blob/main/docs/json-contract.md).

[![ci](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml/badge.svg)](https://github.com/alexgrebeshok-coder/samemind/actions/workflows/ci.yml)

**One memory bundle. Switch engines. Same mind.**

Git-native markdown bundle (no daemon or DB required): identity, search, handoff, an append-only work ledger, and a kanban board in one place. Wire-compatible with [Google OKF v0.1](docs/interop.md). Optional embeddings; **BM25 always works offline**.

## Why not “just markdown + BM25”?

| | Typical git-markdown memory | samemind |
|---|---|---|
| Wire format | ad hoc | [OKF v0.1](docs/interop.md) export/import |
| Identity | flat notes | `Identity` / `User` / `EngineRule` → budgeted `brief` |
| Work | separate tools | [event ledger](docs/event-ledger.md) + board in the same bundle |
| Multi-engine ops | assumed, never checked | [fleet registry](docs/fleet.md) + heartbeat: who reports, who went quiet |
| Engines | often one client | `samemind install` → 12 engines ([adapters](docs/adapters.md)) |
| Capture | — | `samemind capture` (read-only session → inbox) |
| Freshness | manual copy-paste into context | opt-in daemon + [lifecycle hooks](docs/service.md), honest per-engine tier |
| Face | raw files | `samemind ui` — local dashboard: board, graph, fleet, live feed |

## First 5 minutes

**Requires Node.js ≥ 20** (`package.json` → `engines.node`).

### 1. Wire the current project

```sh
npx samemind setup
```

Detects the agent, scaffolds a bundle if needed, wires the memory protocol into its instruction file, registers MCP, probes local embeddings (or stays on honest BM25). Interactive by default; `--yes` / `--dry-run` / `--target <dir>` available.

**You should see something like** (dry-run shape; live run drops the `[dry-run]` prefix):

```text
Detected engine(s): claude-code
OKF bundle already present — left as is.
[dry-run] would install samemind brief into Claude Code's instruction file(s)

=== samemind setup — summary ===
Engine(s): claude-code
Bundle:    /path/to/your/project
MCP:       Claude Code: would add samemind to .mcp.json
Semantic:  on   # or BM25-only if no local embeddings endpoint
```

### 2. Try search, board, brief (demo bundle)

```sh
npx samemind init --demo          # fresh empty dir only
cd <that-dir>
npx samemind recall "context budget" -k 3
npx samemind board
npx samemind brief --engine claude-code
```

**`recall` — expect ranked hits** (BM25 if no embeddings; demo ids are stable):

```text
⚠ semantic off, BM25 fallback — set OKF_EMBED_URL for semantic search
# "context budget" → top-3 [bm25, score=bm25]
6.161  Concept    concepts/context-budget — Context budget
4.284  Concept    concepts/retrieval-strategy — Retrieval strategy
1.630  User       entities/alex-doe — Alex Doe
```

**`board` — expect a kanban** with demo tasks (In progress / Blocked / Done / Plans).

**`brief` — expect an identity block** between `<!-- samemind:brief:start -->` markers (demo agent “Nova”).

Agent self-install protocol: [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md).

### 3. Continuity across engines (why the product exists)

Same bundle root = same mind. Engine A writes a note; engine B (or a fresh shell) finds it.

```sh
# --- session A (any engine, or just the shell) ---
mkdir -p inbox
cat > inbox/note-ship-honest-docs.md <<'EOF'
---
type: Concept
title: Ship honest docs before 0.15
description: Decision from engine A
visibility: internal
tags: [docs]
timestamp: 2026-08-01T12:00:00Z
---

# Ship honest docs before 0.15

Recorded in session A so session B does not re-discover it.
EOF

# --- session B (different engine, same directory) ---
npx samemind recall "honest docs" --include-inbox -k 3
npx samemind handoff
```

**`recall --include-inbox` — expect the note near the top:**

```text
# "honest docs" → top-3 [bm25, score=bm25]
7.997  Concept    inbox/note-ship-honest-docs — Ship honest docs before 0.15
…
```

(`recall` skips `inbox/` unless you pass `--include-inbox` — by design: curated
canon is the default search surface; inbox is raw until you promote it.)

**`handoff` — same work state on every engine** that shares the bundle (typed
Plan/Task/Decision/Session in the bundle; not raw inbox notes):

```text
# Handoff — work state
## Active
- **in-progress** Ship Lumen backlink editor — /projects/task-lumen-backlinks.md
…
## Last session
**Lumen sync kickoff (2026-07-09)** (claude-code, …) — /concepts/session-2026-07-09-lumen-sync.md
```

Via MCP the same write path is `memory_write_inbox`; via hooks (Claude Code /
Codex / opencode only) SessionStart already runs `handoff` for you after
`samemind hooks install --agent <id>`.

## Dashboard

```sh
npx samemind ui          # → http://127.0.0.1:7787 (your bundle; --root <dir>, --open)
```

Loopback-only (127.0.0.1, exact-match Host guard via `tools/lib/http-guard.mjs`). The **memory
bundle** is not mutated from the UI: no inbox writes, no ledger append, no fleet dispatch — those
stay CLI/MCP commands the UI may show and copy but never run. **Two write routes**, both behind the
same origin/host/content-type guard: `POST /api/config` toggles `voice` / `vision` in
`.samemind/config.json` (idempotent, reversible), and `POST /api/nudge/respond` records your answer
to a nudge — the one place the UI writes work state, and only ever the answer you clicked.
Everything else non-GET is 405.

Seven screens (`ui/src/screens/`): **Today** — in-flight/stuck work, recovery commands, and the
nudge card (what it would raise now and why, or which of the ten reasons it is quiet for);
**Overview** — kanban with honest totals, synthesized from ledger topics when no Task docs exist
(real Task docs always win); **Memory** — concept browser, BM25 search, interactive graph;
**Fleet** — engine heartbeat bars, naryad timeline, live SSE feed (`/api/events/stream`);
**Projects** — cards with status, description, linked concepts; **Voice** — companion state and
intent gate (no built-in microphone capture in core); **Settings** — effective `voice`/`vision`
values with per-field **layer** (default / global / project). Light + dark.

Capability config lives in **`.samemind/config.json`** (project) merged over **`~/.samemind/config.json`**
(global), same file as `projection` / embed settings. Voice keeps **three separate consents** —
microphone (`enabled`) ≠ storing transcripts (`storeTranscripts`) ≠ sending recognized text to an
LLM (`sendTextToLlm`). The dashboard shows each effective value and which tier won it.

**Voice companion:** samemind does **not** ship speech recognition; it talks to any OpenAI-compatible
HTTP endpoint you set in `voice.serviceUrl` (same pattern as embeddings). See
[docs/voice-companion.md](docs/voice-companion.md).

The same board/handoff/fleet data is scriptable: `board`, `handoff`, `status`, `doctor`, `fleet status`,
`ledger status`, `query links`, and `proactive` support `--json` (`{ contract: 1, kind, … }` where
documented in [docs/json-contract.md](docs/json-contract.md)); the dashboard `/api/*` mirrors those
shapes (HTTP adds `generatedAt` on some routes the CLI omits — also in the contract doc).

**Global personal bundle** (project + global recall, project wins on id collision):

```sh
npx samemind setup --global
```

Details: [docs/full-guide.md § Global mode](docs/full-guide.md#global-mode) (archived long homepage).

## Keeping memory fresh

Nothing runs in the background by default — `recall`/`brief`/`board` run on demand. Three opt-in
ways to keep an engine's own instruction file current automatically, in order of how much moves
outside your terminal:

```sh
npx samemind project --engine claude-code      # one-shot: write curated facts into the engine's file now
npx samemind service install                   # OS-scheduled: re-run `project` on an interval (LaunchAgent/systemd/Task Scheduler)
npx samemind service install --daemon          # supervised: `samemind serviced` re-projects on every bundle change + periodic backstop
npx samemind hooks install --agent claude-code # real SessionStart/SessionEnd hooks — no polling at all
```

Honest per-engine tier (`samemind hooks list`): **auto** (Claude Code, Codex, opencode — real
lifecycle hooks, verified) vs **projection** (every other engine — kept current by a file write,
not a live hook). `samemind status` reads the heartbeat any real run leaves behind: `✅ ok` /
`⚠️ stale` / `❌ failed` / `❓ unknown` (`status --json` for the machine shape). `samemind serve --http [--port N]` exposes the same MCP
tools over local HTTP (127.0.0.1 only) instead of stdio. Details: [docs/service.md](docs/service.md).

## Why agents have no memory (`samemind doctor`)

A line in an engine’s MCP config is **not** a working connection. Until 0.15 the server could answer
`tools/list` with all ten tools while serving the **package directory** and holding **zero facts** —
nothing reported the problem. `samemind doctor` is the inspect-first answer.

Five states, checked in order; each failure short-circuits later steps to `skipped`:

`supported` → `installed` → `connected` → `verified` → `active`

- **`connected`** only means an entry exists in the engine config — it does **not** imply **`verified`**.
- **`verified`** spawns the configured server and runs a real JSON-RPC round-trip (`initialize`,
  `tools/list`, `memory_health`), then compares the **corpus** (fact count / root sanity), not just
  whether tools are listed.
- **`active`** is projection liveness from `.samemind/health.json` (same family as `samemind status`).

Safe by default: reads configs and probes; it never writes unless you pass **`--repair`**, and repair
has exactly **one** safe auto-fix — inject a missing `OKF_ROOT` when the target bundle is unambiguous
(everything else stays advisory). Human report or **`doctor --json`** (`contract: 1`, env values redacted).
Details and finding ids: [`docs/spec/`](docs/spec/) (doctor contract).

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
| `ui` | Local dashboard: memory read-only; settings via `POST /api/config` only |
| `project` | Project curated facts into an engine's own instruction file |
| `service` / `serviced` | Install an OS unit that keeps `project` running — periodic or event-daemon |
| `status` | Health check: is memory projection alive (`--json`) |
| `doctor` | Connection health: config vs live MCP + corpus (`--json`, `--repair`, `--no-probe`) |
| `hooks` | Per-engine lifecycle wiring — real hooks where an engine has them, file projection otherwise |
| `serve` | MCP: `memory_search`, `memory_get`, `memory_write_inbox`, … (stdio default, `--http` for local HTTP) |
| `proactive` | Active Memory prototype: auto top-k recall pack before an answer (`-k`, `--json`, `--force`) |
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
| Auto-sync: `project`/`service`/`serviced`/`hooks`/`status`/`doctor` | [docs/service.md](docs/service.md) |
| Compaction / handoff | [docs/compaction-recipe.md](docs/compaction-recipe.md) |
| OKF interop | [docs/interop.md](docs/interop.md) |
| JSON contract (`--json`, `/api/*`, 1.0 freeze) | [docs/json-contract.md](docs/json-contract.md) |
| Voice companion (external ASR, `serviceUrl`) | [docs/voice-companion.md](docs/voice-companion.md) |
| Dashboard build contract | [docs/ui-spec.md](docs/ui-spec.md) |
| Machine-readable specs (`doctor`, voice, …) | [docs/spec/](docs/spec/) |
| Benchmark notes | [docs/benchmark.md](docs/benchmark.md) |

## Limits (honest)

- Canon promotion is **human-gated** (inbox → concepts); not auto-mem that rewrites truth silently.
- Semantic search needs a local/OpenAI-compatible embeddings endpoint (`OKF_EMBED_URL`); without it, BM25 only — by design.
- Hand-curated scale (roughly 10²–10³ concepts), not a 24/7 life-ingestion daemon — see vs [gbrain](docs/full-guide.md#samemind-vs-gbrain-garry-tan--when-to-use-which).

## Version policy (JSON contract)

Heading toward **1.0**, the CLI `--json` and HTTP `/api/*` shapes in
[docs/json-contract.md](docs/json-contract.md) are the human-readable contract record; after 1.0,
breaking changes there require a **major** package version.

- **Breaking (major):** remove or rename a documented field; change a field’s JSON type; change a
  field’s meaning while keeping the name; drop or repurpose a `kind`; move payloads in/out of the
  `{ contract, kind, generatedAt, data }` envelope without coordination.
- **Non-breaking (minor/patch):** add an optional field; add a new `kind` or route/command; add
  `*Total` / overflow fields beside truncated arrays; add `generatedAt` where it was missing.
- **MCP tools** (`memory_search`, `memory_handoff`, …) are a **separate surface** — pretty-printed JSON
  inside MCP `content[].text`, not the CLI/HTTP envelope — with their own compatibility rules (see
  §7 of the contract doc). Do not assume one schema fits both.

## FAQ

### Does samemind need a database or background daemon?
No, to use it: it's git-native markdown, BM25 search always works offline, and semantic search is optional (needs a local/OpenAI-compatible embeddings endpoint, `OKF_EMBED_URL`). An event-driven daemon (`samemind serviced`) is available opt-in to keep engine files projected automatically — see [Keeping memory fresh](#keeping-memory-fresh).

### Which AI engines does it work with?
`samemind install` wires the memory protocol into 12 engines (see [docs/adapters.md](docs/adapters.md)), and it exposes an MCP server (`npx samemind serve`) for engines like Claude Code. Three of those 12 also get real lifecycle hooks (`claude-code`, `codex`, `opencode`); the rest stay on file projection — see Freshness tier in the matrix.

### What's new in v0.18.0?

Memory that speaks first — **without a camera**. `samemind nudge` raises one thing worth raising:
an unclosed failure nobody came back to, a blocker that stopped moving, a plan that named itself
next. Relevance comes entirely from the board and the ledger, which is why no camera is involved —
a camera would supply the moment, never the reason. A card on the dashboard shows what it would say
and why, with *Понял / Не сейчас / Не надо / Хватит на сегодня*; when it is quiet it says which of
the ten reasons applies. Gates run in order — allowed hours, do-not-disturb, "enough for today",
cooldown after "not now", daily cap — and exactly one nudge is ever delivered.
**Off by default**: `vision.enabled` is `false`, no camera and no microphone are used at all.

**v0.17** was the groundwork for freezing the contract at 1.0. The JSON shape is now **written down**
([docs/json-contract.md](docs/json-contract.md)) and **locked with shape tests** — before this,
renaming a field left the suite green. Payloads stopped carrying absolute paths and full document
bodies (`board` on a real bundle: 160,833 → 23,123 bytes), truncated arrays now state their totals,
and each payload returns one key set with explicit `null` instead of three shapes by branch.
**`samemind dogfood`** answers "how long has it run clean?" — and says *nothing to measure* rather
than *0 failures* when there is no history.

**v0.16** grew the dashboard into a switchboard: **Settings** (with `POST /api/config` as the sole
write route), **Today** and **Voice** screens, `voice`/`vision` in `.samemind/config.json` with layer
provenance and honest companion availability, plus `/api/status` and `/api/doctor` on the wire.
**v0.15** added **`samemind doctor`** — five connection states where `connected` ≠ `verified`, corpus
checks beyond `tools/list`, and `--repair` for a missing `OKF_ROOT`. Earlier 0.14 work (`serviced`,
`serve --http`, lifecycle hooks) is still there — see the changelog. Full history:
[CHANGELOG.md](https://github.com/alexgrebeshok-coder/samemind/blob/main/CHANGELOG.md).

## Tests

```sh
node --test tools/*.test.mjs
```

## License

MIT © 2026 Aleksandr Grebeshok

# Adapters — engine compatibility matrix

Every row below is a real, checked way to get a samemind bundle in front of an agent
engine: either MCP (the engine calls `memory_search`/`memory_get`/… as tools), an
instruction file (`samemind install --agent <id>` writes the brief + protocol
straight into it), or both. Source research: N11/N12 (`gbrain#11`, `gbrain#12`),
snapshot 10.07.2026 — see `~/.claude/research/agent-engines-20260710.md` for the
full writeup (popularity numbers, sources) behind this table.

**Zero-level fallback, true for every row:** the bundle is plain markdown on disk.
Any agent with a shell and `cat`/`grep`/`find` can read it with no adapter at all —
MCP and instruction files are conveniences on top of a format that already works
with anything that has a filesystem.

## Matrix

| Engine | Instruction file(s) — `samemind install --agent <id>` | Connect MCP (`samemind serve`) | Built-in memory |
|---|---|---|---|
| **Claude Code** — `claude-code` | `CLAUDE.md` | `claude mcp add samemind -- npx samemind serve` | Own `CLAUDE.md` (manual) + auto-memory notes; samemind sits underneath as the git-native, portable layer. |
| **Cursor** — `cursor` | `AGENTS.md` + `.cursor/rules/samemind.md` | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user):<br>`{"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` | Closed "Cursor Memories" (auto session notes) — not a user-owned file, doesn't travel with you to another engine. |
| **GitHub Copilot** (agent mode) — `copilot` | `.github/copilot-instructions.md` + `AGENTS.md` | VS Code `.vscode/mcp.json`:<br>`{"servers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` (cloud coding agent: same JSON shape in the repo's Copilot settings on github.com) | None outside instruction files. |
| **Codex CLI** (OpenAI) — `codex` | `AGENTS.md` | `codex mcp add samemind -- npx samemind serve` (writes `~/.codex/config.toml` under `[mcp_servers.samemind]`) | None — `AGENTS.md` + session only. |
| **Gemini CLI** (Google) — `gemini-cli` | `GEMINI.md` | `~/.gemini/settings.json` or `.gemini/settings.json`:<br>`{"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` | None — `GEMINI.md` context-file hierarchy only. |
| **opencode** (sst) — `opencode` | `AGENTS.md` | `opencode.json`:<br>`{"mcp": {"samemind": {"type": "local", "command": ["npx", "samemind", "serve"], "enabled": true}}}` | None. |
| **Cline** — `cline` | `.clinerules` | `~/.cline/mcp.json` (or `cline_mcp_settings.json`):<br>`{"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` | None — resets every session. |
| **Roo Code** — `roo` | `.roo/rules/samemind.md` | `.roo/mcp.json` (project) or global `mcp_settings.json`:<br>`{"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` | None — resets every session. |
| **Windsurf** (Cognition) — `windsurf` | `.windsurf/rules/samemind.md` + `AGENTS.md` | `~/.codeium/windsurf/mcp_config.json`:<br>`{"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}` | Auto-generated `memories/` snapshots (`~/.codeium/windsurf/memories/`) — own format, not portable. |
| **Goose** (Block) — `goose` | `.goosehints` | `goose configure` → Add Extension → Command-Line Extension → command `npx`, args `samemind serve`; or `~/.config/goose/config.yaml`:<br>`extensions: [{name: samemind, type: stdio, cmd: "npx", args: ["samemind", "serve"]}]` | None built in — MCP-native architecture is the whole point of Goose extensions. |
| **Kiro** (AWS) — `kiro` | `.kiro/steering/samemind.md` | `kiro-cli mcp add --name samemind --command npx --args "samemind serve"` (writes `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`) | None — steering files only. |
| **Antigravity** (Google) — `antigravity` | `AGENTS.md` + `GEMINI.md` | IDE settings / `mcp_config.json` (community convention) for local stdio; `tools: [{"type": "mcp_server", ...}]` in a Gemini API call for remote MCP | None built in — community "Memory Bank MCP" pattern is the closest analog, same idea as samemind. |
| **Aider** — *no `install` target* | — (see below) | Unofficial/community only, needs Aider ≥0.69: `~/.aider.conf.yml` → `mcp-servers: {"mcpServers": {"samemind": {"command": "npx", "args": ["samemind", "serve"]}}}`, or `--mcp-servers-file mcp.json`. Not in official `aider.chat/docs`. | None — `CONVENTIONS.md` is read-only and **not auto-loaded**: pass it explicitly with `--read CONVENTIONS.md` or a `read:` line in `.aider.conf.yml`. |

### Aider — through files directly, no adapter needed

Aider is the one engine in the top-13 without a documented, official MCP path, and
it has no auto-loaded instruction file — so `samemind install --agent aider`
doesn't exist. It still works, just more manually:

```sh
aider --read docs/snippets/AGENTS.md   # or your own CLAUDE.md/AGENTS.md-shaped file
# or in ~/.aider.conf.yml:
read:
  - docs/snippets/AGENTS.md
```

Aider will treat the file as read-only context every session — same protocol,
pasted rather than auto-wired. If you want MCP anyway, the community config above
is functional but unsupported upstream; treat it as experimental.

## OpenClaw / Hermes — bootstrap, not install

OpenClaw and Hermes Agent aren't coding-agent engines samemind adapts *into* — they
already run an almost identical architecture natively: a `MEMORY.md` (+ per-topic
`memory/**/*.md` for OpenClaw, `USER.md` for Hermes) living directly in the agent's
own workspace, read as plain markdown, no daemon required. That's the strongest
external validation samemind's approach exists: two of the most-starred agent
projects in the ecosystem (382K★ / 213K★) independently converged on the same
shape, and Hermes users have an open feature request (issue #10835) asking to
expose exactly that memory over MCP so it can be shared with Claude Code/Cursor —
literally samemind's value proposition, requested by someone else's users.

There's no `samemind install --agent openclaw` because there's nothing to inject —
instead, point their existing memory file at the bundle so the two don't drift:

```markdown
<!-- in OpenClaw's MEMORY.md / Hermes' USER.md -->
## External memory: samemind

Canonical memory lives in the samemind bundle at `<path-to-bundle>` (git-native
OKF markdown — see its README). Before answering from memory, prefer:

    samemind recall "<query>" -k 5      # or MCP memory_search, if connected
    samemind query get <id>             # or MCP memory_get

New durable facts/decisions → `samemind` `inbox/` (MCP `memory_write_inbox`), not
back into this file, so both surfaces read from one source of truth instead of
silently forking.
```

Wiring MCP for either follows the same shape as everything else in the matrix
above — `openclaw mcp serve`/`hermes mcp add` are how *they* expose tools, not how
you'd reach *them*; to point OpenClaw or Hermes at a samemind MCP server, add it
the same way you would for any other MCP client on that engine (see each
project's own `mcp add`/config-file docs — the JSON/TOML shape is the same
`{"command": "npx", "args": ["samemind", "serve"]}` pattern throughout this file).

## See also

- [README → MCP](../README.md#mcp) — what `samemind serve` exposes (tool list, security perimeter).
- [README → Compatibility](../README.md#compatibility) — short version of this page.
- [`INSTALL_FOR_AGENTS.md`](../INSTALL_FOR_AGENTS.md) — self-install protocol for an agent to run against its own project.
- [docs/identity-layer.md](identity-layer.md) — what `samemind install` actually embeds (Identity/User/EngineRule → `samemind brief`).
- [docs/memory-protocol.md](memory-protocol.md) — the recall→read→cite→gaps protocol embedded in every instruction file.
- [docs/session-capture.md](session-capture.md) — the other direction: pulling an engine's own *live* session store (JSONL transcripts, markdown diaries) into the bundle read-only, via `samemind capture --engine <id>`.

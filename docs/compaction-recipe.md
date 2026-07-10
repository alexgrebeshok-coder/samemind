# Compaction recipe — keep work state across `/compact` and engine switches

> Pain #3: after `/compact` (or a new engine session) the agent forgets what is
> in progress, what was decided, and what is blocked. Fix: dump decisions into
> the inbox **before** compact, then load a **handoff** brief at session start.

This is about **work state**, not personality. For identity/owner/engine role
use `samemind brief` / the identity layer. For "what is going on right now" use
`samemind handoff` / MCP `memory_handoff`.

## The loop

```
┌─ session ─────────────────────────────────────────────┐
│  1. START  → memory_handoff (or samemind handoff)     │
│  2. work   → decisions? → memory_write_inbox NOW      │
│  3. END or PRE-COMPACT                                │
│       → write Session / Decision / Task updates        │
│       → (optional) SessionEnd hook stub                │
└───────────────────────────────────────────────────────┘
         ↓ /compact or new engine
┌─ next session ────────────────────────────────────────┐
│  START again → memory_handoff  (no re-explaining)     │
└───────────────────────────────────────────────────────┘
```

### Before `/compact` (or end of session)

1. **Flush decisions** — any plan/position agreed this session → MCP
   `memory_write_inbox` (or a full `Decision` / `Plan` / `Session` stub in
   `inbox/`). "I'll write it later" = lost to compact.
2. **Update tasks in place** — status changes, especially `blocked` +
   `blocked_reason`.
3. **Session summary** — `## Done` / `## Decided` / `## Next` (see
   [`docs/work-discipline.md`](work-discipline.md) and the
   [SessionEnd hook example](hooks/claude-code-session-end.md)).

### At the start of the next session

```sh
# CLI
OKF_ROOT=~/samemind npx samemind handoff
# optional focus
OKF_ROOT=~/samemind npx samemind handoff --project lumen --days 14
```

Or via MCP: call `memory_handoff` with `{ "project"?: "…", "days"?: 14 }`.

Paste or inject the markdown into context. Target size ≤ ~2000 tokens.

## Claude Code hooks (example only)

Hook event names and payload shape depend on your Claude Code version — treat
this as a template, verify against current docs before relying on it.

### PreCompact — remind the agent (or dump a note)

One-liner that appends a pre-compact reminder into the inbox (does **not**
delete anything; append-only):

```sh
OKF_ROOT="${OKF_ROOT:-$HOME/samemind}" sh -c 'mkdir -p "$OKF_ROOT/inbox"; printf "\n## %s — pre-compact\n\nFlush Decision/Session/Task to inbox before compact. Next session: memory_handoff.\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OKF_ROOT/inbox/mcp.md"'
```

### SessionStart — print handoff to stderr (agent can re-run as tool)

```sh
OKF_ROOT="${OKF_ROOT:-$HOME/samemind}" npx samemind handoff
```

### settings.json block

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "OKF_ROOT=$HOME/samemind sh -c 'mkdir -p \"$OKF_ROOT/inbox\"; printf \"\\n## %s — pre-compact\\n\\nFlush Decision/Session/Task to inbox before compact. Next session: memory_handoff.\\n\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" >> \"$OKF_ROOT/inbox/mcp.md\"'"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "OKF_ROOT=$HOME/samemind npx samemind handoff"
          }
        ]
      }
    ]
  }
}
```

## Snippet rule (all engines)

On session start, run `memory_handoff` (MCP) or `samemind handoff` (CLI). See
[`docs/snippets/`](snippets/) — each paste-ready block includes that line.

## What handoff contains

| Section | Source |
|---------|--------|
| **Active** | `Task` with `status: in-progress` or `blocked` (+ reason) |
| **Last decisions** | `Decision` nodes within `--days` (default 14), newest first |
| **Plans in force** | `Plan` with `status: agreed` or `in-progress` (`superseded` skipped) |
| **Last session** | Freshest `Session` — Done / Decided / Next (short) |
| **Open questions** | Blocked tasks + `## Next` bullets from last session |

Full type rules: [`docs/work-discipline.md`](work-discipline.md).
Security: secret-visibility concepts are never loaded into the handoff.

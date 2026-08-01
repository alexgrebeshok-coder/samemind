# Hook example — auto-write a Session stub on session end

> **Wired since v0.14.** `samemind hooks install --agent claude-code` merges real
> `SessionStart` / `SessionEnd` entries into the project's `.claude/settings.json`
> (see `tools/lib/hooks.mjs` and `tools/lib/hook-templates/`).
>
> What the **package** installs by default:
>
> - **SessionStart** → runs `npx samemind handoff` (work-state brief into the session).
> - **SessionEnd** → appends a short timestamped stub to `inbox/claude-code.md`
>   (template: `tools/lib/hook-templates/session-end.json`).
>
> This page is a **richer manual alternative**: a full `Session` frontmatter stub
> (Done / Decided / Next) as its own file under `inbox/`. Use it if you want a
> proper Session document instead of the one-line package stub — copy the script
> below and point the `SessionEnd` command at it (or keep both hooks; samemind
> only replaces its own previous entries on reinstall).

The write-discipline rule ("session ended → write a `Session` summary") is easy to
forget. A Claude Code **SessionEnd** hook can drop a fresh `Session` stub into the
bundle's `inbox/` for you every time a session closes, so the closing artifact
always exists — you just fill it in (or let the agent fill it next session).

## 1. The hook script

Save as `~/.samemind/hooks/session-end-stub.sh` and `chmod +x` it. It ignores the
JSON Claude Code sends on stdin and just appends a timestamped stub.

```sh
#!/usr/bin/env sh
# Appends a fresh Session stub to the samemind inbox when a Claude Code session ends.
# Point OKF_ROOT at your bundle (or export it in your shell before launching Claude Code).
set -eu
ROOT="${OKF_ROOT:-$HOME/samemind}"
INBOX="$ROOT/inbox"
mkdir -p "$INBOX"
STAMP="$(date +%Y%m%d-%H%M%S)"
DATE="$(date +%Y-%m-%d)"
OUT="$INBOX/session-stub-$STAMP.md"
cat > "$OUT" <<EOF
---
type: Session
title: <session summary>
description: <one line>
visibility: internal
engine: claude-code
date: $DATE
tags: [session]
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
source:
relations:
  decided: []
  next: []
---

# <session summary>

One line: the span of work this session covered.

## Done

-

## Decided

-

## Next

-
EOF
echo "samemind: Session stub written to $OUT" >&2
```

One-liner equivalent (no script file), if you prefer to inline it in settings:

```sh
OKF_ROOT="$HOME/samemind" sh -c 'f="inbox/session-stub-$(date +%Y%m%d-%H%M%S).md"; printf -- "---\ntype: Session\nengine: claude-code\ndate: %s\n---\n\n## Done\n\n## Decided\n\n## Next\n" "$(date +%F)" > "$OKF_ROOT/$f"'
```

## 2. The settings.json block

**Preferred (package-managed):** from the bundle root,

```sh
npx samemind hooks install --agent claude-code
# → merges SessionStart + SessionEnd into ./.claude/settings.json
#    (preserves foreign hooks; re-run is idempotent)
```

**Manual richer stub** (this page's script): add or replace the SessionEnd command
in Claude Code settings (`~/.claude/settings.json` or project `.claude/settings.json`).
The `SessionEnd` event fires once when a session ends; the command runs with
`OKF_ROOT` exported so the script writes to your bundle.

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "OKF_ROOT=$HOME/samemind ~/.samemind/hooks/session-end-stub.sh"
          }
        ]
      }
    ]
  }
}
```

## Notes and caveats

- **Package default vs this example.** The package SessionEnd is a short append to
  `inbox/claude-code.md`. This page's script writes a full `Session` markdown file.
  Both land in `inbox/` only — never in `concepts/` or `projects/`.
- **Stub, not a summary.** Either path writes an *empty* scaffold (date + engine).
  Filling `## Done` / `## Decided` / `## Next` (and the `relations.decided` /
  `relations.next` edges) is the agent's job next session — that's the part that
  needs judgment, which is exactly why it stays manual.
- **Hook shape is Claude Code's.** Event names, payload shape, and matcher
  semantics follow Claude Code's hooks docs for your version; verify before
  relying on a hand-edited block. `samemind hooks install` keeps the shape in
  lockstep with the templates shipped in the package.
- **Inbox only.** Promoting a finished session into `concepts/` is a curation step
  (`tools/consolidate.mjs`), consistent with the memory protocol.
- **`OKF_ROOT`.** Point it at whatever bundle you want the stubs to land in. The
  package templates set `OKF_ROOT` to the install target root; the manual script
  defaults to `$HOME/samemind` if unset.

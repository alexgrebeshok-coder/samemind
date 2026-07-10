# Hook example — auto-write a Session stub on session end

> This is **documentation only**. Nothing here is wired into the package or the
> scaffold. Copy it into your own Claude Code settings if you want it.

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

Add this to your Claude Code settings (`~/.claude/settings.json` or a project
`.claude/settings.json`). The `SessionEnd` event fires once when a session ends;
the command runs with `OKF_ROOT` exported so the script writes to your bundle.

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

- **Example only.** Hook event names, payload shape, and matcher semantics are
  specific to your Claude Code version — verify them against your version's
  hooks documentation before relying on this. Treat the JSON above as a template.
- **Stub, not a summary.** The hook writes an *empty* `Session` with the date and
  engine filled in. Filling `## Done` / `## Decided` / `## Next` (and the
  `relations.decided` / `relations.next` edges) is the agent's job next session —
  that's the part that needs judgment, which is exactly why it stays manual.
- **Inbox only.** The stub lands in `inbox/`, never in `concepts/` or `projects/`.
  Promoting a finished session into `concepts/` is a curation step
  (`tools/consolidate.mjs`), consistent with the memory protocol.
- **`OKF_ROOT`.** Point it at whatever bundle you want the stubs to land in. If
  unset, the script defaults to `$HOME/samemind`.

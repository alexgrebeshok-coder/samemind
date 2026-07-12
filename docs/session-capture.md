# Session capture — pulling a live engine's own history into the bundle

Every coding-agent engine keeps *some* history of its own — Claude Code's JSONL
transcripts, a chat-log export, a directory of markdown diaries (OpenClaw's
`memory/*.md`). None of that reaches the samemind bundle by default: it sits
in the engine's private store, invisible to every other engine sharing the
bundle. `samemind capture` is the read-only bridge — no bespoke sync script
per engine, one small adapter registry instead (closes
[alexgrebeshok-coder/samemind#1](https://github.com/alexgrebeshok-coder/samemind/issues/1)).

Related code: `tools/capture.mjs`. CLI:

```sh
npx samemind capture --engine <id> [--source <path>] [--since <ts>] [--dry-run]
```

## What it does

1. **Locate** — an adapter finds the engine's native session files (a
   directory walk; read-only, never touches the source).
2. **Extract** — the adapter distills each file into a short note: for
   Claude Code, the session's *final* assistant text plus light meta
   (session id, project/cwd, message count); for a markdown diary, a
   pointer note (title + first lines + path).
3. **Mask** — obvious secret shapes (`npm_…`, `sk-…`, `ghp_…`, `AKIA…`) are
   replaced with `•••masked•••` before anything is written. We are reading
   *live* transcripts — they sometimes contain pasted tokens.
4. **Quarantine** — the distilled text is run through the same
   prompt-injection heuristic `memory_write_inbox` uses
   (`tools/lib/injection.mjs`). Flagged content is never dropped, only
   wrapped in a fenced ` ```quarantine ` block with `quarantine: true`.
5. **Append** — new notes (not already captured) are appended to
   `inbox/<engine>.md`, atomically, in the same append-only shape every
   other inbox writer in this package uses.
6. **Record** — captured keys (session ids for `claude-code`, absolute
   paths for `generic-markdown`) are written to
   `.samemind-capture-state.json` in the bundle root, so a re-run only
   picks up what's actually new.

Nothing is promoted into the canon automatically — same rule as `import`:
`inbox/<engine>.md` is a curation queue, not the canon. A human or a curating
agent moves anything worth keeping into `concepts/`/`entities`/`projects/`.

## Adapters (MVP: 2)

| Engine id | Default source | What one captured item is |
|---|---|---|
| `claude-code` | `~/.claude/projects/**/*.jsonl` (override with `--source`) | One session: final assistant text block (truncated to ~1500 chars), `session id`, `project` (the transcript's `cwd`, falling back to the containing directory name), `messages` (turn count). Sessions with no assistant text at all (queue-only, aborted) are skipped — nothing to distill. |
| `generic-markdown` | none — `--source <path>` is **required** | One new/changed `.md` file: title (first `# ` heading, or the filename), the first non-heading lines as a preview, and the file's path relative to `--source`. Covers any directory of markdown diaries, e.g. OpenClaw's `~/.openclaw/workspace/memory/topics/`. |

Adding a third engine is one more entry in the `ADAPTERS` registry in
`tools/capture.mjs`: `{ requiresSource, locate(source), extract(files, opts) }`.
`locate` returns file paths; `extract` returns
`{ key, date, heading, body }[]` — `key` is what idempotency dedupes on.

## Flags

- `--engine <id>` — required; one of the adapter ids above.
- `--source <path>` — override the default location. Required for
  `generic-markdown` (there is no sane universal default for "a directory of
  diaries"); optional for `claude-code` (mainly useful for testing against a
  fixture directory instead of the real `~/.claude/projects`).
- `--since <ts>` — an ISO-8601 (or anything `Date.parse` accepts) cutoff;
  items whose date is older are skipped. Applied **after** the idempotency
  filter — an item already captured never resurfaces just because `--since`
  widened, and widening `--since` on a later run does not re-capture
  something already recorded in the state file.
- `--dry-run` — runs locate/extract/mask/quarantine and reports what
  *would* be captured, but writes nothing: no `inbox/<engine>.md` change, no
  state-file change. A real run afterwards still captures everything the
  dry-run listed.

## Idempotency

`.samemind-capture-state.json` lives in the bundle root, next to `inbox/`:

```json
{
  "engines": {
    "claude-code": { "captured": ["<session-id>", "…"] },
    "generic-markdown": { "captured": ["/abs/path/to/note.md", "…"] }
  }
}
```

A key present here is never re-captured, regardless of `--since`. This is
the only state `capture` writes outside `inbox/` — everything else about the
run is read-only.

## Security notes

- **Read-only to the source.** `capture` never writes into
  `~/.claude/projects/`, a markdown diary directory, or any other engine
  store — only into `inbox/<engine>.md` and `.samemind-capture-state.json`
  inside the target bundle.
- **Secret masking is a heuristic, not a scanner.** The four patterns
  (`npm_`/`sk-`/`ghp_`/`AKIA` prefixes) catch the common accidental-paste
  shapes; they are not a substitute for real secret scanning. Curate before
  promoting anything out of `inbox/` into the canon.
- **Prompt-injection content is quarantined, not dropped** — identical
  contract to `memory_write_inbox` (see
  [README → MCP → Security](../README.md#security)). Live transcripts can
  contain adversarial or copy-pasted instruction-like text; it is still
  captured (memory is never silently lost) but fenced so nothing downstream
  executes it blindly.
- **Path safety**: `inbox/<engine>.md` and the state file are the only
  write targets, both under the bundle root, written through
  `lib/atomic-write.mjs` (temp file + rename).

## Example

```sh
npx samemind capture --engine claude-code --dry-run
# [dry-run] CAPTURE --engine claude-code
# new: 3
#   + <session-id> (2026-07-12T09:41:00.000Z)
#   + <session-id> (2026-07-12T08:15:00.000Z) [masked]
#   + <session-id> (2026-07-11T22:03:00.000Z)
# skipped (already captured / before --since): 40
# (dry-run — nothing written)

npx samemind capture --engine claude-code
# … same report, this time with `inbox file: inbox/claude-code.md`

npx samemind capture --engine generic-markdown --source ~/.openclaw/workspace/memory/topics --since 2026-07-01
```

## See also

- [docs/interop.md](interop.md) — `export`/`import` (foreign OKF-bundle
  interchange; a different problem — a *whole bundle*, not a live native
  session store).
- [docs/memory-protocol.md](memory-protocol.md) — the `memory_write_inbox`
  contract `capture` mirrors (append-only, quarantine, never promotes to
  canon).
- [README → MCP → Security](../README.md#security) — the injection-quarantine
  and path-safety guarantees shared across every write path in this package.

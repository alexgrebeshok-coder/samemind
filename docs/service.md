# Auto-sync: keeping engine memory current

Four commands make an engine's own instruction file track the bundle without a manual
`recall`/`brief` every time, plus one command to check whether it's actually working. None of
this is required — `recall`, `brief`, `board` etc. always work on demand with zero setup. This is
what to reach for when you want an engine's file to stay current between sessions on its own.

Honest summary: there is no engine that gets memory injected mid-conversation by magic. What
changes across the tiers below is *how often* an engine's own file gets rewritten, and — for the
three engines with a real hook API — whether recall/persist happens automatically at session
boundaries instead of needing a manual run.

## `samemind project` — the core, one-shot

```sh
samemind project --engine claude-code [--dry-run]   # one ad-hoc target
samemind project                                     # every projection.targets in .samemind/config.json
samemind project --engine <id> --file <path>         # generic target, engine outside the known table
```

Projects a curated block of FACTS (concepts/decisions/plans/sessions — never `Identity`/`User`/
`EngineRule`, that's `brief`/`install`'s job) into the target's own file, between
`<!-- samemind:project:start/end -->` markers that coexist with `install`'s identity block.
Facts are ranked by `--source canon` (freshness: `valid_from`/timestamp, newest first) or
`--source bundle` (hygiene score — supersedes/deprecated demoted), deduplicated by name, and
truncated to `--budget` tokens (default 1500) with the markers always preserved. An engine never
gets its own writes projected back at it (anti-echo via each target's `excludeSource`).

Every real run (not `--dry-run`) writes `.samemind/health.json` — success or failure — which is
what `samemind status` reads. Config lives under `projection` in `.samemind/config.json`:
`budgetTokens`, `factSource` (`canon`|`bundle`), `coreFresh`, `indexTail`, `intervalSec`,
`targets: [{engine, excludeSource}]`.

## `samemind service` — run it on a schedule

```sh
samemind service install   [--root <dir>] [--interval <sec>] [--label <id>] [--daemon] [--dry-run]
samemind service status    [--label <id>]
samemind service uninstall [--label <id>]
```

Registers a per-user OS unit — no admin, no sudo, no network, and only ever on an explicit
command (never a postinstall hook: npm v12 blocks install scripts, and silently registering a
scheduler on `npm i` would be hostile). Default mode runs `samemind project` every `--interval`
seconds (1800 by default):

| Platform | Unit |
|----------|------|
| macOS | `~/Library/LaunchAgents/<label>.plist`, `launchctl bootstrap gui/$UID` |
| Linux | `~/.config/systemd/user/<label>.{service,timer}`, `systemctl --user enable --now` |
| Windows | Per-user Scheduled Task from XML, `schtasks /create` |

Linux without a reachable user bus (headless/CI) doesn't fail silently — it writes the unit
files anyway and prints a ready-to-paste `nohup` polling loop as a fallback.

`--daemon` installs against `samemind serviced` instead (below) — a supervised long-lived
process (launchd `KeepAlive`, systemd `Restart=always`, Windows `RestartOnFailure`) rather than a
periodic poll.

## `samemind serviced` — event-driven daemon (long-lived)

```sh
samemind serviced [--root <dir>] [--interval <sec>]
```

Not meant to be run by hand — `service install --daemon` wires it under an OS supervisor that
owns restart-on-crash. Every cycle is one real `samemind project` call, so ranking, config,
injection, and the health heartbeat all stay in the one place `project` already implements.

What makes it reliable instead of a naive `fs.watch` wrapper:

- **Trigger** — one recursive `fs.watch` (Linux falls back to an mtime poll; recursive watch
  isn't supported there). Changes are debounce-coalesced so an editor's multi-write save is one run.
- **Stat-settle** — before running, changed files must hold size+mtime steady across a couple of
  short windows, so a file still being written is never read half-baked.
- **Backstop** — a full projection also runs on a jittered `--interval` period regardless of
  events, because `fs.watch` drops events under load; a watcher error forces an immediate full
  rescan too.
- **Overlap-guard** — runs are single-flight (in-process flag + a cross-process advisory file
  lock); a trigger during a run is remembered and coalesced into the next one, never parallelized.
- **Degrade, not hot-loop** — repeated failures back off exponentially; after 5 in a row the
  daemon stops auto-retrying, records the actionable error to `health.json`, and only tries again
  on the next real change or backstop pass. One clean run resets it.
- **Self-trigger-proof** — the daemon ignores the exact files it writes into (engine instruction
  files, `.samemind/*`), so its own projection never wakes itself up.
- **Cold-start digest** — after every successful run it also writes `.samemind/digest.md`, the
  full readable projection of the bundle, freshest-first. An engine that starts without an MCP
  connection reads this file; it's a snapshot, not authoritative — the live MCP is.
- Clean shutdown on SIGTERM/SIGINT: watcher and timers torn down, a final heartbeat flushed.

## `samemind hooks` — real lifecycle hooks, where they exist

```sh
samemind hooks list
samemind hooks install --agent <id> [--target <dir>] [--root <dir>]
```

`hooks list` shows every known engine's tier, honestly:

- **`auto`** — the engine has a real, verified lifecycle-hook API samemind wires in for real:
  `claude-code` and `codex` (SessionStart→recall, SessionEnd→persist, merged into their own
  settings JSON without touching foreign hooks) and `opencode` (best-effort, via its plugin
  system — no 1:1 SessionStart/SessionEnd there yet, see
  [sst/opencode#5409](https://github.com/sst/opencode/issues/5409)).
- **`projection`** — every other engine `samemind install` covers (cursor, gemini-cli, copilot,
  cline, roo, windsurf, goose, kiro, antigravity, …): no lifecycle-hook API is known to exist, so
  it stays on the file `project`/`service`/`serviced` write — never promised as a live hook.
- **`none`** — an engine id samemind doesn't know at all.

`hooks install` refuses (non-zero exit, explicit message) on anything but `auto` — no silent
no-op. Installing is idempotent: it replaces only samemind's own previous hook entries, keeping
every foreign hook and every other key in the target file untouched.

## `samemind status` — is projection alive

```sh
samemind status [--root <dir>] [--json]
```

Reads `.samemind/health.json` (written by every real `project`/`serviced` run) and reports:
`✅ ok`, `⚠️ stale` (the run stopped happening), `❌ failed` (last run errored — a fresh-but-failed
run is never shown as green), `❓ unknown` (never ran). Freshness window is 2× the configured
`intervalSec`, the same field `serviced`'s backstop reads — the two never drift apart.
`--json` → `{contract: 1, kind: 'status', data: {...}}`.

## `samemind serve --http` — the same MCP tools over local HTTP

```sh
samemind serve --http [--port N]
```

Streamable HTTP transport for the identical ten `memory_*` tools stdio `serve` exposes — same
handlers, no duplicated logic. Binds `127.0.0.1` only, with an exact-match `Host` header
allow-list (kills DNS-rebinding: a page on another domain that resolves to 127.0.0.1 gets 403
before any tool runs). `--port 0` (default) picks an ephemeral port; read it from the startup
log line. The default `serve` (no `--http`) is unchanged stdio.

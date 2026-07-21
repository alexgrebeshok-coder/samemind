# INSTALL_FOR_AGENTS.md — self-install protocol

You are an AI coding agent that has just been pointed at this file (a URL, a
pasted snippet, or a project that vendors it). Your job: install **samemind** —
a git-native markdown memory bundle — for yourself, in this project, with no
human doing the typing. Follow the steps **in order**. Each step has a
**Verify** line — run it and confirm the expected result before moving on. If a
step's Verify fails, stop and fix that step; do not continue on a broken base.

You need: Node.js ≥18 and a shell. No API keys, no npm dependencies to install
system-wide, no cloud account.

---

## Fast path: `npx samemind setup`

Try this first. It composes Steps 0–4 below into one command: detects your
engine (env var + instruction file), scaffolds a bundle if none exists here
yet, installs the identity+memory brief into your own instruction file,
registers samemind as an MCP server, and probes for a local embeddings
endpoint (honest BM25 fallback if none is running — never silently pretends
to be semantic).

```sh
npx samemind setup --yes --target .
```

**Verify:** the printed summary shows `Bundle:` pointing at a real path and
your engine listed under `Engine(s):`. If both hold, skip straight to Step 5
(fill in the identity layer) and Step 6 (confirm end-to-end) below.

Fall back to the manual protocol — Steps 0 through 4 — when `setup` can't
detect your engine, you need a target other than the project root, or you
want each step (which bundle, which engine, which MCP config) under your own
control rather than composed for you.

---

## Step 0 — Identify yourself

Figure out which engine you are running as. If you're not sure, look at what
loaded you: `CLAUDE.md` → Claude Code, `AGENTS.md` → Codex/Cursor/opencode/
Copilot/Windsurf/Antigravity, `GEMINI.md` → Gemini CLI/Antigravity,
`.clinerules` → Cline, `.roo/` → Roo Code, `.kiro/` → Kiro, `.goosehints` →
Goose. The full id table is `samemind install --list` (Step 3) or
[`docs/adapters.md`](docs/adapters.md). Remember your `<engine-id>` — you'll
need it in Steps 3 and 4.

**Verify:** you can name one `<engine-id>` from the list above (or `all` if
several of your instruction files already coexist in this project).

---

## Step 1 — Get a bundle

Decide: does this project already have a samemind/OKF bundle (a folder with
`concepts/`, `entities/`, `projects/`, `index.md`)? If unsure:

```sh
find . -maxdepth 2 -name index.md -exec grep -l okf_version {} \;
```

- **No bundle found** → scaffold one. Pick a real, empty folder for it — the
  project root only if that root truly has nothing in it yet:

  ```sh
  npx samemind init ./memory        # empty bundle you'll fill in as you go
  # or, to see the format with a worked (fictional) example first:
  npx samemind init ./memory --demo
  ```

  `init` refuses a non-empty target — it will never overwrite your project.

- **Bundle found** → note its path; you'll export it as `OKF_ROOT` in the next
  steps instead of re-running `init`.

**Verify:**

```sh
OKF_ROOT=./memory npx samemind query validate
```

Expect `0 errors` (warnings about missing Identity/User are fine at this
stage — Step 5 covers those).

---

## Step 2 — Export `OKF_ROOT` for this session

Every samemind command after this point needs to know which bundle to use.
Set it once for your shell/session (adjust the path to Step 1's answer):

```sh
export OKF_ROOT=./memory
```

If you can't persist an env var across your own tool calls, pass
`OKF_ROOT=./memory` inline on every `samemind`/`npx samemind` command instead —
functionally identical, just more typing.

**Verify:**

```sh
OKF_ROOT=./memory npx samemind query list
```

Expect a non-error concept list (empty is fine for a fresh non-demo bundle).

---

## Step 3 — Install the instruction-file protocol

```sh
npx samemind install --list
```

Confirm your `<engine-id>` from Step 0 is in the list. Then, from the project
root (the directory your instruction file — `CLAUDE.md`, `AGENTS.md`, … —
belongs in):

```sh
npx samemind install --agent <engine-id>
```

This idempotently inserts the identity brief + memory protocol between
`<!-- samemind:install:start -->` / `<!-- samemind:install:end -->` markers in
your instruction file(s) (creating them if they don't exist yet; any of your
own content outside the markers is left untouched). Re-running it any time you
update the bundle is safe and expected — it's not a one-shot.

**Verify:**

```sh
grep -l "samemind:install:start" CLAUDE.md AGENTS.md .clinerules \
  .cursor/rules/samemind.md .roo/rules/samemind.md .kiro/steering/samemind.md \
  .windsurf/rules/samemind.md .goosehints .github/copilot-instructions.md \
  2>/dev/null
```

At least one file matching your engine from Step 0 must be listed.

---

## Step 4 — Connect MCP (skip only if your engine has no MCP support)

Look up your engine's exact command in [`docs/adapters.md`](docs/adapters.md)
(every row has one, checked as of 10.07.2026). The shape is always
`{"command": "npx", "args": ["samemind", "serve"]}` or an equivalent one-liner.
For Claude Code and Codex CLI specifically:

```sh
claude mcp add samemind -- npx samemind serve     # Claude Code
codex mcp add samemind -- npx samemind serve      # Codex CLI
```

Aider has no official MCP path — skip this step for Aider and rely on Step 3's
instruction file instead (see the Aider note in `docs/adapters.md`).

**Verify:** list your engine's configured MCP servers (e.g. `claude mcp list`,
`codex mcp list`, or inspect the config file docs/adapters.md points at for
your engine) and confirm `samemind` appears.

---

## Step 5 — Fill in the identity layer (recommended, not blocking)

If Step 1 scaffolded a fresh (non-demo) bundle, its identity templates are
empty placeholders. Fill them in so `samemind brief`/`install` have something
real to say about who you are and who you work for:

```sh
cp memory/concepts/_identity-template.md memory/concepts/<agent-name>.md
cp memory/entities/_user-template.md memory/entities/<owner-name>.md
cp memory/concepts/_engine-rule-template.md memory/concepts/engine-<engine-id>.md
# edit all three, then:
npx samemind install --agent <engine-id>   # re-run to refresh the brief with real content
```

**Verify:**

```sh
OKF_ROOT=./memory npx samemind brief --engine <engine-id>
```

Expect real names/voice/rules in the output, not template placeholders like
`<agent name>`.

---

## Step 6 — Confirm the whole loop end-to-end

```sh
OKF_ROOT=./memory npx samemind query validate   # 0 errors
OKF_ROOT=./memory npx samemind recall "test" -k 3   # runs without crashing (BM25, zero-dep)
```

Then, from inside your own agent session (not a shell), call your MCP
`memory_search` tool once with any query and confirm it returns a JSON result
(possibly empty) rather than an error — that proves the MCP wiring from Step 4
is live, not just configured.

**Verify:** both shell commands exit 0, and the in-session MCP call returns
without an error.

---

## Done

You now have: a git-native markdown bundle, your instruction file wired with
the recall→read→cite→gaps protocol and write discipline (see
[`docs/memory-protocol.md`](docs/memory-protocol.md) and
[`docs/work-discipline.md`](docs/work-discipline.md)), and (unless you're
Aider) an MCP connection. Report back to whoever pointed you at this file with
a one-line summary: bundle path, engine id, whether MCP connected, and whether
Step 5's identity layer is filled in or still templated.

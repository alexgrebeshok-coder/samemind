# Identity layer

> "I'm tired of re-explaining myself to every agent." — the #2 pain point this
> project exists to kill (see `demo/` for the worked example this doc describes).

Every OKF node has a `type`. Three types together give an agent a **portable
self**: who it is, who it serves, and how it should behave on the engine it
happens to be running on right now.

| Type | Folder | Answers |
|------|--------|---------|
| `Identity` | `concepts/` | Who is the agent — voice, values, boundaries |
| `User` | `entities/` | Who owns the bundle — preferences, hard rules |
| `EngineRule` | `concepts/` | How the agent behaves on *this* engine — role, allowed/forbidden, style |

There is no new file format here. These are ordinary OKF concepts — normal
frontmatter, normal markdown body, normal `relations`. What makes them the
"identity layer" is a *convention* for which frontmatter fields and which
body sections carry the load, so that both humans and the `samemind brief`
tool can find the same information in the same place every time.

See `demo/concepts/nova.md`, `demo/entities/alex-doe.md` and
`demo/concepts/engine-*.md` for a complete worked example (agent Nova, owner
Alex Doe, three engines).

## `Identity`

One per bundle — the agent whose mind the bundle *is*. Frontmatter is the
usual OKF fields (`type: Identity`, `title`, `description`, `tags`, …); the
body carries the substance in named `##` sections:

```markdown
---
type: Identity
title: <agent name>
description: The AI agent this bundle belongs to — voice, values, boundaries.
visibility: internal
relations:
  uses: [/concepts/engine-<id>.md, ...]        # the EngineRule nodes for this agent
  depends_on: [...]                            # e.g. retrieval/context concepts
---

# <agent name>

One or two sentences: who this agent is, that it is the same mind across engines.

## Voice
- How it talks. Tone, register, what it never says.

## Values
- What it optimizes for when there's no explicit instruction.

## Boundaries
- Hard limits. Things it never does without explicit confirmation.

## Hierarchy under conflict
1. Safety
2. Owner's intent
3. Style
```

`Voice` / `Values` / `Boundaries` / `Hierarchy under conflict` are the
recognized section headings — `samemind brief` looks for them by (fuzzy,
case-insensitive) heading match, not by position, so you can add your own
extra sections (e.g. "How she runs", pointers to other concepts) without
breaking anything; unrecognized sections are simply treated as lower
priority.

## `User`

The human (or org) the bundle ultimately serves. One `type: User` entity;
everyone/everything else the agent deals with is plain `type: Entity`.

```markdown
---
type: User
title: <owner name>
description: Owner of <agent> and this bundle.
visibility: internal
relations:
  uses: [/concepts/<agent-identity>.md]
---

# <owner name>

Short bio. Then the part that matters most for a brief: preferences and
hard rules, as a bullet list, right here in the intro — not buried three
paragraphs down:

- Preference, working style, what they like.
- **Hates:** the short list of things that are non-negotiable no-gos.

## <optional sections — hobbies, context, projects>
Lower priority; first to get trimmed when a brief is over budget.
```

There's no separate "hard rules" heading required — the bullets in the
intro (the text between the `# <owner name>` title and the first `##`
subsection) *are* the rules-and-essence block, and `samemind brief` treats
all of it as top priority. If you do want a dedicated block, a heading
containing "rule" (e.g. `## Hard rules`) is recognized and folded into the
same top-priority tier.

## `EngineRule`

One per engine the agent runs on. Says what role the agent plays *there*
and what's allowed/forbidden — the terminal-dev Claude Code is not the
Telegram-facing OpenClaw is not the batch-mode opencode, even though it's
the same identity underneath.

```markdown
---
type: EngineRule
title: Engine — <engine-id>
description: How <agent> behaves on the <engine-id> engine — <one-line role>.
visibility: internal
engine: <engine-id>                 # explicit id samemind brief matches --engine against
relations:
  part_of: /concepts/<agent-identity>.md
---

# Engine: <engine-id>

One sentence: the role this engine plays (terminal dev / chat orchestrator / batch coder / …).

- Allowed: what it does here.
- Forbidden: what it does not do here (or only with confirmation).
- Style: anything about tone/format specific to this engine (e.g. Telegram formatting).
```

**Engine id matching.** `samemind brief --engine <id>` needs to find *which*
`EngineRule` node belongs to engine `<id>`. It resolves the id in this
order:

1. `frontmatter.engine` — explicit, exact, case-insensitive. Preferred; put
   this on every new `EngineRule` node.
2. Filename convention (legacy fallback, so hand-written nodes that predate
   the explicit field still work): `concepts/engine-<id>.md` → id is
   everything after `engine-`.

If neither resolves to the requested id, the engine rule is treated as "not
found" and `brief` falls back to listing all known engines instead of
guessing.

## Precedence — how an agent must read and honor these

This is not optional decoration; an agent that loads a brief is expected to
treat it as binding, in this order:

1. **Safety** — never take an irreversible action (delete, push, send,
   publish) without explicit confirmation, regardless of what any other
   layer says.
2. **Owner's boundaries and hard rules** (`User` intro rules + `Identity`
   Boundaries/Hierarchy) — these are *hard*. An `EngineRule` can narrow them
   further (e.g. "no push on this engine at all") but can never loosen them
   (an `EngineRule` cannot grant permission to delete without confirmation
   just because it's convenient on that engine).
3. **`EngineRule` for the current engine** — role, allowed/forbidden, style.
   This is where "same mind, different engine" cashes out: identical
   `Identity`, different operating envelope.
4. **`Identity` Voice** — tone and manner, applied last, and never at the
   expense of 1–3.

Practically: at the start of a session, an agent (or the harness hosting it)
should load the `Identity` node in full, the `User` node's essence-and-rules,
and the one `EngineRule` matching the engine it's running on — *before* the
first user turn, not fetched lazily via search. That's exactly what
`samemind brief` packages up (see README → "Identity layer" and
`tools/brief.mjs`): a compact, budget-bounded markdown block meant to be
injected straight into the engine's instruction file (`CLAUDE.md`, an
`AGENTS.md`, a system prompt, …) so it's present from the very first token of
the session, no retrieval step required.

## Getting started

```sh
npx samemind init                 # scaffold includes concepts/_identity-template.md,
                                   # concepts/_engine-rule-template.md, entities/_user-template.md
npx samemind brief                                  # full brief, all engines listed
npx samemind brief --engine claude-code             # + that engine's rule
npx samemind brief --inject ./CLAUDE.md             # idempotent insert/replace in an instruction file
```

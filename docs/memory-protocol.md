# Memory protocol

How an AI agent should **use** a samemind bundle when answering questions
about the past, the owner, people, projects, or decisions.

This is **not** a background daemon. Synthesis runs in the agent: search →
read → answer with citations → name gaps. Zero API keys, zero extra services —
only the tools already in the package (`samemind recall` / MCP
`memory_search` + `memory_get` + `memory_write_inbox`).

---

## When to run the protocol

Trigger on questions that depend on stored context, for example:

- past decisions, preferences, project status
- people and orgs the owner works with
- “what do I need before the meeting with X?”
- “what did we decide about Y?”

Skip for pure coding / general knowledge that does not need this bundle.

---

## Steps

### 1. Search (cheap)

```sh
samemind recall "<question>" -k 5 --mode bm25
# or MCP: memory_search { query, k: 5 }
```

Use `auto` if a semantic index exists; otherwise BM25 is enough.
Take the **top 3–5** hits by score. Do not load the whole graph.

### 2. Read top hits fully

For each hit id, load the full node:

```sh
samemind query get <id>
# or MCP: memory_get { id }
```

If a hit points at a person/project that is clearly the subject of the
question, also open **one hop** of direct relation targets (e.g. `works_at`,
`uses`) when they are still within the same budget of ~5 full reads total.

### 3. Answer with path citations

Write the answer from those nodes only. Cite bundle paths in backticks, e.g.
`/entities/iris-vale.md`, `/projects/lumen.md`. Prefer short quotes or
paraphrases tied to a path — not anonymous “from memory”.

### 4. Mandatory closing block: gaps

End every protocol answer with:

```markdown
## What the memory doesn't cover
```

List **explicit** gaps relevant to the question, not generic caveats:

- missing agenda, dates, open decisions, contact channels
- no prior-meeting notes if none exist
- **staleness**: use each node’s `timestamp` frontmatter; if all share a seed
  day or are months old, say so

If the graph has nothing on-topic, say that first and still list what would
need to be written later.

### 5. Write new facts to the inbox only

When the user states a new fact, decision, or meeting outcome:

```sh
# MCP: memory_write_inbox { content, title? }
```

Never invent paths under `concepts/` / `entities/` / `projects/` as agent
writes. Canon promotion is a human/curation step (`tools/consolidate.mjs`).

---

## Write discipline

The bundle is a system of **work**, not only facts. Four concept types capture
agreements, decisions, owed work, and session outcomes — see
[`docs/work-discipline.md`](work-discipline.md) for the full spec. The rules
below are **MUSTs**, not suggestions:

- **Agreed a plan or a position with the owner → write it *now*.** Open a `Plan`
  (status `agreed`, `agreed_with`, `agreed_on`) or `Decision` node in `inbox/`
  via `memory_write_inbox` (or a file). "I'll note it later" = it didn't happen.
- **A plan changed → write a *new* `Plan`**, not an edit. Set
  `relations.supersedes: /projects/<old-plan>.md` on the new one and mark the old
  one `status: superseded`. Plans and Decisions are append-only history; the old
  node stays on record.
- **Session ended → write a `Session` summary** in `inbox/`: `## Done`,
  `## Decided`, `## Next`, plus `engine` and `date`. This is the closing artifact
  of every non-trivial session — no session-summary, no provenance.
- **A task changed status → update the `Task` *in place*.** `Task` is the one
  discipline type you edit, because `status` is its current state, not history.
  If it is now `blocked`, `blocked_reason` is mandatory (what blocks it, what
  unblocks it).

Validate catches the common lapses as warnings:
`samemind query validate` flags a `Plan`/`Task` with no `status`, a `status`
outside the type's dictionary, or a blocked `Task` with no `blocked_reason`.

---

## Knowledge cycle — reacting to an immature Idea

The bundle also holds **candidates**, not only work and facts: `Analysis` /
`Research` / `Idea` (full spec: [`docs/knowledge-cycle.md`](knowledge-cycle.md)),
linked by `informs` / `spawned_by` / `led_to`. Any agent that lands on an
`Idea` with `status: spark` or `status: incubating` touching its own domain
should **react**, not read past it:

- Write a reflection to your **own inbox** (`memory_write_inbox`), never edit
  the Idea node — `target: /concepts/<idea>.md` in the frontmatter, body
  proposing a path forward (adopt, reject, or what evidence would decide it).
- Curation merges reflections into the Idea's `## Reflections` section; only
  curation (or the owner) flips `status` or sets `relations.led_to` once
  `adopted`. `rejected` requires a non-empty `rejected_reason`.
- `samemind query validate` warns on `Idea` missing `status`, bad `status`, or
  `rejected` without a reason — same severity as the work-discipline checks.

---

## Token discipline

| Phase | Cost | Rule |
|-------|------|------|
| Search | Low | Always first. Snippets + scores only. |
| Full read | Higher | Top **N = 3–5** only (plus at most one relation hop if needed). |
| Whole bundle | Forbidden by default | No `list` dump into the context for a single question. |

Frontmatter (title / description / tags) is the cheap summary; load bodies
only for the ranked top set.

---

## Example (live run on `demo/`)

Fictional Nova demo. Commands run from a samemind checkout with
`OKF_ROOT=demo`. Data is invented; not a real person or company.

### Q

> What do I need to know before my meeting with Iris Vale?

### 1. Recall (BM25, k=5)

```sh
OKF_ROOT=demo node tools/okf-recall.mjs \
  "What do I need to know before my meeting with Iris Vale?" -k 5 --mode bm25
```

| Score | Type | Id | Title |
|------:|------|-----|-------|
| 4.274 | Project | `projects/lumen` | Lumen |
| 3.994 | Entity | `entities/iris-vale` | Iris Vale |
| 3.507 | Identity | `concepts/nova` | Nova |
| 3.130 | EngineRule | `concepts/engine-openclaw` | Engine — openclaw |
| 2.648 | Project | `projects/atlas` | Atlas |

Subject-relevant set for full read: Iris + both projects she is on.
Dropped from synthesis: Nova identity and openclaw engine rule (high BM25
from shared vocabulary, not meeting context). One-hop: Acme Labs
(`/entities/acme-labs.md`) and owner Alex (`/entities/alex-doe.md`) via
links from Iris / Lumen.

### 2. Full reads (paths)

- `/entities/iris-vale.md` — designer; works at Acme; UX on Lumen; contributes to Atlas
- `/projects/lumen.md` — Alex’s side project; UX owned by Iris; prototype; next = backlink editor, then sync
- `/projects/atlas.md` — research KB; Iris contributes; status = gathering sources; next = wire retrieval
- `/entities/acme-labs.md` — Alex’s employer; sponsors Lumen; Iris is a collaborator
- `/entities/alex-doe.md` — owner; works at Acme; Lumen as side project

All of the above carry `timestamp: 2026-07-10T00:00:00Z` (demo seed).

### 3. Synthesized answer

**Iris Vale** (`/entities/iris-vale.md`) is a designer and frequent collaborator
of Alex Doe at **Acme Labs** (`/entities/acme-labs.md`). She owns UX for
**Lumen** and contributes to **Atlas**.

**Lumen** (`/projects/lumen.md`) — Alex’s side project (notes app), sponsored by
Acme; Iris owns UX. Goal: local-first notes with a clean backlink graph.
Status: **prototype**. Explicit next steps in memory: ship the backlink
editor, then sync. Nova is wired in via the retrieval strategy concept.

**Atlas** (`/projects/atlas.md`) — research knowledge base; Iris contributes;
Nova curates/recalls. Status: **gathering sources**. Next in memory: wire
retrieval strategy over the corpus.

**Shared context for tone** (`/entities/alex-doe.md`): Alex is an engineer /
LLM power user at Acme; prefers evenings; dislikes flakiness and stalling.
Useful if the meeting is with Iris as a collaborator, not as a cold intro.

### 4. What the memory doesn't cover

- No meeting **agenda, date, time, location, or channel** (calendar is outside the bundle).
- No **prior meeting notes**, open action items, or decisions attributed to Iris ↔ Alex.
- No Iris **contact details**, timezone, or communication preferences.
- No design critique trail, Figma/PR links, or blockers on the “backlink editor” / “sync” next steps.
- No conflict or priority note between Lumen vs Atlas for this conversation.
- **Staleness:** every cited node is timestamped `2026-07-10T00:00:00Z` (demo seed day). There is no multi-day history of updates — treat project status as a single snapshot, not a living timeline.

If this were a real prep, the agent would ask the owner for agenda + last
touchpoints, then `memory_write_inbox` the outcome after the meeting.

---

## Wiring into agents

Paste a ready block from `docs/snippets/`:

| File | For |
|------|-----|
| [`docs/snippets/CLAUDE.md`](snippets/CLAUDE.md) | Claude Code / CLAUDE.md |
| [`docs/snippets/AGENTS.md`](snippets/AGENTS.md) | Codex / Cursor / generic AGENTS.md |
| [`docs/snippets/GEMINI.md`](snippets/GEMINI.md) | Gemini CLI / Antigravity |

Full detail stays here; snippets are ≤40 lines and point back to this doc.

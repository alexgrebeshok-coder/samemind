# Memory hygiene

> "A stale fact and a current fact must not live as equals." — the problem this
> doc describes (naryad N17). Memory that only ever grows silently rewards
> whatever was written first, not whatever is true now.

Git-native, append-only memory has a real cost: nothing is ever deleted, so a
belief you corrected six months ago is still sitting in the bundle, still
indexed, still able to outrank the correction if it happens to use better
keywords. Hygiene is the set of signals that let recall tell old from current
**without deleting history** — the append-only spirit stays intact; ranking
just stops pretending everything is equally fresh.

Three independent signals, one combined rank multiplier:

| Signal | Frontmatter field | Set by |
|---|---|---|
| Explicit replacement | `supersedes: /path.md` (or a list) | You, when writing the new concept |
| Soft deletion | `deprecated: true` + `deprecated_on: <ISO>` | `samemind forget <id>` (or by hand) |
| Curated weight | `importance: 1..5` | You, optionally, on any concept |
| Implicit staleness | `timestamp` (already a standard OKF field) | You, on every concept |

None of these ever remove a node from `list`/`links`/recall results. They only
change **rank** (a multiplier on the raw score) and add a visible **label** —
the old concept is still there, still findable, still one click away from the
thing that replaced it.

## Fields

### `supersedes`

Put it on the **new** concept, pointing at the **old** one it replaces:

```yaml
---
type: Concept
title: New retrieval idea
supersedes: /concepts/old-idea.md          # scalar…
# supersedes: [/concepts/old-idea.md, /concepts/old-idea-2.md]   # …or a list
---
```

Parsed and normalized exactly like a `relations` value (scalar → one-element
array; a bundle-absolute path or a path relative to the bundle root both
work). It is deliberately **not** nested under `relations:` — `supersedes` is
a hygiene signal consumed by ranking/validation, not a graph edge you'd query
with `okf-query rel`.

A concept is "superseded" the moment *any other* concept's `supersedes`
names it — you never touch the old concept's own frontmatter.

### `deprecated` / `deprecated_on`

Set by `samemind forget <id>` (see below), or by hand if you'd rather not use
the CLI. Behaves exactly like being superseded for ranking purposes, without
requiring a replacement to exist — useful for "this was just wrong, and
nothing replaces it" rather than "this was replaced by that."

### `importance`

Optional integer `1..5`, default (absent) `3` — neutral, no effect on rank.
Use it to hand-curate weight independent of recency: a load-bearing
`Identity`/`EngineRule` node can be pinned above 3 so it never gets crowded
out by decay or by noisier concepts with better keyword overlap.

### `timestamp` (already standard)

No new field — hygiene just starts reading the existing OKF `timestamp` to
apply gentle time-decay to old, never-revisited concepts (see formula below).

## The rank formula

Applied identically in **both** recall modes (BM25 keyword fallback and
semantic/cosine) and in `gde` — one hygiene layer, shared by every ranker
(`tools/lib/recall.mjs` calls into `tools/lib/hygiene.mjs`):

```
finalScore = rawScore(query, doc) × hygieneMultiplier(doc)

hygieneMultiplier(doc) = supersededPenalty × importanceMultiplier × decayMultiplier × heatMultiplier
```

`heatMultiplier` (Ф5, optional — see "Tiered heat" below) defaults to `1.0`
(no-op) unless a `heatIndex` from the event ledger is passed in; every call
site that predates Ф5 behaves byte-for-byte as before.

**`supersededPenalty`** — `0.35` if the doc is named by another concept's
`supersedes`, or has `deprecated: true`; `1.0` otherwise. A flat penalty, not
a cliff to zero: a superseded concept can still surface for a query only it
answers, just never ahead of a same-relevance current one.

**`importanceMultiplier`** — `clamp(importance, 1, 5) / 3`. Default/absent
`importance` → `3/3 = 1.0` (neutral). `importance: 5` → `×1.67`,
`importance: 1` → `×0.33`.

**`decayMultiplier`** — gentle linear time-decay, and only for concepts that
can plausibly go stale:

```
decayMultiplier(doc) =
  1.0                                              if type ∈ {Identity, User, EngineRule}  (timeless)
  1.0                                              if age_days ≤ 180
  1.0 − frac × (1 − 0.6)   , frac = (age−180)/(720−180)     if 180 < age_days < 720
  0.6                                              if age_days ≥ 720
```

`Identity`/`User`/`EngineRule` are exempt on purpose — an agent's own
identity, its owner's preferences, and its per-engine rules don't go stale
just because they haven't been edited; nothing else in the formula reads
`type` for anything but this exemption.

Raw scores are never mutated in place — `rawScore` is kept alongside the
final `score` in every ranker's internal result, purely so the multiplier's
effect stays inspectable/testable.

## What changes where

- **`samemind recall` / `okf-recall.mjs`** (both `bm25` and `semantic`
  modes) and **`samemind gde`** — superseded/deprecated hits sort lower and
  print an inline label: `[superseded by /concepts/new.md]` or
  `[deprecated 2026-07-10]`. Never hidden.
- **`samemind serve` (MCP) `memory_search`** — same ranking (shared
  `recallSearch`), plus a `hygiene` field on each result mirroring the label.
- **`okf-query get <id>`** — a superseded or deprecated concept gets a
  visible warning banner above the raw file content, e.g.:
  `⚠️  SUPERSEDED by /concepts/new-idea.md — kept for history, prefer the newer concept.`
- **`okf-query validate`** — prints every `supersedes` chain found
  (`concepts/new-idea supersedes concepts/old-idea`), and reports two classes
  of problem as **warnings** (same severity as broken `relations` edges —
  conformance itself still only depends on every concept having a `type`):
  a `supersedes` target that doesn't exist, and a cycle
  (`A supersedes B`, `B supersedes A`, …).
- **`okf-query links`** — `supersedes` edges now count toward the edge tally
  and inbound links, so a superseded-but-referenced-only-that-way concept
  isn't misreported as an orphan.
- **`tools/consolidate.mjs`** — a new "⚔️ Contradictions" (contradictions)
  section: pairs of canon concepts of the **same `type`** with high
  title/tag token similarity where **neither** `supersedes` the other —
  candidates for a human to resolve (merge, add `supersedes`, or leave be).
  Deliberately simple: Jaccard similarity over lowercased title+tag tokens,
  no embeddings required.

## `samemind forget <id>`

```sh
npx samemind forget concepts/old-idea
```

Soft-deprecates a concept — **never deletes the file** (append-only spirit:
git already keeps every version; this just stops recall from treating it as
fresh). Sets `deprecated: true` and `deprecated_on: <ISO timestamp>` in the
frontmatter via an atomic write (temp file + rename), leaving every other
line — other fields, `relations:`, the body — byte-for-byte untouched.
Running it again just refreshes `deprecated_on`.

Id resolution matches `okf-query get`: exact id, or a unique basename-suffix
match; ambiguous or missing input is a hard refusal, never a guess.

## Bi-temporal supersede (Ф2)

`supersedes` (above) answers "what replaced me?" by asking the *whole corpus*
(`buildSupersededMap` scans every doc's `supersedes` field). Three more
optional fields let a concept carry that signal on its **own** frontmatter,
no corpus scan required — same append-only spirit, never delete, only label:

| Field | Meaning | Set by |
|---|---|---|
| `valid_from` | ISO date the fact became true | You, optionally |
| `invalid_at` | ISO date the fact stopped being true | You, or a human applying a `reconcile` proposal |
| `superseded_by` | `/path.md` (or a list) — the reverse of `supersedes`, pointing forward from the OLD fact to its replacement | You, or a human applying a `reconcile` proposal |

Absent fields = always valid — every concept written before Ф2 is
unaffected. As of Э6/6.3, recall **excludes by default** any concept that is
stale as-of now: named by another concept's `supersedes` (`buildSupersededMap`),
own `superseded_by` pointing at an existing concept, `invalid_at` ≤ now, or
`valid_from` > now. Opt-in audit: `--include-superseded` (CLI / API
`includeSuperseded: true`) re-includes them demoted by `SUPERSEDED_PENALTY` and
labeled `⤳ superseded by /concepts/new.md` / `invalid_at …` /
`not yet valid (valid_from …)`. Point-in-time: `--as-of <ISO>` (API `asOf`)
evaluates the same bounds against that instant. `deprecated` is still
demote-only (not hard-dropped). Cards without these fields behave as before.

### `tools/reconcile.mjs` — proposals, not writes

```sh
node tools/reconcile.mjs [--dir <subpath>] [--write]
```

Same human-gate as `consolidate.mjs`: reuses its same-type/title-tag-Jaccard
"contradictions" heuristic to find candidate pairs (same subject, no
existing `supersedes`/`superseded_by` link between them yet), picks a
direction by file mtime (newer file = presumed replacement), and prints a
markdown report — `предлагаю пометить Y superseded_by X`. It **never writes
to a concept's frontmatter**; `--write` only saves its own report under
`inbox/_reconcile-report.md`, for a human (or a curating agent acting on
explicit instruction) to act on by hand.

## Tiered heat (Ф5)

SOTA prior art (MemoryOS): promote/demote facts by "heat" — a live, use-driven
signal — not just by how long ago they were *written* (`timestamp`/
`decayMultiplier` above already cover that). Source of truth: `ledger/events.jsonl`
(`docs/event-ledger.md`) — every ledger event's `topic` is matched against a
concept's `id`; a topic that happens to name a concept "touches" it.

```
heatScore(doc) = recencyFactor × frequencyFactor        (each in [0, 1])

recencyFactor  = 1 − age_days / HEAT_WINDOW_DAYS(30)   , 0 if the last touch is older than that
frequencyFactor = min(1, touches_in_window / HEAT_FREQ_SATURATION(5))

heatMultiplier(doc) = 1 + heatScore(doc) × HEAT_BOOST_MAX(0.5)     — always ≥ 1, never a penalty
```

A doc the ledger never touched (the overwhelming majority — a ledger `topic`
is "a free-text work-item id ... not a bundle path", so this only activates
where a topic happens to equal a concept id) gets `heatScore = 0` →
`heatMultiplier = 1.0`, byte-for-byte the same rank as before Ф5. **Cold is
therefore not an absolute penalty, only the absence of a boost** — a cold
fact sinks in rank only relative to hot peers, never below its pre-Ф5 score,
never hidden — the same "demoted, never hidden" contract `SUPERSEDED_PENALTY`
already uses, applied in the same one hygiene pass (no separate ranking step
for bm25 vs. semantic/hybrid).

**Tier** (`heatTier`, derived, not stored): `hot` (`heatScore ≥ 0.5`) / `warm`
(`heatScore > 0`) / `cold` (`heatScore == 0`). Visible via MCP `memory_health`
→ `heatTiers: { hot, warm, cold }` — a bundle-wide read of what's actively
being touched vs. sitting cold, computed over the same `heatIndex` recall uses
(no second pass).

### `tools/reflect.mjs` — reconcile + consolidate + heat, ONE proposal report

```sh
node tools/reflect.mjs [--write]
```

The Ф5 reflection/forgetting cycle: runs `reconcile.mjs`'s supersede
proposals, `consolidate.mjs`'s dedup/gap map, and a heat re-evaluation, and
fuses all three into a single markdown report — "что слить" (merge
candidates), "что пометить superseded" (supersede proposals), "что остыло в
cold" (facts the ledger touched at some point but not in the last
`HEAT_WINDOW_DAYS` — an FYI to re-check importance/timestamp or run
`samemind forget`, not an automatic action). Reuses the existing tools'
functions directly rather than re-implementing their logic — one source of
truth for each classification.

Same human-gate as `reconcile.mjs`/`consolidate.mjs`: **never writes to a
concept's frontmatter**, and never hides/deletes anything itself — `forget.mjs`
stays the one (still soft, `deprecated: true`, never a delete) tool a human
runs to act on a proposal. `--write` only saves the combined report under
`inbox/_reflect-report.md`. Not wired into cron/launchd — a manual (or
human-triggered) run.

## Worked example

`demo/concepts/embed-model-bge-m3.md` (dated 2025-09-01 — old enough to also
pick up a little time-decay) is superseded by
`demo/concepts/embed-model-qwen3.md` (dated today, `importance: 4`):

```yaml
# demo/concepts/embed-model-qwen3.md
---
type: Concept
title: Embedding model — Qwen3-Embedding
supersedes: /concepts/embed-model-bge-m3.md
importance: 4
---
```

```sh
OKF_ROOT=demo node tools/okf-recall.mjs "embedding model for retrieval" --mode bm25
# → embed-model-qwen3 ranks first; embed-model-bge-m3 still appears, labeled
#   [superseded by /concepts/embed-model-qwen3.md]

OKF_ROOT=demo node tools/okf-query.mjs get concepts/embed-model-bge-m3
# → prints the SUPERSEDED banner above the file content

OKF_ROOT=demo node tools/okf-query.mjs validate
# → "# Supersede chains" lists: concepts/embed-model-qwen3 supersedes concepts/embed-model-bge-m3
```

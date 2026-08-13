# samemind JSON contract (frozen at 1.0)

**Status:** frozen as of v1.0.0. Changing the form of anything described here is a major version.  
**Authority:** live CLI/`--json` output and live HTTP `/api/*` responses from this tree.  
**Not authority:** `ui/src/api.ts` (not in the npm package; already drifts), `docs/ui-spec.md` field tables (the spec itself says wire names win).

After **1.0**, changing the shapes described here is a **major** version bump. This file is the human-readable record of what “the contract” means so nobody freezes a ghost.

Verified against live runs on demo root (`OKF_ROOT=demo` / `ui --root demo`) at document time.

**Re-checked 2026-08-13, before signing 1.0** — and the document had drifted from the wire it describes. Four sections said things the code stopped doing in 0.17.0 (`generatedAt` marked missing on five surfaces that all carry it; `proactive` described as envelope-less; two `*Total` fields marked absent; the SSE snapshot frame undocumented) — all corrected here. One drift was in the code, not the document: HTTP `board`/`handoff` skipped the projection their CLI twins apply and shipped absolute host paths and full document bodies; that was fixed in the code before the freeze, because freezing it would have made the fix a major. Method and raw output of the re-check: coverage was 8/8 CLI surfaces, 13 HTTP routes plus SSE, 10 error paths, 10/10 MCP tool names.

---

## 1. Envelope

Most machine-readable surfaces wrap the payload:

```json
{
  "contract": 1,
  "kind": "<string>",
  "generatedAt": "<ISO-8601>",
  "data": { }
}
```

| Field | Meaning |
|-------|---------|
| `contract` | Integer schema generation. Today always `1`. Bump only with a coordinated breaking change (and a major package version after 1.0). |
| `kind` | Which surface produced this object. Consumers branch on `kind`, not on presence of ad-hoc keys. |
| `generatedAt` | ISO-8601 timestamp of when the response was built. **Not universal — see below.** |
| `data` | Payload. Usually an object; for `kind: "concepts"` it is an **array**. |

### `generatedAt` is universal (since 0.17.0)

Confirmed live (CLI unless noted) — all eight CLI surfaces build the same
`{ contract: 1, kind, generatedAt: new Date().toISOString(), data }` envelope:

| Surface | Has `generatedAt`? |
|---------|--------------------|
| `board --json` | **yes** |
| `handoff --json` | **yes** |
| `doctor --json` | **yes** |
| `status --json` | **yes** |
| `fleet status --json` | **yes** |
| `ledger status --json` | **yes** |
| `query links --json` | **yes** |
| `proactive … --json` | **yes** |
| Every HTTP route that uses `wrap()` in `tools/lib/ui-server.mjs` | **yes** (including `/api/status`, `/api/fleet`, `/api/ledger`, `/api/graph`) |

`generatedAt` was added to `status` / `fleet status` / `ledger status` / `query links` / `proactive` in 0.17.0 (see CHANGELOG). Source: `tools/status.mjs:70`, `tools/fleet.mjs:92`, `tools/ledger.mjs:61`, `tools/okf-query.mjs:198`, `tools/proactive.mjs:101` — every one literally builds the envelope with `generatedAt`. CLI and HTTP now agree on this field for every surface.

### Pretty-print vs one line

| Surface | Form |
|---------|------|
| Most CLI `--json` and all HTTP JSON | Single-line `JSON.stringify(obj)` |
| `doctor --json` (CLI) | Multiline pretty (`JSON.stringify(…, null, 2)`) |
| `proactive … --json` | Multiline pretty, **no** envelope |
| MCP tool results | Multiline pretty JSON **inside** MCP `content[0].text` |

Parse with a real JSON parser; do not assume one line = one response.

---

## 2. Surfaces (command / route → kind → `data` keys)

### 2.1 CLI with envelope

| Command | `kind` | `generatedAt` | Top-level keys of `data` | Notes |
|---------|--------|---------------|--------------------------|-------|
| `samemind board --json` | `board` | yes | `nowMs`, `doneLimit`, `recentDays`, `project`, `backlog`, `inprog`, `blocked`, `done`, `plans`, `ideaIncubating`, `ideaSpark`, `ideaAdopted`, `ideasVisible`, `recent`, `sessions`, `openFailuresShown`, `openFailuresTotal`, `overdueEnginesShown`, `overdueEnginesTotal`, `ledgerOverflow`, `columnTotals` | Cards mix full docs and ledger-derived cards (see §4). |
| `samemind handoff --json` | `handoff` | yes | `projectKey`, `dayWindow`, `active`, `recentDecisions`, `plansInForce`, `lastSession`, `blocked`, `sessionNext`, `nowMs` | Work-state model; not the MCP handoff shape. |
| `samemind status --json` | `status` | **no** | `state`, `liveness`, `ageSec`, `ok`, `lastError`, `targets`, `version`, `ts` | Projection heartbeat over `.samemind/health.json`. |
| `samemind doctor --json` | `doctor` | yes | `ok`, `version`, `node`, `platform`, `root`, `active`, `engines`, `consistency`, `summary`, `findings` | Pretty-printed on CLI. Host-local fields — see §4. |
| `samemind fleet status --json` | `fleet` | **no** | `engines`, `stopPoints` | |
| `samemind ledger status --json` | `ledger` | **no** | `topics`, `openFailures` | Topics include full `evs` arrays. |
| `samemind query links --json` | `links` | **no** | `nodes`, `edges`, `orphans`, `broken`, `mdEdges`, `relCount`, `supersedeCount`, `totalEdges` | Same model as HTTP `/api/graph` (kind stays `links`). |

### 2.2 CLI without envelope

None left. Every CLI `--json` surface, including `proactive`, now ships the full
`{ contract, kind, generatedAt, data }` envelope (0.17.0). `samemind proactive "<query>" --json`
is `{ contract: 1, kind: "proactive", generatedAt, data }` on a single line — `data` keys when
skipped: `skipped`, `reason`, `query`, `hits`, `pack`, `tokens`, `chars`, `latencyMs`,
`manualRecallsSaved`; when not skipped, also `included`, `k`.

### 2.3 HTTP (all via `wrap`, so always full envelope)

Base: `http://127.0.0.1:<port>/api/…` (loopback UI server).

| Route | `kind` | `data` shape | Notes |
|-------|--------|--------------|-------|
| `GET /api/health` | `health` | object: `root`, `concepts`, `version`, `searchMode` | |
| `GET /api/settings` | `settings` | object: `root`, `configPath`, `globalConfigPath`, `features` | Absolute paths. |
| `GET /api/status` | `status` | same keys as CLI status | **Has** `generatedAt` (unlike CLI). |
| `GET /api/doctor` | `doctor` | same as CLI doctor | Compact JSON (unlike pretty CLI). Probe always off. |
| `GET /api/board` | `board` | same as CLI board | |
| `GET /api/handoff` | `handoff` | same as CLI handoff | |
| `GET /api/fleet` | `fleet` | same as CLI fleet | **Has** `generatedAt`. |
| `GET /api/ledger` | `ledger` | same as CLI ledger | **Has** `generatedAt`. |
| `GET /api/concepts` | `concepts` | **array** of `{ id, title, type, tags, status, date }` | Optional query: `type`, `tag`, `q`. |
| `GET /api/concept/<id>` | `concept` | object: `id`, `frontmatter`, `body` | 404/400 use bare error form (§3). |
| `GET /api/graph` | `links` | same as `query links` | kind is **`links`**, not `graph`. |
| `GET /api/voice/probe` | `voice-probe` | availability + `url` + `probe` | Never runs on render path by design. |
| `GET /api/voice/route?text=&confidence=` | `voice-route` | intent decision + `threshold` + `quarantine` | Read-only routing. |
| `POST /api/config` | success → `settings` | re-read settings model | Only write route. Failures: §3. |
| `GET /api/events/stream` | SSE | first frame on connect is envelope `kind: "ledger-snapshot"` (`event: snapshot`, `data.events[]`); subsequent frames are `kind: "ledger-event"` | Not a single JSON body; stream of envelopes. |

### 2.4 Nested shapes worth naming (from live wire)

**Board / handoff document card** (Task/Plan/Session/etc. from the loader):

```
file, id, base, reserved, fm, hasFM, body, links, relations, supersedes, supersededBy
```

`file` is an **absolute path**. `hasFM` is a boolean. Both are on the wire today; see §5 drift.

**Board ledger-derived card** (no Task doc):

```
id ("ledger:<topic>"), title, type, source: "ledger", ts, actor, action
```

Flat — no `fm`, no `file`, no `hasFM`. Readers must not assume every column item is a Doc.

**Handoff `recentDecisions` item:** `{ d: <Doc>, date, age }`.  
**Handoff `sessionNext`:** `string[]` (bullets), not docs.  
**Handoff `lastSession`:** Doc or `null`.

**Ledger event** (openFailures, topic.last, topic.evs):

```
ts, actor, topic, phase, status, action, artifact, ref, quarantine, matches
```

**Fleet engine row:**

```
id, role, status, lastSeen, silentSec, heartbeatSec, overdue
```

**Doctor engine row:** `{ id, label, states: { supported, installed, connected, verified, active } }` — each state object’s key set **varies** by skip/probe path (§4).

**Settings `features.voice` / `features.vision`:** `{ values, layers, state, available, …optional reason|fix|note }` (§4).

---

## 3. Error form (HTTP)

Successful JSON uses the envelope. Failures do **not**.

### Observed live

| Situation | Status | Body |
|-----------|--------|------|
| Unknown `/api/*` | 404 | `{ "error": "not found" }` |
| Bad concept id | 400 | `{ "error": "invalid concept id" }` |
| Missing concept | 404 | `{ "error": "not found" }` |
| Wrong method on write-only path / non-write | 405 | `{ "error": "method not allowed" }` |
| Host / origin guard | 403 | `{ "error": "forbidden host" }` or `{ "error": "forbidden origin" }` |
| Invalid JSON body on `POST /api/config` | 400 | `{ "error": "invalid JSON body" }` |
| Validation reject on `POST /api/config` | 400 | `{ "error": "rejected", "errors": [ "…", … ] }` |
| Body > 64 KiB | 413 | `{ "error": "body too large" }` |
| Internal throw | 500 | `{ "error": "<message>" }` |

Validation always returns **every** problem in `errors[]` (not only the first). Example live:

```json
{"error":"rejected","errors":["\"voice.confidenceThreshold\" expects number","\"voice.confidenceThreshold\" must be between 0 and 1"]}
```

### Decided (frozen for 1.0): errors stay bare

Errors are bare `{ error }` / `{ error, errors }` **without** `contract` / `kind` / `generatedAt`. That is the current wire, confirmed uniform across every failure path in `tools/lib/ui-server.mjs` — the sole error constructor `sendJson(res, status, obj)` (`tools/lib/ui-server.mjs:60`) is called with a bare `{ error }` or `{ error, errors }` object at all 24 call sites, e.g. 400 invalid concept id (`tools/lib/ui-server.mjs:430`), 404 not found (`tools/lib/ui-server.mjs:435`, `:517`, `:526`), 403 host/origin guard (`:458`), validation reject with `errors[]` (`:268`), and 500 internal throw (`:544`). No call site ever emits an enveloped error.

**Decision:** errors keep this bare form after 1.0 — it is not wrapped in `{ contract, kind, generatedAt, data }`. Moving error bodies into that envelope (`kind: "error"`) is itself a **breaking (major)** change to the error surface, not a silent patch.

---

## 4. Consumer traps

### 4.1 Truncated arrays without a total

| Place | Cap | Total field? |
|-------|-----|--------------|
| Board `openFailuresShown` | `OPEN_FAILURES_LIMIT` = 5 | **yes** — `openFailuresTotal` |
| Board `overdueEnginesShown` | `OVERDUE_ENGINES_LIMIT` = 5 | **yes** — `overdueEnginesTotal` |
| Board ledger-derived cards per column | `LEDGER_DERIVED_CAP` = 8 | **yes** — `ledgerOverflow.<col>` and `columnTotals` |
| Board `done` (Task docs) | `doneLimit` (default 10) | Partial honesty: `doneLimit` is exposed; heading is “last N”. `columnTotals.done` counts the **shown window + ledger overflow**, not all historical done tasks. |
| Board `sessions` | `SESSION_SUMMARY_LIMIT` = 3 | **yes** — `sessionsTotal` (added 0.17.0) |
| Ideas columns | uncapped in model | lengths are full for that status filter |
| Handoff `sessionNext` | first **5** bullets | **yes** — `sessionNextTotal` (added 0.17.0) |
| Ledger `read` (human CLI, not status --json) | default last 200 | status `--json` returns full `evs` per topic today |

Rule of thumb: **never** treat `array.length` as a KPI unless a `*Total` / `columnTotals` / `overflow` field exists for that list.

### 4.2 Fields that are sometimes `null`, sometimes absent

**Settings / voice availability** (`assessAvailability` in `tools/lib/settings.mjs`):

| State | Present keys (beyond `state`, `available`) |
|-------|--------------------------------------------|
| `unavailable` (no `serviceUrl`) | `reason`, `fix` — no `note` |
| `configured` (url set, not probed) | `note` — no `reason`/`fix` |
| `reachable` (after probe) | `note` — no `reason`/`fix` |
| Vision (always unavailable today) | `reason`, `fix: null` |

`GET /api/voice/probe` folds the same machine and always adds `url` and `probe` (`probe` may be `null`).

**Doctor state objects:**

| Situation | Shape |
|-----------|--------|
| Skipped step (`skip()`) | `{ ok: false, skipped: true }` — **no** `reason` |
| Connected + `--no-probe` / HTTP doctor | verified: `{ ok: false, skipped: true, reason: "probe-skipped" }` |
| Engine not connected | `active` stays skip-shaped; when connected, `active` is replaced by the **bundle** active object |
| Bundle active when root known | `{ ok, state, intervalSec, lastError, targets }` (`lastError` often `null`) |
| Bundle active when root unknown | `{ ok: false, state: "unknown" }` — **missing** `intervalSec` / `lastError` / `targets` |

Optional fields on verified success paths (`health`, `serverInfo`, …) appear only when a real probe ran.

**Nulls that stay keys** (present, value `null`): status `ageSec`/`ok`/`lastError`/`version`/`ts` when projection never ran; handoff `projectKey` / `lastSession`; board `project`; ledger `artifact`/`ref`/`openFail`; voice `serviceUrl`.

### 4.3 Machine-local / host-bound data in responses

These leave the machine boundary; treat as **local-only**, not for cross-host caches or public paste without scrubbing:

| Field / area | What leaks |
|--------------|------------|
| Board/handoff doc `file` | Absolute path under the bundle root |
| Doctor `node`, `platform` | Node version string, OS platform |
| Doctor `root.path` / `root.realpath` | Absolute bundle paths |
| Doctor `engines[].states.installed.evidence` | Absolute config paths under `$HOME` |
| Doctor `engines[].states.connected.locations[]` | `file`, `command`, `args` (absolute), `env` (values redacted for secrets but **paths and OKF_ROOT remain**) |
| Settings `root`, `configPath`, `globalConfigPath` | Absolute paths (`globalConfigPath` uses `$HOME`) |
| Health `root` | Absolute path |
| MCP `memory_health.root` | Absolute path |
| MCP `memory_get.content` | Full file text from disk |

`doctor` env redaction is intentional for secrets; it is **not** a general PII/path scrubber.

---

## 5. Drift: wire vs `ui/src/api.ts` (and vs old specs)

Confirmed on live board/handoff JSON vs `Doc` in `api.ts`:

| Wire field | In `api.ts` `Doc`? |
|------------|--------------------|
| `file` | **missing** |
| `hasFM` | **missing** |

Other known mismatches:

| Topic | Wire | `api.ts` / old docs |
|-------|------|---------------------|
| Envelope always has `generatedAt` | CLI status/fleet/ledger/links omit it | `Envelope<T>` requires `generatedAt: string` |
| Graph kind | `"links"` | consumers may expect `"graph"` from the URL path |
| Ledger events | include `matches: string[]` | `LedgerEvent` type omits `matches` |
| Concepts list | `data` is an **array** | easy to type as object |
| Proactive | no envelope | not modeled in UI types |
| ui-spec board table | still says `openFailures` / `overdueEngines` | wire uses `openFailuresShown` + `*Total` and `overdueEnginesShown` + `*Total` |

`api.ts` header claims types were read off the wire; they already lag. **Do not regenerate this document from `api.ts`.**

---

## 6. Breaking-change policy after 1.0

**The rule:** changing the **form** of an existing field — its JSON type, its nesting/structure, the semantics of its value, or its name (rename or removal) — is a **major** version bump. Adding a new *optional* field is **minor**. Within any minor or patch release, no field already on a documented surface is removed or changes type.

### Breaking (requires major)

- Remove or rename a field that is part of a documented surface.
- Change the JSON type of a field (e.g. string → number, object → array).
- Change the meaning of a field while keeping the name (e.g. `sessions.length` starts meaning “total sessions”).
- Remove a `kind` value consumers rely on, or change which route emits which `kind`.
- Move success payloads out of the envelope, or put success fields only on errors (or the reverse) without a major.
- Change default caps in a way that alters semantics of length-as-count **without** totals (still breaking if consumers were told length was complete).

### Non-breaking (minor / patch)

- Add a new optional field on an existing object.
- Add a new `kind` and/or new route/command that does not change old kinds.
- Add a new total/overflow field next to a previously truncated list.
- Add `generatedAt` where it was missing (strict clients that reject unknown keys are not the baseline; unknown-field tolerance is assumed).
- Add new enum-like string values only if documented as open-ended (prefer additive).
- Tighten validation on **writes** in a way that rejects previously accepted bad input may be major if it was documented as accepted; prefer minor with clear changelog when the old acceptance was a bug.

### Process

1. Change the live wire.  
2. Update **this file** in the same PR.  
3. Bump `contract` only when the envelope generation itself changes in a coordinated way (rare).  
4. After 1.0: package **major** for breaking; **minor** for additive.

---

## 7. MCP — separate surface, separate fate

Ten tools in `tools/lib/mcp.mjs`:

`memory_search`, `memory_get`, `memory_list`, `memory_write_inbox`, `memory_handoff`, `memory_health`, `memory_ledger_append`, `memory_ledger_status`, `memory_fleet_status`, `memory_fleet_assign`.

### Transport shape (not the CLI envelope)

Successful tool result:

```json
{
  "content": [
    { "type": "text", "text": "<pretty-printed JSON of the tool payload>" }
  ]
}
```

Errors: `isError: true` with text `Error [<code>]: <message>` (and machine codes where handlers set `err.code`). **No** `{ contract, kind, generatedAt, data }` wrapper around the tool payload.

The JSON **inside** `text` is the MCP contract. It is pretty-printed (`null, 2`).

### Representative payloads (from handlers, not CLI)

| Tool | Payload sketch |
|------|----------------|
| `memory_search` | `{ query, mode, warning, count, results[{ id, type, title, score, snippet, hygiene, source? }], expanded? }` — see §7.1 for `expanded` shape (1.1 additive `kind`) |
| `memory_get` | `{ found, id }` or `{ found, id, type, title, visibility, tags, content }` — full raw file in `content` |
| `memory_list` | `{ count, items[{ id, type, title, visibility }] }` |
| `memory_write_inbox` | `{ ok, agent, file, quarantined, matches, bytesWritten }` |
| `memory_handoff` | `{ markdown, project, days, sections, warnings }` — **not** `buildHandoffModel` |
| `memory_health` | `{ root, concepts, searchMode, embedUrl, heatTiers, version }` |
| `memory_ledger_append` | `{ ok, actor, topic, phase, status, quarantine, matches }` (+ `deduped` path) |
| `memory_ledger_status` | `{ topics[{ topic, count, open, last }], openFailures }` — thinner than CLI ledger `topics` (no full `evs`) |
| `memory_fleet_status` | `{ registry, stopPoints?, engines, overdue }` or no-registry message shape |
| `memory_fleet_assign` | `{ ok, engine, topic, … }` or `{ ok, deduped: true, … }` |

### Critical: `memory_handoff` ≠ `handoff --json`

| | CLI / HTTP handoff | MCP `memory_handoff` |
|--|--------------------|----------------------|
| Envelope | `{ contract, kind: "handoff", generatedAt?, data }` | none |
| Work model | Structured arrays of docs (`active`, `blocked`, …) | Markdown brief + `sections` + `warnings` |
| Purpose | UI / machine board consumers | Agent session start brief |

Do **not** share types between them. MCP may evolve on its own cadence; folding MCP into the HTTP envelope without a major of the MCP tool API would be a separate decision.

### 7.1 `memory_search` — `expanded` block (1.1 additive)

Omitted when `expand` is false or absent — payload shape is **byte-identical to
1.0** (no `expanded` key). When `expand: true`, neighbors appear only in
`expanded`, never merged into `results`.

Each `expanded[]` element (live wire, since 1.1):

```json
{
  "id": "concepts/retrieval-strategy",
  "type": "Concept",
  "title": "Retrieval strategy",
  "kind": "depends_on",
  "hop": 1,
  "expandedFrom": "projects/lumen",
  "snippet": "…",
  "hygiene": "optional — same labels as primary hits when include_superseded pulls stale neighbors"
}
```

| Field | Since | Notes |
|-------|-------|-------|
| `id`, `type`, `title`, `snippet` | G2 (0.9+) | Unchanged |
| `kind` | **1.1** | Canonical read-side edge kind (`about`, `member_of`, `depends_on`, `uses`, `agreed_with`, `informs`, `related`, `cites`). **Optional** on the wire only in the sense that pre-1.1 clients never saw `expanded`; within 1.1+ `expand: true` responses, every row carries `kind`. |
| `hop` | **1.1** | Always `1` today (1-hop ceiling) |
| `expandedFrom` | G2 | Seed hit id this neighbor was pulled from |

Input (additive, non-breaking):

| Parameter | Type | Default | Parity |
|-----------|------|---------|--------|
| `expand` | boolean | false | CLI `--expand` |
| `expand_budget` | integer | 5 | CLI `--expand-budget N` |
| `include_superseded` | boolean | false | CLI `--include-superseded` — stale neighbors in `expanded` get the same hygiene labels as primary hits |

### MCP policy after 1.0

Treat MCP tool JSON-in-text as a **second contract**:

- Breaking changes to tool result keys → major (or a dedicated MCP contract version field if introduced later).  
- Adding tools or optional result fields → non-breaking.  
- Never silently make MCP results use the CLI envelope (or vice versa) without a major of the surface being changed.

---

## 8. How this document was verified

Live commands (demo root), non-exhaustive list:

```bash
node bin/samemind.mjs board --json
node bin/samemind.mjs handoff --json
node bin/samemind.mjs status --json
node bin/samemind.mjs doctor --json --no-probe
node bin/samemind.mjs fleet status --json
node bin/samemind.mjs ledger status --json
node bin/samemind.mjs query links --json
node bin/samemind.mjs proactive "…" --json

node bin/samemind.mjs ui --root demo --port 7850 &
curl -s http://127.0.0.1:7850/api/{health,settings,status,doctor,board,handoff,fleet,ledger,concepts,graph,voice/probe}
curl -s "http://127.0.0.1:7850/api/voice/route?text=тест&confidence=0.9"
# POST /api/config validation and success with Origin
```

Caps and null/optional fields cross-checked in `tools/board.mjs`, `tools/handoff.mjs`, `tools/doctor.mjs`, `tools/lib/settings.mjs`, `tools/lib/ui-server.mjs`, `tools/lib/mcp.mjs`.

When in doubt, re-run the wire — not the types.

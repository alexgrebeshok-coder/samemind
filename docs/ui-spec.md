# samemind ui — dashboard specification (v1)

Local web dashboard over one samemind bundle: what the memory knows, what work is
in flight, which engines are alive, and how concepts connect. Served by `samemind ui`
(node:http, 127.0.0.1 only), SPA lives in `dist/`. This file is the build contract for the
frontend: every section below is REQUIRED unless marked optional — see the acceptance
checklist at the end.

## 0. Hard constraints

- **Memory read-only.** The UI never mutates the OKF bundle (no inbox, ledger, fleet dispatch, or
  canon promotion). **Settings writes are allowed:** exactly one route, `POST /api/config`, updates
  `voice` / `vision` in `.samemind/config.json` (see `WRITE_ROUTES` in `tools/lib/ui-server.mjs`,
  guarded by `tools/lib/http-guard.mjs`). Consequential commands are shown for copy only.
- **Self-contained.** No CDN, no external fonts, no network calls other than same-origin
  `/api/*`. Everything ships in `dist/`.
- **Stack:** Vite + React + TypeScript + Tailwind. No component libraries (no MUI/antd);
  no chart libraries — the visualizations below are simple enough for hand-rolled SVG.
- **Security:** never render markdown/concept bodies via `dangerouslySetInnerHTML` unless the
  HTML went through a sanitizer bundled locally; default to rendering markdown as escaped text
  with minimal own formatting (headings, lists, code fences, links — links rendered inert,
  `rel="noopener"`, never auto-followed).
- **Theming:** light + dark via `prefers-color-scheme`, plus a manual toggle (persisted in
  `localStorage`). Both themes are first-class — check every screen in both.
- **A11y basics:** semantic landmarks, focus states, contrast ≥ WCAG AA, keyboard navigation
  for tabs/lists.
- **No placeholder lorem ipsum** anywhere; empty states are designed (see §5).

## 1. Data source — API contract

All data comes from same-origin JSON endpoints (shape: `{ contract: 1, kind, generatedAt,
data }`). The dev fixture is the `demo/` bundle (`OKF_ROOT=demo samemind ui`) — it has
non-empty fleet, ledger, failures and overdue sections.

| Endpoint | kind | data (summary) |
|---|---|---|
| `/api/health` | health | root path, concept count, search mode, version |
| `/api/board` | board | backlog / inprog / blocked / done, plans, ideas (spark/incubating/adopted), recent, sessions, openFailures, overdueEngines |
| `/api/handoff` | handoff | active tasks, decisions, plans, last session |
| `/api/fleet` | fleet | engines: id, role, status, lastSeen, silentSec, heartbeatSec, overdue; stopPoints |
| `/api/ledger` | ledger | topics: topic, last event, count, openFail; openFailures list |
| `/api/concepts?type=&tag=&q=` | concepts | list: id, title, type, tags, status, date |
| `/api/concept/<id>` | concept | frontmatter + raw markdown body |
| `/api/graph` | links | nodes {id,title,type}, edges {from,to,kind:relation\|link, rel?}, orphans, broken |
| `/api/settings` | settings | root, config paths, `features.voice` / `features.vision` (values + layers + availability) |
| `/api/status` | status | projection liveness (same keys as `samemind status --json`) |
| `/api/doctor` | doctor | connection report (`probe: false` — no spawn on dashboard GET) |
| `GET /api/voice/probe` | voice-probe | on-demand companion reachability |
| `GET /api/voice/route` | voice-route | read-only intent gate |
| `POST /api/config` | settings | validated patch → re-read settings (sole write) |
| `GET /api/events/stream` | SSE | ledger events (`kind: ledger-event` per event) |

Field names are authoritative in the endpoint responses, not in this table — fetch once,
type from the actual payload. `score`-like fields are display-only, never re-sorted client-side.

## 2. Layout shell

- Left sidebar (collapsible at <900px into a top bar): product mark "samemind", nav items
  **Today · Overview · Memory · Fleet · Projects · Voice · Settings**, theme toggle, and a footer chip with bundle root
  path + version from `/api/health`.
- Content area with a slim header: current screen title + `generatedAt` freshness stamp
  ("updated 12s ago", auto-refresh every 30s, manual refresh button).
- Responsive: usable at 1280px (primary), degrades gracefully to 768px (single column).

## 3. Screens

### 3.0 Today  (`/today`)

1. **Work now** — in-flight and blocked counts from `/api/board` `columnTotals` (not raw array lengths).
2. **Recovery** — cards with the exact CLI command and one-click copy (`Cmd`); never auto-run.
3. **Recent decisions** — from board/handoff-shaped data where present.

### 3.1 Overview  (`/`)

Checklist — ALL required:
1. **KPI strip** (4 stat tiles): concepts total, tasks in progress, open failures, overdue
   engines. Failures/overdue tiles turn red-accented when > 0.
2. **Kanban** — 4 columns Backlog / In progress / Blocked / Done from `/api/board`; card =
   title, project chip, age. Blocked cards show `blocked_reason` on hover/expand. Cards with
   no matching Task doc are synthesized from ledger topics (`source: 'ledger'`) and carry a
   small grey "ledger" chip instead of a project chip, plus the topic's last `action` as a muted
   second line (one line, ~90 chars) — a bare topic like `sub:a39fbe85` is unreadable on its own.
3. **🔥 Open failures** panel — list with topic, age, last action; empty state per §5.
4. **🔥 Overdue engines** panel — engine id, role, silence duration vs heartbeat limit.
5. **Ideas strip** — spark / incubating / adopted counts with a compact segmented bar.
6. **Recent activity** — last 10 board "recent" items with dates.

### 3.2 Memory  (`/memory`)

1. **Search bar** (queries `/api/concepts?q=`), plus type filter (dropdown of types present)
   and tag filter.
2. **Concept list** — virtualized if >200; row = title, type badge, tags, date, status.
3. **Concept view** (right pane or route `/memory/<id>`): frontmatter as a definition list
   (type, status, visibility, tags, dates, relations as links), body rendered per §0 security
   rule; outbound relations and "cited by" (from `/api/graph` reverse edges) as link chips.
4. **Graph view** (toggle within Memory): force-directed or concentric SVG of `/api/graph`,
   max ~300 nodes (over budget → show top-connected + note), node color by type, click →
   concept view; orphans and broken links listed under the graph.

### 3.3 Fleet  (`/fleet`)

1. **Engine roster** — table: id, role badge (director/executor/reserve), status,
   last seen (relative), heartbeat limit, silence bar (silentSec/heartbeatSec, red when
   overdue). Never-seen engines: "never" + full-width red bar.
2. **Naryad timeline** — `/api/ledger` topics as horizontal lanes; events as dots
   (start ▶ step · done ✓ fail ✕ block ⏸) with tooltip (actor, action, ts). Most recent
   15 topics, newest on top.
3. **Open failures** — same data as Overview but full list with actions/refs.
4. **Stop points** — static chips row from `/api/fleet` stopPoints (prod-deploy, money, …)
   with a one-line caption "the pipeline halts before these by design".

### 3.4 Projects  (`/projects`)

A bundle can hold many Project docs and no Task docs at all (the live one does: 34 projects, 0
tasks). Task counts alone therefore say nothing — a card must stand on the doc's own facts.

1. **Project cards** — one per `projects/` doc, the whole card a link to its detail route:
   - title + type badge;
   - `status` chip from the doc's own frontmatter, when it has one (most don't — no placeholder);
   - **links count** — distinct graph neighbours of the project node from `/api/graph`, inbound and
     outbound folded together, self-loops dropped (`neighbourIds`); shown only when > 0;
   - last activity (latest of the doc's own date and its board cards' dates);
   - 1–2 lines of `description` from frontmatter (clamped, full text on hover). `/api/concepts`
     returns a slim row without it, so the grid fetches `/api/concept/<id>` per project once per
     id-set — not on every refresh tick;
   - task counts by column **only when the project has at least one card**; otherwise a single
     muted line "no linked tasks". A 0/0/0/0 strip on every card is noise, not information.
2. **Project detail** (route `/projects/<id>`): back button, title + status chip + id, description,
   frontmatter mini-table (type/status/visibility/tags/date/source), the doc body rendered through
   the same escaped-markdown renderer as Memory's concept view (§0), linked concepts as chips
   (graph neighbours, labelled with node titles, click → concept view), and the filtered board —
   again only when the project has cards, else one muted line.

### 3.5 Voice  (`/voice`)

1. **Companion state** — unavailable / configured / reachable (probe via `/api/voice/probe` only).
2. **Intent preview** — `/api/voice/route` gate; microphone capture is out of scope for core UI.
3. **Consent copy** — three separate voice consents reflected in settings model.

### 3.6 Settings  (`/settings`)

1. **Voice + vision toggles** — effective values with layer chips (default / global / project).
2. **Save** — `POST /api/config`; on success, re-fetch server state (not optimistic-only).
3. **Unavailable capabilities** — render as unavailable, not a silent unchecked box.

## 4. Design tokens

- Type: system font stack (`ui-sans-serif, -apple-system, …`); numbers in stat tiles bold,
  tabular-nums.
- Radius 12px cards, 1px borders; spacing scale 4/8/12/16/24; spacious, not cramped.
- Light: near-white bg (#fafaf9), ink #1c1917, borders #e7e5e4.
  Dark: #0c0a09 bg, #e7e5e4 ink, #292524 borders.
- One accent: **amber-600** (light) / **amber-400** (dark) — links, active nav, primary
  chips. Semantic reds/greens only for failure/success signals. No purple gradients.
- Type badge palette (consistent across list, graph, kanban): Task=sky, Plan=violet,
  Decision=emerald, Project=amber, Concept=stone, Session=rose, Idea=lime, others=slate.

## 5. Empty & error states (all designed, not blank)

- No fleet registry → Fleet screen shows "No fleet registry — `samemind fleet init`" card.
- No ledger → timeline area shows "No events yet — `samemind ledger append …`".
- Zero failures/overdue → green check chip "all quiet".
- API unreachable → full-width banner "server stopped — restart `samemind ui`", stale data
  kept visible, dimmed.
- Search with no hits → "nothing found for ⟨q⟩" + clear-filters button.

## 6. Acceptance checklist (verified in review, both themes)

- [ ] 7 screens (Today, Overview, Memory, Fleet, Projects, Voice, Settings), every numbered item above present
- [ ] both themes pass contrast; toggle persists
- [ ] demo fixture renders non-empty failures + overdue + timeline
- [ ] live bundle (123 concepts) renders <1s after load; list virtualization holds
- [ ] no external network requests (inspect network tab)
- [ ] no `dangerouslySetInnerHTML` without sanitizer (grep)
- [ ] keyboard: tab through nav, lists, graph nodes reachable
- [ ] empty states per §5 reachable and styled
- [ ] `npm run build` → `dist/` served by `samemind ui` works from the packed tarball

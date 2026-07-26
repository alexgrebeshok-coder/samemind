#!/usr/bin/env node
// board.mjs — samemind board: a human-facing kanban over the work-discipline layer
// (Plan / Task / Decision / Session — see docs/work-discipline.md) plus the
// knowledge-cycle layer (Analysis / Research / Idea — see docs/knowledge-cycle.md).
// Reads the bundle's current state and renders a markdown board: who owes what,
// what's moving, what's blocked (and for how long), what just landed, what was
// recently agreed, and what candidate ideas are incubating.
//
//   node tools/board.mjs [--write] [--project <path>] [--html [--out <file>]] [--json]
//
// --write            atomic-write the board to <bundle-root>/DASHBOARD.md (committed
//                     feature — DASHBOARD.md is tracked, not gitignored). Default: stdout.
// --project <path>   scope the four task columns to one project (matched against the
//                     Task `relations.project` field). Plans / Ideas / Recent / Sessions
//                     stay portfolio-wide — they are cross-cutting state, not project-scoped.
// --html             render a self-contained HTML projection instead of markdown (no CDN/JS,
//                     light+dark via prefers-color-scheme) — see tools/lib/html-render.mjs.
//                     Prints to stdout, or atomic-writes to --out <file>.
// --json             print `{ contract: 1, kind: 'board', generatedAt, data: buildBoardModel() }`
//                     as one line to stdout — a versioned foundation for a future UI. Incompatible
//                     with --write/--html (pick one projection). Never atomic-written.
//
// The board is a pure function of parsed docs (lib/okf.mjs `load()`); `now` is injectable
// so aging/davnost is deterministic in tests. No volatile timestamp is baked into the
// output, so `--write` is idempotent: same bundle state → same bytes.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, ROOT, pathToId } from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { readEvents, summarizeLedger } from './lib/ledger.mjs';
import { readRegistry, heartbeat } from './lib/fleet.mjs';

export const DASHBOARD_NAME = 'DASHBOARD.md';

const DAY_MS = 86_400_000;
const DEFAULT_DONE_LIMIT = 10;
const DEFAULT_RECENT_DAYS = 7;
const SESSION_SUMMARY_LIMIT = 3;
export const AGING_THRESHOLD_DAYS = 7;     // blocked older than this is flagged "aging"
export const OPEN_FAILURES_LIMIT = 5;      // event-ledger 🔥 Open failures: shown cap (see docs/event-ledger.md)
export const OVERDUE_ENGINES_LIMIT = 5;    // fleet 🔥 Overdue engines: shown cap (see docs/fleet.md)
const DESC_MAX = 140;

// Plans shown on the board: active planning states. `done` and `superseded` are history
// (a finished/replaced plan is not something you're working — it's the record). See
// docs/work-discipline.md.
const ACTIVE_PLAN_STATUS = new Set(['draft', 'agreed', 'in-progress']);

const typeOf = d => String(d.fm?.type || '').trim().toLowerCase();
export const statusOf = d => String(d.fm?.status || '').trim().toLowerCase();

// The following small accessors are exported (not just module-private) so the `--html`
// projection (tools/lib/html-render.mjs) can render exactly the same fields the markdown
// board does, without re-deriving or re-parsing anything.
export function titleOf(d) {
  return String(d.fm?.title || '').trim() || String(d.id).split('/').pop();
}

/** Bundle-absolute markdown link to a doc: /projects/foo.md */
export function linkOf(d) {
  return `/${d.id}.md`;
}

/** One-line description: frontmatter `description`, falling back to the first prose line of the body. */
export function oneline(d) {
  let s = String(d.fm?.description || '').trim();
  if (!s) {
    for (const line of String(d.body || '').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('>')) continue;
      s = t;
      break;
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > DESC_MAX) s = s.slice(0, DESC_MAX - 1).trimEnd() + '…';
  return s;
}

/** Epoch ms of a doc, from `timestamp` (falling back to `date`). NaN if unknown. */
function tsOf(d) {
  const raw = String(d.fm?.timestamp || d.fm?.date || '').trim();
  if (!raw) return NaN;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? NaN : t;
}

/** Whole days between `now` and the doc's timestamp (>= 0 if the doc is in the past). NaN if unknown. */
export function ageDays(d, nowMs) {
  const t = tsOf(d);
  if (!Number.isFinite(t)) return NaN;
  return Math.floor((nowMs - t) / DAY_MS);
}

/** YYYY-MM-DD for display (prefers `date`, falls back to the timestamp day). */
export function dateOf(d) {
  const raw = String(d.fm?.date || '').trim();
  if (raw) return raw.slice(0, 10);
  const t = tsOf(d);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

const byTsDesc = (a, b) => (tsOf(b) || 0) - (tsOf(a) || 0);
const byTsAsc = (a, b) => (tsOf(a) || 0) - (tsOf(b) || 0);   // oldest first (surface stale blockers)

/** Normalize a project path/id to a comparable stem: `/projects/lumen.md` → `projects/lumen`. */
export function normProj(p) {
  return String(p || '').trim().replace(/^\/+/, '').replace(/\.md$/, '');
}

/** Does this Task belong to `filter`? Matches relations.project by stem (lumen / projects/lumen / …). */
function taskProjectMatches(d, filter) {
  if (!filter) return true;
  const want = normProj(filter);
  if (!want) return true;
  const rel = d.relations || d.fm?.relations || {};
  const projects = Array.isArray(rel.project) ? rel.project : (rel.project ? [rel.project] : []);
  return projects.some(p => {
    const n = normProj(p);
    return n === want || n.endsWith('/' + want);
  });
}

function renderTask(d, nowMs) {
  const lines = [`- **[${titleOf(d)}](${linkOf(d)})** — ${oneline(d)}`];
  if (statusOf(d) === 'blocked') {
    const reason = String(d.fm?.blocked_reason || '').trim();
    if (reason) lines.push(`  - ⛔ ${reason}`);
    const age = ageDays(d, nowMs);
    if (Number.isFinite(age) && age >= 0) {
      lines.push(`  - ⏳ ${age}d${age >= AGING_THRESHOLD_DAYS ? ' (aging)' : ''}`);
    }
  }
  return lines.join('\n');
}

function renderPlan(d) {
  return `- **[${titleOf(d)}](${linkOf(d)})** · ${statusOf(d) || '?'} — ${oneline(d)}`;
}

/** First bundle path out of a relation value (scalar or list), or null. */
export function firstRelPath(d, key) {
  const rel = d.relations || d.fm?.relations || {};
  const v = rel[key];
  const first = Array.isArray(v) ? v[0] : v;
  return first ? String(first).trim() : null;
}

function renderIdea(d) {
  return `- **[${titleOf(d)}](${linkOf(d)})** — ${oneline(d)}`;
}

/** Adopted idea → compact line pointing at the Plan it became (`relations.led_to`). */
function renderAdoptedIdea(d, byId) {
  const target = firstRelPath(d, 'led_to');
  let arrow = '';
  if (target) {
    const plan = byId.get(pathToId(target));
    arrow = plan ? ` → [${titleOf(plan)}](${linkOf(plan)})` : ` → ${target}`;
  }
  return `- **[${titleOf(d)}](${linkOf(d)})** · adopted${arrow}`;
}

function renderRecent(d) {
  const t = String(d.fm?.type || '').trim() || '—';
  return `- **[${titleOf(d)}](${linkOf(d)})** · ${t} — ${oneline(d)}`;
}

function renderSession(d) {
  const date = dateOf(d);
  return `- [${titleOf(d)}](${linkOf(d)})${date ? ` · ${date}` : ''} — ${oneline(d)}`;
}

/** One line for a 🔥 Open failures entry: `summarizeLedger`'s open-failure event, plus `topic`. */
export function renderOpenFailure(f) {
  const when = String(f.ts || '').slice(0, 16).replace('T', ' ');
  const tail = f.artifact ? ` \`${f.artifact}\`` : '';
  return `- **${f.topic}** — ${f.action} _(${f.actor}, ${f.phase}/${f.status}, ${when})_${tail}`;
}

/** Most-silent first: never-seen (silentSec null) sorts ahead of any finite silence. */
const bySilenceDesc = (a, b) => {
  const as = a.silentSec === null || a.silentSec === undefined ? Infinity : a.silentSec;
  const bs = b.silentSec === null || b.silentSec === undefined ? Infinity : b.silentSec;
  return bs - as;
};

/** One line for a 🔥 Overdue engines entry: `heartbeat()`'s row for one silent engine. */
export function renderOverdueEngine(r) {
  const seen = r.lastSeen ? String(r.lastSeen).slice(0, 16).replace('T', ' ') : 'never seen';
  const silent = r.silentSec === null || r.silentSec === undefined ? '∞' : `${r.silentSec}s`;
  return `- **${r.id}** — ${r.role}, silent ${silent} (limit ${r.heartbeatSec}s) _(last seen ${seen})_`;
}

/** Append a `## heading (n)` section with items; `_(empty)_` when empty. */
function section(L, heading, items, render, nowMs) {
  L.push(`## ${heading} (${items.length})`, '');
  if (!items.length) { L.push('_(empty)_'); }
  else { for (const it of items) L.push(render(it, nowMs)); }
  L.push('');
}

/**
 * Build the board's data model for a bundle: the same filtering/sorting/columns that
 * `buildBoard` renders to markdown, but as plain arrays/maps — no rendering. This is the
 * single source of truth for both the markdown board and the `--html` projection
 * (tools/lib/html-render.mjs): both consume this model, neither re-derives it nor re-parses
 * the other's output. Pure function of `docs` (from lib/okf.mjs `load()`) and options; `now`
 * (epoch ms or Date) is injectable so davnost/aging is deterministic in tests.
 */
export function buildBoardModel(docs, {
  now = Date.now(),
  doneLimit = DEFAULT_DONE_LIMIT,
  recentDays = DEFAULT_RECENT_DAYS,
  project = null,
  openFailures = [],
  overdueEngines = [],
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const cs = (docs || []).filter(d => !d.reserved);

  // Event ledger 🔥 Open failures (docs/event-ledger.md): not bundle concepts — the caller
  // (this module's `main()`) reads `ledger/events.jsonl` and passes the already-summarized
  // open-failure list in, so this function stays a pure function of its arguments, same as
  // every other input here. Freshest first, capped for display; total kept for the heading.
  const openFailuresTotal = openFailures.length;
  const openFailuresShown = [...openFailures]
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, OPEN_FAILURES_LIMIT);

  // Fleet 🔥 Overdue engines (docs/fleet.md): same discipline as Open failures — the caller
  // reads fleet/registry.json + the ledger and passes already-computed `heartbeat()` rows
  // (pre-filtered to `overdue: true`) in, so this stays a pure function of its arguments.
  // Unlike Open failures, an empty list means the section is OMITTED entirely (see buildBoard)
  // — most bundles have no fleet registry at all, and a permanent "(0)" heading would be noise.
  const overdueEnginesTotal = overdueEngines.length;
  const overdueEnginesShown = [...overdueEngines].sort(bySilenceDesc).slice(0, OVERDUE_ENGINES_LIMIT);

  const tasks = cs.filter(d => typeOf(d) === 'task');
  const inProject = d => taskProjectMatches(d, project);

  const backlog = tasks.filter(d => statusOf(d) === 'backlog' && inProject(d)).sort(byTsDesc);
  const inprog = tasks.filter(d => statusOf(d) === 'in-progress' && inProject(d)).sort(byTsDesc);
  const blocked = tasks.filter(d => statusOf(d) === 'blocked' && inProject(d)).sort(byTsAsc);
  const done = tasks.filter(d => statusOf(d) === 'done' && inProject(d))
    .sort(byTsDesc).slice(0, doneLimit);

  const plans = cs.filter(d => typeOf(d) === 'plan' && ACTIVE_PLAN_STATUS.has(statusOf(d)))
    .sort(byTsDesc);

  // Knowledge-cycle Ideas (see docs/knowledge-cycle.md): incubating shown first (actively being
  // weighed), then spark (first mentions); adopted moves into a compact "Adopted → Plans" line
  // via relations.led_to; rejected is hidden entirely (dead, but not deleted from the bundle).
  const ideasAll = cs.filter(d => typeOf(d) === 'idea');
  const ideaIncubating = ideasAll.filter(d => statusOf(d) === 'incubating').sort(byTsDesc);
  const ideaSpark = ideasAll.filter(d => statusOf(d) === 'spark').sort(byTsDesc);
  const ideaAdopted = ideasAll.filter(d => statusOf(d) === 'adopted').sort(byTsDesc);
  const ideasVisible = [...ideaIncubating, ...ideaSpark];
  const byId = new Map(cs.map(d => [d.id, d]));

  const recentCutoff = nowMs - recentDays * DAY_MS;
  const recent = cs.filter(d => {
    const t = tsOf(d);
    return Number.isFinite(t) && t >= recentCutoff && !String(d.base).startsWith('_');
  }).sort(byTsDesc);

  const sessions = cs.filter(d => typeOf(d) === 'session').sort(byTsDesc).slice(0, SESSION_SUMMARY_LIMIT);

  return {
    nowMs, doneLimit, recentDays, project,
    backlog, inprog, blocked, done, plans,
    ideaIncubating, ideaSpark, ideaAdopted, ideasVisible, byId,
    recent, sessions,
    openFailuresShown, openFailuresTotal,
    overdueEnginesShown, overdueEnginesTotal,
  };
}

/**
 * Build the kanban markdown for a bundle. Pure function of `docs` (from lib/okf.mjs `load()`)
 * and options. `now` (epoch ms or Date) is injectable so davnost/aging is deterministic in tests.
 */
export function buildBoard(docs, opts = {}) {
  const m = buildBoardModel(docs, opts);
  const {
    nowMs, doneLimit, recentDays, project,
    backlog, inprog, blocked, done, plans,
    ideaAdopted, ideasVisible, byId, recent, sessions,
    openFailuresShown, openFailuresTotal,
    overdueEnginesShown, overdueEnginesTotal,
  } = m;

  const L = [];
  L.push('# Dashboard', '');
  L.push('> Memory kanban: what\'s in progress, what\'s done, what\'s stuck. Refresh: `samemind board --write`.');
  if (project) {
    L.push('', `> Task filter: project \`${normProj(project)}\` (Plans / Ideas / Recent / Sessions — bundle-wide).`);
  }
  L.push('');

  // 🔥 Open failures (event ledger, docs/event-ledger.md): fail/block-phase events not yet
  // closed by a later done/ok event of the same topic. Above Blocked — these are the
  // fine-grained, cross-engine failure signals the coarse Task.status column can't show.
  L.push(`## 🔥 Open failures (${openFailuresTotal})`, '');
  if (!openFailuresShown.length) {
    L.push('_(empty)_');
  } else {
    for (const f of openFailuresShown) L.push(renderOpenFailure(f));
    if (openFailuresTotal > openFailuresShown.length) {
      L.push(`_…and ${openFailuresTotal - openFailuresShown.length} more — \`samemind ledger status\`_`);
    }
  }
  L.push('');

  // 🔥 Overdue engines (fleet, docs/fleet.md): omitted entirely when there are none — most
  // bundles have no fleet registry, and a standing "(0)" heading would be noise for them.
  if (overdueEnginesTotal > 0) {
    L.push(`## 🔥 Overdue engines (${overdueEnginesTotal})`, '');
    for (const r of overdueEnginesShown) L.push(renderOverdueEngine(r));
    if (overdueEnginesTotal > overdueEnginesShown.length) {
      L.push(`_…and ${overdueEnginesTotal - overdueEnginesShown.length} more — \`samemind fleet status\`_`);
    }
    L.push('');
  }

  section(L, '🆕 Backlog', backlog, renderTask, nowMs);
  section(L, '🔧 In progress', inprog, renderTask, nowMs);
  section(L, '🔴 Blocked', blocked, renderTask, nowMs);
  section(L, `✅ Done · last ${doneLimit}`, done, renderTask, nowMs);
  section(L, '📋 Plans', plans, renderPlan);

  L.push(`## 💡 Ideas (${ideasVisible.length})`, '');
  if (!ideasVisible.length) { L.push('_(empty)_'); }
  else { for (const it of ideasVisible) L.push(renderIdea(it)); }
  if (ideaAdopted.length) {
    L.push('', `**Adopted → Plans (${ideaAdopted.length})**`, '');
    for (const it of ideaAdopted) L.push(renderAdoptedIdea(it, byId));
  }
  L.push('');

  L.push(`## 🕒 Recent (last ${recentDays}d, ${recent.length})`, '');
  if (recent.length) {
    for (const d of recent) L.push(renderRecent(d));
  } else {
    L.push(`_(nothing in the last ${recentDays}d)_`);
  }
  L.push('');

  L.push(`### Recent sessions (${sessions.length})`, '');
  if (sessions.length) {
    for (const d of sessions) L.push(renderSession(d));
  } else {
    L.push('_(no sessions)_');
  }
  L.push('');

  return L.join('\n').trim() + '\n';
}

function parseArgs(argv) {
  const out = { write: false, project: null, html: false, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--project') out.project = argv[++i] || null;
    else if (a === '--html') out.html = true;
    else if (a === '--out') out.out = argv[++i] || null;
    else if (a === '--json') out.json = true;
  }
  return out;
}

/** Board file path inside a bundle root. */
export function boardPath(root = ROOT) {
  return join(root, DASHBOARD_NAME);
}

export async function main(argv = process.argv.slice(2)) {
  const { write, project, html, out, json } = parseArgs(argv);
  if (json && (write || html)) {
    console.error('board: --json is incompatible with --write/--html');
    process.exitCode = 1;
    return;
  }
  const docs = load({ includeSecret: false });
  // Event ledger (docs/event-ledger.md) is not part of the OKF graph — read it separately
  // and summarize to open failures here, in the I/O layer, so buildBoardModel/buildBoard stay
  // pure functions of their arguments (same reasoning as `now` being injectable).
  const events = readEvents(ROOT);
  const { openFailures } = summarizeLedger(events);
  // Fleet registry (docs/fleet.md) is likewise not an OKF concept — read it here, in the I/O
  // layer, and reduce to the overdue subset via the same `heartbeat()` the CLI/MCP use, so
  // buildBoardModel/buildBoard never touch the filesystem themselves. No registry → [].
  const registry = readRegistry(ROOT);
  const overdueEngines = registry ? heartbeat(registry.engines, events, Date.now()).filter(e => e.overdue) : [];

  if (json) {
    // --json: versioned wrapper over the same buildBoardModel the markdown/--html projections
    // consume — a foundation for a future UI, not a new model (see contract note in module header).
    const now = Date.now();
    const model = buildBoardModel(docs, { now, project, openFailures, overdueEngines });
    console.log(JSON.stringify({
      contract: 1, kind: 'board', generatedAt: new Date(now).toISOString(), data: model,
    }));
    return;
  }

  if (html) {
    // --html: self-contained HTML projection (tools/lib/html-render.mjs) — canon stays
    // markdown, this is a generated face, never storage. See gbrain idea-html-projections.
    const { renderBoardHtml } = await import('./lib/html-render.mjs');
    const model = buildBoardModel(docs, {
      now: Date.now(), project, openFailures, overdueEngines,
    });
    const page = renderBoardHtml(model);
    if (out) {
      atomicWriteFileSync(out, page);
      console.log(`✓ board HTML written: ${out}`);
    } else {
      console.log(page);
    }
    return;
  }

  const md = buildBoard(docs, {
    now: Date.now(), project, openFailures, overdueEngines,
  });

  if (write) {
    const target = boardPath(ROOT);
    atomicWriteFileSync(target, md);
    console.log(`✓ board written: ${target}`);
    console.log('  DASHBOARD.md is committed to git (a feature, not gitignored).');
  } else {
    console.log(md);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

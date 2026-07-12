#!/usr/bin/env node
// board.mjs — samemind board: a human-facing kanban over the work-discipline layer
// (Plan / Task / Decision / Session — see docs/work-discipline.md) plus the
// knowledge-cycle layer (Analysis / Research / Idea — see docs/knowledge-cycle.md).
// Reads the bundle's current state and renders a markdown board: who owes what,
// what's moving, what's blocked (and for how long), what just landed, what was
// recently agreed, and what candidate ideas are incubating.
//
//   node tools/board.mjs [--write] [--project <path>]
//
// --write            atomic-write the board to <bundle-root>/DASHBOARD.md (committed
//                     feature — DASHBOARD.md is tracked, not gitignored). Default: stdout.
// --project <path>   scope the four task columns to one project (matched against the
//                     Task `relations.project` field). Plans / Ideas / Recent / Sessions
//                     stay portfolio-wide — they are cross-cutting state, not project-scoped.
//
// The board is a pure function of parsed docs (lib/okf.mjs `load()`); `now` is injectable
// so aging/davnost is deterministic in tests. No volatile timestamp is baked into the
// output, so `--write` is idempotent: same bundle state → same bytes.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, ROOT, pathToId } from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

export const DASHBOARD_NAME = 'DASHBOARD.md';

const DAY_MS = 86_400_000;
const DEFAULT_DONE_LIMIT = 10;
const DEFAULT_RECENT_DAYS = 7;
const SESSION_SUMMARY_LIMIT = 3;
const AGING_THRESHOLD_DAYS = 7;            // blocked older than this is flagged "aging"
const DESC_MAX = 140;

// Plans shown on the board: active planning states. `done` and `superseded` are history
// (a finished/replaced plan is not something you're working — it's the record). See
// docs/work-discipline.md.
const ACTIVE_PLAN_STATUS = new Set(['draft', 'agreed', 'in-progress']);

const typeOf = d => String(d.fm?.type || '').trim().toLowerCase();
const statusOf = d => String(d.fm?.status || '').trim().toLowerCase();

function titleOf(d) {
  return String(d.fm?.title || '').trim() || String(d.id).split('/').pop();
}

/** Bundle-absolute markdown link to a doc: /projects/foo.md */
function linkOf(d) {
  return `/${d.id}.md`;
}

/** One-line description: frontmatter `description`, falling back to the first prose line of the body. */
function oneline(d) {
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
function ageDays(d, nowMs) {
  const t = tsOf(d);
  if (!Number.isFinite(t)) return NaN;
  return Math.floor((nowMs - t) / DAY_MS);
}

/** YYYY-MM-DD for display (prefers `date`, falls back to the timestamp day). */
function dateOf(d) {
  const raw = String(d.fm?.date || '').trim();
  if (raw) return raw.slice(0, 10);
  const t = tsOf(d);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

const byTsDesc = (a, b) => (tsOf(b) || 0) - (tsOf(a) || 0);
const byTsAsc = (a, b) => (tsOf(a) || 0) - (tsOf(b) || 0);   // oldest first (surface stale blockers)

/** Normalize a project path/id to a comparable stem: `/projects/lumen.md` → `projects/lumen`. */
function normProj(p) {
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
function firstRelPath(d, key) {
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

/** Append a `## heading (n)` section with items; `_(empty)_` when empty. */
function section(L, heading, items, render, nowMs) {
  L.push(`## ${heading} (${items.length})`, '');
  if (!items.length) { L.push('_(empty)_'); }
  else { for (const it of items) L.push(render(it, nowMs)); }
  L.push('');
}

/**
 * Build the kanban markdown for a bundle. Pure function of `docs` (from lib/okf.mjs `load()`)
 * and options. `now` (epoch ms or Date) is injectable so davnost/aging is deterministic in tests.
 */
export function buildBoard(docs, {
  now = Date.now(),
  doneLimit = DEFAULT_DONE_LIMIT,
  recentDays = DEFAULT_RECENT_DAYS,
  project = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const cs = (docs || []).filter(d => !d.reserved);

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

  const L = [];
  L.push('# Dashboard', '');
  L.push('> Memory kanban: what\'s in progress, what\'s done, what\'s stuck. Refresh: `samemind board --write`.');
  if (project) {
    L.push('', `> Task filter: project \`${normProj(project)}\` (Plans / Ideas / Recent / Sessions — bundle-wide).`);
  }
  L.push('');

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
  const out = { write: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--project') out.project = argv[++i] || null;
  }
  return out;
}

/** Board file path inside a bundle root. */
export function boardPath(root = ROOT) {
  return join(root, DASHBOARD_NAME);
}

export async function main(argv = process.argv.slice(2)) {
  const { write, project } = parseArgs(argv);
  const docs = load({ includeSecret: false });
  const md = buildBoard(docs, { now: Date.now(), project });

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

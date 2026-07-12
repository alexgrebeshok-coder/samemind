#!/usr/bin/env node
// handoff.mjs — samemind handoff: compact "work state" brief so a new session (any engine)
// can continue without re-explaining. Built from the work-discipline layer
// (Plan / Decision / Task / Session — see docs/work-discipline.md).
//
//   node tools/handoff.mjs [--project <path>] [--days N] [--html [--out <file>]]
//
// NOT the same as `samemind brief` (identity/personality). This is about *what is in
// progress* — active tasks, recent decisions, plans in force, last session, open questions.
//
// --html   render a self-contained HTML projection instead of markdown (no CDN/JS, light+dark
//          via prefers-color-scheme) — see tools/lib/html-render.mjs. Prints to stdout, or
//          atomic-writes to --out <file>.
//
// Target size ≤ ~2000 tokens (~8000 chars). Each line carries a path citation.
import { fileURLToPath } from 'node:url';
import { load, asPathList, pathToId } from './lib/okf.mjs';

export const DEFAULT_DAYS = 14;
export const DEFAULT_BUDGET_TOKENS = 2000;
export const CHARS_PER_TOKEN = 4;

const typeOf = d => String(d.fm?.type || '').toLowerCase();
export const statusOf = d => String(d.fm?.status || '').trim().toLowerCase();

// cite/extractSection/firstBullets/oneLine/docDate are exported (not just module-private)
// so the `--html` projection (tools/lib/html-render.mjs) renders the exact same fields the
// markdown handoff does, without re-deriving or re-parsing anything.

/** Bundle path form for citations: `/projects/x.md` */
export function cite(doc) {
  const id = doc.id || '';
  return id.startsWith('/') ? `${id}.md`.replace(/\.md\.md$/, '.md') : `/${id}.md`;
}

/** Content between a `## ` heading matching `re` and the next heading of any level. */
export function extractSection(body, re) {
  const lines = String(body || '').split('\n');
  let capturing = false;
  const out = [];
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (capturing) break;
      if (re.test(h[2].trim())) capturing = true;
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').trim();
}

/** First non-empty bullet / line from a section, one compact line. */
export function firstBullets(sectionText, max = 3) {
  const lines = String(sectionText || '')
    .split('\n')
    .map(l => l.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .filter(l => l !== '-');
  return lines.slice(0, max);
}

/** Collapse whitespace + truncate for one-line list items. */
export function oneLine(s, max = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Normalize a --project value to a comparable key:
 *   lumen | projects/lumen | /projects/lumen.md → projects/lumen
 */
export function normalizeProjectKey(p) {
  if (p == null || p === '') return null;
  let s = String(p).trim().replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/^\//, '').replace(/\.md$/i, '');
  if (!s.includes('/')) s = `projects/${s}`;
  return s.toLowerCase();
}

function pathKey(p) {
  return pathToId(String(p || '')).toLowerCase();
}

/** True if path `p` refers to the same project node as `projectKey`. */
function isProjectPath(p, projectKey) {
  if (!projectKey) return true;
  const k = pathKey(p);
  if (!k) return false;
  if (k === projectKey) return true;
  // allow bare name match: projects/lumen ↔ lumen as trailing segment
  const leaf = projectKey.split('/').pop();
  return k === leaf || k.endsWith(`/${leaf}`);
}

/**
 * Does this discipline doc belong to --project?
 * Task → relations.project; Plan → relations.covers; Decision → relations.about;
 * Session → relations.next/decided that touch related task/decision ids (passed in),
 * or any relation path that is the project itself.
 */
function touchesProject(doc, projectKey, relatedIds) {
  if (!projectKey) return true;
  const rels = doc.fm?.relations || {};
  const t = typeOf(doc);

  if (t === 'task') {
    return asPathList(rels.project).some(p => isProjectPath(p, projectKey));
  }
  if (t === 'plan') {
    return asPathList(rels.covers).some(p => isProjectPath(p, projectKey));
  }
  if (t === 'decision') {
    return asPathList(rels.about).some(p => isProjectPath(p, projectKey));
  }
  if (t === 'session') {
    for (const edge of ['next', 'decided', 'about', 'covers', 'project']) {
      for (const p of asPathList(rels[edge])) {
        if (isProjectPath(p, projectKey)) return true;
        if (relatedIds && relatedIds.has(pathKey(p))) return true;
      }
    }
    return false;
  }
  return false;
}

/** ISO date (YYYY-MM-DD) from agreed_on / date / timestamp — best effort. */
export function docDate(doc) {
  const fm = doc.fm || {};
  for (const key of ['agreed_on', 'date', 'timestamp']) {
    const v = fm[key];
    if (!v) continue;
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return null;
}

function daysAgo(isoDate, now) {
  if (!isoDate) return Infinity;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return Infinity;
  const ms = now.getTime() - t;
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * Build the handoff's data model from pre-loaded OKF docs: the same filtering/sorting
 * (Active, Last decisions, Plans in force, Last session, Open questions) that `buildHandoff`
 * renders to markdown, but as plain arrays/objects — no rendering. This is the single source
 * of truth for both the markdown handoff and the `--html` projection (tools/lib/html-render.mjs):
 * both consume this model, neither re-derives it nor re-parses the other's output.
 *
 * @param {object[]} docs - from load(); secret already excluded by caller
 * @param {{ project?: string|null, days?: number, now?: Date }} opts
 */
export function buildHandoffModel(docs, {
  project = null,
  days = DEFAULT_DAYS,
  now = new Date(),
} = {}) {
  const cs = (docs || []).filter(d => d && !d.reserved);
  const projectKey = normalizeProjectKey(project);
  const dayWindow = Number.isFinite(Number(days)) && Number(days) > 0
    ? Math.floor(Number(days))
    : DEFAULT_DAYS;

  const allTasks = cs.filter(d => typeOf(d) === 'task');
  const allPlans = cs.filter(d => typeOf(d) === 'plan');
  const allDecisions = cs.filter(d => typeOf(d) === 'decision');
  const allSessions = cs.filter(d => typeOf(d) === 'session');

  // Related ids for session project-filter: tasks/plans/decisions that already match.
  const relatedIds = new Set();
  if (projectKey) {
    for (const d of [...allTasks, ...allPlans, ...allDecisions]) {
      if (touchesProject(d, projectKey, null)) relatedIds.add(pathKey(d.id));
    }
  }

  const tasks = allTasks.filter(d => touchesProject(d, projectKey, relatedIds));
  const plans = allPlans.filter(d => touchesProject(d, projectKey, relatedIds));
  const decisions = allDecisions.filter(d => touchesProject(d, projectKey, relatedIds));
  const sessions = allSessions.filter(d => touchesProject(d, projectKey, relatedIds));

  // --- Active: in-progress + blocked ---
  const active = tasks
    .filter(d => {
      const s = statusOf(d);
      return s === 'in-progress' || s === 'blocked';
    })
    .sort((a, b) => {
      // blocked after in-progress, then by title
      const rank = s => (statusOf(s) === 'in-progress' ? 0 : 1);
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return String(a.fm.title || a.id).localeCompare(String(b.fm.title || b.id));
    });

  // --- Last decisions within window, newest first ---
  const recentDecisions = decisions
    .map(d => ({ d, date: docDate(d), age: daysAgo(docDate(d), now) }))
    .filter(x => x.age <= dayWindow)
    .sort((a, b) => {
      // newest first; undated last
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return String(b.d.fm.timestamp || '').localeCompare(String(a.d.fm.timestamp || ''));
    });

  // --- Plans in force: agreed | in-progress; skip superseded (and draft/done) ---
  const plansInForce = plans
    .filter(d => {
      const s = statusOf(d);
      return s === 'agreed' || s === 'in-progress';
    })
    .sort((a, b) => String(a.fm.title || a.id).localeCompare(String(b.fm.title || b.id)));

  // --- Last session: freshest by date/timestamp ---
  const lastSession = sessions
    .map(d => ({ d, date: docDate(d) || '0000-00-00', ts: String(d.fm.timestamp || '') }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.ts < b.ts ? 1 : -1;
    })[0]?.d || null;

  // --- Open questions: blocked tasks + ## Next bullets from last session ---
  const blocked = tasks.filter(d => statusOf(d) === 'blocked');
  const sessionNext = lastSession
    ? firstBullets(extractSection(lastSession.body, /^next$/i), 5)
    : [];

  return { projectKey, dayWindow, active, recentDecisions, plansInForce, lastSession, blocked, sessionNext, nowMs: now.getTime() };
}

/**
 * Build the work-state handoff markdown from pre-loaded OKF docs.
 *
 * @param {object[]} docs - from load(); secret already excluded by caller
 * @param {{ project?: string|null, days?: number, now?: Date, budgetTokens?: number }} opts
 * @returns {{ markdown: string, sections: object, warnings: string[] }}
 */
export function buildHandoff(docs, {
  project = null,
  days = DEFAULT_DAYS,
  now = new Date(),
  budgetTokens = DEFAULT_BUDGET_TOKENS,
} = {}) {
  const {
    projectKey, dayWindow, active, recentDecisions, plansInForce, lastSession, blocked, sessionNext,
  } = buildHandoffModel(docs, { project, days, now });
  const warnings = [];

  // --- Assemble markdown ---
  const lines = [];
  lines.push('# Handoff — work state');
  if (projectKey) lines.push(`_project filter: \`${projectKey}\` · last ${dayWindow}d_`);
  else lines.push(`_last ${dayWindow}d_`);
  lines.push('');

  lines.push('## Active');
  if (!active.length) {
    lines.push('_none_');
  } else {
    for (const d of active) {
      const st = statusOf(d);
      const title = oneLine(d.fm.title || d.id, 80);
      if (st === 'blocked') {
        const reason = oneLine(d.fm.blocked_reason || '(no reason)', 100);
        lines.push(`- **blocked** ${title} — ${reason} — \`${cite(d)}\``);
      } else {
        lines.push(`- **in-progress** ${title} — \`${cite(d)}\``);
      }
    }
  }
  lines.push('');

  lines.push(`## Last decisions (${dayWindow}d)`);
  if (!recentDecisions.length) {
    lines.push('_none_');
  } else {
    for (const { d, date } of recentDecisions) {
      const title = oneLine(d.fm.title || d.fm.description || d.id, 90);
      const when = date || '?';
      lines.push(`- ${when} ${title} — \`${cite(d)}\``);
    }
  }
  lines.push('');

  lines.push('## Plans in force');
  if (!plansInForce.length) {
    lines.push('_none_');
  } else {
    for (const d of plansInForce) {
      const title = oneLine(d.fm.title || d.id, 80);
      lines.push(`- **${statusOf(d)}** ${title} — \`${cite(d)}\``);
    }
  }
  lines.push('');

  lines.push('## Last session');
  if (!lastSession) {
    lines.push('_none_');
  } else {
    const title = oneLine(lastSession.fm.title || lastSession.id, 80);
    const eng = lastSession.fm.engine ? String(lastSession.fm.engine) : '?';
    const when = docDate(lastSession) || '?';
    lines.push(`**${title}** (${eng}, ${when}) — \`${cite(lastSession)}\``);
    const done = firstBullets(extractSection(lastSession.body, /^done$/i), 2);
    const decided = firstBullets(extractSection(lastSession.body, /^decided$/i), 2);
    const next = firstBullets(extractSection(lastSession.body, /^next$/i), 2);
    if (done.length) lines.push(`- Done: ${oneLine(done.join(' · '), 140)}`);
    if (decided.length) lines.push(`- Decided: ${oneLine(decided.join(' · '), 140)}`);
    if (next.length) lines.push(`- Next: ${oneLine(next.join(' · '), 140)}`);
    if (!done.length && !decided.length && !next.length) {
      lines.push(`- _(see \`${cite(lastSession)}\`)_`);
    }
  }
  lines.push('');

  lines.push('## Open questions');
  const openLines = [];
  for (const d of blocked) {
    const title = oneLine(d.fm.title || d.id, 70);
    const reason = oneLine(d.fm.blocked_reason || '(no reason)', 90);
    openLines.push(`- blocked: ${title} — ${reason} — \`${cite(d)}\``);
  }
  for (const n of sessionNext) {
    openLines.push(`- next: ${oneLine(n, 120)}`);
  }
  if (!openLines.length) lines.push('_none_');
  else lines.push(...openLines);

  let markdown = `${lines.join('\n').replace(/\n+$/, '')}\n`;

  // Soft budget: if over, drop session bullet detail first, then older decisions.
  const budgetChars = Math.max(1, Math.floor(budgetTokens * CHARS_PER_TOKEN));
  let truncated = false;
  if (markdown.length > budgetChars) {
    // rebuild without session Done/Decided detail (keep Next via Open questions)
    const compact = markdown
      .replace(/^- Done:.*$/m, '')
      .replace(/^- Decided:.*$/m, '')
      .replace(/\n{3,}/g, '\n\n');
    if (compact.length <= budgetChars) {
      markdown = compact;
      truncated = true;
    } else {
      // keep header + Active + Open questions only
      const parts = markdown.split(/^## /m);
      const keep = [parts[0]];
      for (const p of parts.slice(1)) {
        if (p.startsWith('Active') || p.startsWith('Open questions')) keep.push(`## ${p}`);
      }
      markdown = `${keep.join('').trim()}\n\n> _(handoff truncated to fit budget — run without --project or raise budget)_\n`;
      truncated = true;
    }
  }

  if (truncated) warnings.push('handoff truncated to fit budget');

  const sections = {
    active: active.map(d => d.id),
    decisions: recentDecisions.map(x => x.d.id),
    plans: plansInForce.map(d => d.id),
    lastSession: lastSession?.id || null,
    openQuestions: {
      blocked: blocked.map(d => d.id),
      sessionNext,
    },
  };

  return { markdown, sections, warnings, days: dayWindow, project: projectKey };
}

function parseArgs(argv) {
  const out = { project: null, days: DEFAULT_DAYS, html: false, outFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (a === '--html') out.html = true;
    else if (a === '--out') out.outFile = argv[++i] || null;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('samemind handoff — work-state brief (Plan/Task/Decision/Session)');
    console.log('  --project <path>   filter by project (e.g. lumen or /projects/lumen.md)');
    console.log(`  --days N           decision window in days (default ${DEFAULT_DAYS})`);
    console.log('  --html             self-contained HTML projection instead of markdown');
    console.log('  --out <file>       with --html, atomic-write the page here instead of stdout');
    return;
  }
  // Never include secret — handoff is for session start, not secret review.
  // inbox stays excluded too (default, no includeInbox): handoff is built purely from typed
  // work-discipline docs (Plan/Task/Decision/Session); raw inbox notes have no `type` and were
  // never picked up by touchesProject()/typeOf() anyway — see issue #4.
  const docs = load({ includeSecret: false, includeMirror: true });

  if (opts.html) {
    // --html: self-contained HTML projection (tools/lib/html-render.mjs) — canon stays
    // markdown, this is a generated face, never storage. See gbrain idea-html-projections.
    const { renderHandoffHtml } = await import('./lib/html-render.mjs');
    const { atomicWriteFileSync } = await import('../lib/atomic-write.mjs');
    const model = buildHandoffModel(docs, { project: opts.project, days: opts.days });
    const page = renderHandoffHtml(model);
    if (opts.outFile) {
      atomicWriteFileSync(opts.outFile, page);
      console.log(`✓ handoff HTML written: ${opts.outFile}`);
    } else {
      console.log(page);
    }
    return;
  }

  const { markdown, warnings } = buildHandoff(docs, {
    project: opts.project,
    days: opts.days,
  });
  for (const w of warnings) console.error(`⚠ ${w}`);
  process.stdout.write(markdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

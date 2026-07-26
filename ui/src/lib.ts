// lib.ts — pure display helpers + the graph layout. No React, no fetch: everything here runs
// under plain node and is covered by src/lib.test.mjs.
import type { Doc, Frontmatter, Graph } from './api';

/** "12s ago" / "4m ago" / "3d ago" — coarse on purpose, this is a freshness stamp not a clock. */
export function ago(fromIso: string | null | undefined, now: number = Date.now()): string {
  if (!fromIso) return 'never';
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return '—';
  return agoSec(Math.max(0, Math.round((now - t) / 1000)));
}

export function agoSec(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Compact duration for silence bars / heartbeat limits: "45m", "7h", "2d". */
export function dur(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** Card age from the best date the doc has. */
export function docDate(fm: Frontmatter): string | null {
  const v = fm.agreed_on || fm.date || fm.timestamp;
  return typeof v === 'string' && v ? v : null;
}

export function ageLabel(fm: Frontmatter, now: number = Date.now()): string {
  const d = docDate(fm);
  if (!d) return '—';
  const t = Date.parse(d);
  if (Number.isNaN(t)) return '—';
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d old';
  return `${days}d old`;
}

/** `/projects/lumen.md` (a bundle-absolute link) → `projects/lumen` (a concept id). */
export function linkToId(link: string): string {
  return link.replace(/^\/+/, '').replace(/\.md$/i, '');
}

export function idTail(id: string): string {
  const i = id.lastIndexOf('/');
  return i === -1 ? id : id.slice(i + 1);
}

/** The project doc a task/plan belongs to, or null. Relations win over ad-hoc body links. */
export function projectOf(doc: Doc): string | null {
  const rel = doc.relations?.project?.[0] || doc.fm.relations?.project?.[0];
  if (rel) return linkToId(rel);
  const covers = doc.relations?.covers?.[0];
  if (covers) return linkToId(covers);
  return null;
}

const TYPE_BADGE: Record<string, string> = {
  // spec §4 — one palette, reused by list rows, kanban cards and graph legend
  task: 'bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800',
  plan: 'bg-violet-100 text-violet-900 border-violet-300 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-800',
  decision:
    'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800',
  project: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800',
  concept: 'bg-stone-100 text-stone-900 border-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:border-stone-600',
  session: 'bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800',
  idea: 'bg-lime-100 text-lime-900 border-lime-300 dark:bg-lime-950 dark:text-lime-200 dark:border-lime-800',
};

const SLATE = 'bg-slate-100 text-slate-900 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600';

export function typeBadgeClass(type: string | undefined): string {
  return TYPE_BADGE[String(type || '').toLowerCase()] || SLATE;
}

/** Graph node fill — same meaning as the badges, flat hex so the SVG needs no Tailwind classes. */
const TYPE_HEX: Record<string, string> = {
  task: '#0284c7',
  plan: '#7c3aed',
  decision: '#059669',
  project: '#d97706',
  concept: '#78716c',
  session: '#e11d48',
  idea: '#65a30d',
};

export function typeColor(type: string | undefined): string {
  return TYPE_HEX[String(type || '').toLowerCase()] || '#64748b';
}

/**
 * Silence bar tone: how much of an engine's heartbeat budget its silence has eaten.
 * `bad` stays reserved for what the API itself flags — overdue, or never seen at all — so the
 * bar never contradicts the roster's own verdict. An engine past its budget that the registry
 * still tolerates (a reserve engine) reads amber, not red.
 */
export type SilenceTone = 'ok' | 'warn' | 'bad';

export function silenceTone(
  silentSec: number | null | undefined,
  heartbeatSec: number,
  overdue: boolean,
): { tone: SilenceTone; pct: number } {
  if (silentSec == null) return { tone: 'bad', pct: 100 }; // never seen → full red bar
  const pct = Math.min(100, Math.round((silentSec / Math.max(1, heartbeatSec)) * 100));
  if (overdue) return { tone: 'bad', pct: 100 };
  return { tone: pct >= 50 ? 'warn' : 'ok', pct };
}

export const SILENCE_COLOR: Record<SilenceTone, string> = {
  ok: 'var(--sm-ok)',
  warn: 'var(--sm-accent)',
  bad: 'var(--sm-danger)',
};

/** Ledger phase → glyph (spec §3.3.2). */
export function phaseGlyph(phase: string): string {
  switch (phase) {
    case 'start':
      return '▶';
    case 'done':
      return '✓';
    case 'fail':
      return '✕';
    case 'block':
      return '⏸';
    case 'note':
      return '✎';
    default:
      return '·';
  }
}

export function phaseColor(ev: { phase: string; status: string }): string {
  if (ev.phase === 'fail' || ev.status === 'fail') return 'var(--sm-danger)';
  if (ev.phase === 'done') return 'var(--sm-ok)';
  if (ev.phase === 'block') return '#f59e0b';
  return 'var(--sm-accent)';
}

// --- concentric graph layout (spec §3.2.4) ---------------------------------------------------
// Deterministic by design: sort by degree, most-connected in the middle, each ring wider than
// the one inside it. No physics → no jitter between refreshes, and it fits in one screen.

export const GRAPH_MAX_NODES = 300;
export const GRAPH_SIZE = 720; // viewBox units; the SVG scales to its container
const RING_STEP = 88;

export type PlacedNode = {
  id: string;
  title: string;
  type: string;
  deg: number;
  x: number;
  y: number;
  r: number;
};

/** Ring capacities 1, 6, 12, 24, 48 … — five rings hold the whole 300-node budget. */
function ringPlan(count: number): number[] {
  const plan: number[] = [];
  let cap = 1;
  let left = count;
  while (left > 0) {
    const take = Math.min(cap, left);
    plan.push(take);
    left -= take;
    cap = cap === 1 ? 6 : cap * 2;
  }
  return plan;
}

export function layout(graph: Pick<Graph, 'nodes' | 'edges'>): { placed: PlacedNode[]; clipped: number } {
  const degrees = new Map<string, number>();
  for (const e of graph.edges) {
    degrees.set(e.from, (degrees.get(e.from) || 0) + 1);
    degrees.set(e.to, (degrees.get(e.to) || 0) + 1);
  }
  const sorted = [...graph.nodes].sort(
    (a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) || a.id.localeCompare(b.id),
  );
  const shown = sorted.slice(0, GRAPH_MAX_NODES);
  const c = GRAPH_SIZE / 2;
  const placed: PlacedNode[] = [];
  let idx = 0;
  ringPlan(shown.length).forEach((n, ring) => {
    const radius = ring * RING_STEP;
    for (let i = 0; i < n; i++) {
      const node = shown[idx++];
      const angle = ring === 0 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2;
      const deg = degrees.get(node.id) || 0;
      placed.push({
        id: node.id,
        title: node.title || idTail(node.id),
        type: node.type,
        deg,
        x: c + Math.cos(angle) * radius,
        y: c + Math.sin(angle) * radius,
        r: Math.min(14, 6 + Math.sqrt(deg) * 1.8),
      });
    }
  });
  return { placed, clipped: sorted.length - shown.length };
}

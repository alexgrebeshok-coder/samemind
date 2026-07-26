// shared.tsx — pieces used by more than one screen: the kanban board (Overview + Projects) and
// the open-failures list (Overview + Fleet).
import { navigate } from './App';
import type { BoardCard, Doc, LedgerEvent } from './api';
import { ago, cardView, docDate, idTail, snippet } from './lib';
import { AllQuiet, Card, Empty, TypeBadge } from './ui';

// `edge` is the 3px colour strip on top of each column. Existing theme tokens only, so both
// themes follow automatically; applied as an inline style because a `border-t-*` utility would
// have to out-order Card's own `border-color` at equal specificity.
export const COLUMNS = [
  { key: 'backlog', label: 'Backlog', edge: 'var(--sm-muted)' },
  { key: 'inprog', label: 'In progress', edge: 'var(--sm-accent)' },
  { key: 'blocked', label: 'Blocked', edge: 'var(--sm-danger)' },
  { key: 'done', label: 'Done', edge: 'var(--sm-ok)' },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];

function KanbanCard({ card, now }: { card: BoardCard; now: number }) {
  const { id, title, type, age, project, ledger, actor, reason, tooltip } = cardView(card, now);
  return (
    <li className="rounded-[12px] border border-line bg-surface p-3" title={tooltip || undefined}>
      {ledger ? (
        // no concept doc behind a synthesized card, so the title is plain text, not a link
        <p className="text-sm font-medium">{title}</p>
      ) : (
        <button
          type="button"
          onClick={() => navigate(`/memory/${id}`)}
          className="block w-full text-left text-sm font-medium hover:text-accent"
        >
          {title}
        </button>
      )}
      {ledger && tooltip ? (
        // a bare topic ("sub:a39fbe85") says nothing; the last ledger action on it says everything
        <p className="mt-1 text-[11px] leading-snug text-muted">{snippet(tooltip)}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {ledger ? (
          <span
            className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
            title="synthesized from a ledger topic — no Task doc exists for it"
          >
            ledger
          </span>
        ) : project ? (
          <button
            type="button"
            onClick={() => navigate(`/projects/${project}`)}
            className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
            title={project}
          >
            {idTail(project)}
          </button>
        ) : null}
        <TypeBadge type={type} />
        <span className="tnum text-[11px] text-muted">{age}</span>
        {actor ? <span className="truncate text-[11px] text-muted">· {actor}</span> : null}
      </div>
      {reason ? (
        // hover for the short form, expand for the whole reason — no truncation-only dead end
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-danger" title={reason}>
            blocked ▸ <span className="underline decoration-dotted group-open:hidden">why?</span>
          </summary>
          <p className="mt-1 text-xs text-muted">{reason}</p>
        </details>
      ) : null}
    </li>
  );
}

export function Kanban({
  columns,
  now,
  overflow,
  totals,
}: {
  columns: Record<ColumnKey, BoardCard[]>;
  now: number;
  overflow?: Partial<Record<ColumnKey, number>>;
  /** True column sizes before the cap; falls back to the rendered count when absent. */
  totals?: Partial<Record<ColumnKey, number>>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((c) => {
        const docs = columns[c.key] || [];
        const more = overflow?.[c.key] || 0;
        const total = totals?.[c.key] ?? docs.length;
        return (
          <Card
            key={c.key}
            tone="muted"
            className="flex flex-col"
            style={{ borderTopWidth: 3, borderTopColor: c.edge }}
          >
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <h3 className="text-sm font-semibold">{c.label}</h3>
              <span className="tnum text-xs text-muted" title={total === docs.length ? undefined : `${docs.length} shown of ${total}`}>
                {total}
              </span>
            </div>
            {docs.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted">no cards</p>
            ) : (
              <ul className="flex flex-col gap-2 p-3">
                {docs.map((d) => (
                  <KanbanCard key={d.id} card={d} now={now} />
                ))}
              </ul>
            )}
            {more > 0 ? (
              <p className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
                …and {more} more from the ledger
              </p>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/** Open failures (spec §3.1.3 compact / §3.3.3 with actions + refs). */
export function FailureList({
  failures,
  now,
  full = false,
}: {
  failures: LedgerEvent[];
  now: number;
  full?: boolean;
}) {
  if (failures.length === 0) return <AllQuiet what="no open failures" />;
  return (
    <ul className="flex flex-col gap-2">
      {failures.map((f, i) => (
        <li key={`${f.topic}-${f.ts}-${i}`} className="rounded-[12px] border border-danger/40 bg-danger-soft/40 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm font-semibold text-danger">{f.topic}</span>
            <span className="tnum text-[11px] text-muted" title={f.ts}>
              {ago(f.ts, now)}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink">{f.action}</p>
          {full ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
              <span>actor: {f.actor}</span>
              {f.artifact ? <span className="font-mono">artifact: {f.artifact}</span> : null}
              {f.ref ? <span className="font-mono">ref: {f.ref}</span> : null}
              <span>phase: {f.phase}</span>
              {f.quarantine ? <span className="text-danger">quarantined</span> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function RecentList({ docs }: { docs: Doc[] }) {
  if (docs.length === 0) return <Empty text="No activity in the recent window — nothing touched lately." />;
  return (
    <ul className="divide-y divide-line">
      {docs.slice(0, 10).map((d) => (
        <li key={d.id} className="flex items-baseline justify-between gap-3 py-2">
          <button
            type="button"
            onClick={() => navigate(`/memory/${d.id}`)}
            className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent"
          >
            {d.fm.title || d.id}
          </button>
          <TypeBadge type={d.fm.type} />
          <span className="tnum shrink-0 text-[11px] text-muted">{docDate(d.fm)?.slice(0, 10) || '—'}</span>
        </li>
      ))}
    </ul>
  );
}

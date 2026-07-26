// shared.tsx — pieces used by more than one screen: the kanban board (Overview + Projects) and
// the open-failures list (Overview + Fleet).
import { navigate } from './App';
import type { Doc, LedgerEvent } from './api';
import { ageLabel, ago, docDate, idTail, projectOf } from './lib';
import { AllQuiet, Card, Empty, TypeBadge } from './ui';

export const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'inprog', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];

function KanbanCard({ doc, now }: { doc: Doc; now: number }) {
  const project = projectOf(doc);
  const reason = String(doc.fm.blocked_reason || '');
  return (
    <li className="rounded-[12px] border border-line bg-surface p-3">
      <button
        type="button"
        onClick={() => navigate(`/memory/${doc.id}`)}
        className="block w-full text-left text-sm font-medium hover:text-accent"
      >
        {doc.fm.title || doc.id}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {project ? (
          <button
            type="button"
            onClick={() => navigate(`/projects/${project}`)}
            className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
            title={project}
          >
            {idTail(project)}
          </button>
        ) : null}
        <TypeBadge type={doc.fm.type} />
        <span className="tnum text-[11px] text-muted">{ageLabel(doc.fm, now)}</span>
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

export function Kanban({ columns, now }: { columns: Record<ColumnKey, Doc[]>; now: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((c) => {
        const docs = columns[c.key] || [];
        return (
          <Card key={c.key} tone="muted" className="flex flex-col">
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <h3 className="text-sm font-semibold">{c.label}</h3>
              <span className="tnum text-xs text-muted">{docs.length}</span>
            </div>
            {docs.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted">no cards</p>
            ) : (
              <ul className="flex flex-col gap-2 p-3">
                {docs.map((d) => (
                  <KanbanCard key={d.id} doc={d} now={now} />
                ))}
              </ul>
            )}
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

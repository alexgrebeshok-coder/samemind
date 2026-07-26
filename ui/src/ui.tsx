// ui.tsx — the whole component vocabulary: cards, badges, chips, stat tiles, empty states.
// Hand-rolled on purpose (spec §0: no component library).
import type { ReactNode } from 'react';
import { dur, typeBadgeClass } from './lib';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[12px] border border-line bg-surface ${className}`}>{children}</div>
  );
}

export function Panel({
  title,
  hint,
  right,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function StatTile({
  label,
  value,
  alert = false,
  note,
}: {
  label: string;
  value: number | string;
  alert?: boolean;
  note?: string;
}) {
  return (
    <Card
      className={`p-4 ${alert ? 'border-danger/60 bg-danger-soft/40' : ''}`}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`tnum mt-1 text-3xl font-bold ${alert ? 'text-danger' : ''}`}>{value}</div>
      {note ? <div className="mt-1 text-xs text-muted">{note}</div> : null}
    </Card>
  );
}

export function TypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${typeBadgeClass(type)}`}>
      {type}
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'danger' | 'ok';
  title?: string;
}) {
  const tones = {
    neutral: 'border-line bg-surface-2 text-muted',
    accent: 'border-accent/40 bg-accent-soft text-accent',
    danger: 'border-danger/40 bg-danger-soft text-danger',
    ok: 'border-ok/40 bg-ok-soft text-ok',
  } as const;
  return (
    <span title={title} className={`rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Designed empty state (spec §5) — a sentence plus the command that fixes it. */
export function Empty({ text, cmd }: { text: string; cmd?: string }) {
  return (
    <div className="rounded-[12px] border border-dashed border-line px-4 py-6 text-center">
      <p className="text-sm text-muted">{text}</p>
      {cmd ? (
        <code className="mt-2 inline-block rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-ink">
          {cmd}
        </code>
      ) : null}
    </div>
  );
}

export function AllQuiet({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-ok/40 bg-ok-soft px-3 py-2">
      <span aria-hidden="true" className="text-ok">
        ✓
      </span>
      <span className="text-sm text-ok">all quiet — {what}</span>
    </div>
  );
}

/** Silence bar: silentSec against heartbeatSec, red once overdue (spec §3.3.1). */
export function SilenceBar({
  silentSec,
  heartbeatSec,
  overdue,
}: {
  silentSec: number | null;
  heartbeatSec: number;
  overdue: boolean;
}) {
  const never = silentSec == null;
  const pct = never ? 100 : Math.min(100, Math.round((silentSec / Math.max(1, heartbeatSec)) * 100));
  const bad = never || overdue;
  const label = never ? 'never seen' : `${dur(silentSec)} of ${dur(heartbeatSec)} budget`;
  return (
    <div
      className="min-w-[7rem]"
      role="img"
      aria-label={label}
      title={label}
    >
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: bad ? 'var(--sm-danger)' : 'var(--sm-accent)' }}
        />
      </div>
      <div className={`tnum mt-1 text-[11px] ${bad ? 'text-danger' : 'text-muted'}`}>{label}</div>
    </div>
  );
}

/** Segmented bar for the ideas strip (spec §3.1.5). */
export function SegmentedBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        {total > 0 &&
          parts.map((p) => (
            <div
              key={p.label}
              style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
              title={`${p.label}: ${p.value}`}
            />
          ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-xs text-muted">
            <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden="true" />
            {p.label} <b className="tnum text-ink">{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Spinner({ label = 'loading' }: { label?: string }) {
  return (
    <p className="px-1 py-6 text-center text-sm text-muted" role="status">
      {label}…
    </p>
  );
}

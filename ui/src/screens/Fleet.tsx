// Fleet (spec §3.3): engine roster, naryad timeline, full open failures, stop points.
import {
  useApi,
  useApiStatus,
  type Fleet as FleetData,
  type Ledger,
  type LedgerEvent,
  type LedgerTopic,
} from '../api';
import { FEED_LIMIT, ago, dur, eventKey, hhmmss, isSubTopic, phaseColor, phaseGlyph } from '../lib';
import { FailureList } from '../shared';
import { Card, Chip, Empty, Panel, SilenceBar, Spinner } from '../ui';

const ROLE_TONE: Record<string, string> = {
  director: 'border-accent/40 bg-accent-soft text-accent',
  executor: 'border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  reserve: 'border-line bg-surface-2 text-muted',
};

function Roster({ engines, now }: { engines: FleetData['engines']; now: number }) {
  if (engines.length === 0) {
    return <Empty text="No fleet registry — nothing is registered for this bundle yet." cmd="samemind fleet init" />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs tracking-wide text-muted uppercase">
            <th scope="col" className="py-2 pr-3 font-medium">
              Engine
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Role
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Last seen
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Heartbeat
            </th>
            <th scope="col" className="py-2 font-medium">
              Silence
            </th>
          </tr>
        </thead>
        <tbody>
          {engines.map((e) => (
            <tr key={e.id} className="border-b border-line/70 last:border-0">
              <th scope="row" className="py-3 pr-3 text-left font-mono font-semibold">
                {e.id}
              </th>
              <td className="py-3 pr-3">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${ROLE_TONE[e.role] || ROLE_TONE.reserve}`}
                >
                  {e.role}
                </span>
              </td>
              <td className="py-3 pr-3">
                <span className={e.overdue ? 'font-medium text-danger' : ''}>{e.status}</span>
              </td>
              <td className="tnum py-3 pr-3 text-muted" title={e.lastSeen || 'never'}>
                {e.lastSeen ? ago(e.lastSeen, now) : <span className="text-danger">never</span>}
              </td>
              <td className="tnum py-3 pr-3 text-muted">{dur(e.heartbeatSec)}</td>
              <td className="py-3">
                <SilenceBar silentSec={e.silentSec} heartbeatSec={e.heartbeatSec} overdue={e.overdue} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live feed: every ledger line as it lands, newest on top. Same phase glyphs as the timeline
 * below it, so one vocabulary covers both views. No entrance animation — a row that slides in is
 * a row you can't read, and it would need a reduced-motion escape hatch for nothing.
 */
function LiveFeed({ events }: { events: LedgerEvent[] }) {
  if (events.length === 0) {
    return <Empty text="No events streamed yet — this fills as the ledger grows." cmd="samemind ledger append …" />;
  }
  return (
    // capped and scrollable: a full 60-event buffer would otherwise push the timeline and the
    // failures list off the screen
    <ol className="max-h-[26rem] divide-y divide-line overflow-y-auto">
      {events.map((e) => {
        const failed = e.phase === 'fail' || e.status === 'fail';
        return (
          <li
            key={eventKey(e)}
            className={`grid grid-cols-[4.5rem_1fr] items-baseline gap-x-3 gap-y-0.5 px-2 py-1.5 sm:grid-cols-[4.5rem_7rem_1fr] ${
              failed ? 'bg-danger-soft/60' : ''
            }`}
          >
            <span className="tnum text-[11px] text-muted" title={e.ts}>
              {hhmmss(e.ts)}
            </span>
            <span className="truncate font-mono text-[11px] text-muted" title={e.actor}>
              {e.actor}
            </span>
            <span className="col-span-2 flex min-w-0 items-baseline gap-1.5 sm:col-span-1">
              <span
                aria-hidden="true"
                className="shrink-0 text-xs"
                style={{ color: phaseColor(e) }}
                title={`${e.phase}/${e.status}`}
              >
                {phaseGlyph(e.phase)}
              </span>
              <span
                className={`shrink-0 font-mono text-xs font-semibold ${failed ? 'text-danger' : ''}`}
                title={e.topic}
              >
                {e.topic}
              </span>
              {isSubTopic(e.topic) ? <Chip title="a subagent's naryad">sub</Chip> : null}
              <span className="truncate text-xs text-muted" title={e.action}>
                {e.action}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Horizontal lanes, one per topic, dots positioned by timestamp across a shared time axis. */
function Timeline({ topics, now }: { topics: LedgerTopic[]; now: number }) {
  if (topics.length === 0) {
    return <Empty text="No events yet — the ledger for this bundle is empty." cmd="samemind ledger append …" />;
  }
  const lanes = [...topics]
    .sort((a, b) => Date.parse(b.last.ts) - Date.parse(a.last.ts))
    .slice(0, 15);

  const stamps = lanes.flatMap((l) => l.evs.map((e) => Date.parse(e.ts))).filter((n) => !Number.isNaN(n));
  const t0 = Math.min(...stamps);
  const t1 = Math.max(...stamps);
  const span = Math.max(1, t1 - t0);
  const pos = (ts: string) => ((Date.parse(ts) - t0) / span) * 100;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  return (
    <div>
      <ol className="flex flex-col gap-1">
        {lanes.map((l) => (
          <li key={l.topic} className="grid grid-cols-[9rem_1fr] items-center gap-3 md:grid-cols-[14rem_1fr]">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-semibold" title={l.topic}>
                {l.openFail ? <span className="text-danger">● </span> : null}
                {l.topic}
              </div>
              <div className="tnum text-[11px] text-muted">
                {l.count} events · {ago(l.last.ts, now)}
              </div>
            </div>
            <div className="relative h-9 rounded-[12px] bg-surface-2">
              <div className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-line" />
              {l.evs.map((e, i) => (
                <button
                  key={`${e.ts}-${i}`}
                  type="button"
                  className="absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-[10px] leading-none hover:scale-125"
                  style={{ left: `calc(12px + (100% - 24px) * ${pos(e.ts) / 100})`, color: phaseColor(e) }}
                  title={`${e.ts} · ${e.actor} · ${e.phase}/${e.status}\n${e.action}`}
                  aria-label={`${l.topic}, ${e.phase}, ${e.actor}, ${e.ts}: ${e.action}`}
                >
                  <span aria-hidden="true">{phaseGlyph(e.phase)}</span>
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <div className="tnum mt-2 flex justify-between border-t border-line pt-2 text-[11px] text-muted">
        <span>{day(t0)}</span>
        <span className="flex flex-wrap gap-x-3">
          <span>▶ start</span>
          <span>· step</span>
          <span>✓ done</span>
          <span>✕ fail</span>
          <span>⏸ block</span>
        </span>
        <span>{day(t1)}</span>
      </div>
    </div>
  );
}

export function Fleet() {
  const fleet = useApi<FleetData>('/api/fleet');
  const ledger = useApi<Ledger>('/api/ledger');
  const { now, events, live } = useApiStatus();

  if (!fleet.data && fleet.loading) return <Spinner label="reading the fleet registry" />;

  const engines = fleet.data?.engines || [];
  const stopPoints = fleet.data?.stopPoints || [];
  const overdueCount = engines.filter((e) => e.overdue).length;

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title="Engine roster"
        hint={`${engines.length} registered · ${overdueCount} overdue`}
      >
        <Roster engines={engines} now={now} />
      </Panel>

      <Panel
        title="Live feed"
        hint={`ledger events as they land, newest first (${FEED_LIMIT} max)`}
        right={<Chip tone={live ? 'ok' : 'neutral'}>{live ? '● live' : '○ polling'}</Chip>}
      >
        <LiveFeed events={events} />
      </Panel>

      <Panel title="Naryad timeline" hint="ledger topics, newest on top (15 max)">
        {!ledger.data && ledger.loading ? <Spinner label="reading the ledger" /> : <Timeline topics={ledger.data?.topics || []} now={now} />}
      </Panel>

      <Panel title="🔥 Open failures" hint="every unresolved fail event, with its artifact and ref">
        <FailureList failures={ledger.data?.openFailures || []} now={now} full />
      </Panel>

      <Card className="p-4">
        <h2 className="text-sm font-semibold tracking-wide">Stop points</h2>
        <p className="mt-0.5 text-xs text-muted">the pipeline halts before these by design</p>
        {stopPoints.length === 0 ? (
          <div className="mt-3">
            <Empty text="No stop points declared in the fleet registry." cmd="samemind fleet init" />
          </div>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {stopPoints.map((s) => (
              <li key={s}>
                <Chip tone="accent">✋ {s}</Chip>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

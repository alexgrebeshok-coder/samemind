// Overview (spec §3.1): KPI strip, kanban, open failures, overdue engines, ideas strip,
// recent activity.
import { useApi, useApiStatus, type Board, type Health } from '../api';
import { dur, typeColor } from '../lib';
import { FailureList, Kanban, RecentList } from '../shared';
import { AllQuiet, Card, Empty, Panel, SegmentedBar, Spinner, StatTile } from '../ui';

export function Overview() {
  const board = useApi<Board>('/api/board');
  const health = useApi<Health>('/api/health');
  const { now } = useApiStatus();
  const b = board.data;

  if (!b) {
    return board.loading ? (
      <Spinner label="reading the board" />
    ) : (
      <Empty text="Board unavailable — the API returned no data." cmd="samemind ui" />
    );
  }

  const failures = b.openFailuresShown || [];
  const overdue = b.overdueEnginesShown || [];

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 min-[1200px]:grid-cols-4">
        <StatTile label="Concepts" value={health.data?.concepts ?? b.backlog.length + b.inprog.length} />
        <StatTile label="In progress" value={b.inprog.length} note={`${b.blocked.length} blocked`} />
        <StatTile label="Open failures" value={b.openFailuresTotal} alert={b.openFailuresTotal > 0} />
        <StatTile label="Overdue engines" value={b.overdueEnginesTotal} alert={b.overdueEnginesTotal > 0} />
      </section>

      <section aria-label="Kanban">
        <h2 className="mb-2 text-sm font-semibold tracking-wide">Board</h2>
        <Kanban columns={{ backlog: b.backlog, inprog: b.inprog, blocked: b.blocked, done: b.done }} now={now} />
      </section>

      <div className="grid gap-5 min-[1200px]:grid-cols-2">
        <Panel title="🔥 Open failures" hint={`${b.openFailuresTotal} open in the ledger`}>
          <FailureList failures={failures} now={now} />
        </Panel>

        <Panel title="🔥 Overdue engines" hint="silence beyond the engine's heartbeat budget">
          {overdue.length === 0 ? (
            <AllQuiet what="every engine within its heartbeat" />
          ) : (
            <ul className="flex flex-col gap-2">
              {overdue.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-[12px] border border-danger/40 bg-danger-soft/40 p-3"
                >
                  <div>
                    <span className="font-mono text-sm font-semibold">{e.id}</span>
                    <span className="ml-2 text-[11px] text-muted">{e.role}</span>
                  </div>
                  <span className="tnum text-xs text-danger">
                    silent {dur(e.silentSec)} · limit {dur(e.heartbeatSec)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 min-[1200px]:grid-cols-2">
        <Panel title="Ideas" hint="spark → incubating → adopted">
          {b.ideaSpark.length + b.ideaIncubating.length + b.ideaAdopted.length === 0 ? (
            <Empty text="No ideas captured yet." cmd="samemind idea add …" />
          ) : (
            <>
              <SegmentedBar
                parts={[
                  { label: 'spark', value: b.ideaSpark.length, color: '#a3a3a3' },
                  { label: 'incubating', value: b.ideaIncubating.length, color: typeColor('idea') },
                  { label: 'adopted', value: b.ideaAdopted.length, color: 'var(--sm-accent)' },
                ]}
              />
              <ul className="mt-3 flex flex-col gap-1.5">
                {b.ideasVisible.slice(0, 5).map((d) => (
                  <li key={d.id} className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 text-muted">{String(d.fm.status || '')}</span>
                    <span className="truncate">{d.fm.title || d.id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title="Recent activity" hint={`touched in the last ${b.recentDays} days`}>
          <RecentList docs={b.recent} />
        </Panel>
      </div>

      {b.plans.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold tracking-wide">Plans in force</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {b.plans.map((p) => (
              <li
                key={p.id}
                className="rounded-full border border-violet-300 bg-violet-100 px-3 py-1 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200"
                title={String(p.fm.description || '')}
              >
                {p.fm.title || p.id}
                {p.fm.agreed_on ? <span className="tnum ml-1.5 opacity-70">agreed {p.fm.agreed_on}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

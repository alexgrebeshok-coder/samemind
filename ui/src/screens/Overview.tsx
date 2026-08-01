// Overview: backlog/done kanban, ideas, recent activity — in-flight KPIs live on Today.
import { useApi, useApiStatus, type Board } from '../api';
import { typeColor } from '../lib';
import { Kanban, RecentList } from '../shared';
import { Empty, Panel, SegmentedBar, Spinner } from '../ui';

export function Overview() {
  const board = useApi<Board>('/api/board');
  const { now } = useApiStatus();
  const b = board.data;

  if (!b) {
    return board.loading ? (
      <Spinner label="reading the board" />
    ) : (
      <Empty text="Board unavailable — the API returned no data." cmd="samemind ui" />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Kanban">
        <h2 className="mb-2 text-sm font-semibold tracking-wide">Backlog & done</h2>
        <Kanban
          columns={{ backlog: b.backlog, inprog: b.inprog, blocked: b.blocked, done: b.done }}
          now={now}
          overflow={b.ledgerOverflow}
          totals={b.columnTotals}
          only={['backlog', 'done']}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
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
    </div>
  );
}

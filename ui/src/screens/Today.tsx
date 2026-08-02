// Today — landing screen: what is in flight, what is stuck, what to do next (sm016).
// Board supplies kanban truth; handoff only fills sessionNext + recentDecisions.
import { navigate } from '../App';
import { useApi, useApiStatus, type Board, type BoardCard, type Handoff, type Health } from '../api';
import { blockedRecoveryCmd, cardView, idTail } from '../lib';
import { KpiStrip } from '../shared';
import { Markdown } from '../markdown';
import { Card, Cmd, Empty, Panel, Spinner, TypeBadge } from '../ui';

function decisionAgeLabel(ageDays: number): string {
  if (ageDays < 1 / 24) return 'today';
  if (ageDays < 1) return `${Math.max(1, Math.round(ageDays * 24))}h ago`;
  if (ageDays < 2) return '1d ago';
  return `${ageDays.toFixed(1)}d ago`;
}

function WorkCard({ card, now, blocked }: { card: BoardCard; now: number; blocked?: boolean }) {
  const { id, title, type, age, project, ledger, actor, reason, tooltip } = cardView(card, now);
  return (
    <li className="rounded-[12px] border border-line bg-surface p-3" title={tooltip || undefined}>
      {ledger ? (
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
      {ledger && tooltip ? <p className="mt-1 text-[11px] leading-snug text-muted">{tooltip}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {ledger ? (
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-muted">ledger</span>
        ) : project ? (
          <button
            type="button"
            onClick={() => navigate(`/projects/${project}`)}
            className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
          >
            {idTail(project)}
          </button>
        ) : null}
        <TypeBadge type={type} />
        <span className="tnum text-[11px] text-muted">{age}</span>
        {actor ? <span className="truncate text-[11px] text-muted">· {actor}</span> : null}
      </div>
      {reason ? <p className="mt-2 text-xs text-danger">{reason}</p> : null}
      {blocked ? <Cmd>{blockedRecoveryCmd(card)}</Cmd> : null}
    </li>
  );
}

function ColumnPanel({
  title,
  total,
  shown,
  overflow,
  cards,
  now,
  blocked,
  emptyText,
  emptyCmd,
}: {
  title: string;
  total: number;
  shown: number;
  overflow: number;
  cards: BoardCard[];
  now: number;
  blocked?: boolean;
  emptyText: string;
  emptyCmd: string;
}) {
  const hint =
    total === shown
      ? `${total} in the ledger`
      : `${shown} shown · ${total} total${overflow > 0 ? ` · ${overflow} more not shown` : ''}`;
  return (
    <Panel title={title} hint={hint}>
      {cards.length === 0 ? (
        <Empty text={emptyText} cmd={emptyCmd} />
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((c) => (
            <WorkCard key={c.id} card={c} now={now} blocked={blocked} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Today() {
  const board = useApi<Board>('/api/board');
  const handoff = useApi<Handoff>('/api/handoff');
  const health = useApi<Health>('/api/health');
  const { now } = useApiStatus();
  const b = board.data;
  const h = handoff.data;

  if (!b) {
    return board.loading ? (
      <Spinner label="reading the board" />
    ) : (
      <Empty text="Board unavailable — the API returned no data." cmd="samemind ui" />
    );
  }

  const inprogTotal = b.columnTotals?.inprog ?? b.inprog.length;
  const blockedTotal = b.columnTotals?.blocked ?? b.blocked.length;
  const inprogOverflow = b.ledgerOverflow?.inprog ?? 0;
  const blockedOverflow = b.ledgerOverflow?.blocked ?? 0;

  const sessionNext = h?.sessionNext ?? [];
  const recentDecisions = h?.recentDecisions ?? [];
  const dayWindow = h?.dayWindow ?? 14;

  return (
    <div className="flex flex-col gap-5">
      <KpiStrip board={b} health={health.data} />

      <div className="grid gap-5 xl:grid-cols-2">
        <ColumnPanel
          title="In flight"
          total={inprogTotal}
          shown={b.inprog.length}
          overflow={inprogOverflow}
          cards={b.inprog}
          now={now}
          emptyText="Nothing in progress — the board is quiet on active work."
          emptyCmd='samemind ledger append --actor cursor --topic my-topic --phase start --status wip --action "…"'
        />
        <ColumnPanel
          title="Blocked"
          total={blockedTotal}
          shown={b.blocked.length}
          overflow={blockedOverflow}
          cards={b.blocked}
          now={now}
          blocked
          emptyText="No blockers on the board — nothing is waiting on a fail or block phase."
          emptyCmd="samemind board"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title="What next"
          hint={
            h?.lastSession
              ? `from last session · ${h.lastSession.fm.title || h.lastSession.id}`
              : 'bullets from the last session doc'
          }
        >
          {handoff.loading && !h ? (
            <p className="text-sm text-muted">reading handoff…</p>
          ) : sessionNext.length === 0 ? (
            <Empty
              text="No session “Next” bullets yet — add a ## Next section to your latest Session doc, or start a new one."
              cmd="samemind handoff"
            />
          ) : (
            <Card tone="muted" className="p-4">
              <Markdown
                body={sessionNext.map((line) => `- ${line.replace(/^\s*[-*]\s*/, '')}`).join('\n')}
                onOpen={(id) => navigate(`/memory/${id}`)}
              />
            </Card>
          )}
        </Panel>

        <Panel title="Recent decisions" hint={`last ${dayWindow} days from handoff`}>
          {handoff.loading && !h ? (
            <p className="text-sm text-muted">reading handoff…</p>
          ) : recentDecisions.length === 0 ? (
            <Empty
              text="No decisions in the handoff window — decisions show up here once they are captured in the bundle."
              cmd="samemind query type Decision"
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {recentDecisions.slice(0, 8).map(({ d, date, age }) => (
                <li key={d.id} className="rounded-[12px] border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/memory/${d.id}`)}
                      className="text-left text-sm font-medium hover:text-accent"
                    >
                      {d.fm.title || d.fm.description || d.id}
                    </button>
                    <span className="tnum shrink-0 text-[11px] text-muted" title={date || undefined}>
                      {date ? `${date} · ` : ''}
                      {decisionAgeLabel(age)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <TypeBadge type={d.fm.type || 'Decision'} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

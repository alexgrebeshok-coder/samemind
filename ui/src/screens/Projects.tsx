// Projects (spec §3.4): a card per project doc with per-column task counts, plus a detail view
// with the board filtered to that project and its concept links.
import { useMemo } from 'react';
import { navigate } from '../App';
import { useApi, useApiStatus, type Board, type Concept, type ConceptRow, type Doc, type Graph } from '../api';
import { docDate, idTail, projectOf } from '../lib';
import { Markdown } from '../markdown';
import { COLUMNS, Kanban, type ColumnKey } from '../shared';
import { Card, Chip, Empty, Panel, Spinner, TypeBadge } from '../ui';

type Cols = Record<ColumnKey, Doc[]>;

function emptyCols(): Cols {
  return { backlog: [], inprog: [], blocked: [], done: [] };
}

function columnsFor(board: Board, projectId: string | null): Cols {
  const out = emptyCols();
  for (const c of COLUMNS) {
    const docs = board[c.key];
    out[c.key] = projectId ? docs.filter((d) => projectOf(d) === projectId) : docs;
  }
  return out;
}

function lastActivity(docs: Doc[], ownDate: string | null): string {
  const all = [ownDate, ...docs.map((d) => docDate(d.fm))].filter(Boolean) as string[];
  return all.sort().at(-1)?.slice(0, 10) || '—';
}

export function Projects({ id }: { id: string | null }) {
  const board = useApi<Board>('/api/board');
  const concepts = useApi<ConceptRow[]>('/api/concepts?type=Project');
  const graph = useApi<Graph>('/api/graph');
  const { now } = useApiStatus();

  const projects = concepts.data || [];
  const b = board.data;

  const cards = useMemo(() => {
    if (!b) return [];
    return projects.map((p) => {
      const cols = columnsFor(b, p.id);
      const docs = COLUMNS.flatMap((c) => cols[c.key]);
      return { p, cols, total: docs.length, last: lastActivity(docs, p.date) };
    });
  }, [b, projects]);

  if (!b || (!concepts.data && concepts.loading)) {
    return board.loading || concepts.loading ? (
      <Spinner label="reading projects" />
    ) : (
      <Empty text="Projects unavailable — the API returned no data." cmd="samemind ui" />
    );
  }

  if (id) return <ProjectDetail id={id} board={b} graph={graph.data} now={now} />;

  if (projects.length === 0) {
    return <Empty text="No project docs in this bundle yet." cmd="samemind write --type Project …" />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {cards.map(({ p, cols, total, last }) => (
        <Card key={p.id} className="flex flex-col p-4">
          <div className="flex items-baseline justify-between gap-2">
            <button
              type="button"
              onClick={() => navigate(`/projects/${p.id}`)}
              className="text-left text-base font-semibold hover:text-accent"
            >
              {p.title || idTail(p.id)}
            </button>
            <TypeBadge type={p.type} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            {p.status ? <Chip tone="accent">{p.status}</Chip> : null}
            <span className="tnum">last activity {last}</span>
          </div>
          <dl className="mt-3 grid grid-cols-4 gap-2">
            {COLUMNS.map((c) => (
              <div key={c.key} className="rounded-[12px] border border-line bg-surface-2 px-2 py-1.5 text-center">
                <dd className="tnum text-lg font-bold">{cols[c.key].length}</dd>
                <dt className="text-[10px] tracking-wide text-muted uppercase">{c.label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            {total === 0 ? 'no tasks linked to this project' : `${total} task${total === 1 ? '' : 's'} on the board`}
          </p>
          {p.tags.length ? (
            <p className="mt-2 truncate text-[11px] text-muted">{p.tags.map((t) => `#${t}`).join(' ')}</p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function ProjectDetail({
  id,
  board,
  graph,
  now,
}: {
  id: string;
  board: Board;
  graph: Graph | null;
  now: number;
}) {
  const detail = useApi<Concept>(`/api/concept/${id}`);
  const cols = columnsFor(board, id);
  const fm = detail.data?.frontmatter;
  const linked = (graph?.edges || []).filter((e) => e.from === id || e.to === id);
  const neighbours = [...new Set(linked.map((e) => (e.from === id ? e.to : e.from)))];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="rounded-[12px] border border-line px-3 py-1.5 text-xs hover:border-accent/60"
        >
          ← All projects
        </button>
        <h2 className="text-xl font-bold tracking-tight">{fm?.title || idTail(id)}</h2>
        {fm?.status ? <Chip tone="accent">{String(fm.status)}</Chip> : null}
        <code className="font-mono text-[11px] text-muted">{id}</code>
      </div>

      {fm?.description ? <p className="text-sm text-muted">{String(fm.description)}</p> : null}

      <section aria-label="Project board">
        <h3 className="mb-2 text-sm font-semibold tracking-wide">Board</h3>
        <Kanban columns={cols} now={now} />
      </section>

      <Panel title="Concept links" hint="everything the graph connects to this project">
        {neighbours.length === 0 ? (
          <Empty text="No resolved links to or from this project in the graph." />
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {neighbours.map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => navigate(`/memory/${n}`)}
                  className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] hover:border-accent/60"
                  title={n}
                >
                  {idTail(n)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {detail.data?.body ? (
        <Card className="p-4">
          <Markdown body={detail.data.body} onOpen={(next) => navigate(`/memory/${next}`)} />
        </Card>
      ) : detail.loading ? (
        <Spinner label="reading project doc" />
      ) : null}
    </div>
  );
}

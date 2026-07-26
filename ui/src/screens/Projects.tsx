// Projects (spec §3.4): a card per project doc — status, blurb, how much of the memory it touches,
// last activity — and a detail route with the doc itself, its links and its board when it has one.
import { useMemo } from 'react';
import { navigate } from '../App';
import {
  useApi,
  useApiStatus,
  useConceptMap,
  type Board,
  type BoardCard,
  type Concept,
  type ConceptRow,
  type Frontmatter,
  type Graph,
} from '../api';
import { docDate, idTail, neighbourIds, projectOf, snippet } from '../lib';
import { Markdown } from '../markdown';
import { COLUMNS, Kanban, type ColumnKey } from '../shared';
import { Card, Chip, Empty, Panel, Spinner, TypeBadge } from '../ui';

type Cols = Record<ColumnKey, BoardCard[]>;

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

function lastActivity(docs: BoardCard[], ownDate: string | null): string {
  // every card here came through projectOf(), so it is a real doc — docDate tolerates the rest
  const all = [ownDate, ...docs.map((d) => docDate('fm' in d ? d.fm : undefined))].filter(Boolean) as string[];
  return all.sort().at(-1)?.slice(0, 10) || '—';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function Projects({ id }: { id: string | null }) {
  const board = useApi<Board>('/api/board');
  const concepts = useApi<ConceptRow[]>('/api/concepts?type=Project');
  const graph = useApi<Graph>('/api/graph');
  const { now } = useApiStatus();

  const projects = concepts.data || [];
  // the list row carries no `description`; the per-doc frontmatter does (fetched once per id set)
  const ids = useMemo(() => projects.map((p) => p.id), [projects]);
  const fmById = useConceptMap(ids);
  const b = board.data;

  const cards = useMemo(() => {
    if (!b) return [];
    return projects.map((p) => {
      const cols = columnsFor(b, p.id);
      const docs = COLUMNS.flatMap((c) => cols[c.key]);
      return {
        p,
        cols,
        total: docs.length,
        last: lastActivity(docs, p.date),
        links: neighbourIds(graph.data, p.id).length,
      };
    });
  }, [b, projects, graph.data]);

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
      {cards.map(({ p, cols, total, last, links }) => {
        const fm = fmById.get(p.id);
        const status = p.status || String(fm?.status || '');
        const desc = snippet(fm?.description, 260);
        return (
          <Card key={p.id} className="overflow-hidden">
            {/* the whole card is the link — a project card exists to be opened */}
            <a
              href={`#/projects/${p.id}`}
              className="flex h-full flex-col gap-2 p-4 hover:bg-surface-2/60"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-base font-semibold">{p.title || idTail(p.id)}</span>
                <TypeBadge type={p.type} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                {status ? <Chip tone="accent">{status}</Chip> : null}
                {links > 0 ? (
                  <Chip title="concepts the link graph connects to this project">{plural(links, 'link')}</Chip>
                ) : null}
                <span className="tnum">last activity {last}</span>
              </div>
              {desc ? (
                <p className="line-clamp-2 text-xs leading-relaxed text-muted" title={String(fm?.description || '')}>
                  {desc}
                </p>
              ) : null}
              {total > 0 ? (
                // the counts strip only earns its space when there is something to count
                <dl className="mt-1 grid grid-cols-4 gap-2">
                  {COLUMNS.map((c) => (
                    <div key={c.key} className="rounded-[12px] border border-line bg-surface-2 px-2 py-1.5 text-center">
                      <dd className="tnum text-lg font-bold">{cols[c.key].length}</dd>
                      <dt className="text-[10px] tracking-wide text-muted uppercase">{c.label}</dt>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-auto text-xs text-muted">no linked tasks</p>
              )}
              {p.tags.length ? (
                <p className="truncate text-[11px] text-muted">{p.tags.map((t) => `#${t}`).join(' ')}</p>
              ) : null}
            </a>
          </Card>
        );
      })}
    </div>
  );
}

/** Frontmatter mini-table — the same fields Memory's concept view shows, minus the relations pane. */
function FrontmatterTable({ fm }: { fm: Frontmatter }) {
  const rows: [string, React.ReactNode][] = [
    ['type', fm.type ? <TypeBadge type={fm.type} /> : '—'],
    ['status', fm.status || '—'],
    ['visibility', fm.visibility || '—'],
    ['tags', fm.tags?.length ? fm.tags.map((t) => `#${t}`).join(' ') : '—'],
    ['date', String(fm.date || fm.agreed_on || fm.timestamp || '—').slice(0, 10)],
    ['source', String(fm.source || '—')],
  ];
  return (
    <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
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
  const tasks = COLUMNS.reduce((n, c) => n + cols[c.key].length, 0);
  const fm = detail.data?.frontmatter;
  const neighbours = neighbourIds(graph, id);
  const titles = useMemo(
    () => new Map((graph?.nodes || []).map((n) => [n.id, n.title || idTail(n.id)])),
    [graph],
  );

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

      {fm ? (
        <Card className="p-4">
          <FrontmatterTable fm={fm} />
        </Card>
      ) : null}

      {detail.data?.body ? (
        <Card className="p-4">
          <Markdown body={detail.data.body} onOpen={(next) => navigate(`/memory/${next}`)} />
        </Card>
      ) : detail.loading ? (
        <Spinner label="reading project doc" />
      ) : null}

      <Panel
        title={`Linked concepts (${neighbours.length})`}
        hint="everything the link graph joins to this project, inbound and outbound"
      >
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
                  {titles.get(n) || idTail(n)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* an empty 4-column board told the reader nothing but "0 0 0 0" */}
      {tasks > 0 ? (
        <section aria-label="Project board">
          <h3 className="mb-2 text-sm font-semibold tracking-wide">Board ({tasks})</h3>
          <Kanban columns={cols} now={now} />
        </section>
      ) : (
        <p className="text-xs text-muted">No task docs point at this project — nothing on the board.</p>
      )}
    </div>
  );
}

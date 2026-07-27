// Memory (spec §3.2): search + filters, concept list (virtualized past 200 rows), concept view,
// graph toggle.
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { useApi, type Concept, type ConceptRow, type Graph } from '../api';
import { GraphView } from '../graph';
import { idTail, linkToId, typeBadgeClass } from '../lib';
import { Markdown } from '../markdown';
import { Card, Chip, Empty, Spinner, TypeBadge } from '../ui';

const VIRTUALIZE_OVER = 200;
const ROW_H = 68;
const OVERSCAN = 6;

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Row({ row, active, onOpen }: { row: ConceptRow; active: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      aria-current={active ? 'true' : undefined}
      style={{ height: ROW_H }}
      className={`flex w-full flex-col justify-center gap-1 border-b border-line px-3 text-left last:border-0 ${
        active ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate text-sm ${active ? 'font-semibold text-accent' : ''}`}>
          {row.title || idTail(row.id)}
        </span>
        <span className="tnum shrink-0 text-[11px] text-muted">{row.date || '—'}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <TypeBadge type={row.type} />
        {row.status ? <span className="text-[11px] text-muted">{row.status}</span> : null}
        <span className="min-w-0 truncate text-[11px] text-muted">
          {row.tags.map((t) => `#${t}`).join(' ')}
        </span>
      </div>
    </button>
  );
}

/** Plain windowed list: fixed row height, render only what fits plus overscan. Kicks in past
 *  200 rows (spec §3.2.2); below that the whole list is cheap enough to render outright. */
function ConceptList({
  rows,
  activeId,
  onOpen,
}: {
  rows: ConceptRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(560);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const virtual = rows.length > VIRTUALIZE_OVER;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const end = virtual ? Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN) : rows.length;
  const slice = rows.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)}
      className="max-h-[70vh] min-h-[16rem] overflow-y-auto"
    >
      {virtual ? (
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
            {slice.map((r) => (
              <Row key={r.id} row={r} active={r.id === activeId} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ) : (
        slice.map((r) => <Row key={r.id} row={r} active={r.id === activeId} onOpen={onOpen} />)
      )}
    </div>
  );
}

function Relations({ relations, onOpen }: { relations: Record<string, string[]>; onOpen: (id: string) => void }) {
  const entries = Object.entries(relations || {}).filter(([, v]) => Array.isArray(v) && v.length);
  if (!entries.length) return <span className="text-xs text-muted">none</span>;
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([rel, targets]) => (
        <div key={rel} className="flex flex-wrap items-baseline gap-1.5">
          <span className="font-mono text-[11px] text-muted">{rel}</span>
          {targets.map((t) => {
            const id = linkToId(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => onOpen(id)}
                className="rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] text-accent hover:border-accent"
                title={id}
              >
                {idTail(id)}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Detail({ id, graph, onOpen }: { id: string; graph: Graph | null; onOpen: (id: string) => void }) {
  const { data, loading, error } = useApi<Concept>(`/api/concept/${id}`);
  if (!data) {
    if (loading) return <Spinner label="reading concept" />;
    return <Empty text={error ? `Could not load ${id} — ${error}` : `No concept at ${id}.`} />;
  }
  const fm = data.frontmatter || {};
  const citedBy = (graph?.edges || []).filter((e) => e.to === id);
  const rows: [string, React.ReactNode][] = [
    ['type', fm.type ? <TypeBadge type={fm.type} /> : '—'],
    ['status', fm.status || '—'],
    ['visibility', fm.visibility || '—'],
    ['tags', fm.tags?.length ? fm.tags.map((t) => `#${t}`).join(' ') : '—'],
    ['date', String(fm.date || fm.agreed_on || fm.timestamp || '—').slice(0, 10)],
    ['source', String(fm.source || '—')],
    ['relations', <Relations relations={fm.relations || {}} onOpen={onOpen} />],
  ];

  return (
    <article className="flex flex-col gap-4">
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold tracking-tight">{fm.title || idTail(id)}</h2>
          <code className="font-mono text-[11px] text-muted">{id}</code>
        </div>
        {fm.description ? <p className="mt-1 text-sm text-muted">{String(fm.description)}</p> : null}
      </header>

      <Card className="p-4">
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-xs tracking-wider text-muted uppercase">Cited by ({citedBy.length})</h3>
        {citedBy.length === 0 ? (
          <p className="text-xs text-muted">nothing links here yet</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {citedBy.map((e, i) => (
              <li key={`${e.from}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOpen(e.from)}
                  className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] hover:border-accent/60"
                  title={`${e.from} — ${e.rel || e.kind}`}
                >
                  {idTail(e.from)}
                  {e.rel ? <span className="ml-1 text-muted">[{e.rel}]</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <Markdown body={data.body} onOpen={onOpen} />
      </Card>
    </article>
  );
}

export function Memory({ id }: { id: string | null }) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [qInput, setQInput] = useState('');
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  const q = useDebounced(qInput);

  const all = useApi<ConceptRow[]>('/api/concepts');
  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (type) p.set('type', type);
    if (tag) p.set('tag', tag);
    const s = p.toString();
    return s ? `/api/concepts?${s}` : '/api/concepts';
  }, [q, type, tag]);
  const list = useApi<ConceptRow[]>(path);
  const graph = useApi<Graph>('/api/graph');

  const facets = useMemo(() => {
    const rows = all.data || [];
    const types = [...new Set(rows.map((r) => r.type).filter(Boolean))].sort();
    const tags = [...new Set(rows.flatMap((r) => r.tags))].sort();
    return { types, tags };
  }, [all.data]);

  const open = (nextId: string) => navigate(`/memory/${nextId}`);
  // A concept in the route always wins over the graph tab — otherwise clicking a graph node
  // changed the hash while the graph stayed on screen and the concept never opened (spec §3.2.4).
  const shown = id ? 'list' : view;
  const rows = list.data || [];
  const filtered = !!(q || type || tag);
  const clearFilters = () => {
    setQInput('');
    setType('');
    setTag('');
  };

  const selectClass =
    'rounded-[12px] border border-line bg-surface px-2 py-2 text-sm text-ink focus:border-accent';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-[12px] border border-line p-0.5" role="tablist" aria-label="Memory view">
          {(['list', 'graph'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={shown === v}
              onClick={() => {
                setView(v);
                if (v === 'graph' && id) navigate('/memory'); // leave the open concept behind
              }}
              className={`rounded-[10px] px-3 py-1.5 text-xs ${
                shown === v ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {v === 'list' ? 'Concepts' : 'Graph'}
            </button>
          ))}
        </div>
        {/* Narrow screens (<900px, same threshold the sidebar collapses at — spec §2): the search
            box was squeezed to ~267px by the two selects sharing the row, clipping its placeholder
            with no ellipsis. Push it to its own full-width row instead of letting it shrink. */}
        <label className="order-last flex min-w-[12rem] grow shrink basis-full items-center gap-2 rounded-[12px] border border-line bg-surface px-3 py-2 focus-within:border-accent min-[900px]:order-none min-[900px]:basis-0">
          <span aria-hidden="true" className="text-muted">
            ⌕
          </span>
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search concepts (BM25 over the bundle)"
            aria-label="Search concepts"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </label>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type" className={selectClass}>
          <option value="">All types</option>
          {facets.types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag" className={selectClass}>
          <option value="">All tags</option>
          {facets.tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        {filtered ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-[12px] border border-line px-3 py-2 text-xs hover:border-accent/60"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {shown === 'graph' ? (
        !graph.data ? (
          graph.loading ? (
            <Spinner label="building the graph" />
          ) : (
            <Empty text="Graph unavailable — the API returned no link model." />
          )
        ) : (
          <GraphView graph={graph.data} onOpen={open} />
        )
      ) : (
        <div className="grid gap-4 min-[1100px]:grid-cols-[22rem_1fr]">
          <Card className={`overflow-hidden ${id ? 'hidden min-[1100px]:block' : ''}`}>
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <h2 className="text-sm font-semibold">Concepts</h2>
              <span className="tnum text-xs text-muted">
                {rows.length}
                {rows.length > VIRTUALIZE_OVER ? ' · virtualized' : ''}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="p-3">
                {list.loading ? (
                  <Spinner />
                ) : filtered ? (
                  <div className="flex flex-col items-center gap-3">
                    <Empty text={`nothing found for ⟨${[q, type && `type:${type}`, tag && `#${tag}`].filter(Boolean).join(' ')}⟩`} />
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="rounded-[12px] border border-accent/50 bg-accent-soft px-3 py-1.5 text-xs text-accent"
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <Empty text="This bundle has no concepts yet." cmd="samemind write …" />
                )}
              </div>
            ) : (
              <ConceptList rows={rows} activeId={id} onOpen={open} />
            )}
          </Card>

          <div>
            {id ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate('/memory')}
                  className="mb-3 rounded-[12px] border border-line px-3 py-1.5 text-xs hover:border-accent/60 min-[1100px]:hidden"
                >
                  ← All concepts
                </button>
                <Detail id={id} graph={graph.data} onOpen={open} />
              </>
            ) : (
              <Card className="p-6">
                <h2 className="text-sm font-semibold">Pick a concept</h2>
                <p className="mt-1 text-sm text-muted">
                  Select a row to read its frontmatter, body and links. Types present:{' '}
                  {facets.types.length ? (
                    <span className="inline-flex flex-wrap gap-1.5 align-middle">
                      {facets.types.map((t) => (
                        <span key={t} className={`rounded-full border px-2 py-0.5 text-[11px] ${typeBadgeClass(t)}`}>
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )}
                </p>
                <p className="mt-3 text-xs text-muted">
                  <Chip>{graph.data ? `${graph.data.totalEdges} edges in the link graph` : 'graph loading'}</Chip>
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

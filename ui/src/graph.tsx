// graph.tsx — concentric link graph over /api/graph, hand-rolled SVG (spec §0: no chart libs).
// The layout itself lives in lib.ts (pure, unit-tested); this file only draws it and wires
// hover/focus/click. Nodes are focusable <g role="button"> so the graph is keyboard-reachable.
import { useMemo, useState } from 'react';
import type { Graph } from './api';
import { GRAPH_SIZE as SIZE, layout, typeColor } from './lib';
import { Chip } from './ui';

export function GraphView({ graph, onOpen }: { graph: Graph; onOpen: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const { placed, clipped } = useMemo(() => layout(graph), [graph]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const types = useMemo(() => [...new Set(graph.nodes.map((n) => n.type).filter(Boolean))].sort(), [graph.nodes]);

  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const activeIds = hover
    ? new Set([hover, ...edges.filter((e) => e.from === hover || e.to === hover).flatMap((e) => [e.from, e.to])])
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[12px] border border-line bg-surface p-2">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-auto w-full"
          role="group"
          aria-label={`Link graph: ${placed.length} nodes, ${edges.length} edges`}
        >
          <g stroke="var(--sm-line)">
            {edges.map((e, i) => {
              const a = byId.get(e.from)!;
              const b = byId.get(e.to)!;
              const lit = !!activeIds && (e.from === hover || e.to === hover);
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={lit ? 'var(--sm-accent)' : 'var(--sm-line)'}
                  strokeWidth={lit ? 1.6 : 0.8}
                  strokeDasharray={e.kind === 'relation' ? undefined : '3 3'}
                  opacity={activeIds && !lit ? 0.25 : 0.9}
                />
              );
            })}
          </g>
          {placed.map((p) => {
            const dim = activeIds && !activeIds.has(p.id);
            return (
              <g
                key={p.id}
                tabIndex={0}
                role="button"
                aria-label={`${p.title} (${p.type || 'untyped'}, ${p.deg} links)`}
                className="cursor-pointer"
                opacity={dim ? 0.3 : 1}
                onClick={() => onOpen(p.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onOpen(p.id);
                  }
                }}
                onMouseEnter={() => setHover(p.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(p.id)}
                onBlur={() => setHover(null)}
              >
                <title>{`${p.title} — ${p.type} · ${p.deg} links`}</title>
                <circle cx={p.x} cy={p.y} r={p.r} fill={typeColor(p.type)} stroke="var(--sm-bg)" strokeWidth={1.5} />
                {p.deg >= 4 || hover === p.id ? (
                  <text
                    x={p.x}
                    y={p.y - p.r - 5}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--sm-ink)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--sm-bg)', strokeWidth: 3 }}
                  >
                    {p.title.length > 26 ? p.title.slice(0, 25) + '…' : p.title}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>{placed.length} nodes</span>
        <span>·</span>
        <span title="edges whose both ends are concepts in this bundle; the model also counts links from index.md">
          {edges.length} of {graph.totalEdges} edges drawn ({graph.relCount} relations, {graph.mdEdges} markdown)
        </span>
        {clipped > 0 ? <Chip tone="accent">{clipped} less-connected nodes hidden (300-node budget)</Chip> : null}
        {edges.length === 0 && graph.broken.length > 0 ? (
          <Chip tone="danger">no edges resolved — every link target is reported broken (see below)</Chip>
        ) : null}
      </div>

      <ul className="flex flex-wrap gap-2">
        {types.map((t) => (
          <li key={t} className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="inline-block size-2.5 rounded-full" style={{ background: typeColor(t) }} aria-hidden="true" />
            {t}
          </li>
        ))}
      </ul>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-[12px] border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold">Orphans ({graph.orphans.length})</h3>
          <p className="mt-0.5 text-xs text-muted">no inbound links — nothing in the bundle points here</p>
          {graph.orphans.length === 0 ? (
            <p className="mt-2 text-xs text-ok">none — every concept is cited</p>
          ) : (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {graph.orphans.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onOpen(id)}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {id}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-[12px] border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold">Broken links ({graph.broken.length})</h3>
          <p className="mt-0.5 text-xs text-muted">link target missing from the bundle</p>
          {graph.broken.length === 0 ? (
            <p className="mt-2 text-xs text-ok">none — every link resolves</p>
          ) : (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto font-mono text-xs text-muted">
              {graph.broken.slice(0, 200).map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

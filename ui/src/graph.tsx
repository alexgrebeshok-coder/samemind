// graph.tsx — the Memory graph: hand-rolled SVG, hand-rolled physics (spec §0: no chart libs).
// Obsidian-style interaction: the layout settles by itself, the wheel zooms to the cursor, the
// background pans, and a node follows the pointer while the rest of the graph keeps living around
// it. All maths lives in sim.ts (pure, unit-tested); this file only wires DOM events to it.
//
// Above the 300-node budget the interactive mode is dropped for the original static concentric
// layout — an O(n²) tick is cheap at 300 nodes and pointless past it.
//
// Two measured decisions about the render loop, both from the live bundle (103 nodes / 296 edges):
//   1. React renders STRUCTURE only. The animation loop writes to the DOM directly — letting React
//      reconcile the scene every frame measured 52fps.
//   2. Edges are not 296 <line> elements but three pooled <path>s (solid relations, dashed links,
//      highlighted neighbourhood) whose `d` is rebuilt per frame. Per-element edges cost ~10ms of
//      main thread per frame; three path writes cost a fraction of that, and the renderer lays out
//      three elements instead of 296.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from './api';
import { GRAPH_MAX_NODES, GRAPH_SIZE as SIZE, layout, typeColor } from './lib';
import {
  IDENTITY_VIEW,
  LABEL_ZOOM,
  SIM_REST_ENERGY,
  createSim,
  fitView,
  isClick,
  panBy,
  settle,
  tick,
  toWorld,
  zoomAt,
  type SimNode,
  type View,
} from './sim';
import { Chip } from './ui';

// Only true hubs keep a label in the far view. Measured on the live bundle: deg>=4 labelled 63 of
// 103 nodes and the middle became a wall of text; deg>=10 still stacked 16 labels in the dense
// centre, because that is exactly where hubs sit. deg>=14 leaves 7. Everything else is labelled on
// hover, or once you zoom past LABEL_ZOOM.
// ponytail: no label collision avoidance — the few remaining centre labels can still overlap at the
// far zoom. A greedy "skip a label whose box hits one already placed" pass in paint() is the
// upgrade, worth it only if the far view is where people actually read names.
const LABEL_MIN_DEG = 14;
const WAKE_ALPHA = 0.4; // how much life an interaction breathes back into a settled layout

function trim(s: string, n = 26) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Shared chrome under the canvas: counts, legend, orphans, broken links. */
function GraphFooter({
  graph,
  shown,
  drawnEdges,
  clipped,
  onOpen,
}: {
  graph: Graph;
  shown: number;
  drawnEdges: number;
  clipped: number;
  onOpen: (id: string) => void;
}) {
  const types = useMemo(() => [...new Set(graph.nodes.map((n) => n.type).filter(Boolean))].sort(), [graph.nodes]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>{shown} nodes</span>
        <span>·</span>
        <span title="edges whose both ends are concepts in this bundle; the model also counts links from index.md">
          {drawnEdges} of {graph.totalEdges} edges drawn ({graph.relCount} relations, {graph.mdEdges} markdown)
        </span>
        {clipped > 0 ? <Chip tone="accent">{clipped} less-connected nodes hidden (300-node budget)</Chip> : null}
        {drawnEdges === 0 && graph.broken.length > 0 ? (
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
                  <button type="button" onClick={() => onOpen(id)} className="font-mono text-xs text-accent hover:underline">
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
    </>
  );
}

/** The original concentric layout, kept for graphs past the interactive budget. */
function StaticGraph({ graph, onOpen }: { graph: Graph; onOpen: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const { placed, clipped } = useMemo(() => layout(graph), [graph]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const active = hover
    ? new Set([hover, ...edges.filter((e) => e.from === hover || e.to === hover).flatMap((e) => [e.from, e.to])])
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[12px] border border-line bg-surface p-2">
        <p className="px-1 pb-1 text-[11px] text-muted">
          {graph.nodes.length} nodes is past the interactive budget — showing the static concentric layout.
        </p>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-auto w-full"
          role="group"
          aria-label={`Link graph: ${placed.length} nodes, ${edges.length} edges`}
        >
          {edges.map((e, i) => {
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const lit = !!active && (e.from === hover || e.to === hover);
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
                opacity={active && !lit ? 0.25 : 0.9}
              />
            );
          })}
          {placed.map((p) => (
            <g
              key={p.id}
              tabIndex={0}
              role="button"
              aria-label={`${p.title} (${p.type || 'untyped'}, ${p.deg} links)`}
              className="cursor-pointer"
              opacity={active && !active.has(p.id) ? 0.3 : 1}
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
              {p.deg >= LABEL_MIN_DEG || hover === p.id ? (
                <text
                  x={p.x}
                  y={p.y - p.r - 5}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--sm-ink)"
                  style={{ paintOrder: 'stroke', stroke: 'var(--sm-bg)', strokeWidth: 3 }}
                >
                  {trim(p.title)}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </div>
      <GraphFooter graph={graph} shown={placed.length} drawnEdges={edges.length} clipped={clipped} onOpen={onOpen} />
    </div>
  );
}

type DragState =
  | { kind: 'node'; node: SimNode; id: string; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; lastX: number; lastY: number; startX: number; startY: number; moved: boolean };

function ForceGraph({ graph, onOpen }: { graph: Graph; onOpen: (id: string) => void }) {
  const reduced = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // Mutable simulation state, deliberately outside React.
  const sim = useMemo(() => {
    const s = createSim(graph);
    if (reduced) settle(s); // reduced motion: arrive already at rest, never animate
    return s;
  }, [graph, reduced]);

  const [hover, setHoverState] = useState<string | null>(null);
  // Only what the MARKUP depends on lives in state: the zoom percentage readout and whether every
  // node is labelled. Both change on user gestures, not per frame.
  // `k` is here (not only in the ref) because labels must keep a constant SCREEN size: their font
  // and halo are divided by the scale. Zoom changes at gesture rate, not per frame, so the extra
  // render is cheap — panning does not touch this state at all.
  const [zoomState, setZoomState] = useState({ pct: 100, k: 1, allLabels: false });

  const svgRef = useRef<SVGSVGElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const relPathRef = useRef<SVGPathElement>(null);
  const linkPathRef = useRef<SVGPathElement>(null);
  const litPathRef = useRef<SVGPathElement>(null);
  const hoverRef = useRef<string | null>(null);
  const viewRef = useRef<View>(IDENTITY_VIEW);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const fittedRef = useRef(false);

  /** Writes the current simulation + view straight to the DOM. No React involved. */
  const paint = useCallback(() => {
    const v = viewRef.current;
    sceneRef.current?.setAttribute('transform', `translate(${v.tx} ${v.ty}) scale(${v.k})`);
    for (const n of sim.nodes) {
      nodeEls.current.get(n.id)?.setAttribute('transform', `translate(${n.x} ${n.y})`);
    }
    const hovered = hoverRef.current;
    let rel = '';
    let link = '';
    let lit = '';
    for (const e of sim.edges) {
      const a = sim.nodes[e.a];
      const b = sim.nodes[e.b];
      const seg = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      if (hovered && (a.id === hovered || b.id === hovered)) lit += seg;
      else if (e.kind === 'relation') rel += seg;
      else link += seg;
    }
    relPathRef.current?.setAttribute('d', rel);
    linkPathRef.current?.setAttribute('d', link);
    litPathRef.current?.setAttribute('d', lit);
  }, [sim]);

  const applyView = useCallback(
    (next: View) => {
      fittedRef.current = true;
      viewRef.current = next;
      paint();
      const pct = Math.round(next.k * 100);
      const allLabels = next.k >= LABEL_ZOOM;
      setZoomState((prev) => (prev.pct === pct && prev.allLabels === allLabels ? prev : { pct, k: next.k, allLabels }));
    },
    [paint],
  );

  /** One animation step: advance physics, paint, stop once the layout is at rest. */
  const step = useCallback(() => {
    const dragging = dragRef.current?.kind === 'node';
    const energy = tick(sim);
    paint();
    if (energy <= SIM_REST_ENERGY && !dragging) {
      rafRef.current = 0;
      // frame the graph the first time it settles — but never yank a viewport the user has moved
      if (!fittedRef.current) applyView(fitView(sim.nodes));
      return;
    }
    rafRef.current = requestAnimationFrame(step);
  }, [sim, paint, applyView]);

  useEffect(() => {
    if (reduced) {
      applyView(fitView(sim.nodes)); // settled synchronously already — just frame and paint it
      return;
    }
    viewRef.current = IDENTITY_VIEW;
    fittedRef.current = false;
    paint();
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [sim, reduced, step, paint, applyView]);

  /** Nudges the layout back to life after an interaction, restarting the loop if it had stopped. */
  const wake = useCallback(() => {
    if (reduced) return;
    sim.alpha = Math.max(sim.alpha, WAKE_ALPHA);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(step);
  }, [sim, reduced, step]);

  /** Client coords → viewBox units (the space every bit of view maths works in). */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: 0, y: 0 };
    return { x: ((clientX - rect.left) / rect.width) * SIZE, y: ((clientY - rect.top) / rect.height) * SIZE };
  }, []);

  // Wheel must be a non-passive listener or preventDefault cannot stop the page scrolling with it.
  // Trackpad pinch arrives as wheel+ctrlKey — same handler, it is the same gesture.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const p = toLocal(ev.clientX, ev.clientY);
      const intensity = ev.ctrlKey ? 0.02 : 0.0015; // pinch deltas are far smaller than wheel ticks
      applyView(zoomAt(viewRef.current, p.x, p.y, Math.exp(-ev.deltaY * intensity)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyView, toLocal]);

  const onNodePointerDown = (ev: React.PointerEvent, node: SimNode) => {
    ev.stopPropagation(); // do not also start a pan
    svgRef.current?.setPointerCapture(ev.pointerId);
    const p = toLocal(ev.clientX, ev.clientY);
    node.pinned = true;
    dragRef.current = { kind: 'node', node, id: node.id, startX: p.x, startY: p.y, moved: false };
    wake();
  };

  const onBackgroundPointerDown = (ev: React.PointerEvent) => {
    svgRef.current?.setPointerCapture(ev.pointerId);
    const p = toLocal(ev.clientX, ev.clientY);
    dragRef.current = { kind: 'pan', lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, moved: false };
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toLocal(ev.clientX, ev.clientY);
    if (!isClick(p.x - d.startX, p.y - d.startY)) d.moved = true;
    if (d.kind === 'node') {
      const w = toWorld(viewRef.current, p.x, p.y);
      d.node.x = w.x;
      d.node.y = w.y;
      d.node.vx = 0;
      d.node.vy = 0;
      wake();
    } else {
      applyView(panBy(viewRef.current, p.x - d.lastX, p.y - d.lastY));
      d.lastX = p.x;
      d.lastY = p.y;
    }
  };

  const endDrag = (ev: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    svgRef.current?.releasePointerCapture?.(ev.pointerId);
    if (d.kind === 'node') {
      d.node.pinned = false; // released: the node is free again, Obsidian-style
      if (!d.moved) onOpen(d.id); // travelled less than the threshold → that was a click
      wake();
    }
  };

  const zoomButton = (factor: number) => () => applyView(zoomAt(viewRef.current, SIZE / 2, SIZE / 2, factor));

  /** Hover drives both the node opacities (React) and the highlighted edge path (paint). */
  const setHover = useCallback(
    (id: string | null) => {
      hoverRef.current = id;
      setHoverState(id);
      paint();
    },
    [paint],
  );

  const { nodes, edges, clipped } = sim;
  const active = hover
    ? new Set([
        hover,
        ...edges
          .filter((e) => nodes[e.a].id === hover || nodes[e.b].id === hover)
          .flatMap((e) => [nodes[e.a].id, nodes[e.b].id]),
      ])
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[12px] border border-line bg-surface p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          <p className="text-[11px] text-muted">
            {reduced ? 'settled layout (reduced motion)' : 'drag a node, drag the background, scroll to zoom'}
          </p>
          <div className="flex items-center gap-1">
            <span className="tnum mr-1 text-[11px] text-muted" data-testid="zoom">
              {zoomState.pct}%
            </span>
            <button
              type="button"
              onClick={zoomButton(1 / 1.3)}
              aria-label="Zoom out"
              className="size-6 rounded-md border border-line text-xs leading-none hover:border-accent/60"
            >
              −
            </button>
            <button
              type="button"
              onClick={zoomButton(1.3)}
              aria-label="Zoom in"
              className="size-6 rounded-md border border-line text-xs leading-none hover:border-accent/60"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => applyView(fitView(sim.nodes))}
              aria-label="Fit graph to view"
              className="rounded-md border border-line px-2 py-0.5 text-[11px] hover:border-accent/60"
            >
              fit
            </button>
          </div>
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-auto w-full touch-none select-none"
          role="group"
          aria-label={`Link graph: ${nodes.length} nodes, ${edges.length} edges. Drag to move, scroll to zoom.`}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* background catcher: gives the pan gesture something to grab (transparent still hit-tests) */}
          <rect
            x={0}
            y={0}
            width={SIZE}
            height={SIZE}
            fill="transparent"
            className="cursor-grab"
            data-testid="graph-bg"
          />
          <g ref={sceneRef}>
            {/* pooled edge geometry: `d` is rewritten by paint(), never by React */}
            <path
              ref={relPathRef}
              data-testid="edges-relation"
              fill="none"
              stroke="var(--sm-muted)"
              strokeWidth={0.9}
              opacity={hover ? 0.12 : 0.4}
              vectorEffect="non-scaling-stroke"
            />
            <path
              ref={linkPathRef}
              data-testid="edges-link"
              fill="none"
              stroke="var(--sm-muted)"
              strokeWidth={0.9}
              strokeDasharray="3 3"
              opacity={hover ? 0.12 : 0.3}
              vectorEffect="non-scaling-stroke"
            />
            <path
              ref={litPathRef}
              data-testid="edges-lit"
              fill="none"
              stroke="var(--sm-accent)"
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
            {nodes.map((p) => {
              const dim = active && !active.has(p.id);
              const labelled = zoomState.allLabels || p.deg >= LABEL_MIN_DEG || hover === p.id;
              return (
                <g
                  key={p.id}
                  ref={(el) => {
                    if (el) nodeEls.current.set(p.id, el);
                    else nodeEls.current.delete(p.id);
                  }}
                  transform={`translate(${p.x} ${p.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${p.title} (${p.type || 'untyped'}, ${p.deg} links)`}
                  className="cursor-pointer"
                  opacity={dim ? 0.25 : 1}
                  onPointerDown={(ev) => onNodePointerDown(ev, p)}
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
                  <circle
                    r={p.r}
                    fill={typeColor(p.type)}
                    stroke={hover === p.id ? 'var(--sm-accent)' : 'var(--sm-bg)'}
                    strokeWidth={hover === p.id ? 2.5 : 1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  {labelled ? (
                    // sizes divided by the scale so a label reads the same at 20% and at 400%
                    <text
                      y={-p.r - 5 / zoomState.k}
                      textAnchor="middle"
                      fontSize={11 / zoomState.k}
                      fill="var(--sm-ink)"
                      style={{ paintOrder: 'stroke', stroke: 'var(--sm-bg)', strokeWidth: 2.5 / zoomState.k }}
                    >
                      {trim(p.title)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <GraphFooter graph={graph} shown={nodes.length} drawnEdges={edges.length} clipped={clipped} onOpen={onOpen} />
    </div>
  );
}

export function GraphView({ graph, onOpen }: { graph: Graph; onOpen: (id: string) => void }) {
  return graph.nodes.length > GRAPH_MAX_NODES ? (
    <StaticGraph graph={graph} onOpen={onOpen} />
  ) : (
    <ForceGraph graph={graph} onOpen={onOpen} />
  );
}

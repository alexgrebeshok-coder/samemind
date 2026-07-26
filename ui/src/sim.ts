// sim.ts — force-directed graph physics and viewport math. Pure: no React, no DOM, no clock.
// Lives apart from lib.ts (display helpers) because it is the only stateful-but-testable maths in
// the app, and it runs unmodified under plain node in src/lib.test.mjs.
//
// Forces per tick: all-pairs repulsion, springs along edges, mild gravity toward the centre,
// velocity damping, and a cooling `alpha` so the system provably comes to rest instead of
// jittering forever. Repulsion is O(n²) — at the graph's 300-node budget that is 45k cheap
// iterations per frame, far below a frame budget.
// ponytail: O(n²) repulsion, swap in Barnes-Hut only if the node budget ever leaves 300 behind.
import type { Graph } from './api';
import { GRAPH_MAX_NODES, GRAPH_SIZE, idTail } from './lib.ts'; // .ts so plain node can run this file in tests

const REPEL = 1600; // pairwise repulsion strength
const MIN_DIST = 12; // floor on pair distance, so coincident nodes don't launch each other
const SPRING = 0.02; // edge stiffness
const LINK_LEN = 78; // resting edge length
const GRAVITY = 0.012; // pull toward the centre, keeps islands from drifting off-canvas
const DAMP = 0.82; // velocity retained per tick
const MAX_V = 24; // speed clamp
const ALPHA_DECAY = 0.98;
const ALPHA_MIN = 0.008;

/** Below this kinetic energy the layout is at rest and the animation loop can stop. */
export const SIM_REST_ENERGY = 0.05;
/** Pointer travel (in viewBox units) that turns a click into a drag. */
export const DRAG_THRESHOLD = 4;
/**
 * Zoom at which every node gets a label, not just the hubs and the hovered one. Set past 2x on
 * purpose: at 1.6x the visible area still holds enough nodes for 100 labels to overlap.
 */
export const LABEL_ZOOM = 2.2;
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

export type SimNode = {
  id: string;
  title: string;
  type: string;
  deg: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** While pinned (dragged) the node ignores forces and sits where the pointer put it. */
  pinned: boolean;
};

export type SimEdge = { a: number; b: number; kind: 'link' | 'relation'; rel?: string };

export type Sim = { nodes: SimNode[]; edges: SimEdge[]; alpha: number; clipped: number };

/** Deterministic golden-angle spiral: same graph → same start, so reloads don't reshuffle. */
function seedPosition(i: number, n: number): { x: number; y: number } {
  const c = GRAPH_SIZE / 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const radius = (GRAPH_SIZE * 0.36) * Math.sqrt((i + 0.5) / Math.max(1, n));
  return { x: c + Math.cos(i * golden) * radius, y: c + Math.sin(i * golden) * radius };
}

export function createSim(graph: Pick<Graph, 'nodes' | 'edges'>): Sim {
  const degrees = new Map<string, number>();
  for (const e of graph.edges) {
    degrees.set(e.from, (degrees.get(e.from) || 0) + 1);
    degrees.set(e.to, (degrees.get(e.to) || 0) + 1);
  }
  // same ordering and same 300-node budget as the static layout, so the two modes agree on
  // which nodes are worth showing
  const sorted = [...graph.nodes].sort(
    (a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) || a.id.localeCompare(b.id),
  );
  const shown = sorted.slice(0, GRAPH_MAX_NODES);
  const index = new Map(shown.map((n, i) => [n.id, i]));

  const nodes: SimNode[] = shown.map((n, i) => {
    const deg = degrees.get(n.id) || 0;
    const { x, y } = seedPosition(i, shown.length);
    return {
      id: n.id,
      title: n.title || idTail(n.id),
      type: n.type,
      deg,
      r: Math.min(14, 6 + Math.sqrt(deg) * 1.8),
      x,
      y,
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  const edges: SimEdge[] = [];
  for (const e of graph.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push({ a, b, kind: e.kind, rel: e.rel });
  }
  return { nodes, edges, alpha: 1, clipped: sorted.length - shown.length };
}

/** Advances the simulation one step. Returns the total kinetic energy after the step. */
export function tick(sim: Sim): number {
  const { nodes, edges } = sim;
  const n = nodes.length;
  if (!n) return 0;
  const a = sim.alpha;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[i].x - nodes[j].x;
      let dy = nodes[i].y - nodes[j].y;
      let d2 = dx * dx + dy * dy;
      if (d2 < MIN_DIST * MIN_DIST) {
        // coincident or near-coincident: push apart along a deterministic axis
        if (d2 === 0) {
          dx = (i % 2 ? 1 : -1) * 0.5;
          dy = (j % 2 ? 1 : -1) * 0.5;
          d2 = dx * dx + dy * dy;
        }
        d2 = MIN_DIST * MIN_DIST;
      }
      const d = Math.sqrt(d2);
      const f = (REPEL * a) / d2;
      const ux = dx / d;
      const uy = dy / d;
      fx[i] += ux * f;
      fy[i] += uy * f;
      fx[j] -= ux * f;
      fy[j] -= uy * f;
    }
  }

  for (const e of edges) {
    const p = nodes[e.a];
    const q = nodes[e.b];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || MIN_DIST;
    const f = (d - LINK_LEN) * SPRING * a;
    const ux = (dx / d) * f;
    const uy = (dy / d) * f;
    fx[e.a] += ux;
    fy[e.a] += uy;
    fx[e.b] -= ux;
    fy[e.b] -= uy;
  }

  const c = GRAPH_SIZE / 2;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    fx[i] += (c - node.x) * GRAVITY * a;
    fy[i] += (c - node.y) * GRAVITY * a;
    let vx = (node.vx + fx[i]) * DAMP;
    let vy = (node.vy + fy[i]) * DAMP;
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_V) {
      vx = (vx / speed) * MAX_V;
      vy = (vy / speed) * MAX_V;
    }
    node.vx = vx;
    node.vy = vy;
    node.x += vx;
    node.y += vy;
    energy += vx * vx + vy * vy;
  }
  sim.alpha = Math.max(ALPHA_MIN, sim.alpha * ALPHA_DECAY);
  return energy;
}

/** Runs the simulation to rest without animating — used under prefers-reduced-motion. */
export function settle(sim: Sim, maxSteps = 400): { steps: number; energy: number } {
  let energy = Infinity;
  let steps = 0;
  while (steps < maxSteps && energy > SIM_REST_ENERGY) {
    energy = tick(sim);
    steps++;
  }
  return { steps, energy };
}

/** A drag becomes a drag (not a click) once the pointer has travelled far enough. */
export function isClick(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < DRAG_THRESHOLD;
}

// --- viewport ---------------------------------------------------------------------------------
// `view` maps world (simulation) coordinates to screen: screen = world * k + t. Both are in
// viewBox units, so the SVG stays responsive and pointer maths needs only the element's rect.

export type View = { k: number; tx: number; ty: number };
export const IDENTITY_VIEW: View = { k: 1, tx: 0, ty: 0 };

export function clampZoom(k: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
}

export function toWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k };
}

/**
 * Zoom anchored at a screen point: whatever sits under the cursor stays under the cursor.
 * Zooming to the centre instead is the classic bug — it walks the graph off screen.
 */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const k = clampZoom(view.k * factor);
  if (k === view.k) return view;
  const w = toWorld(view, sx, sy);
  return { k, tx: sx - w.x * k, ty: sy - w.y * k };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { k: view.k, tx: view.tx + dx, ty: view.ty + dy };
}

/** Fits every node into a `size`×`size` viewport with padding. */
export function fitView(nodes: Pick<SimNode, 'x' | 'y' | 'r'>[], size = GRAPH_SIZE, pad = 28): View {
  if (!nodes.length) return IDENTITY_VIEW;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r);
    minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    maxY = Math.max(maxY, n.y + n.r);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const k = clampZoom(Math.min((size - pad * 2) / w, (size - pad * 2) / h));
  return { k, tx: (size - w * k) / 2 - minX * k, ty: (size - h * k) / 2 - minY * k };
}

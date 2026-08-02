// Self-check for the pure display logic (time/age formatting, id mapping, ring layout) and for
// the security-critical markdown parse. Runs on plain node — no framework, no jsdom:
//   node --experimental-strip-types --test ui/src/lib.test.mjs
// (also wired as `npm test` inside ui/).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ago,
  agoSec,
  dur,
  ageLabel,
  linkToId,
  idTail,
  projectOf,
  typeBadgeClass,
  phaseGlyph,
  layout,
  silenceTone,
  SILENCE_COLOR,
  cardView,
  isLedgerCard,
  hhmmss,
  isSubTopic,
  eventKey,
  mergeEvents,
  nextRefreshDelay,
  FEED_LIMIT,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MIN_GAP_MS,
  neighbourIds,
  snippet,
} from './lib.ts';

import {
  createSim,
  tick,
  settle,
  isClick,
  zoomAt,
  toWorld,
  panBy,
  fitView,
  clampZoom,
  DRAG_THRESHOLD,
  SIM_REST_ENERGY,
  ZOOM_MIN,
  ZOOM_MAX,
  IDENTITY_VIEW,
} from './sim.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

/** A ring of `n` nodes, each linked to the next — enough structure for the physics to shape. */
function ringGraph(n) {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: `c/${i}`, title: `node ${i}`, type: 'Concept' })),
    edges: Array.from({ length: n }, (_, i) => ({ from: `c/${i}`, to: `c/${(i + 1) % n}`, kind: 'link' })),
  };
}

test('ago / agoSec collapse to coarse buckets', () => {
  const now = Date.parse('2026-07-26T12:00:00Z');
  assert.equal(ago('2026-07-26T11:59:48Z', now), '12s ago');
  assert.equal(ago('2026-07-26T11:56:00Z', now), '4m ago');
  assert.equal(ago('2026-07-26T09:00:00Z', now), '3h ago');
  assert.equal(ago('2026-07-23T12:00:00Z', now), '3d ago');
  assert.equal(ago(null, now), 'never');
  assert.equal(ago('not-a-date', now), '—');
  assert.equal(agoSec(0), '0s ago');
});

test('dur formats heartbeat budgets', () => {
  assert.equal(dur(45), '45s');
  assert.equal(dur(3600), '1h');
  assert.equal(dur(86400), '1d');
  assert.equal(dur(null), '—');
});

test('ageLabel prefers agreed_on > date > timestamp', () => {
  const now = Date.parse('2026-07-26T00:00:00Z');
  assert.equal(ageLabel({ timestamp: '2026-07-10T00:00:00Z' }, now), '16d old');
  assert.equal(ageLabel({ date: '2026-07-25', timestamp: '2026-07-10T00:00:00Z' }, now), '1d old');
  assert.equal(ageLabel({ agreed_on: '2026-07-26' }, now), 'today');
  assert.equal(ageLabel({}, now), '—');
});

test('link paths map to concept ids', () => {
  assert.equal(linkToId('/projects/lumen.md'), 'projects/lumen');
  assert.equal(linkToId('concepts/nova.md'), 'concepts/nova');
  assert.equal(idTail('concepts/engine-claude-code'), 'engine-claude-code');
  assert.equal(idTail('nova'), 'nova');
});

test('projectOf returns null for ledger cards instead of throwing', () => {
  assert.equal(projectOf(LEDGER_CARD), null);
  assert.equal(projectOf({ id: 'projects/bare' }), null, 'no fm, no relations, no crash');
});

test('projectOf reads relations, falling back to fm.relations then covers', () => {
  assert.equal(
    projectOf({ relations: { project: ['/projects/atlas.md'] }, fm: {} }),
    'projects/atlas',
  );
  assert.equal(projectOf({ relations: {}, fm: { relations: { project: ['/projects/lumen.md'] } } }), 'projects/lumen');
  assert.equal(projectOf({ relations: { covers: ['/projects/lumen.md'] }, fm: {} }), 'projects/lumen');
  assert.equal(projectOf({ relations: {}, fm: {} }), null);
});

// shapes copied off the wire from /api/board, not from the spec prose
const LEDGER_CARD = {
  id: 'ledger:samemind-1.0-finalize',
  title: 'samemind-1.0-finalize',
  type: 'Task',
  source: 'ledger',
  ts: '2026-07-26T17:45:28.058Z',
  actor: 'claude',
  action: 'stale worktrees removed, 22 auto/* merged',
};
const DOC_CARD = {
  id: 'projects/task-atlas-retrieval',
  relations: { project: ['/projects/atlas.md'] },
  fm: {
    type: 'Task',
    title: 'Wire retrieval strategy over the Atlas corpus',
    status: 'blocked',
    blocked_reason: 'Corpus ingestion paused — waiting on Alex.',
    description: 'Connect retrieval-strategy to Atlas sources.',
    timestamp: '2026-07-10T00:00:00Z',
  },
};

test('isLedgerCard discriminates on the top-level source, not fm.source', () => {
  assert.equal(isLedgerCard(LEDGER_CARD), true);
  assert.equal(isLedgerCard(DOC_CARD), false);
  // a doc whose frontmatter happens to say source: demo is still a doc card
  assert.equal(isLedgerCard({ id: 'x', fm: { source: 'ledger' } }), false);
});

test('cardView reads a ledger card without touching fm', () => {
  const now = Date.parse('2026-07-26T18:45:28.058Z');
  const v = cardView(LEDGER_CARD, now);
  assert.equal(v.title, 'samemind-1.0-finalize', 'title is the topic');
  assert.equal(v.age, '1h ago', 'age comes from ts');
  assert.equal(v.actor, 'claude');
  assert.equal(v.ledger, true);
  assert.equal(v.project, null, 'a ledger topic belongs to no project');
  assert.equal(v.reason, '', 'no blocked_reason exists on a synthesized card');
  assert.equal(v.tooltip, LEDGER_CARD.action);
  assert.equal(v.type, 'Task');
});

test('cardView still reads a real doc card the old way', () => {
  const now = Date.parse('2026-07-26T00:00:00Z');
  const v = cardView(DOC_CARD, now);
  assert.equal(v.title, 'Wire retrieval strategy over the Atlas corpus');
  assert.equal(v.age, '16d old');
  assert.equal(v.project, 'projects/atlas');
  assert.equal(v.ledger, false);
  assert.equal(v.actor, null);
  assert.match(v.reason, /Corpus ingestion paused/);
});

test('cardView survives the malformed cards that blanked the SPA', () => {
  // the actual pre-fix crash: reading .fm.relations on a card that has no fm
  assert.doesNotThrow(() => cardView({ id: 'ledger:t', source: 'ledger', ts: null, actor: '', action: '' }));
  assert.doesNotThrow(() => cardView({ id: 'projects/bare' })); // doc card with no fm at all
  const bare = cardView({ id: 'projects/bare' });
  assert.equal(bare.title, 'projects/bare', 'falls back to the id');
  assert.equal(bare.age, '—');
  assert.equal(bare.reason, '');
  const noTitle = cardView({ id: 'ledger:orphan-topic', source: 'ledger', ts: '', actor: '', action: '' });
  assert.equal(noTitle.title, 'orphan-topic', 'strips the ledger: prefix when no title came through');
  assert.equal(noTitle.age, 'never');
});

test('board counts are read from the model, never recounted from the capped arrays', () => {
  // guards the release-blocker: "In progress 8" on a bundle with 93 in-flight topics
  const shared = readFileSync(join(SRC, 'shared.tsx'), 'utf8');
  assert.match(shared, /columnTotals\?\.inprog \?\? b\.inprog\.length/, 'KPI prefers the model total');
  assert.match(shared, /columnTotals\?\.blocked \?\? b\.blocked\.length/, 'so does the blocked annotation');
  assert.doesNotMatch(shared, /value=\{b\.inprog\.length\}/, 'no bare capped-array count in a KPI tile');
  const today = readFileSync(join(SRC, 'screens', 'Today.tsx'), 'utf8');
  assert.match(today, /columnTotals\?\.inprog/, 'Today column headings use model totals');
  assert.match(today, /columnTotals\?\.blocked/, 'Today blocked column uses model totals');
  assert.doesNotMatch(today, /value=\{b\.inprog\.length\}/, 'no bare inprog.length as a heading total');
  assert.doesNotMatch(today, /value=\{b\.blocked\.length\}/, 'no bare blocked.length as a heading total');
  const overview = readFileSync(join(SRC, 'screens', 'Overview.tsx'), 'utf8');
  assert.doesNotMatch(overview, /\.filter\([^)]*source/, 'never filters derived cards out client-side');
  assert.match(shared, /totals\?\.\[c\.key\] \?\? docs\.length/, 'column heading prefers the model total');
});

test('type badge palette is per spec §4 and falls back to slate', () => {
  assert.match(typeBadgeClass('Task'), /sky/);
  assert.match(typeBadgeClass('plan'), /violet/);
  assert.match(typeBadgeClass('Decision'), /emerald/);
  assert.match(typeBadgeClass('Project'), /amber/);
  assert.match(typeBadgeClass('Session'), /rose/);
  assert.match(typeBadgeClass('Idea'), /lime/);
  assert.match(typeBadgeClass('EngineRule'), /slate/);
  assert.match(typeBadgeClass(undefined), /slate/);
});

test('phase glyphs match the timeline legend', () => {
  assert.deepEqual(
    ['start', 'step', 'done', 'fail', 'block'].map(phaseGlyph),
    ['▶', '·', '✓', '✕', '⏸'],
  );
});

test('silenceTone: green inside budget, amber past half, red only when the API says so', () => {
  assert.deepEqual(silenceTone(600, 3600, false), { tone: 'ok', pct: 17 });
  assert.deepEqual(silenceTone(1700, 3600, false), { tone: 'ok', pct: 47 });
  assert.equal(silenceTone(1800, 3600, false).tone, 'warn', 'half the budget is a warning');
  // the threshold is on the rounded percentage, so 49.97% displays as 50 and reads as a warning
  assert.deepEqual(silenceTone(1799, 3600, false), { tone: 'warn', pct: 50 });
  assert.equal(silenceTone(3500, 3600, false).tone, 'warn');
  // grok in the demo bundle: way past budget but the registry does not flag it — amber, not red,
  // so the bar never contradicts the roster's own "overdue" verdict
  assert.deepEqual(silenceTone(181989, 3600, false), { tone: 'warn', pct: 100 });
  assert.deepEqual(silenceTone(113589, 3600, true), { tone: 'bad', pct: 100 }, 'overdue → full red');
  assert.deepEqual(silenceTone(null, 1800, false), { tone: 'bad', pct: 100 }, 'never seen → full red');
  assert.equal(silenceTone(0, 3600, false).pct, 0);
  assert.equal(silenceTone(600, 0, false).pct, 100, 'zero budget must not divide by zero');
  // every tone maps to a theme token, so both themes follow without a second palette
  assert.deepEqual(Object.keys(SILENCE_COLOR).sort(), ['bad', 'ok', 'warn']);
  assert.ok(Object.values(SILENCE_COLOR).every((v) => v.startsWith('var(--sm-')));
});

test('kanban columns carry one colour edge each, all from theme tokens', async () => {
  const src = readFileSync(join(SRC, 'shared.tsx'), 'utf8');
  const edges = [...src.matchAll(/edge: '(var\(--sm-[a-z]+\))'/g)].map((m) => m[1]);
  assert.equal(edges.length, 4, 'one edge colour per column');
  assert.deepEqual(edges, ['var(--sm-muted)', 'var(--sm-accent)', 'var(--sm-danger)', 'var(--sm-ok)']);
  assert.equal(new Set(edges).size, 4, 'columns are distinguishable');
});

// ─────────────────────────── force simulation (src/sim.ts) ───────────────────────────

test('sim: energy decays to rest and the layout stops moving', () => {
  const sim = createSim(ringGraph(40));
  const first = tick(sim);
  const { steps, energy } = settle(sim);
  assert.ok(steps < 400, `settled in ${steps} steps, before the cap`);
  assert.ok(energy <= SIM_REST_ENERGY, `final energy ${energy} is at rest`);
  assert.ok(energy < first / 100, `energy fell from ${first.toFixed(1)} to ${energy.toFixed(4)}`);

  // and it STAYS at rest: ten more ticks must not move anything meaningfully
  const before = sim.nodes.map((n) => ({ x: n.x, y: n.y }));
  for (let i = 0; i < 10; i++) tick(sim);
  const moved = Math.max(...sim.nodes.map((n, i) => Math.hypot(n.x - before[i].x, n.y - before[i].y)));
  assert.ok(moved < 1, `largest drift after rest was ${moved.toFixed(3)}px`);
});

test('sim: springs pull linked nodes together, repulsion keeps the rest apart', () => {
  const sim = createSim(ringGraph(30));
  settle(sim);
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const linked = sim.edges.map((e) => d(sim.nodes[e.a], sim.nodes[e.b]));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const arbitrary = [];
  for (let i = 0; i < sim.nodes.length; i++) {
    const j = (i * 7 + 3) % sim.nodes.length;
    if (i !== j) arbitrary.push(d(sim.nodes[i], sim.nodes[j]));
  }
  assert.ok(avg(linked) < avg(arbitrary), `linked ${avg(linked).toFixed(1)} < arbitrary ${avg(arbitrary).toFixed(1)}`);
  assert.ok(sim.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), 'no NaN escaped');
});

test('sim: coincident nodes are pushed apart instead of exploding', () => {
  const sim = createSim(ringGraph(4));
  for (const n of sim.nodes) { n.x = 360; n.y = 360; n.vx = 0; n.vy = 0; }
  settle(sim);
  assert.ok(sim.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), 'still finite');
  const pairs = [];
  for (let i = 0; i < sim.nodes.length; i++)
    for (let j = i + 1; j < sim.nodes.length; j++)
      pairs.push(Math.hypot(sim.nodes[i].x - sim.nodes[j].x, sim.nodes[i].y - sim.nodes[j].y));
  assert.ok(Math.min(...pairs) > 1, `closest pair ended ${Math.min(...pairs).toFixed(1)}px apart`);
});

test('sim: a pinned node stays exactly where it was put while the rest keeps moving', () => {
  const sim = createSim(ringGraph(20));
  const held = sim.nodes[0];
  held.pinned = true;
  held.x = 100;
  held.y = 120;
  const othersBefore = sim.nodes.slice(1).map((n) => ({ x: n.x, y: n.y }));
  for (let i = 0; i < 30; i++) tick(sim);
  assert.equal(held.x, 100, 'pinned x untouched');
  assert.equal(held.y, 120, 'pinned y untouched');
  assert.equal(held.vx, 0);
  const movedOthers = sim.nodes.slice(1).filter((n, i) => Math.hypot(n.x - othersBefore[i].x, n.y - othersBefore[i].y) > 1);
  assert.ok(movedOthers.length > 0, 'the simulation kept living around the pinned node');
});

test('sim: deterministic — the same graph always seeds and settles identically', () => {
  const a = createSim(ringGraph(25));
  const b = createSim(ringGraph(25));
  settle(a);
  settle(b);
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y]), b.nodes.map((n) => [n.x, n.y]));
});

test('sim: edges to nodes outside the budget, and self-loops, are dropped', () => {
  const sim = createSim({
    nodes: [{ id: 'a', title: 'A', type: 'Concept' }, { id: 'b', title: 'B', type: 'Concept' }],
    edges: [
      { from: 'a', to: 'b', kind: 'link' },
      { from: 'a', to: 'a', kind: 'link' }, // self-loop
      { from: 'a', to: 'index', kind: 'link' }, // target is not a node (index.md)
    ],
  });
  assert.equal(sim.edges.length, 1);
  assert.deepEqual([sim.edges[0].a, sim.edges[0].b], [0, 1]);
});

// ─────────────────────────── click vs drag, zoom, pan, fit ───────────────────────────

test('isClick: the 4px threshold separates a click from a drag', () => {
  assert.equal(DRAG_THRESHOLD, 4);
  assert.equal(isClick(0, 0), true, 'no movement is a click');
  assert.equal(isClick(3, 0), true, 'a 3px twitch is still a click');
  assert.equal(isClick(0, -3.9), true);
  assert.equal(isClick(3, 3), false, '4.24px diagonal is a drag');
  assert.equal(isClick(0, 4), false, 'exactly the threshold is a drag');
  assert.equal(isClick(200, 200), false);
});

test('zoomAt: the point under the cursor stays under the cursor', () => {
  const view = { k: 1, tx: 0, ty: 0 };
  const cursor = { x: 200, y: 140 };
  const worldBefore = toWorld(view, cursor.x, cursor.y);
  for (const factor of [1.3, 1 / 1.3, 2, 0.5]) {
    const next = zoomAt(view, cursor.x, cursor.y, factor);
    const worldAfter = toWorld(next, cursor.x, cursor.y);
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9, `x anchored at factor ${factor}`);
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9, `y anchored at factor ${factor}`);
  }
  // anchoring must hold when starting from an already panned+zoomed view
  const panned = { k: 2.5, tx: -300, ty: 80 };
  const w = toWorld(panned, 90, 400);
  const zoomed = zoomAt(panned, 90, 400, 0.7);
  const w2 = toWorld(zoomed, 90, 400);
  assert.ok(Math.hypot(w2.x - w.x, w2.y - w.y) < 1e-9, 'anchored from a panned view too');
  // zooming to the centre instead would move the cursor's world point — guard against that bug
  const centreZoom = zoomAt(panned, 360, 360, 0.7);
  assert.notDeepEqual(centreZoom, zoomed, 'cursor anchoring differs from centre anchoring');
});

test('zoom stays inside 0.2–4x and is a no-op at the rails', () => {
  assert.equal(clampZoom(100), ZOOM_MAX);
  assert.equal(clampZoom(0.0001), ZOOM_MIN);
  const maxed = { k: ZOOM_MAX, tx: 10, ty: 20 };
  assert.equal(zoomAt(maxed, 100, 100, 2), maxed, 'already at max: same object, no drift');
  const mined = { k: ZOOM_MIN, tx: 10, ty: 20 };
  assert.equal(zoomAt(mined, 100, 100, 0.5), mined, 'already at min: same object');
  let v = IDENTITY_VIEW;
  for (let i = 0; i < 50; i++) v = zoomAt(v, 300, 300, 1.3);
  assert.equal(v.k, ZOOM_MAX, 'repeated zoom-in saturates instead of running away');
});

test('panBy shifts the viewport without changing scale', () => {
  const v = panBy({ k: 1.7, tx: 5, ty: -5 }, 30, -12);
  assert.deepEqual(v, { k: 1.7, tx: 35, ty: -17 });
});

test('fitView frames every node inside the viewport', () => {
  const size = 720;
  const sim = createSim(ringGraph(24));
  settle(sim);
  const v = fitView(sim.nodes, size);
  for (const n of sim.nodes) {
    const sx = n.x * v.k + v.tx;
    const sy = n.y * v.k + v.ty;
    assert.ok(sx >= 0 && sx <= size, `x ${sx.toFixed(1)} inside 0..${size}`);
    assert.ok(sy >= 0 && sy <= size, `y ${sy.toFixed(1)} inside 0..${size}`);
  }
  // a tight cluster zooms in, but never past the max
  const tight = [{ x: 359, y: 359, r: 6 }, { x: 361, y: 361, r: 6 }];
  assert.ok(fitView(tight, size).k <= ZOOM_MAX);
  assert.deepEqual(fitView([], size), IDENTITY_VIEW, 'empty graph: identity, no NaN');
});

test('graph layout: most-connected in the centre, 300-node budget, no NaN coordinates', () => {
  const nodes = Array.from({ length: 420 }, (_, i) => ({ id: `c/${i}`, title: `n${i}`, type: 'Concept' }));
  // node c/7 is the hub: every other node links to it
  const edges = nodes.filter((n) => n.id !== 'c/7').map((n) => ({ from: n.id, to: 'c/7', kind: 'link' }));
  const { placed, clipped } = layout({ nodes, edges, orphans: [], broken: [] });
  assert.equal(placed.length, 300);
  assert.equal(clipped, 120);
  assert.equal(placed[0].id, 'c/7', 'hub is placed first (ring 0 = centre)');
  assert.ok(placed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.r > 0));
  assert.equal(new Set(placed.map((p) => p.id)).size, 300, 'no node placed twice');

  const empty = layout({ nodes: [], edges: [], orphans: [], broken: [] });
  assert.deepEqual(empty.placed, []);
});

/** A ledger event as the stream delivers it — only the fields the feed reads. */
function ev(ts, over = {}) {
  return {
    ts,
    actor: 'cursor',
    topic: 'atlas-retrieval',
    phase: 'step',
    status: 'wip',
    action: `work at ${ts}`,
    artifact: null,
    ref: null,
    quarantine: false,
    ...over,
  };
}

test('live feed buffer: newest first, deduped, capped', () => {
  // snapshot arrives oldest-first, the way the file (and the append order) has it
  const snapshot = [ev('2026-07-26T10:00:00Z'), ev('2026-07-26T10:00:05Z'), ev('2026-07-26T10:00:09Z')];
  const buf = mergeEvents([], snapshot);
  assert.deepEqual(
    buf.map((e) => e.ts),
    ['2026-07-26T10:00:09Z', '2026-07-26T10:00:05Z', '2026-07-26T10:00:00Z'],
    'newest on top',
  );

  const withNew = mergeEvents(buf, [ev('2026-07-26T10:00:20Z')]);
  assert.equal(withNew[0].ts, '2026-07-26T10:00:20Z', 'a live event lands on top');
  assert.equal(withNew.length, 4);

  // a reconnect replays a snapshot that overlaps the buffer: nothing may double up
  const afterReconnect = mergeEvents(withNew, [...snapshot, ev('2026-07-26T10:00:20Z')]);
  assert.equal(afterReconnect.length, 4, 'overlapping snapshot adds nothing');
  assert.equal(new Set(afterReconnect.map(eventKey)).size, 4);

  // same timestamp, different action → two distinct rows, not one
  const twins = mergeEvents([], [ev('2026-07-26T10:00:00Z', { action: 'a' }), ev('2026-07-26T10:00:00Z', { action: 'b' })]);
  assert.equal(twins.length, 2);

  const flood = mergeEvents(
    [],
    Array.from({ length: FEED_LIMIT + 25 }, (_, i) => ev(new Date(Date.UTC(2026, 6, 26, 10, 0, i)).toISOString())),
  );
  assert.equal(flood.length, FEED_LIMIT, 'DOM budget holds');
  assert.equal(flood[0].ts, `2026-07-26T10:01:24.000Z`, 'the cap drops the oldest, not the newest');

  assert.deepEqual(mergeEvents([], []), []);
});

test('refresh scheduling: 2s debounce floor, never closer than 5s apart', () => {
  const now = 1_000_000;
  assert.equal(nextRefreshDelay(now, 0), REFRESH_DEBOUNCE_MS, 'no refresh yet → plain debounce');
  assert.equal(nextRefreshDelay(now, now - 9_000), REFRESH_DEBOUNCE_MS, 'long quiet → plain debounce');
  assert.equal(nextRefreshDelay(now, now - 1_000), REFRESH_MIN_GAP_MS - 1_000, 'fresh refresh → stretched to the gap');
  assert.equal(nextRefreshDelay(now, now), REFRESH_MIN_GAP_MS, 'back-to-back burst waits the whole gap');
  assert.ok(nextRefreshDelay(now, now - 3_000) >= REFRESH_DEBOUNCE_MS, 'the debounce is a floor, not a target');
});

test('feed row bits: clock time and the sub badge', () => {
  const local = new Date(2026, 6, 26, 9, 5, 3); // built local → the assertion is TZ-independent
  assert.equal(hhmmss(local.toISOString()), '09:05:03');
  assert.equal(hhmmss('not-a-date'), '—');
  assert.equal(isSubTopic('sub:atlas-retrieval'), true);
  assert.equal(isSubTopic('atlas-retrieval'), false);
  assert.equal(isSubTopic(''), false);
});

test('project card facts: graph neighbours fold both directions, snippet cuts once', () => {
  const graph = {
    edges: [
      { from: 'projects/p', to: 'concepts/a', kind: 'link' },
      { from: 'concepts/b', to: 'projects/p', kind: 'relation', rel: 'project' },
      { from: 'projects/p', to: 'concepts/a', kind: 'relation', rel: 'covers' }, // second edge, same pair
      { from: 'projects/p', to: 'projects/p', kind: 'link' }, // self-loop is not a relation
      { from: 'concepts/c', to: 'concepts/d', kind: 'link' }, // unrelated pair
    ],
  };
  assert.deepEqual(neighbourIds(graph, 'projects/p').sort(), ['concepts/a', 'concepts/b']);
  assert.deepEqual(neighbourIds(graph, 'concepts/d'), ['concepts/c'], 'inbound-only still counts');
  assert.deepEqual(neighbourIds(graph, 'projects/absent'), [], 'a node with no edges has no links');
  assert.deepEqual(neighbourIds(null, 'projects/p'), [], 'graph still loading → no crash, no links');

  assert.equal(snippet('субагент начал: правка UI'), 'субагент начал: правка UI', 'short text is untouched');
  assert.equal(snippet('a\n b\t\tc'), 'a b c', 'whitespace collapses to one line');
  assert.equal(snippet('', 10), '');
  assert.equal(snippet(undefined), '');
  assert.equal(snippet('x'.repeat(90)), 'x'.repeat(90), '90 chars is the cap, not past it');
  const cut = snippet('x'.repeat(200));
  assert.equal(cut.length, 90, 'the cap includes the ellipsis');
  assert.ok(cut.endsWith('…'));
  assert.equal(snippet('word boundary', 6), 'word…', 'a cut landing on a space loses it, not keeps it');
});

test('source carries no HTML-injection sinks and no external hosts (spec §0)', () => {
  const files = readdirSync(SRC, { recursive: true }).filter((f) => /\.(ts|tsx|css)$/.test(String(f)));
  assert.ok(files.length >= 8, `expected the whole src tree, saw ${files.length}`);
  for (const f of files) {
    const text = readFileSync(join(SRC, String(f)), 'utf8');
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML|new Function\(|eval\(/, `sink in ${f}`);
    // only same-origin /api/* may be fetched; no CDN, font or image host anywhere
    assert.doesNotMatch(text, /https?:\/\/(?!127\.0\.0\.1)/, `external URL in ${f}`);
  }
});

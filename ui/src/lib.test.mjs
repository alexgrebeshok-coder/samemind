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
} from './lib.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

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

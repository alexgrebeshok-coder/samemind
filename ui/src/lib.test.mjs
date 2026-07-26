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

test('projectOf reads relations, falling back to fm.relations then covers', () => {
  assert.equal(
    projectOf({ relations: { project: ['/projects/atlas.md'] }, fm: {} }),
    'projects/atlas',
  );
  assert.equal(projectOf({ relations: {}, fm: { relations: { project: ['/projects/lumen.md'] } } }), 'projects/lumen');
  assert.equal(projectOf({ relations: { covers: ['/projects/lumen.md'] }, fm: {} }), 'projects/lumen');
  assert.equal(projectOf({ relations: {}, fm: {} }), null);
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

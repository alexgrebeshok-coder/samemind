#!/usr/bin/env node
// html-render.test.mjs — tools/lib/html-render.mjs: self-contained HTML projections for
// `samemind board --html` / `samemind handoff --html` (see gbrain idea-html-projections.md).
// Unit (pure renderers over the shared data models) + CLI integration (demo bundle, --out
// atomic write, base suite stays green).
//   node --test tools/html-render.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderBoardHtml, renderHandoffHtml, svgKanbanBars, svgIdeasStrip, svgDecisionTimeline } from './lib/html-render.mjs';
import { buildBoardModel } from './board.mjs';
import { buildHandoffModel } from './handoff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, 'board.mjs');
const HANDOFF = join(HERE, 'handoff.mjs');
const DEMO = resolve(HERE, '..', 'demo');

const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const DAY = 86_400_000;
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

/** No http(s):// URL anywhere in the page — self-contained means zero external resources.
 * (Anchors, if any are ever added, use bundle-relative `#...`/`/path.md` — never a real URL —
 * so stripping `href="#..."` first is a no-op today but documents the intent.) */
function assertNoExternalUrls(html) {
  const stripped = html.replace(/href="#[^"]*"/g, '');
  assert.doesNotMatch(stripped, /https?:\/\//, 'no http(s):// URL anywhere in a self-contained page');
}

function assertSelfContained(html) {
  assert.match(html, /^<!doctype html>/i, 'starts with a doctype');
  assert.doesNotMatch(html, /<script/i, 'no JS at all — static report');
  assert.doesNotMatch(html, /<link\b/i, 'no external <link> (fonts/CSS CDN)');
  assert.match(html, /<style>/i, 'CSS is inlined');
  assert.match(html, /prefers-color-scheme:\s*dark/i, 'dark theme via prefers-color-scheme');
  assert.match(html, /<meta name="viewport"/i, 'mobile viewport meta present');
  assertNoExternalUrls(html);
}

function doc(id, fm) {
  return { id, base: id.split('/').pop(), reserved: false, fm, relations: fm.relations, body: fm.body || '' };
}
function task(id, status, extra = {}) {
  return doc(id, {
    type: 'Task',
    title: extra.title || id.split('/').pop(),
    description: extra.description || '',
    status,
    blocked_reason: extra.blocked_reason || '',
    timestamp: extra.timestamp ?? daysAgo(1),
    ...(extra.project ? { relations: { project: [extra.project] } } : {}),
  });
}

// ─────────────────────────────── unit: renderBoardHtml ───────────────────────────────

describe('renderBoardHtml — self-contained page over buildBoardModel', () => {
  const docs = [
    task('projects/t-back', 'backlog', { title: 'BacklogTask' }),
    task('projects/t-prog', 'in-progress', { title: 'ProgTask' }),
    task('projects/t-done', 'done', { title: 'DoneTask' }),
    task('projects/t-block', 'blocked', { title: 'BlockTask', blocked_reason: 'waiting on license', timestamp: daysAgo(20) }),
    doc('projects/p1', { type: 'Plan', title: 'ActivePlan', description: 'd', status: 'agreed', timestamp: daysAgo(1) }),
    doc('concepts/idea-1', { type: 'Idea', title: 'SparkIdea', description: 'raw idea', status: 'spark', timestamp: daysAgo(1) }),
  ];
  const model = buildBoardModel(docs, { now: NOW });
  const html = renderBoardHtml(model);

  it('is a self-contained page: no CDN/JS, both themes, mobile viewport', () => {
    assertSelfContained(html);
  });

  it('contains the four kanban counts and the tasks by column', () => {
    assert.match(html, /Backlog[\s\S]*\(1\)/);
    assert.match(html, /In progress[\s\S]*\(1\)/);
    assert.match(html, /Blocked[\s\S]*\(1\)/);
    assert.match(html, /Done[\s\S]*\(1\)/);
    assert.ok(html.includes('BacklogTask'));
    assert.ok(html.includes('ProgTask'));
    assert.ok(html.includes('DoneTask'));
    assert.ok(html.includes('BlockTask'));
  });

  it('shows the blocked reason and the aging marker past the threshold', () => {
    assert.ok(html.includes('waiting on license'));
    assert.match(html, /20d/);
    assert.match(html, /aging/);
  });

  it('shows the active plan and the spark idea', () => {
    assert.ok(html.includes('ActivePlan'));
    assert.ok(html.includes('SparkIdea'));
  });

  it('renders two SVG visualizations (kanban bars + Ideas strip), no external image refs', () => {
    const svgCount = (html.match(/<svg /g) || []).length;
    assert.ok(svgCount >= 2, `expected >=2 <svg>, got ${svgCount}`);
    assert.doesNotMatch(html, /<img\b/i);
  });

  it('is a pure function: same model → identical bytes', () => {
    assert.equal(renderBoardHtml(model), renderBoardHtml(buildBoardModel(docs, { now: NOW })));
  });

  it('empty bundle → a page with empty-state notes, no throw', () => {
    const emptyHtml = renderBoardHtml(buildBoardModel([], { now: NOW }));
    assertSelfContained(emptyHtml);
    assert.match(emptyHtml, /empty/);
  });
});

// ─────────────────────────────── unit: renderHandoffHtml ───────────────────────────────

describe('renderHandoffHtml — self-contained page over buildHandoffModel', () => {
  const FIXED_NOW = new Date('2026-07-10T12:00:00Z');
  function hdoc({ id, type, title, status, blocked_reason, agreed_on, date, engine, relations, body }) {
    const fm = { type, title: title || id, visibility: 'internal' };
    if (status !== undefined) fm.status = status;
    if (blocked_reason !== undefined) fm.blocked_reason = blocked_reason;
    if (agreed_on !== undefined) fm.agreed_on = agreed_on;
    if (date !== undefined) fm.date = date;
    if (engine !== undefined) fm.engine = engine;
    if (relations) fm.relations = relations;
    return { id, reserved: false, fm, body: body || `# ${title || id}\n` };
  }
  const docs = [
    hdoc({ id: 'projects/task-lumen-backlinks', type: 'Task', title: 'Ship Lumen backlink editor', status: 'in-progress' }),
    hdoc({ id: 'projects/task-atlas-retrieval', type: 'Task', title: 'Wire retrieval strategy over the Atlas corpus', status: 'blocked', blocked_reason: 'Corpus ingestion paused — waiting on license list.' }),
    hdoc({ id: 'projects/plan-lumen-sync', type: 'Plan', title: 'Lumen multi-device sync', status: 'agreed', agreed_on: '2026-07-08' }),
    hdoc({ id: 'concepts/decision-lumen-local-first', type: 'Decision', title: 'Lumen stays local-first', agreed_on: '2026-07-08' }),
    hdoc({
      id: 'concepts/session-2026-07-09-lumen-sync', type: 'Session', title: 'Lumen sync kickoff', engine: 'claude-code', date: '2026-07-09',
      body: '# Lumen sync kickoff\n\n## Done\n\n- Picked a CRDT-first direction.\n\n## Next\n\n- Land the backlink editor first.\n',
    }),
  ];
  const model = buildHandoffModel(docs, { now: FIXED_NOW, days: 14 });
  const html = renderHandoffHtml(model);

  it('is a self-contained page: no CDN/JS, both themes, mobile viewport', () => {
    assertSelfContained(html);
  });

  it('shows Active/Decisions/Plans/Session/Open sections with real content', () => {
    assert.ok(html.includes('Ship Lumen backlink editor'));
    assert.ok(html.includes('Wire retrieval strategy over the Atlas corpus'));
    assert.ok(html.includes('Corpus ingestion paused'));
    assert.ok(html.includes('Lumen multi-device sync'));
    assert.ok(html.includes('Lumen stays local-first'));
    assert.ok(html.includes('Lumen sync kickoff'));
    assert.ok(html.includes('Land the backlink editor first'));
  });

  it('renders a decision timeline SVG', () => {
    assert.match(html, /<svg /);
  });

  it('is a pure function: same model → identical bytes', () => {
    assert.equal(renderHandoffHtml(model), renderHandoffHtml(buildHandoffModel(docs, { now: FIXED_NOW, days: 14 })));
  });

  it('no active tasks/decisions → empty-state notes, no throw', () => {
    const emptyHtml = renderHandoffHtml(buildHandoffModel([], { now: FIXED_NOW }));
    assertSelfContained(emptyHtml);
    assert.match(emptyHtml, /empty/);
  });
});

// ─────────────────────────────────── unit: SVG helpers ───────────────────────────────────

describe('SVG helpers — pure, no external refs, degrade gracefully', () => {
  it('svgKanbanBars renders all-zero counts without throwing', () => {
    const svg = svgKanbanBars([
      { label: 'Backlog', value: 0, cls: 'backlog' },
      { label: 'In progress', value: 0, cls: 'inprogress' },
    ]);
    assert.match(svg, /<svg /);
    assertNoExternalUrls(svg);
  });

  it('svgIdeasStrip renders a fully-empty strip without throwing', () => {
    const svg = svgIdeasStrip([{ label: 'Spark', value: 0, cls: 'spark' }]);
    assert.match(svg, /<svg /);
  });

  it('svgDecisionTimeline renders a single point (no division by n-1 NaN)', () => {
    const svg = svgDecisionTimeline([{ label: 'Only decision', date: '2026-07-01' }]);
    assert.doesNotMatch(svg, /NaN/);
  });

  it('svgDecisionTimeline renders zero points (axis only)', () => {
    const svg = svgDecisionTimeline([]);
    assert.match(svg, /<svg /);
    assert.doesNotMatch(svg, /NaN/);
  });
});

// ───────────────────────────── integration: CLI --html on demo ─────────────────────────────

function runCLI(script, root, args) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

describe('CLI — `board --html` / `handoff --html` on the demo bundle', () => {
  it('board --html prints a self-contained page with demo content', () => {
    const { code, out, err } = runCLI(BOARD, DEMO, ['--html']);
    assert.equal(code, 0, err || out);
    assertSelfContained(out);
    assert.ok(out.includes('Wire retrieval strategy over the Atlas corpus'), 'blocked demo task shown');
    assert.ok(out.includes('Lumen multi-device sync'), 'agreed plan shown');
  });

  it('handoff --html prints a self-contained page with demo content', () => {
    const { code, out, err } = runCLI(HANDOFF, DEMO, ['--html']);
    assert.equal(code, 0, err || out);
    assertSelfContained(out);
    assert.ok(/local-first/i.test(out), 'decision shown');
    assert.ok(/Lumen sync kickoff|backlink/i.test(out), 'session/active task shown');
  });
});

describe('CLI — --html --out writes atomically', () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), 'samemind-html-out-')); });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('board --html --out <file> writes the page and leaves no temp file behind', () => {
    const target = join(root, 'board.html');
    const { code, err } = runCLI(BOARD, DEMO, ['--html', '--out', target]);
    assert.equal(code, 0, err);
    assert.ok(existsSync(target), 'out-file written');
    const content = readFileSync(target, 'utf8');
    assertSelfContained(content);
    assert.ok(content.includes('Lumen multi-device sync'));
    const leftovers = readdirSync(root).filter(f => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'no leftover .tmp file — atomic write cleaned up');
  });

  it('handoff --html --out <file> writes the page and leaves no temp file behind', () => {
    const target = join(root, 'handoff.html');
    const { code, err } = runCLI(HANDOFF, DEMO, ['--html', '--out', target]);
    assert.equal(code, 0, err);
    assert.ok(existsSync(target), 'out-file written');
    const content = readFileSync(target, 'utf8');
    assertSelfContained(content);
    assert.ok(/local-first/i.test(content));
    const leftovers = readdirSync(root).filter(f => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'no leftover .tmp file — atomic write cleaned up');
  });

  it('--out overwrites cleanly on a second run (atomic rename, not append/corrupt)', () => {
    const target = join(root, 'board-rerun.html');
    const first = runCLI(BOARD, DEMO, ['--html', '--out', target]);
    assert.equal(first.code, 0, first.err);
    const second = runCLI(BOARD, DEMO, ['--html', '--out', target]);
    assert.equal(second.code, 0, second.err);
    const content = readFileSync(target, 'utf8');
    // exactly one doctype/</html> — a bad (non-atomic) write could duplicate or truncate content
    assert.equal((content.match(/<!doctype html>/gi) || []).length, 1);
    assert.equal((content.match(/<\/html>/gi) || []).length, 1);
    assertSelfContained(content);
  });
});

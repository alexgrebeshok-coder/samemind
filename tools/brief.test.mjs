#!/usr/bin/env node
// brief.test.mjs — unit + CLI tests for `samemind brief` (node --test).
// Unit tests exercise buildBrief()/injectBrief() directly with hand-built docs (no OKF_ROOT
// juggling needed — buildBrief takes pre-loaded docs, injectBrief is pure file IO). CLI tests
// spawn tools/brief.mjs as a real subprocess against a demo-seeded tmp bundle (own process ⇒
// its own OKF_ROOT, no module-cache issues). Never touches the real repo or ~/samemind.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { buildBrief, injectBrief, BRIEF_START, BRIEF_END, DEFAULT_BUDGET_TOKENS } from './brief.mjs';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = join(HERE, 'brief.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

/** Minimal synthetic doc — only the fields buildBrief reads. */
function doc({ id, type, title, description, engine, body }) {
  const fm = { type, title, description };
  if (engine) fm.engine = engine;
  return { id, reserved: false, fm, body };
}

const NOVA = doc({
  id: 'concepts/nova',
  type: 'Identity',
  title: 'Nova',
  body: `
# Nova

Nova is the agent whose mind lives in this bundle.

## Voice

- Direct, no filler.
- Calm, dry wit.

## Values

- Simplicity is the highest virtue.

## Boundaries

- Never deletes files without an explicit "delete".

## Hierarchy under conflict

1. Safety
2. Owner's intent
`,
});

const ALEX = doc({
  id: 'entities/alex-doe',
  type: 'User',
  title: 'Alex Doe',
  body: `
# Alex Doe

Owner of Nova.

- Power user of LLMs.
- Hates: lies, flakiness, being ignored.

## Hobbies

- Side project: Lumen.
`,
});

const ENGINE_CC = doc({
  id: 'concepts/engine-claude-code',
  type: 'EngineRule',
  title: 'Engine — claude-code',
  description: 'terminal development role',
  body: `
# Engine: claude-code

On this engine Nova does terminal development.

- Works in the repo.
`,
});

const ENGINE_OC = doc({
  id: 'concepts/engine-openclaw',
  type: 'EngineRule',
  title: 'Engine — openclaw',
  description: 'chat orchestrator role',
  body: `
# Engine: openclaw

On this engine Nova is a chat orchestrator.

- Telegram-facing.
`,
});

describe('buildBrief — unit', () => {
  it('wraps output in the brief markers', () => {
    const { markdown } = buildBrief([NOVA, ALEX]);
    assert.ok(markdown.startsWith(BRIEF_START));
    assert.ok(markdown.trim().endsWith(BRIEF_END));
  });

  it('includes Identity (voice/values/boundaries) and User essence+rules', () => {
    const { markdown } = buildBrief([NOVA, ALEX]);
    assert.match(markdown, /Nova/);
    assert.match(markdown, /Direct, no filler/);
    assert.match(markdown, /Simplicity is the highest virtue/);
    assert.match(markdown, /Never deletes files without an explicit "delete"/);
    assert.match(markdown, /Alex Doe/);
    assert.match(markdown, /Hates: lies, flakiness, being ignored/);
  });

  it('with no --engine and EngineRule docs present, lists all engines one line each', () => {
    const { markdown, warnings } = buildBrief([NOVA, ALEX, ENGINE_CC, ENGINE_OC]);
    assert.match(markdown, /## Engines/);
    assert.match(markdown, /claude-code/);
    assert.match(markdown, /openclaw/);
    assert.equal(warnings.length, 0);
  });

  it('--engine <id> that matches includes only that engine\'s role, not others\'', () => {
    const { markdown, warnings } = buildBrief([NOVA, ALEX, ENGINE_CC, ENGINE_OC], { engine: 'claude-code' });
    assert.match(markdown, /Engine: claude-code/);
    assert.match(markdown, /terminal development/);
    assert.doesNotMatch(markdown, /chat orchestrator/);
    assert.doesNotMatch(markdown, /## Engines/); // no generic engine list once one is matched
    assert.equal(warnings.length, 0);
  });

  it('--engine <id> matches via explicit frontmatter `engine:` field', () => {
    const relabeled = doc({
      id: 'concepts/engine-weird-filename',
      type: 'EngineRule',
      title: 'Engine — claude-code',
      engine: 'claude-code',
      body: '# Engine: claude-code\n\nRole text here.\n',
    });
    const { markdown } = buildBrief([NOVA, ALEX, relabeled], { engine: 'claude-code' });
    assert.match(markdown, /Role text here/);
  });

  it('--engine <id> with no match warns and falls back to the engine list', () => {
    const { markdown, warnings } = buildBrief([NOVA, ALEX, ENGINE_CC], { engine: 'bogus-engine' });
    assert.match(markdown, /## Engines/);
    assert.ok(warnings.some(w => /bogus-engine/.test(w)));
  });

  it('missing Identity/User does not throw, warns instead', () => {
    const { markdown, warnings } = buildBrief([ENGINE_CC]);
    assert.ok(markdown.includes(BRIEF_START));
    assert.ok(warnings.some(w => /Identity/.test(w)));
    assert.ok(warnings.some(w => /User/.test(w)));
  });

  it('no Identity/User/EngineRule at all → clear notice instead of an empty blob (UAT quirk)', () => {
    const plain = doc({ id: 'concepts/plain', type: 'Concept', title: 'Just a note', body: '# Just a note\n\nsome text\n' });
    const { markdown, truncated } = buildBrief([plain]);
    assert.match(markdown, /no Identity\/User concept in this bundle/);
    assert.match(markdown, /identity-layer\.md/);
    assert.equal(truncated, false);
  });

  it('default budget comfortably fits the full demo-shaped brief (no truncation)', () => {
    const { truncated } = buildBrief([NOVA, ALEX, ENGINE_CC, ENGINE_OC], { engine: 'claude-code' });
    assert.equal(truncated, false);
  });

  it('a tight --budget drops low-priority sections first, keeps boundaries/rules', () => {
    const { markdown, truncated } = buildBrief([NOVA, ALEX, ENGINE_CC], { engine: 'claude-code', budgetTokens: 20 });
    assert.equal(truncated, true);
    // tier 0 (never dropped): identity boundaries, owner rules, matched engine role
    assert.match(markdown, /Never deletes files without an explicit "delete"/);
    assert.match(markdown, /Hates: lies, flakiness, being ignored/);
    assert.match(markdown, /terminal development/);
    // tier 2 (dropped first): Values
    assert.doesNotMatch(markdown, /Simplicity is the highest virtue/);
    assert.match(markdown, /truncated/);
  });

  it('DEFAULT_BUDGET_TOKENS is the documented ~1500', () => {
    assert.equal(DEFAULT_BUDGET_TOKENS, 1500);
  });

  it('--exclude-source drops concepts authored by that source (anti-echo)', () => {
    const echo = {
      id: 'concepts/engine-claude-code',
      reserved: false,
      fm: { type: 'EngineRule', title: 'Engine — claude-code', engine: 'claude-code', source: 'claude-code' },
      body: '# Engine: claude-code\n\nECHO-MARKER role text.\n',
    };
    const baseline = buildBrief([NOVA, ALEX, echo], { engine: 'claude-code' });
    assert.match(baseline.markdown, /ECHO-MARKER/);

    const filtered = buildBrief([NOVA, ALEX, echo], { engine: 'claude-code', excludeSource: 'claude-code' });
    assert.doesNotMatch(filtered.markdown, /ECHO-MARKER/, 'engine-authored rule filtered out');
    assert.doesNotMatch(filtered.markdown, /Engine: claude-code/);
  });
});

describe('buildBrief — smooth budget (paragraph-level trim)', () => {
  // Identity with a long multi-paragraph Values (tier-2) section, so a budget just under the full
  // size forces paragraph trimming of that one block (not a whole-block drop, not a hard mid-line cut).
  const longValues = Array.from({ length: 12 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `VAL-${n} paragraph of values. Lorem ipsum dolor sit amet consectetur adipiscing elit eiusmod tempor incididunt ut labore.`;
  }).join('\n\n');
  const BIG = doc({
    id: 'concepts/big',
    type: 'Identity',
    title: 'Big',
    body: `
# Big

Big intro line.

## Voice

VOICE-P1 a short voice paragraph, calm and direct.

## Values

${longValues}

## Boundaries

- Never deletes files without an explicit "delete".
- BOUND-LINE-2 second boundary kept verbatim at every budget.
- BOUND-LINE-3 third boundary kept verbatim at every budget.
`,
  });
  // A plain User with no extra sections → no "Owner — more" tier-2 block, so Values is the
  // ONLY tier-2 block and a near-full budget must paragraph-trim it (not drop it whole).
  const ALEX_PLAIN = doc({
    id: 'entities/alex-doe',
    type: 'User',
    title: 'Alex Doe',
    body: `
# Alex Doe

Owner of Nova.

- Hates: lies, flakiness, being ignored.
`,
  });
  const docs = [BIG, ALEX_PLAIN, ENGINE_CC];

  it('trims the last tier-2 section by paragraphs and marks the cut', () => {
    const full = buildBrief(docs, { engine: 'claude-code', budgetTokens: 100000 }).markdown;
    const fullLen = full.length;
    // target ~70% of full: tier-0 + voice + ~half of values — values is paragraph-trimmed
    const budget = Math.floor(fullLen * 0.70 / 4);
    const { markdown, truncated } = buildBrief(docs, { engine: 'claude-code', budgetTokens: budget });

    assert.equal(truncated, true);
    assert.match(markdown, /…truncated/);
    // tier-0 boundaries kept verbatim (never trimmed)
    assert.match(markdown, /BOUND-LINE-3/);
    assert.match(markdown, /Never deletes files without an explicit "delete"/);
    // values is prefix-trimmed: first paragraph kept, last cut
    assert.match(markdown, /VAL-01/);
    assert.doesNotMatch(markdown, /VAL-12/);
    // trimmed toward the budget, strictly under the full size
    assert.ok(markdown.length < fullLen, 'should be shorter than the full brief');
    assert.ok(markdown.length <= budget * 4 + 220, `over budget: ${markdown.length} vs target ${budget * 4}`);
  });

  it('tier-0 alone can exceed the budget without being cut (stays intact on purpose)', () => {
    // absurdly small budget: only tier-0 survives; it is NOT sliced mid-paragraph
    const { markdown } = buildBrief(docs, { engine: 'claude-code', budgetTokens: 1 });
    assert.match(markdown, /BOUND-LINE-3/);
    assert.match(markdown, /Engine: claude-code/);
  });

  it('monotone by tier-0/1: a larger budget never drops tier-0/1 text a smaller one kept', () => {
    const budgets = [40, 80, 120, 160, 200, 400];
    const briefs = budgets.map(b => buildBrief(docs, { engine: 'claude-code', budgetTokens: b }).markdown);
    // tier-0 anchors survive at every budget
    for (const md of briefs) {
      assert.match(md, /BOUND-LINE-2/);
      assert.match(md, /Engine: claude-code/);
    }
    // content size (sans truncation ellipsis noise) is non-decreasing
    const sizes = briefs.map(md => md.replace(/…truncated/g, '').length);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] >= sizes[i - 1] - 1, `size shrank at budget ${budgets[i]}: ${sizes[i]} < ${sizes[i - 1]}`);
    }
  });

  it('a comfortably large budget keeps every paragraph and marks nothing truncated', () => {
    const { markdown, truncated } = buildBrief(docs, { engine: 'claude-code', budgetTokens: 100000 });
    assert.equal(truncated, false);
    assert.doesNotMatch(markdown, /…truncated/);
    assert.match(markdown, /VAL-12/);
    assert.match(markdown, /VOICE-P1/);
  });

  it('demo bundle: brief size lands within ±10% across the working budget range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-smooth-'));
    try {
      assert.equal(runInit({ targetDir: dir, demo: true }).ok, true);
      for (const b of [450, 500, 520, 540]) {
        const out = execFileSync(process.execPath, [BRIEF, '--engine', 'claude-code', '--budget', String(b)], {
          env: { ...process.env, OKF_ROOT: dir },
          encoding: 'utf8',
        });
        const target = b * 4;
        const ratio = out.length / target;
        assert.ok(ratio >= 0.9 && ratio <= 1.1, `budget ${b}: ratio ${ratio.toFixed(3)} outside ±10% (size ${out.length} vs target ${target})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('injectBrief — idempotent insertion', () => {
  it('creates the file with the block when it does not exist', () => {
    const dir = tmp('inject-new');
    try {
      const file = join(dir, 'CLAUDE.md');
      const block = `${BRIEF_START}\nhello\n${BRIEF_END}`;
      const res = injectBrief(file, block);
      assert.equal(res.created, true);
      assert.equal(readFileSync(file, 'utf8'), `${block}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends the block to an existing file with no prior block, preserving content', () => {
    const dir = tmp('inject-append');
    try {
      const file = join(dir, 'CLAUDE.md');
      writeFileSync(file, '# My own notes\n\nDo not touch this.\n', 'utf8');
      const block = `${BRIEF_START}\nhello\n${BRIEF_END}`;
      const res = injectBrief(file, block);
      assert.equal(res.created, false);
      assert.equal(res.replaced, false);
      const out = readFileSync(file, 'utf8');
      assert.match(out, /Do not touch this\./);
      assert.match(out, new RegExp(block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an existing block in place, leaves surrounding text untouched, and is idempotent', () => {
    const dir = tmp('inject-idempotent');
    try {
      const file = join(dir, 'CLAUDE.md');
      writeFileSync(file, `# Before\n\nmy own text\n\n${BRIEF_START}\nOLD BRIEF\n${BRIEF_END}\n\n# After\n\nmore of my own text\n`, 'utf8');
      const block = `${BRIEF_START}\nNEW BRIEF\n${BRIEF_END}`;

      const res1 = injectBrief(file, block);
      assert.equal(res1.replaced, true);
      const afterFirst = readFileSync(file, 'utf8');
      assert.match(afterFirst, /my own text/);
      assert.match(afterFirst, /more of my own text/);
      assert.match(afterFirst, /NEW BRIEF/);
      assert.doesNotMatch(afterFirst, /OLD BRIEF/);
      // exactly one pair of markers
      assert.equal((afterFirst.match(new RegExp(BRIEF_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);

      const res2 = injectBrief(file, block);
      const afterSecond = readFileSync(file, 'utf8');
      assert.equal(afterFirst, afterSecond, 'second run must be a no-op byte-for-byte');
      assert.equal(res2.replaced, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('samemind brief — CLI (demo bundle)', () => {
  function makeDemoBundle() {
    const dir = tmp('brief-cli');
    const result = runInit({ targetDir: dir, demo: true });
    assert.equal(result.ok, true, 'demo bundle scaffold failed');
    return dir;
  }

  it('with no args: brief contains Nova + Alex Doe + engine rules', () => {
    const dir = makeDemoBundle();
    try {
      const out = execFileSync(process.execPath, [BRIEF], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(out, new RegExp(BRIEF_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(out, /Nova/);
      assert.match(out, /Alex Doe/);
      assert.match(out, /claude-code/);
      assert.match(out, /openclaw/);
      assert.match(out, /opencode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--engine claude-code gives that engine\'s role specifically', () => {
    const dir = makeDemoBundle();
    try {
      const out = execFileSync(process.execPath, [BRIEF, '--engine', 'claude-code'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(out, /Engine: claude-code/);
      assert.match(out, /terminal development/);
      assert.doesNotMatch(out, /chat orchestrator/);
      assert.doesNotMatch(out, /batch coder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--budget forces truncation and still keeps boundaries', () => {
    const dir = makeDemoBundle();
    try {
      const out = execFileSync(process.execPath, [BRIEF, '--engine', 'claude-code', '--budget', '10'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.match(out, /Never deletes files/);
      assert.match(out, /truncated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--inject is idempotent end-to-end via the CLI and preserves foreign content', () => {
    const dir = makeDemoBundle();
    const injectDir = tmp('brief-inject-target');
    try {
      const file = join(injectDir, 'CLAUDE.md');
      writeFileSync(file, '# Sasha\'s own instructions\n\nDo not delete without asking.\n', 'utf8');

      execFileSync(process.execPath, [BRIEF, '--engine', 'claude-code', '--inject', file], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      const once = readFileSync(file, 'utf8');
      assert.match(once, /Do not delete without asking\./);
      assert.match(once, new RegExp(BRIEF_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      execFileSync(process.execPath, [BRIEF, '--engine', 'claude-code', '--inject', file], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      const twice = readFileSync(file, 'utf8');
      assert.equal(once, twice, 'second --inject run must not change the file');
      // exactly one block
      assert.equal((twice.match(new RegExp(BRIEF_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(injectDir, { recursive: true, force: true });
    }
  });

  it('bin/samemind.mjs routes "brief" to tools/brief.mjs', () => {
    const dir = makeDemoBundle();
    try {
      const out = execFileSync(process.execPath, [BIN, 'brief', '--engine', 'claude-code'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(out, /Engine: claude-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

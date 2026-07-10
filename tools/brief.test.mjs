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

#!/usr/bin/env node
// install.test.mjs — unit + CLI tests for `samemind install` (node --test).
// Unit tests exercise buildInstallBlock()/injectInstallBlock() directly with hand-built docs
// (same pattern as brief.test.mjs). CLI tests spawn tools/install.mjs / bin/samemind.mjs as a
// real subprocess against a demo-seeded tmp bundle, writing into a SEPARATE tmp --target dir
// (own process ⇒ its own OKF_ROOT, no module-cache issues). Never touches the real repo,
// ~/samemind, or any global config — only tmp dirs under the OS tmp root.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  ENGINE_FILES, INSTALL_START, INSTALL_END, buildInstallBlock, injectInstallBlock,
} from './install.mjs';
import { BRIEF_START, BRIEF_END } from './brief.mjs';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, 'install.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

/** Minimal synthetic doc — only the fields buildBrief (via buildInstallBlock) reads. */
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

## Boundaries

- Never deletes files without an explicit "delete".
`,
});

const ALEX = doc({
  id: 'entities/alex-doe',
  type: 'User',
  title: 'Alex Doe',
  body: `
# Alex Doe

Owner of Nova.

- Hates: lies, flakiness, being ignored.
`,
});

const ENGINE_CC = doc({
  id: 'concepts/engine-claude-code',
  type: 'EngineRule',
  title: 'Engine — claude-code',
  engine: 'claude-code',
  body: `
# Engine: claude-code

On this engine Nova does terminal development.
`,
});

describe('ENGINE_FILES — supported engine table', () => {
  const expectedIds = [
    'claude-code', 'cursor', 'copilot', 'codex', 'gemini-cli', 'opencode',
    'cline', 'roo', 'windsurf', 'goose', 'kiro', 'antigravity',
  ];

  it('declares exactly the N13 target list, each with a label and at least one file', () => {
    assert.deepEqual(Object.keys(ENGINE_FILES).sort(), expectedIds.sort());
    for (const [id, meta] of Object.entries(ENGINE_FILES)) {
      assert.ok(meta.label && meta.label.length > 0, `${id} needs a label`);
      assert.ok(Array.isArray(meta.files) && meta.files.length > 0, `${id} needs files`);
    }
  });

  it('rules-file engines (cursor/roo/kiro/windsurf) get a dedicated samemind.md in their folder', () => {
    assert.ok(ENGINE_FILES.cursor.files.includes('.cursor/rules/samemind.md'));
    assert.ok(ENGINE_FILES.roo.files.includes('.roo/rules/samemind.md'));
    assert.ok(ENGINE_FILES.kiro.files.includes('.kiro/steering/samemind.md'));
    assert.ok(ENGINE_FILES.windsurf.files.includes('.windsurf/rules/samemind.md'));
  });

  it('AGENTS.md is the shared file for the AGENTS.md-adopters', () => {
    for (const id of ['cursor', 'copilot', 'codex', 'opencode', 'windsurf', 'antigravity']) {
      assert.ok(ENGINE_FILES[id].files.includes('AGENTS.md'), `${id} should read AGENTS.md`);
    }
  });
});

describe('buildInstallBlock — unit', () => {
  it('wraps output in the install markers', () => {
    const { block } = buildInstallBlock([NOVA, ALEX, ENGINE_CC], 'claude-code');
    assert.ok(block.startsWith(INSTALL_START));
    assert.ok(block.trim().endsWith(INSTALL_END));
  });

  it('embeds the identity brief (without its own nested BRIEF markers) and the protocol core', () => {
    const { block } = buildInstallBlock([NOVA, ALEX, ENGINE_CC], 'claude-code');
    assert.match(block, /Nova is the agent whose mind lives in this bundle/);
    assert.match(block, /Never deletes files without an explicit "delete"/);
    assert.match(block, /Alex Doe/);
    assert.match(block, /## samemind memory/);
    assert.match(block, /## Write discipline \(MUST\)/);
    assert.match(block, /memory_write_inbox/);
    // the brief's own start/end markers must not leak into the install block verbatim
    assert.doesNotMatch(block, new RegExp(BRIEF_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(block, new RegExp(BRIEF_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('names the specific engine label in the protocol footer when engineId matches an EngineRule', () => {
    const { block } = buildInstallBlock([NOVA, ALEX, ENGINE_CC], 'claude-code');
    assert.match(block, /On this engine Nova does terminal development/);
    assert.match(block, /installed for \*\*Claude Code\*\*/);
  });

  it('engineId=null renders a generic, engine-agnostic block (used for files shared by several engines)', () => {
    const { block } = buildInstallBlock([NOVA, ALEX, ENGINE_CC], null);
    assert.match(block, /installed for \*\*this agent\*\*/);
    assert.doesNotMatch(block, /terminal development/);
  });

  it('an id outside ENGINE_FILES still renders — uses the id itself as the label, generic brief, never throws', () => {
    const { block, warnings } = buildInstallBlock([NOVA, ALEX], 'some-future-engine');
    assert.match(block, /some-future-engine/);
    assert.doesNotMatch(block, /## Engines/); // no ENGINE_FILES meta ⇒ no --engine passed to buildBrief, no engine-list fallback noise
    assert.equal(warnings.length, 0);
  });
});

describe('injectInstallBlock — idempotent insertion', () => {
  it('creates the file with the block when it does not exist', () => {
    const dir = tmp('install-inject-new');
    try {
      const file = join(dir, 'CLAUDE.md');
      const block = `${INSTALL_START}\nhello\n${INSTALL_END}`;
      const res = injectInstallBlock(file, block);
      assert.equal(res.created, true);
      assert.equal(readFileSync(file, 'utf8'), `${block}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends to an existing foreign file, preserving its content untouched', () => {
    const dir = tmp('install-inject-append');
    try {
      const file = join(dir, 'AGENTS.md');
      writeFileSync(file, '# My own instructions\n\nDo not touch this line.\n', 'utf8');
      const block = `${INSTALL_START}\nhello\n${INSTALL_END}`;
      const res = injectInstallBlock(file, block);
      assert.equal(res.created, false);
      assert.equal(res.replaced, false);
      const out = readFileSync(file, 'utf8');
      assert.match(out, /Do not touch this line\./);
      assert.match(out, /hello/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an existing block in place and is byte-for-byte idempotent on re-run', () => {
    const dir = tmp('install-inject-idempotent');
    try {
      const file = join(dir, 'CLAUDE.md');
      writeFileSync(file, `# Before\n\nmine\n\n${INSTALL_START}\nOLD\n${INSTALL_END}\n\n# After\n\nalso mine\n`, 'utf8');
      const block = `${INSTALL_START}\nNEW\n${INSTALL_END}`;

      const res1 = injectInstallBlock(file, block);
      assert.equal(res1.replaced, true);
      const once = readFileSync(file, 'utf8');
      assert.match(once, /mine/);
      assert.match(once, /also mine/);
      assert.match(once, /NEW/);
      assert.doesNotMatch(once, /OLD/);

      injectInstallBlock(file, block);
      const twice = readFileSync(file, 'utf8');
      assert.equal(once, twice, 'second run must be a byte-for-byte no-op');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('samemind install — CLI (demo bundle)', () => {
  function makeDemoBundle() {
    const dir = tmp('install-cli-bundle');
    const result = runInit({ targetDir: dir, demo: true });
    assert.equal(result.ok, true, 'demo bundle scaffold failed');
    return dir;
  }

  it('--list enumerates every supported engine', () => {
    const out = execFileSync(process.execPath, [INSTALL, '--list'], { encoding: 'utf8' });
    for (const id of Object.keys(ENGINE_FILES)) {
      assert.match(out, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `--list should mention ${id}`);
    }
    assert.match(out, /aider/i, '--list should note the no-MCP Aider fallback');
  });

  it('install --agent claude-code creates CLAUDE.md with the install markers and the Nova brief', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-cc');
    try {
      const out = execFileSync(process.execPath, [INSTALL, '--agent', 'claude-code', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
      });
      assert.match(out, /Claude Code/);
      const file = join(target, 'CLAUDE.md');
      assert.ok(existsSync(file));
      const content = readFileSync(file, 'utf8');
      assert.match(content, new RegExp(INSTALL_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(content, /Nova/);
      assert.match(content, /Alex Doe/);
      assert.match(content, /## samemind memory/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('repeated install is idempotent (byte-for-byte identical on re-run)', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-idem');
    try {
      const args = [INSTALL, '--agent', 'claude-code', '--target', target];
      execFileSync(process.execPath, args, { env: { ...process.env, OKF_ROOT: bundle }, encoding: 'utf8' });
      const once = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
      execFileSync(process.execPath, args, { env: { ...process.env, OKF_ROOT: bundle }, encoding: 'utf8' });
      const twice = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
      assert.equal(once, twice, 'second install run must not change the file');
      const markerCount = (twice.match(/samemind:install:start/g) || []).length;
      assert.equal(markerCount, 1, 'exactly one install block, not stacked copies');
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('preserves a user\'s own foreign content in the instruction file', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-foreign');
    try {
      writeFileSync(join(target, 'AGENTS.md'), '# Sasha\'s own project rules\n\nNever delete without asking.\n', 'utf8');
      execFileSync(process.execPath, [INSTALL, '--agent', 'codex', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
      });
      const content = readFileSync(join(target, 'AGENTS.md'), 'utf8');
      assert.match(content, /Never delete without asking\./);
      assert.match(content, /samemind:install:start/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('cursor/roo/kiro each drop their dedicated file in the right subfolder', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-folders');
    try {
      for (const [id, relPath] of [
        ['cursor', '.cursor/rules/samemind.md'],
        ['roo', '.roo/rules/samemind.md'],
        ['kiro', '.kiro/steering/samemind.md'],
      ]) {
        execFileSync(process.execPath, [INSTALL, '--agent', id, '--target', target], {
          env: { ...process.env, OKF_ROOT: bundle },
          encoding: 'utf8',
        });
        assert.ok(existsSync(join(target, relPath)), `${id} should create ${relPath}`);
      }
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('--agent all touches only instruction files that already exist, creates nothing new', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-all');
    try {
      // Only CLAUDE.md pre-exists — a bare-bones project that only uses Claude Code.
      writeFileSync(join(target, 'CLAUDE.md'), '# my claude notes\n', 'utf8');

      const out = execFileSync(process.execPath, [INSTALL, '--agent', 'all', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
      });
      assert.match(out, /CLAUDE\.md/);

      const claude = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
      assert.match(claude, /my claude notes/);
      assert.match(claude, /samemind:install:start/);

      // None of the other engines' files should have been created.
      for (const rel of [
        'AGENTS.md', 'GEMINI.md', '.clinerules', '.goosehints',
        '.cursor/rules/samemind.md', '.roo/rules/samemind.md', '.kiro/steering/samemind.md',
        '.windsurf/rules/samemind.md', '.github/copilot-instructions.md',
      ]) {
        assert.equal(existsSync(join(target, rel)), false, `${rel} should not be created by --agent all`);
      }
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('--agent all on an empty target dir touches nothing and says so', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-empty');
    try {
      const out = execFileSync(process.execPath, [INSTALL, '--agent', 'all', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
      });
      assert.match(out, /No engine instruction file/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('unknown --agent id fails loudly instead of silently no-op-ing', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-unknown');
    try {
      assert.throws(() => {
        execFileSync(process.execPath, [INSTALL, '--agent', 'not-a-real-engine', '--target', target], {
          env: { ...process.env, OKF_ROOT: bundle },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }, /Command failed/);
      assert.equal(existsSync(join(target, 'CLAUDE.md')), false);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('unknown --agent without --file mentions --file in the error', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-nofile');
    try {
      execFileSync(process.execPath, [INSTALL, '--agent', 'future-agent', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected install to exit non-zero');
    } catch (e) {
      assert.equal(e.status, 1);
      const stderr = String(e.stderr || '');
      assert.match(stderr, /--file/);
      assert.match(stderr, /future-agent/);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('--list advertises that any id works via --file', () => {
    const out = execFileSync(process.execPath, [INSTALL, '--list'], { encoding: 'utf8' });
    assert.match(out, /any id via --file/);
  });

  it('unknown --agent with --file writes a marker-wrapped block and is idempotent', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-generic');
    try {
      const args = [INSTALL, '--agent', 'future-agent', '--target', target, '--file', 'INSTRUCTIONS.md'];
      execFileSync(process.execPath, args, { env: { ...process.env, OKF_ROOT: bundle }, encoding: 'utf8' });
      const file = join(target, 'INSTRUCTIONS.md');
      assert.ok(existsSync(file), 'generic file created');
      const once = readFileSync(file, 'utf8');
      assert.match(once, new RegExp(INSTALL_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(once, /future-agent/);
      assert.match(once, /## samemind memory/);          // protocol block present
      assert.match(once, /Write discipline/);

      // second run is a byte-for-byte no-op, no stacked blocks
      execFileSync(process.execPath, args, { env: { ...process.env, OKF_ROOT: bundle }, encoding: 'utf8' });
      const twice = readFileSync(file, 'utf8');
      assert.equal(once, twice, 'second generic install run must not change the file');
      assert.equal((twice.match(/samemind:install:start/g) || []).length, 1);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('installEngine — unknown id without --file returns a clear ok:false reason (unit)', async () => {
    const { installEngine } = await import('./install.mjs');
    const res = installEngine('never-heard-of-it', { docs: [NOVA, ALEX, ENGINE_CC] });
    assert.equal(res.ok, false);
    assert.match(res.reason, /never-heard-of-it/);
    assert.match(res.reason, /--file/);
  });

  it('installEngine — unknown id with --file writes the block, generic: true (unit)', async () => {
    const { installEngine } = await import('./install.mjs');
    const dir = tmp('install-unit-generic');
    try {
      const res = installEngine('watson-x', { targetDir: dir, docs: [NOVA, ALEX, ENGINE_CC], file: 'WATSON.md' });
      assert.equal(res.ok, true);
      assert.equal(res.generic, true);
      assert.equal(res.files[0].path, 'WATSON.md');
      const content = readFileSync(join(dir, 'WATSON.md'), 'utf8');
      assert.match(content, /watson-x/);
      assert.match(content, /samemind:install:start/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bin/samemind.mjs routes "install" to tools/install.mjs', () => {
    const bundle = makeDemoBundle();
    const target = tmp('install-cli-target-bin');
    try {
      const out = execFileSync(process.execPath, [BIN, 'install', '--agent', 'claude-code', '--target', target], {
        env: { ...process.env, OKF_ROOT: bundle },
        encoding: 'utf8',
      });
      assert.match(out, /Claude Code/);
      assert.ok(existsSync(join(target, 'CLAUDE.md')));
    } finally {
      rmSync(bundle, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

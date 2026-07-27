#!/usr/bin/env node
// hooks.test.mjs — Ф4-C: engineHookTier / buildHooks / installHooks (node --test).
// Everything runs against a fresh tmpdir target (mkdtempSync) — this suite NEVER touches
// ~/.claude/settings.json or any other real machine config. Pattern matches install.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  engineHookTier, buildHooks, installHooks,
} from './lib/hooks.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('engineHookTier', () => {
  it('classifies the auto (hooked) engines', () => {
    assert.equal(engineHookTier('claude-code'), 'auto');
    assert.equal(engineHookTier('codex'), 'auto');
    assert.equal(engineHookTier('opencode'), 'auto');
  });

  it('classifies projection-only engines (no known hook API, but install.mjs already covers them)', () => {
    assert.equal(engineHookTier('cursor'), 'projection');
    assert.equal(engineHookTier('gemini-cli'), 'projection');
    // spot-check a few more ENGINE_FILES entries with no explicit tier entry
    assert.equal(engineHookTier('copilot'), 'projection');
    assert.equal(engineHookTier('cline'), 'projection');
    assert.equal(engineHookTier('goose'), 'projection');
    assert.equal(engineHookTier('antigravity'), 'projection');
  });

  it('classifies a totally unknown engine id as none', () => {
    assert.equal(engineHookTier('some-made-up-engine'), 'none');
    assert.equal(engineHookTier(undefined), 'none');
  });
});

describe('buildHooks — auto tier', () => {
  it('claude-code: valid hook config, placeholders substituted, mcp_tool-free command hooks', () => {
    const built = buildHooks('claude-code', { root: '/tmp/some-bundle' });
    assert.equal(built.ok, true);
    assert.equal(built.format, 'hooks-json');
    assert.equal(built.file, '.claude/settings.json');
    assert.ok(Array.isArray(built.hooks.SessionStart));
    assert.ok(Array.isArray(built.hooks.SessionEnd));
    const flat = JSON.stringify(built.hooks);
    assert.doesNotMatch(flat, /\$\{ROOT\}|\$\{CLI\}|\$\{ENGINE\}/, 'no leftover placeholders');
    assert.match(flat, /\/tmp\/some-bundle/);
    assert.match(flat, /npx samemind handoff/);
    assert.match(flat, /inbox\/claude-code\.md/);
  });

  it('codex: same event-array shape, own target file', () => {
    const built = buildHooks('codex', { root: '/tmp/some-bundle' });
    assert.equal(built.ok, true);
    assert.equal(built.file, '.codex/hooks.json');
    assert.ok(Array.isArray(built.hooks.SessionStart));
    assert.ok(Array.isArray(built.hooks.SessionEnd));
    assert.match(JSON.stringify(built.hooks), /inbox\/codex\.md/);
  });

  it('opencode: JS plugin content, no leftover placeholders, syntactically valid-looking', () => {
    const built = buildHooks('opencode', { root: '/tmp/some-bundle' });
    assert.equal(built.ok, true);
    assert.equal(built.format, 'opencode-plugin-js');
    assert.equal(built.file, '.opencode/plugins/samemind-hooks.js');
    assert.doesNotMatch(built.content, /\$\{ROOT\}|\$\{CLI\}|\$\{ENGINE\}/);
    assert.match(built.content, /session\.created/);
    assert.match(built.content, /session\.idle/);
    assert.match(built.content, /\/tmp\/some-bundle/);
  });

  it('projection/none tier: no payload, just a message', () => {
    const cursor = buildHooks('cursor', { root: '/tmp/x' });
    assert.equal(cursor.ok, false);
    assert.equal(cursor.tier, 'projection');
    assert.match(cursor.message, /samemind install/);

    const unknown = buildHooks('nope', { root: '/tmp/x' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.tier, 'none');
  });
});

describe('installHooks — claude-code (.claude/settings.json)', () => {
  it('creates the file with SessionStart/SessionEnd on first run', () => {
    const dir = tmp('cc-fresh');
    const res = installHooks('claude-code', { targetDir: dir, root: dir });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    const abs = join(dir, '.claude', 'settings.json');
    assert.ok(existsSync(abs));
    const cfg = JSON.parse(readFileSync(abs, 'utf8'));
    assert.ok(Array.isArray(cfg.hooks.SessionStart));
    assert.ok(Array.isArray(cfg.hooks.SessionEnd));
  });

  it('is idempotent — running twice does not duplicate entries', () => {
    const dir = tmp('cc-idempotent');
    installHooks('claude-code', { targetDir: dir, root: dir });
    const res2 = installHooks('claude-code', { targetDir: dir, root: dir });
    assert.equal(res2.ok, true);
    assert.equal(res2.replaced, true);
    const abs = join(dir, '.claude', 'settings.json');
    const cfg = JSON.parse(readFileSync(abs, 'utf8'));
    assert.equal(cfg.hooks.SessionStart.length, 1, 'SessionStart must not duplicate on re-install');
    assert.equal(cfg.hooks.SessionEnd.length, 1, 'SessionEnd must not duplicate on re-install');
  });

  it('merge never clobbers a foreign hook already in settings.json (other keys preserved too)', () => {
    const dir = tmp('cc-foreign');
    const claudeDir = join(dir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const abs = join(claudeDir, 'settings.json');
    const foreign = {
      model: 'some-model',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'echo my-custom-startup-note' }],
          },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo my-own-guard' }] },
        ],
      },
    };
    writeFileSync(abs, `${JSON.stringify(foreign, null, 2)}\n`);

    const res = installHooks('claude-code', { targetDir: dir, root: dir });
    assert.equal(res.ok, true);
    assert.equal(res.created, false);
    assert.equal(res.replaced, true);

    const cfg = JSON.parse(readFileSync(abs, 'utf8'));
    // untouched top-level keys
    assert.equal(cfg.model, 'some-model');
    assert.deepEqual(cfg.permissions, { allow: ['Bash(ls:*)'] });
    // untouched foreign hook event entirely
    assert.deepEqual(cfg.hooks.PreToolUse, foreign.hooks.PreToolUse);
    // SessionStart: foreign entry preserved AND samemind's own entry added
    assert.equal(cfg.hooks.SessionStart.length, 2);
    assert.ok(cfg.hooks.SessionStart.some(e => e.hooks[0].command === 'echo my-custom-startup-note'));
    assert.ok(cfg.hooks.SessionStart.some(e => e.hooks[0].command.includes('samemind')));
    // SessionEnd added fresh (wasn't there before)
    assert.ok(Array.isArray(cfg.hooks.SessionEnd));
    assert.equal(cfg.hooks.SessionEnd.length, 1);
  });
});

describe('installHooks — codex (.codex/hooks.json)', () => {
  it('creates hooks.json with the same event shape', () => {
    const dir = tmp('codex-fresh');
    const res = installHooks('codex', { targetDir: dir, root: dir });
    assert.equal(res.ok, true);
    const abs = join(dir, '.codex', 'hooks.json');
    assert.ok(existsSync(abs));
    const cfg = JSON.parse(readFileSync(abs, 'utf8'));
    assert.ok(Array.isArray(cfg.hooks.SessionStart));
    assert.ok(Array.isArray(cfg.hooks.SessionEnd));
  });
});

describe('installHooks — opencode (plugin file, whole-file idempotent write)', () => {
  it('writes the plugin file and re-running produces byte-identical content', () => {
    const dir = tmp('opencode-fresh');
    const res1 = installHooks('opencode', { targetDir: dir, root: dir });
    assert.equal(res1.ok, true);
    assert.equal(res1.created, true);
    const abs = join(dir, '.opencode', 'plugins', 'samemind-hooks.js');
    const first = readFileSync(abs, 'utf8');

    const res2 = installHooks('opencode', { targetDir: dir, root: dir });
    assert.equal(res2.ok, true);
    assert.equal(res2.created, false);
    assert.equal(res2.replaced, true);
    const second = readFileSync(abs, 'utf8');
    assert.equal(first, second);
    assert.doesNotMatch(second, /\$\{ROOT\}|\$\{CLI\}|\$\{ENGINE\}/);
  });
});

describe('installHooks — projection/none engines: no-op with a message, nothing written', () => {
  it('cursor (projection): no-op', () => {
    const dir = tmp('cursor-noop');
    const res = installHooks('cursor', { targetDir: dir });
    assert.equal(res.ok, false);
    assert.equal(res.tier, 'projection');
    assert.match(res.message, /samemind install/);
    assert.ok(!existsSync(join(dir, '.cursor')));
  });

  it('gemini-cli (projection): no-op', () => {
    const dir = tmp('gemini-noop');
    const res = installHooks('gemini-cli', { targetDir: dir });
    assert.equal(res.ok, false);
    assert.equal(res.tier, 'projection');
  });

  it('unknown engine (none): no-op', () => {
    const dir = tmp('unknown-noop');
    const res = installHooks('totally-unknown', { targetDir: dir });
    assert.equal(res.ok, false);
    assert.equal(res.tier, 'none');
    assert.equal(readdirSync(dir).length, 0, 'nothing written under targetDir');
  });
});

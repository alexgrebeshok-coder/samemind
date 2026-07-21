// mcp-register.test.mjs — unit tests for tools/lib/mcp-register.mjs (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureMcpRegistered } from './lib/mcp-register.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('ensureMcpRegistered — claude-code', () => {
  it('apply:false (default) writes nothing, even into an empty target', () => {
    const dir = tmp('mcp-plan-empty');
    try {
      const plan = ensureMcpRegistered('claude-code', dir);
      assert.equal(typeof plan, 'string');
      assert.match(plan, /\.mcp\.json/);
      assert.equal(existsSync(join(dir, '.mcp.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply:false leaves a pre-existing .mcp.json byte-for-byte untouched', () => {
    const dir = tmp('mcp-plan-preexisting');
    try {
      const before = '{\n  "mcpServers": {\n    "other": { "command": "foo" }\n  }\n}\n';
      writeFileSync(join(dir, '.mcp.json'), before, 'utf8');
      ensureMcpRegistered('claude-code', dir, { apply: false });
      assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply:true writes a valid .mcp.json registering samemind', () => {
    const dir = tmp('mcp-apply-new');
    try {
      ensureMcpRegistered('claude-code', dir, { apply: true });
      const file = join(dir, '.mcp.json');
      assert.ok(existsSync(file));
      const cfg = JSON.parse(readFileSync(file, 'utf8')); // throws if not valid JSON
      assert.deepEqual(cfg.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('apply:true merges into an existing .mcp.json, preserving other servers', () => {
    const dir = tmp('mcp-apply-merge');
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'foo' } } }), 'utf8');
      ensureMcpRegistered('claude-code', dir, { apply: true });
      const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      assert.deepEqual(cfg.mcpServers.other, { command: 'foo' });
      assert.deepEqual(cfg.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated apply:true does not duplicate the samemind entry', () => {
    const dir = tmp('mcp-apply-idempotent');
    try {
      ensureMcpRegistered('claude-code', dir, { apply: true });
      const once = readFileSync(join(dir, '.mcp.json'), 'utf8');
      ensureMcpRegistered('claude-code', dir, { apply: true });
      const twice = readFileSync(join(dir, '.mcp.json'), 'utf8');
      assert.equal(once, twice, 'second apply must be a byte-for-byte no-op');
      const cfg = JSON.parse(twice);
      assert.equal(Object.keys(cfg.mcpServers).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureMcpRegistered — claude-code, scope:"user" (global setup, G-A)', () => {
  // Every test here passes an explicit userConfigPath (tmpdir fixture) — ensureMcpRegistered's
  // own default (~/.claude.json) must NEVER be hit by this suite; the real file on this machine
  // already carries exa/context7/playwright and must not be touched by a test run.

  it('apply:false returns a plan string, never calls spawnSyncImpl, never writes', () => {
    const dir = tmp('mcp-user-plan');
    try {
      const userConfigPath = join(dir, 'claude.json');
      const spawnSyncImpl = () => { throw new Error('must not be called when apply:false'); };
      const plan = ensureMcpRegistered('claude-code', dir, { scope: 'user', userConfigPath, spawnSyncImpl });
      assert.equal(typeof plan, 'string');
      assert.match(plan, /user-scope/);
      assert.equal(existsSync(userConfigPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('native path: spawnSyncImpl reports success → registered natively, fallback JSON merge never runs', () => {
    const dir = tmp('mcp-user-native-ok');
    try {
      const userConfigPath = join(dir, 'claude.json');
      let calls = 0;
      const spawnSyncImpl = (cmd, args) => {
        calls++;
        assert.equal(cmd, 'claude');
        assert.deepEqual(args, ['mcp', 'add', '--scope', 'user', 'samemind', '--', 'npx', 'samemind', 'serve']);
        return { status: 0, error: undefined };
      };
      const msg = ensureMcpRegistered('claude-code', dir, { apply: true, scope: 'user', userConfigPath, spawnSyncImpl });
      assert.equal(calls, 1);
      assert.match(msg, /registered samemind/i);
      assert.equal(existsSync(userConfigPath), false, 'native success must not touch the JSON fallback file at all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('native path missing (spawnSyncImpl throws ENOENT-like) → falls back to JSON merge, preserving exa/context7/playwright', () => {
    const dir = tmp('mcp-user-native-missing');
    try {
      const userConfigPath = join(dir, 'claude.json');
      const before = {
        mcpServers: {
          exa: { command: 'npx', args: ['exa-mcp'] },
          context7: { command: 'npx', args: ['context7-mcp'] },
          playwright: { command: 'npx', args: ['playwright-mcp'] },
        },
      };
      writeFileSync(userConfigPath, JSON.stringify(before, null, 2), 'utf8');
      const spawnSyncImpl = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

      const msg = ensureMcpRegistered('claude-code', dir, { apply: true, scope: 'user', userConfigPath, spawnSyncImpl });

      assert.match(msg, /wrote samemind/i);
      const after = JSON.parse(readFileSync(userConfigPath, 'utf8'));
      assert.deepEqual(after.mcpServers.exa, before.mcpServers.exa);
      assert.deepEqual(after.mcpServers.context7, before.mcpServers.context7);
      assert.deepEqual(after.mcpServers.playwright, before.mcpServers.playwright);
      assert.deepEqual(after.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
      // a backup of the pre-existing file must exist alongside it
      const backups = readdirSync(dir).filter(f => f.startsWith('claude.json.bak-'));
      assert.equal(backups.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('native path errors (non-zero status, no thrown error) → also falls back to JSON merge', () => {
    const dir = tmp('mcp-user-native-nonzero');
    try {
      const userConfigPath = join(dir, 'claude.json');
      const spawnSyncImpl = () => ({ status: 1, error: undefined, stderr: 'boom' });
      const msg = ensureMcpRegistered('claude-code', dir, { apply: true, scope: 'user', userConfigPath, spawnSyncImpl });
      assert.match(msg, /wrote samemind/i);
      assert.deepEqual(JSON.parse(readFileSync(userConfigPath, 'utf8')).mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allowNative:false skips the native attempt entirely — spawnSyncImpl is never called, straight to JSON merge (post-incident regression)', () => {
    const dir = tmp('mcp-user-allow-native-false');
    try {
      const userConfigPath = join(dir, 'claude.json');
      const spawnSyncImpl = () => { throw new Error('spawnSyncImpl must not be called when allowNative:false'); };
      const msg = ensureMcpRegistered('claude-code', dir, {
        apply: true, scope: 'user', userConfigPath, spawnSyncImpl, allowNative: false,
      });
      assert.match(msg, /wrote samemind/i);
      assert.deepEqual(JSON.parse(readFileSync(userConfigPath, 'utf8')).mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allowNative:true (or default) does attempt native — a successful mock is honored, not skipped', () => {
    const dir = tmp('mcp-user-allow-native-true');
    try {
      const userConfigPath = join(dir, 'claude.json');
      let called = false;
      const spawnSyncImpl = () => { called = true; return { status: 0, error: undefined }; };
      const msg = ensureMcpRegistered('claude-code', dir, {
        apply: true, scope: 'user', userConfigPath, spawnSyncImpl, allowNative: true,
      });
      assert.equal(called, true);
      assert.match(msg, /registered samemind/i);
      assert.equal(existsSync(userConfigPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fallback onto a corrupt userConfigPath: file left byte-for-byte untouched, honest error returned', () => {
    const dir = tmp('mcp-user-native-corrupt');
    try {
      const userConfigPath = join(dir, 'claude.json');
      const before = '{ "mcpServers": { not valid';
      writeFileSync(userConfigPath, before, 'utf8');
      const spawnSyncImpl = () => { const e = new Error('ENOENT'); throw e; };

      const msg = ensureMcpRegistered('claude-code', dir, { apply: true, scope: 'user', userConfigPath, spawnSyncImpl });

      assert.match(msg, /invalid JSON/i);
      assert.equal(readFileSync(userConfigPath, 'utf8'), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureMcpRegistered — other engines', () => {
  it('returns a hint string and never writes anything to target', () => {
    const dir = tmp('mcp-other-engine');
    try {
      for (const engine of ['cursor', 'codex', 'gemini-cli', 'cline', 'roo', 'windsurf', 'goose', 'kiro', 'copilot', 'opencode']) {
        const hint = ensureMcpRegistered(engine, dir, { apply: true }); // apply ignored for non-claude-code
        assert.equal(typeof hint, 'string');
        assert.ok(hint.length > 0, `${engine} should get a non-empty hint`);
      }
      assert.equal(existsSync(join(dir, '.mcp.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown engine id still returns a generic hint string, never throws', () => {
    const hint = ensureMcpRegistered('some-future-engine', '/nonexistent');
    assert.equal(typeof hint, 'string');
    assert.match(hint, /some-future-engine/);
  });
});

// mcp-register.test.mjs — unit tests for tools/lib/mcp-register.mjs (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
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

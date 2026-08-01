// engine-mcp.test.mjs — unit tests for tools/lib/engine-mcp.mjs (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  findSamemindEntries,
  parseTomlMcpServers,
  redactEnv,
  scrubValues,
  SHOWN_ENV_KEYS,
} from './lib/engine-mcp.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('findSamemindEntries — mcpServers (cursor)', () => {
  it('project .cursor/mcp.json with samemind', () => {
    const home = tmp('eng-home');
    const target = tmp('eng-target');
    try {
      mkdirSync(join(target, '.cursor'), { recursive: true });
      writeFileSync(join(target, '.cursor', 'mcp.json'), JSON.stringify({
        mcpServers: { samemind: { command: 'npx', args: ['samemind', 'serve'] } },
      }), 'utf8');
      const entries = findSamemindEntries('cursor', { home, target });
      const project = entries.filter(e => e.scope === 'project');
      assert.equal(project.length, 1);
      assert.equal(project[0].found, true);
      assert.equal(project[0].command, 'npx');
      assert.deepEqual(project[0].args, ['samemind', 'serve']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('corrupt JSON → parseError corrupt-json, file untouched', () => {
    const home = tmp('eng-corrupt-home');
    const target = tmp('eng-corrupt-target');
    try {
      mkdirSync(join(target, '.cursor'), { recursive: true });
      const path = join(target, '.cursor', 'mcp.json');
      const bad = '{ not json at all ';
      writeFileSync(path, bad, 'utf8');
      const entries = findSamemindEntries('cursor', { home, target });
      const project = entries.find(e => e.scope === 'project');
      assert.equal(project.parseError, 'corrupt-json');
      assert.equal(readFileSync(path, 'utf8'), bad);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('findSamemindEntries — mcpServers-nested (claude-code)', () => {
  it('user .claude.json with BOTH mcpServers and projects[target] entries', () => {
    const home = tmp('eng-cc-home');
    const target = tmp('eng-cc-target');
    try {
      const entry = { command: 'npx', args: ['samemind', 'serve'] };
      const entry2 = { command: 'node', args: ['custom.mjs'] };
      writeFileSync(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { samemind: entry },
        projects: { [target]: { mcpServers: { samemind: entry2 } } },
      }), 'utf8');
      const entries = findSamemindEntries('claude-code', { home, target });
      const userFound = entries.filter(e => e.scope === 'user' && e.found);
      assert.equal(userFound.length, 2);
      assert.ok(userFound.some(e => e.command === 'npx'));
      assert.ok(userFound.some(e => e.command === 'node'));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('findSamemindEntries — vscode-servers (copilot)', () => {
  it('reads cfg.servers.samemind', () => {
    const home = tmp('eng-cp-home');
    const target = tmp('eng-cp-target');
    try {
      mkdirSync(join(target, '.vscode'), { recursive: true });
      writeFileSync(join(target, '.vscode', 'mcp.json'), JSON.stringify({
        servers: { samemind: { command: 'npx', args: ['samemind', 'serve'] } },
      }), 'utf8');
      const [e] = findSamemindEntries('copilot', { home, target }).filter(x => x.scope === 'project');
      assert.equal(e.found, true);
      assert.equal(e.command, 'npx');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('findSamemindEntries — opencode', () => {
  it('command array + environment + enabled:false', () => {
    const home = tmp('eng-oc-home');
    const target = tmp('eng-oc-target');
    try {
      writeFileSync(join(target, 'opencode.json'), JSON.stringify({
        mcp: {
          samemind: {
            type: 'local',
            command: ['npx', 'samemind', 'serve'],
            environment: { SAMEMIND_AGENT: 'opencode', SECRET_TOKEN: 'leak-me-not' },
            enabled: false,
          },
        },
      }), 'utf8');
      // Pick the located entry, not [0]: an engine declares several candidate paths
      // (user + project) and the reader reports every one, found or not. doctor's
      // "connected" predicate is likewise "at least one location found".
      const e = findSamemindEntries('opencode', { home, target }).find(r => r.found);
      assert.ok(e, 'project-scope opencode.json should be found');
      assert.equal(e.command, 'npx');
      assert.deepEqual(e.args, ['samemind', 'serve']);
      assert.equal(e.enabled, false);
      assert.equal(e.env.SECRET_TOKEN, 'leak-me-not');
      assert.equal(e.env.SAMEMIND_AGENT, 'opencode');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('findSamemindEntries — codex-toml', () => {
  it('standard [mcp_servers.samemind] block', () => {
    const home = tmp('eng-codex-home');
    const target = tmp('eng-codex-target');
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'config.toml'), `
[mcp_servers.samemind]
command = "npx"
args = ["samemind", "serve"]
`, 'utf8');
      const [e] = findSamemindEntries('codex', { home, target });
      assert.equal(e.found, true);
      assert.equal(e.command, 'npx');
      assert.deepEqual(e.args, ['samemind', 'serve']);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('inline table under [mcp_servers] → toml-unsupported', () => {
    const home = tmp('eng-codex-inline-home');
    const target = tmp('eng-codex-inline-target');
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'config.toml'), `
[mcp_servers]
samemind = { command = "npx", args = ["samemind", "serve"] }
`, 'utf8');
      const [e] = findSamemindEntries('codex', { home, target });
      assert.equal(e.parseError, 'toml-unsupported');
      assert.equal(e.found, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('[mcp_servers.samemind] header without command → toml-unsupported', () => {
    const home = tmp('eng-codex-empty-home');
    const target = tmp('eng-codex-empty-target');
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'config.toml'), `
[mcp_servers.samemind]
enabled = true
`, 'utf8');
      const [e] = findSamemindEntries('codex', { home, target });
      assert.equal(e.parseError, 'toml-unsupported');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('parseTomlMcpServers', () => {
  it('parses env subsection', () => {
    const text = `
[mcp_servers.samemind]
command = "npx"
args = ["samemind", "serve"]

[mcp_servers.samemind.env]
OKF_ROOT = "/data/bundle"
`;
    const { servers } = parseTomlMcpServers(text);
    assert.equal(servers.samemind.command, 'npx');
    assert.equal(servers.samemind.env.OKF_ROOT, '/data/bundle');
  });

  it('multiline args array', () => {
    const text = `
[mcp_servers.other]
args = [
  "a",
  "b",
]
command = "tool"
`;
    const { servers } = parseTomlMcpServers(text);
    assert.deepEqual(servers.other.args, ['a', 'b']);
    assert.equal(servers.other.command, 'tool');
  });
});

describe('redactEnv + scrubValues', () => {
  it('shows whitelist values and keys for secrets as length tokens', () => {
    const env = {
      OKF_ROOT: '/safe/path',
      OKF_EMBED_MODEL: '',
      API_KEY: 'super-secret-value',
      OKF_EMBED_URL: 'https://user:pass@embed.example.com:8443/v1?q=token',
    };
    const red = redactEnv(env);
    assert.equal(red.OKF_ROOT, '/safe/path');
    assert.equal(red.OKF_EMBED_MODEL, '');
      assert.equal(red.API_KEY, '<set:18>');
    assert.equal(red.OKF_EMBED_URL, 'https://embed.example.com:8443');
    assert.ok('API_KEY' in red);
    assert.ok('OKF_EMBED_URL' in red);
  });

  it('scrubValues removes secret literals from stderr-like text', () => {
    const env = { API_KEY: 'super-secret-value', OKF_ROOT: '/safe/path' };
    const text = 'Error: auth failed with super-secret-value in env OKF_ROOT=/safe/path';
    const out = scrubValues(text, env);
    assert.ok(!out.includes('super-secret-value'));
    assert.ok(out.includes('<redacted>'));
    assert.ok(out.includes('/safe/path'));
  });

  it('SHOWN_ENV_KEYS matches spec whitelist', () => {
    for (const k of ['OKF_ROOT', 'OKF_GLOBAL_ROOT', 'OKF_EMBED_MODEL', 'OKF_INDEX_BACKEND', 'SAMEMIND_AGENT', 'NODE_ENV']) {
      assert.ok(SHOWN_ENV_KEYS.has(k), k);
    }
  });
});

describe('findSamemindEntries — engines without mcp shape', () => {
  it('goose → []', () => {
    const home = tmp('eng-goose-home');
    const target = tmp('eng-goose-target');
    try {
      assert.deepEqual(findSamemindEntries('goose', { home, target }), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

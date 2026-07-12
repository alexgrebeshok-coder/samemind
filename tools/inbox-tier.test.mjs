#!/usr/bin/env node
// inbox-tier.test.mjs — regression suite for issue #4: `inbox/` must be a proper reserved tier,
// like secret/mirror — excluded from walk()/validate/list/links/rel/get by default, opt-in via
// --include-inbox, and never surfaced by MCP read tools (memory_search/get/list). consolidate.mjs
// is the one tool that must keep reading it (that's its whole purpose: raw → canon gap map).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  mkdtempSync, writeFileSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { runInit } from './init.mjs';
import { DEFAULT_PROTOCOL_VERSION } from './lib/mcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const MCP_SERVER = join(HERE, 'mcp-server.mjs');

// A raw inbox note exactly as memory_write_inbox produces it: frontmatter with only
// `okf_version`, no `type` — this is the shape that broke `validate` before the fix (issue #4).
const INBOX_MARKER = 'N-ISSUE-4-INBOX-TIER-MARKER';

let BUNDLE_DIR;

function runCli(scriptRel, args, { env = {} } = {}) {
  const script = join(PACKAGE_ROOT, scriptRel);
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OKF_ROOT: BUNDLE_DIR, OKF_EMBED_URL: '', ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    combined: `${res.stdout || ''}\n${res.stderr || ''}`,
  };
}

function writeRawInboxNote() {
  writeFileSync(join(BUNDLE_DIR, 'inbox', 'some-agent.md'), `---
okf_version: "0.1"
---

# Inbox — some-agent

## 2026-07-10T00:00:00.000Z — a raw note

${INBOX_MARKER} — no \`type\` in frontmatter, exactly what memory_write_inbox produces.
`, 'utf8');
}

before(() => {
  BUNDLE_DIR = mkdtempSync(join(tmpdir(), 'samemind-inbox-tier-'));
  const result = runInit({ targetDir: BUNDLE_DIR, demo: true });
  assert.equal(result.ok, true, 'init --demo failed');
  writeRawInboxNote();
});

after(() => {
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
});

describe('inbox tier (issue #4): okf-query family excludes it by default', () => {
  it('validate stays conformant with a typeless inbox note present', () => {
    const r = runCli('tools/okf-query.mjs', ['validate']);
    assert.equal(r.status, 0, r.combined);
    assert.match(r.stdout, /✅ OKF v0\.1 conformant/);
    assert.doesNotMatch(r.combined, /inbox\/some-agent/);
    assert.doesNotMatch(r.combined, /missing required 'type'/);
  });

  it('list does not surface the inbox note', () => {
    const r = runCli('tools/okf-query.mjs', ['list']);
    assert.equal(r.status, 0, r.combined);
    assert.doesNotMatch(r.stdout, /inbox\/some-agent/);
    // demo content still there — this isn't a "walk is broken" false pass
    assert.match(r.stdout, /projects\/lumen/);
  });

  it('links does not list the inbox note as an orphan or count it as a concept', () => {
    const r = runCli('tools/okf-query.mjs', ['links']);
    assert.equal(r.status, 0, r.combined);
    assert.doesNotMatch(r.combined, /inbox\/some-agent/);
  });

  it('get refuses to find the inbox note by id', () => {
    const r = runCli('tools/okf-query.mjs', ['get', 'inbox/some-agent']);
    assert.match(r.stdout, /not found/i);
    assert.doesNotMatch(r.stdout, new RegExp(INBOX_MARKER));
  });

  it('--include-inbox opts back in — list shows it, validate flags its missing type', () => {
    const list = runCli('tools/okf-query.mjs', ['list', '--include-inbox']);
    assert.equal(list.status, 0, list.combined);
    assert.match(list.stdout, /inbox\/some-agent/);
    assert.match(list.stdout, /incl\. inbox/);

    const validate = runCli('tools/okf-query.mjs', ['validate', '--include-inbox']);
    // Opting in deliberately surfaces raw inbox notes as concepts — a typeless one is then
    // correctly flagged. This proves the flag actually re-includes inbox (not a no-op),
    // and that the default-exclude in the previous tests is doing real work.
    assert.equal(validate.status, 1, validate.combined);
    assert.match(validate.combined, /❌ NOT conformant/);
    assert.match(validate.combined, /inbox\/some-agent.*missing required 'type'/);
  });
});

describe('inbox tier (issue #4): consolidate.mjs keeps reading inbox', () => {
  it('reports the raw inbox note as gap material (single-source)', () => {
    const r = runCli('tools/consolidate.mjs', []);
    assert.equal(r.status, 0, r.combined);
    assert.match(r.stdout, /raw: 1 notes/);
    assert.match(r.stdout, /some-agent/);
  });
});

describe('inbox tier (issue #4): MCP read tools never surface inbox', () => {
  function startMcpClient() {
    const proc = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, OKF_ROOT: BUNDLE_DIR, OKF_EMBED_URL: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let nextId = 1;
    const rl = createInterface({ input: proc.stdout, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    function request(method, params) {
      const id = nextId++;
      return new Promise((resolvePromise) => {
        pending.set(id, resolvePromise);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }
    function notify(method, params) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
    function close() {
      return new Promise((resolvePromise) => {
        proc.once('exit', () => resolvePromise());
        try { proc.stdin.end(); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 500);
      });
    }
    return { request, notify, close };
  }

  async function mcpInit(client) {
    await client.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'inbox-tier-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized', {});
  }

  function toolPayload(callResult) {
    assert.ok(callResult?.result?.content?.[0]?.text, 'tool result missing content');
    return JSON.parse(callResult.result.content[0].text);
  }

  it('memory_list / memory_search / memory_get exclude the raw inbox note', async () => {
    const client = startMcpClient();
    try {
      await mcpInit(client);

      const listRes = await client.request('tools/call', { name: 'memory_list', arguments: {} });
      const listPayload = toolPayload(listRes);
      assert.ok(!listPayload.items.some(i => String(i.id || '').startsWith('inbox/')));

      const searchRes = await client.request('tools/call', {
        name: 'memory_search',
        arguments: { query: INBOX_MARKER, k: 10, mode: 'bm25' },
      });
      const searchPayload = toolPayload(searchRes);
      assert.ok(!searchPayload.results.some(r => String(r.id || '').startsWith('inbox/')));
      // the marker naturally appears in the echoed `query` field of the response — that's not a
      // leak. The real assertion is that no *result* (id/snippet) comes from inbox/.
      assert.ok(!searchPayload.results.some(r => String(r.snippet || '').includes(INBOX_MARKER)));

      const getRes = await client.request('tools/call', {
        name: 'memory_get',
        arguments: { id: 'inbox/some-agent' },
      });
      const getPayload = toolPayload(getRes);
      assert.equal(getPayload.found, false);
    } finally {
      await client.close();
    }
  });

  it('regression: a fresh memory_write_inbox entry keeps `samemind query validate` conformant', async () => {
    const client = startMcpClient();
    try {
      await mcpInit(client);
      const writeRes = await client.request('tools/call', {
        name: 'memory_write_inbox',
        arguments: { content: 'first real write through the MCP tool', title: 'Dogfood note' },
      });
      const payload = toolPayload(writeRes);
      assert.equal(payload.ok, true);
    } finally {
      await client.close();
    }
    const validate = runCli('tools/okf-query.mjs', ['validate']);
    assert.equal(validate.status, 0, validate.combined);
    assert.match(validate.stdout, /✅ OKF v0\.1 conformant/);
  });
});

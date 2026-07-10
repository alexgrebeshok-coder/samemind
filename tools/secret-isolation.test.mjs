#!/usr/bin/env node
// secret-isolation.test.mjs — end-to-end perimeter: a visibility:secret concept must NEVER
// appear in any default surface (query list, recall bm25, gde, MCP memory_*, brief).
// One suite, one tmp-bundle, full perimeter. Builds on N3 mcp secret checks without replacing them.
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

/** Unique body marker — must never appear in any default tool output. */
const SECRET_MARKER = 'N7-SECRET-ISOLATION-MARKER-DO-NOT-LEAK-7f3a9c';
const SECRET_ID = 'secret/isolation-vault';
const SECRET_TITLE = 'Isolation Vault Secret';
/** Distinctive title fragment used as BM25/gde query bait. */
const SECRET_QUERY = 'Isolation Vault Secret TOP-SECRET isolation vault';

let BUNDLE_DIR;

function runCli(scriptRel, args, { env = {} } = {}) {
  const script = join(PACKAGE_ROOT, scriptRel);
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OKF_ROOT: BUNDLE_DIR,
      // force BM25 path — no accidental semantic/embed noise
      OKF_EMBED_URL: '',
      ...env,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    combined: `${res.stdout || ''}\n${res.stderr || ''}`,
  };
}

/**
 * Assert no secret content leak.
 * @param {string} label
 * @param {string} text
 * @param {{ allowRequestedId?: boolean }} [opts]
 *   allowRequestedId — CLI/MCP may echo the *requested* id in a "not found" reply;
 *   still never allow the body marker or a listed concept row for secret/.
 */
function assertNoSecretLeak(label, text, { allowRequestedId = false } = {}) {
  assert.ok(
    !text.includes(SECRET_MARKER),
    `${label}: leaked SECRET_MARKER (body)`,
  );
  if (!allowRequestedId) {
    assert.ok(
      !text.includes(SECRET_ID),
      `${label}: leaked secret id ${SECRET_ID}`,
    );
    assert.ok(
      !/secret\/isolation-vault/i.test(text),
      `${label}: leaked secret path`,
    );
  }
  // never print the secret title as a found concept line
  assert.ok(
    !new RegExp(`^.*\\b${SECRET_ID}\\b.*${SECRET_TITLE}`, 'm').test(text),
    `${label}: listed secret as a found concept`,
  );
}

function startMcpClient() {
  const proc = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, OKF_ROOT: BUNDLE_DIR, OKF_EMBED_URL: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderrBuf = '';

  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

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

  return { request, notify, close, stderr: () => stderrBuf };
}

async function mcpInit(client) {
  await client.request('initialize', {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'secret-isolation-test', version: '0.0.0' },
  });
  client.notify('notifications/initialized', {});
}

function toolPayload(callResult) {
  assert.ok(callResult?.result?.content?.[0]?.text, 'tool result missing content');
  return JSON.parse(callResult.result.content[0].text);
}

before(() => {
  BUNDLE_DIR = mkdtempSync(join(tmpdir(), 'samemind-secret-iso-'));
  const result = runInit({ targetDir: BUNDLE_DIR, demo: true });
  assert.equal(result.ok, true, 'init --demo failed');
  writeFileSync(join(BUNDLE_DIR, 'secret', 'isolation-vault.md'), `---
type: Concept
title: ${SECRET_TITLE}
description: isolation perimeter canary — must never leak
visibility: secret
tags: [isolation, canary, vault]
---

# ${SECRET_TITLE}

${SECRET_MARKER}

Body of a secret concept used only by secret-isolation.test.mjs.
`, 'utf8');
});

after(() => {
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
});

describe('secret isolation perimeter (N7)', () => {
  it('secret concept is invisible across query / recall / gde / MCP / brief', async () => {
    // --- 1. query list ---
    const list = runCli('tools/okf-query.mjs', ['list']);
    assert.equal(list.status, 0, `query list exit ${list.status}: ${list.stderr}`);
    assertNoSecretLeak('query list', list.combined);
    assert.match(list.stdout, /projects\/lumen/, 'list should still show public demo concepts');

    // query get by secret id — may echo the requested id in "не найдено", never the body
    const get = runCli('tools/okf-query.mjs', ['get', SECRET_ID]);
    assertNoSecretLeak('query get secret id', get.combined, { allowRequestedId: true });
    assert.match(get.stdout, /не найдено|not found/i);
    assert.ok(!get.stdout.includes(SECRET_MARKER));

    // --- 2. recall bm25 (query baits the secret title/body words) ---
    const recall = runCli('tools/okf-recall.mjs', [SECRET_QUERY, '-k', '10', '--mode', 'bm25']);
    assert.equal(recall.status, 0, `recall exit ${recall.status}: ${recall.stderr}`);
    assertNoSecretLeak('recall bm25', recall.combined);

    // --- 3. gde (mirror on by default; secret off without --secret) ---
    const gde = runCli('tools/gde.mjs', [SECRET_QUERY, '-k', '10']);
    assert.equal(gde.status, 0, `gde exit ${gde.status}: ${gde.stderr}`);
    assertNoSecretLeak('gde', gde.combined);

    // --- 4. brief ---
    const brief = runCli('tools/brief.mjs', []);
    assert.equal(brief.status, 0, `brief exit ${brief.status}: ${brief.stderr}`);
    assertNoSecretLeak('brief', brief.combined);

    // --- 5. MCP: memory_list / memory_search / memory_get ---
    const client = startMcpClient();
    try {
      await mcpInit(client);

      const listRes = await client.request('tools/call', {
        name: 'memory_list',
        arguments: {},
      });
      const listPayload = toolPayload(listRes);
      assert.ok(Array.isArray(listPayload.items));
      assert.ok(!listPayload.items.some(i => String(i.id || '').startsWith('secret/')));
      assertNoSecretLeak('MCP memory_list', JSON.stringify(listRes));

      const searchRes = await client.request('tools/call', {
        name: 'memory_search',
        arguments: { query: SECRET_QUERY, k: 10, mode: 'bm25' },
      });
      const searchPayload = toolPayload(searchRes);
      assert.ok(Array.isArray(searchPayload.results));
      assert.ok(!searchPayload.results.some(r => String(r.id || '').startsWith('secret/')));
      assertNoSecretLeak('MCP memory_search', JSON.stringify(searchRes));

      const getRes = await client.request('tools/call', {
        name: 'memory_get',
        arguments: { id: SECRET_ID },
      });
      const getPayload = toolPayload(getRes);
      assert.equal(getPayload.found, false, 'memory_get must refuse secret id');
      // JSON may echo the requested id in { found:false, id }; body marker must not appear
      assertNoSecretLeak('MCP memory_get', JSON.stringify(getRes), { allowRequestedId: true });
      assert.ok(!JSON.stringify(getRes).includes(SECRET_MARKER));

      // health must not mention the marker either
      const healthRes = await client.request('tools/call', {
        name: 'memory_health',
        arguments: {},
      });
      assertNoSecretLeak('MCP memory_health', JSON.stringify(healthRes));
    } finally {
      await client.close();
    }
  });
});

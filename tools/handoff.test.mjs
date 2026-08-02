#!/usr/bin/env node
// handoff.test.mjs — unit + CLI + MCP tests for `samemind handoff` / memory_handoff.
// Never touches the real repo or ~/samemind. Demo-seeded via runInit or synthetic docs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildHandoff, buildHandoffModel, projectHandoffJson, thinDoc, normalizeProjectKey, DEFAULT_DAYS,
} from './handoff.mjs';
import { runInit } from './init.mjs';
import { DEFAULT_PROTOCOL_VERSION } from './lib/mcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF = join(HERE, 'handoff.mjs');
const MCP_SERVER = join(HERE, 'mcp-server.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');
const DEMO = resolve(HERE, '..', 'demo');

const TOP_SECRET_MARKER = 'TOP-SECRET-HANDOFF-MARKER-DO-NOT-LEAK';

/** Minimal synthetic doc for unit tests. */
function doc({ id, type, title, status, blocked_reason, agreed_on, date, engine, timestamp, relations, body, visibility }) {
  const fm = {
    type,
    title: title || id,
    visibility: visibility || 'internal',
  };
  if (status !== undefined) fm.status = status;
  if (blocked_reason !== undefined) fm.blocked_reason = blocked_reason;
  if (agreed_on !== undefined) fm.agreed_on = agreed_on;
  if (date !== undefined) fm.date = date;
  if (engine !== undefined) fm.engine = engine;
  if (timestamp !== undefined) fm.timestamp = timestamp;
  if (relations) fm.relations = relations;
  return { id, reserved: false, fm, body: body || `# ${title || id}\n` };
}

const FIXED_NOW = new Date('2026-07-10T12:00:00Z');

const DEMO_LIKE = [
  doc({
    id: 'projects/task-lumen-backlinks',
    type: 'Task',
    title: 'Ship Lumen backlink editor',
    status: 'in-progress',
    relations: { project: ['/projects/lumen.md'] },
  }),
  doc({
    id: 'projects/task-atlas-retrieval',
    type: 'Task',
    title: 'Wire retrieval strategy over the Atlas corpus',
    status: 'blocked',
    blocked_reason: 'Corpus ingestion paused — waiting on license list.',
    relations: { project: ['/projects/atlas.md'] },
  }),
  doc({
    id: 'projects/task-iris-ux-review',
    type: 'Task',
    title: 'Iris UX review of sync conflict flow',
    status: 'done',
    relations: { project: ['/projects/lumen.md'] },
  }),
  doc({
    id: 'projects/plan-lumen-sync',
    type: 'Plan',
    title: 'Lumen multi-device sync',
    status: 'agreed',
    agreed_on: '2026-07-08',
    relations: { covers: ['/projects/lumen.md'] },
  }),
  doc({
    id: 'projects/plan-old-cloud',
    type: 'Plan',
    title: 'Hosted cloud sync (superseded)',
    status: 'superseded',
    agreed_on: '2026-06-01',
    relations: { covers: ['/projects/lumen.md'] },
  }),
  doc({
    id: 'concepts/decision-lumen-local-first',
    type: 'Decision',
    title: 'Lumen stays local-first — no mandatory cloud account',
    agreed_on: '2026-07-08',
    relations: { about: ['/projects/lumen.md'] },
  }),
  doc({
    id: 'concepts/session-2026-07-09-lumen-sync',
    type: 'Session',
    title: 'Lumen sync kickoff (2026-07-09)',
    engine: 'claude-code',
    date: '2026-07-09',
    relations: {
      decided: ['/concepts/decision-lumen-local-first.md'],
      next: ['/projects/task-lumen-backlinks.md', '/projects/task-atlas-retrieval.md'],
    },
    body: `# Lumen sync kickoff

## Done

- Walked the sync design space; picked a CRDT-first direction.

## Decided

- Lumen stays local-first, no mandatory cloud account.

## Next

- Land the backlink editor first.
- Atlas retrieval is blocked on the source license list.
`,
  }),
];

describe('buildHandoff — unit', () => {
  it('fills Active / Last decisions / Plans / Last session / Open questions from demo-like docs', () => {
    const { markdown, sections } = buildHandoff(DEMO_LIKE, { now: FIXED_NOW, days: 14 });

    assert.match(markdown, /^# Handoff — work state/m);
    assert.match(markdown, /## Active/);
    assert.match(markdown, /## Last decisions \(14d\)/);
    assert.match(markdown, /## Plans in force/);
    assert.match(markdown, /## Last session/);
    assert.match(markdown, /## Open questions/);

    // Active: in-progress + blocked
    assert.match(markdown, /\*\*in-progress\*\* Ship Lumen backlink editor/);
    assert.match(markdown, /`\/projects\/task-lumen-backlinks\.md`/);
    assert.match(markdown, /\*\*blocked\*\* Wire retrieval strategy/);
    assert.match(markdown, /`\/projects\/task-atlas-retrieval\.md`/);
    // done task not in Active
    assert.doesNotMatch(markdown, /Iris UX review.*\*\*in-progress\*\*|## Active[\s\S]*Iris UX review/);

    // Decision present
    assert.match(markdown, /Lumen stays local-first/);
    assert.match(markdown, /`\/concepts\/decision-lumen-local-first\.md`/);

    // Plan agreed present
    assert.match(markdown, /\*\*agreed\*\* Lumen multi-device sync/);

    // Last session
    assert.match(markdown, /Lumen sync kickoff/);
    assert.match(markdown, /claude-code/);
    assert.match(markdown, /Done:/);
    assert.match(markdown, /Next:/);

    assert.ok(sections.active.includes('projects/task-lumen-backlinks'));
    assert.ok(sections.active.includes('projects/task-atlas-retrieval'));
    assert.equal(sections.lastSession, 'concepts/session-2026-07-09-lumen-sync');
  });

  it('blocked task with reason appears in Open questions', () => {
    const { markdown, sections } = buildHandoff(DEMO_LIKE, { now: FIXED_NOW });
    assert.match(markdown, /## Open questions[\s\S]*blocked:[\s\S]*license list/i);
    assert.match(markdown, /Open questions[\s\S]*`\/projects\/task-atlas-retrieval\.md`/);
    assert.ok(sections.openQuestions.blocked.includes('projects/task-atlas-retrieval'));
    // session Next also in open questions
    assert.match(markdown, /Open questions[\s\S]*next:.*backlink/i);
  });

  it('superseded plan is hidden from Plans in force', () => {
    const { markdown, sections } = buildHandoff(DEMO_LIKE, { now: FIXED_NOW });
    assert.match(markdown, /Lumen multi-device sync/);
    assert.doesNotMatch(markdown, /Hosted cloud sync/);
    assert.ok(sections.plans.includes('projects/plan-lumen-sync'));
    assert.ok(!sections.plans.includes('projects/plan-old-cloud'));
  });

  it('--project filters tasks/plans/decisions (and related session)', () => {
    const { markdown, sections } = buildHandoff(DEMO_LIKE, {
      project: 'lumen',
      now: FIXED_NOW,
    });
    // lumen task in Active
    assert.match(markdown, /Ship Lumen backlink editor/);
    // atlas blocked task filtered out of Active
    assert.doesNotMatch(markdown, /Wire retrieval strategy/);
    // lumen plan + decision stay
    assert.match(markdown, /Lumen multi-device sync/);
    assert.match(markdown, /local-first/);
    // session still present (next → lumen task)
    assert.match(markdown, /Lumen sync kickoff/);
    // open questions: no atlas blocked line
    assert.doesNotMatch(markdown, /Open questions[\s\S]*task-atlas-retrieval/);

    assert.ok(sections.active.includes('projects/task-lumen-backlinks'));
    assert.ok(!sections.active.includes('projects/task-atlas-retrieval'));
  });

  it('normalizeProjectKey accepts bare name, path, and .md form', () => {
    assert.equal(normalizeProjectKey('lumen'), 'projects/lumen');
    assert.equal(normalizeProjectKey('projects/lumen'), 'projects/lumen');
    assert.equal(normalizeProjectKey('/projects/lumen.md'), 'projects/lumen');
    assert.equal(normalizeProjectKey(null), null);
  });

  it('decisions outside --days window are omitted', () => {
    const old = doc({
      id: 'concepts/decision-ancient',
      type: 'Decision',
      title: 'Ancient call',
      agreed_on: '2020-01-01',
      relations: { about: ['/projects/lumen.md'] },
    });
    const { markdown } = buildHandoff([...DEMO_LIKE, old], { now: FIXED_NOW, days: 14 });
    assert.doesNotMatch(markdown, /Ancient call/);
    assert.match(markdown, /local-first/);
  });

  it('each substantive line carries a path citation', () => {
    const { markdown } = buildHandoff(DEMO_LIKE, { now: FIXED_NOW });
    // Active lines
    const activeBlock = markdown.match(/## Active\n([\s\S]*?)\n## /)[1];
    for (const line of activeBlock.split('\n').filter(l => l.startsWith('-'))) {
      assert.match(line, /`\/[^`]+\.md`/);
    }
    // Decision lines
    const decBlock = markdown.match(/## Last decisions[^\n]*\n([\s\S]*?)\n## /)[1];
    for (const line of decBlock.split('\n').filter(l => l.startsWith('-') && !l.includes('_none_'))) {
      assert.match(line, /`\/[^`]+\.md`/);
    }
  });
});

describe('handoff CLI — demo bundle', () => {
  it('OKF_ROOT=demo fills all sections from live demo', () => {
    const r = spawnSync(process.execPath, [HANDOFF], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /## Active/);
    assert.match(out, /in-progress.*backlink|Ship Lumen backlink/i);
    assert.match(out, /blocked.*Atlas|retrieval/i);
    assert.match(out, /## Last decisions/);
    assert.match(out, /local-first/i);
    assert.match(out, /## Plans in force/);
    assert.match(out, /Lumen multi-device sync/i);
    assert.match(out, /## Last session/);
    assert.match(out, /## Open questions/);
    assert.match(out, /Corpus ingestion|license/i);
  });

  it('bin/samemind.mjs handoff routes correctly', () => {
    const r = spawnSync(process.execPath, [BIN, 'handoff', '--days', '30'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /# Handoff — work state/);
  });

  it('--project lumen excludes atlas-only active task', () => {
    const r = spawnSync(process.execPath, [HANDOFF, '--project', 'lumen'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /backlink/i);
    assert.doesNotMatch(r.stdout, /\*\*blocked\*\*.*Atlas|\*\*blocked\*\*.*retrieval/i);
  });
});

describe('handoff CLI — --json', () => {
  it('prints one line: contract=1, kind=handoff, generatedAt, data = buildHandoffModel()', () => {
    const r = spawnSync(process.execPath, [HANDOFF, '--json'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.contract, 1);
    assert.equal(payload.kind, 'handoff');
    assert.ok(!Number.isNaN(Date.parse(payload.generatedAt)), 'generatedAt is a valid ISO timestamp');
    assert.ok(Array.isArray(payload.data.active));
    assert.ok(payload.data.active.some(d => d.id.includes('lumen-backlinks')), 'data is the real buildHandoffModel() output');
  });

  it('--project narrows the JSON data the same way it narrows the markdown', () => {
    const r = spawnSync(process.execPath, [HANDOFF, '--project', 'lumen', '--json'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout.trim());
    assert.equal(payload.data.projectKey, 'projects/lumen');
    assert.ok(!payload.data.active.some(d => d.id.includes('atlas-retrieval')));
  });

  it('--json rejects --html (one projection at a time)', () => {
    const r = spawnSync(process.execPath, [HANDOFF, '--json', '--html'], {
      env: { ...process.env, OKF_ROOT: DEMO },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--json is incompatible with --html/);
  });
});

describe('MCP memory_handoff', () => {
  let BUNDLE_DIR;

  before(() => {
    BUNDLE_DIR = mkdtempSync(join(tmpdir(), 'samemind-handoff-mcp-'));
    const result = runInit({ targetDir: BUNDLE_DIR, demo: true });
    assert.equal(result.ok, true, 'test bundle scaffold failed');
    // secret concept — must never appear in handoff markdown
    mkdirSync(join(BUNDLE_DIR, 'secret'), { recursive: true });
    writeFileSync(join(BUNDLE_DIR, 'secret', 'vault.md'), `---
type: Concept
title: Vault Secret
description: must never leak
visibility: secret
tags: [vault]
---

# Vault Secret

${TOP_SECRET_MARKER} — this body must never reach any MCP response.
`, 'utf8');
  });

  after(() => {
    rmSync(BUNDLE_DIR, { recursive: true, force: true });
  });

  function startClient() {
    const proc = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, OKF_ROOT: BUNDLE_DIR },
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

  async function initialized(client) {
    await client.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'handoff-test', version: '0.0.0' },
    });
    client.notify('notifications/initialized', {});
  }

  function toolPayload(callResult) {
    assert.ok(callResult?.result?.content?.[0]?.text, 'tool result missing content');
    return JSON.parse(callResult.result.content[0].text);
  }

  it('is advertised in tools/list and returns markdown without secret', async () => {
    const client = startClient();
    try {
      await initialized(client);
      const list = await client.request('tools/list', {});
      const names = list.result.tools.map(t => t.name);
      assert.ok(names.includes('memory_handoff'), `tools/list missing memory_handoff: ${names.join(',')}`);

      const res = await client.request('tools/call', {
        name: 'memory_handoff',
        arguments: {},
      });
      assert.ok(!res.result?.isError, JSON.stringify(res));
      const payload = toolPayload(res);
      assert.equal(typeof payload.markdown, 'string');
      assert.match(payload.markdown, /## Active/);
      assert.match(payload.markdown, /## Open questions/);
      assert.equal(payload.days, DEFAULT_DAYS);
      // secret must not leak
      assert.ok(!payload.markdown.includes(TOP_SECRET_MARKER));
      assert.ok(!JSON.stringify(res).includes(TOP_SECRET_MARKER));
      assert.ok(!payload.markdown.includes('secret/vault'));
    } finally {
      await client.close();
    }
  });

  it('accepts project + days args', async () => {
    const client = startClient();
    try {
      await initialized(client);
      const res = await client.request('tools/call', {
        name: 'memory_handoff',
        arguments: { project: 'lumen', days: 30 },
      });
      const payload = toolPayload(res);
      assert.equal(payload.project, 'projects/lumen');
      assert.equal(payload.days, 30);
      assert.match(payload.markdown, /backlink|Lumen/i);
      assert.ok(!payload.markdown.includes(TOP_SECRET_MARKER));
    } finally {
      await client.close();
    }
  });
});

describe('--json payload: document bodies must not be shipped', () => {
  it('thinDoc drops body, file, and internal glue; keeps id, fm, relations', () => {
    const full = {
      id: 'projects/task-x',
      file: '/home/user/bundle/projects/task-x.md',
      base: 'task-x.md',
      reserved: false,
      hasFM: true,
      fm: { type: 'Task', title: 'X', status: 'in-progress' },
      body: '## Detail\nlong body ' + 'y'.repeat(2000),
      links: [],
      relations: {},
      supersedes: [],
      supersededBy: [],
    };
    const thin = thinDoc(full);
    assert.deepEqual(Object.keys(thin).sort(), ['fm', 'id', 'relations']);
    assert.equal(thin.body, undefined);
    assert.equal(thin.file, undefined);
  });

  it('projectHandoffJson strips every doc in the handoff model', () => {
    const docs = [
      doc({ id: 'projects/task-a', type: 'Task', title: 'A', status: 'in-progress', timestamp: '2026-07-01T00:00:00Z' }),
      doc({ id: 'projects/decide-b', type: 'Decision', title: 'B', date: '2026-07-01' }),
    ];
    const model = buildHandoffModel(docs, {});
    const projected = projectHandoffJson(model);
    for (const d of projected.active) {
      assert.equal(d.body, undefined, 'active: body not shipped');
      assert.equal(d.file, undefined, 'active: file not shipped');
    }
    for (const { d } of projected.recentDecisions) {
      assert.equal(d.body, undefined, 'recentDecisions: body not shipped');
    }
    if (projected.lastSession) {
      assert.equal(projected.lastSession.body, undefined, 'lastSession: body not shipped');
    }
  });
});

describe('sessionNext: capped array reports its true total', () => {
  it('sessionNext is capped at 5 but sessionNextTotal reflects all bullets', () => {
    const bullets = Array.from({ length: 8 }, (_, i) => `- bullet ${i + 1}`).join('\n');
    const docs = [
      doc({
        id: 'concepts/sess-1',
        type: 'Session',
        title: 'S1',
        date: '2026-07-09',
        timestamp: '2026-07-09T10:00:00Z',
        body: `## Next\n${bullets}`,
      }),
    ];
    const model = buildHandoffModel(docs, { now: new Date('2026-07-10T12:00:00Z') });
    assert.ok(model.sessionNext.length <= 5, 'sessionNext is capped');
    assert.equal(model.sessionNextTotal, 8, 'sessionNextTotal reflects all bullets');
  });

  it('sessionNextTotal is 0 when there is no last session', () => {
    const model = buildHandoffModel([], {});
    assert.equal(model.sessionNextTotal, 0);
    assert.deepEqual(model.sessionNext, []);
  });
});

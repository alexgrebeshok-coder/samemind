#!/usr/bin/env node
// demo-fixture.test.mjs — A5: fleet-layer onboarding fixtures (node --test tools/demo-fixture.test.mjs).
//   1. `samemind init` scaffolds all 7 tiers (concepts/entities/projects/inbox/secret/ledger/fleet);
//      ledger/.gitkeep and fleet/.gitkeep are never walked as OKF concepts.
//   2. demo/fleet/registry.json + demo/ledger/events.jsonl: a realistic fixture where cursor is
//      silent past its heartbeat, claude-code is healthy, grok (reserve) is never flagged, and
//      atlas-retrieval has one still-open failure — so `samemind board`/`samemind fleet status`
//      have something non-empty to show out of the box. `now` is injected (not Date.now()) so
//      this stays green regardless of when the suite actually runs — see docs/fleet.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runInit } from './init.mjs';
import { load } from './lib/okf.mjs';
import { buildBoard, buildBoardModel } from './board.mjs';
import { readRegistry, heartbeat } from './lib/fleet.mjs';
import { readEvents, summarizeLedger } from './lib/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, '..', 'demo');

// Fixed "now", set at (just after) the latest ts in demo/ledger/events.jsonl (2026-07-26T09:00Z) —
// keeps cursor overdue / claude-code healthy / grok shielded stable for the test's lifetime,
// independent of the real wall clock the suite happens to run under.
const NOW = Date.UTC(2026, 6, 26, 15, 4, 3);

describe('init — scaffolds all 7 tiers, including ledger/ and fleet/', () => {
  it('creates concepts/entities/projects/inbox/secret/ledger/fleet; the last two never leak as concepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samemind-init-fleet-'));
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(result.ok, true);

      for (const folder of ['concepts', 'entities', 'projects', 'inbox', 'secret', 'ledger', 'fleet']) {
        assert.ok(existsSync(join(dir, folder)), `${folder}/ missing`);
      }
      assert.ok(existsSync(join(dir, 'ledger', '.gitkeep')), 'ledger/.gitkeep scaffolded');
      assert.ok(existsSync(join(dir, 'fleet', '.gitkeep')), 'fleet/.gitkeep scaffolded');

      const docs = load({}, dir);
      assert.ok(
        !docs.some(d => d.id.startsWith('ledger/') || d.id.startsWith('fleet/')),
        'ledger/.gitkeep and fleet/.gitkeep are never walked as OKF concepts',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo — fleet/registry.json fixture', () => {
  it('declares 3 engines: claude-code (director, active), cursor (executor, active), grok (executor, reserve)', () => {
    const registry = readRegistry(DEMO);
    assert.ok(registry, 'registry present at demo/fleet/registry.json');
    assert.equal(registry.engines.length, 3);
    const byId = Object.fromEntries(registry.engines.map(e => [e.id, e]));
    assert.equal(byId['claude-code'].role, 'director');
    assert.equal(byId['claude-code'].status, 'active');
    assert.equal(byId['claude-code'].heartbeatSec, 86400);
    assert.equal(byId.cursor.role, 'executor');
    assert.equal(byId.cursor.status, 'active');
    assert.equal(byId.cursor.heartbeatSec, 3600);
    assert.equal(byId.grok.status, 'reserve');
  });

  it('heartbeat: cursor overdue (silent past its 3600s limit), claude-code healthy, grok never flagged', () => {
    const registry = readRegistry(DEMO);
    const rows = heartbeat(registry.engines, readEvents(DEMO), NOW);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.equal(byId.cursor.overdue, true, 'cursor silent well past its 3600s heartbeat');
    assert.equal(byId['claude-code'].overdue, false, 'claude-code checked in within its 86400s heartbeat');
    assert.equal(byId.grok.overdue, false, 'reserve engines are never flagged, regardless of silence');
  });
});

describe('demo — ledger/events.jsonl fixture', () => {
  it('has exactly one open failure (atlas-retrieval), closed topics stay closed', () => {
    const { topics, openFailures } = summarizeLedger(readEvents(DEMO));
    assert.equal(openFailures.length, 1);
    assert.equal(openFailures[0].topic, 'atlas-retrieval');
    const byTopic = Object.fromEntries(topics.map(t => [t.topic, t]));
    assert.equal(byTopic['lumen-sync'].openFail, null, 'lumen-sync has no open failure');
    assert.equal(byTopic['iris-ux-review'].openFail, null, 'iris-ux-review has no open failure');
  });
});

describe('demo — board renders both 🔥 sections non-empty', () => {
  it('samemind board (pure buildBoard/buildBoardModel) shows Open failures + Overdue engines from the demo bundle', () => {
    const docs = load({}, DEMO);
    const events = readEvents(DEMO);
    const { openFailures } = summarizeLedger(events);
    const registry = readRegistry(DEMO);
    const overdueEngines = heartbeat(registry.engines, events, NOW).filter(e => e.overdue);

    const md = buildBoard(docs, { now: NOW, openFailures, overdueEngines });
    assert.match(md, /## 🔥 Open failures \(1\)/);
    assert.match(md, /## 🔥 Overdue engines \(1\)/);
    assert.ok(md.includes('atlas-retrieval'), 'open failure names its topic');
    assert.ok(md.includes('**cursor**'), 'overdue engine listed by id');

    const model = buildBoardModel(docs, { now: NOW, openFailures, overdueEngines });
    assert.equal(model.openFailuresTotal, 1);
    assert.equal(model.overdueEnginesTotal, 1);
  });
});

#!/usr/bin/env node
// nudge-state.test.mjs — node --test, all against mkdtemp tmp dirs (never the real ~/.samemind).
// Mirrors health.test.mjs: atomic write, read-survives-corrupt, retention pruning on write.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readNudgeState, recordOutcome, SCHEMA_VERSION } from './lib/nudge-state.mjs';

const DAY = 24 * 3600_000;
const tmp = prefix => mkdtempSync(join(tmpdir(), `samemind-nudge-${prefix}-`));
const file = root => join(root, '.samemind', 'nudge-state.json');
const writeState = (root, obj) => {
  mkdirSync(join(root, '.samemind'), { recursive: true });
  writeFileSync(file(root), JSON.stringify(obj, null, 2));
};

describe('readNudgeState — never throws, normalizes', () => {
  it('missing file → safe empty state', () => {
    const root = tmp('missing');
    const s = readNudgeState(root);
    assert.deepEqual(s, { schema_version: SCHEMA_VERSION, outcomes: [], dnd: { active: false } });
    assert.equal(existsSync(file(root)), false); // read creates nothing
  });

  it('corrupt JSON → safe empty state, no throw (VERIFY: битый файл не роняет чтение)', () => {
    const root = tmp('corrupt');
    writeState(root, '{ this is not json :::');
    const s = readNudgeState(root);
    assert.deepEqual(s, { schema_version: SCHEMA_VERSION, outcomes: [], dnd: { active: false } });
  });

  it('foreign/extra keys are ignored — only outcomes + dnd are plucked', () => {
    const root = tmp('foreign');
    writeState(root, { schema_version: 99, who: 'knows', outcomes: [{ zone: 'k', outcome: 'delivered', at: 1 }], dnd: { active: true }, extra: 1 });
    const s = readNudgeState(root);
    assert.equal(s.schema_version, SCHEMA_VERSION);       // re-stamped, not trusted from disk
    assert.equal(s.outcomes.length, 1);
    assert.equal(s.dnd.active, true);
    assert.equal('extra' in s, false);
  });

  it('outcomes not an array / dnd not an object → normalized to empty', () => {
    const root = tmp('weird');
    writeState(root, { outcomes: 'nope', dnd: 'nope' });
    const s = readNudgeState(root);
    assert.deepEqual(s.outcomes, []);
    assert.deepEqual(s.dnd, { active: false });
  });
});

describe('recordOutcome — append, persist, prune', () => {
  it('appends one outcome, writes a valid file, returns the new state', () => {
    const root = tmp('append');
    const at = Date.now();
    const next = recordOutcome(root, { zone: 'kitchen', outcome: 'delivered', at, candidateId: 't1' });
    assert.equal(next.outcomes.length, 1);
    assert.equal(next.outcomes[0].zone, 'kitchen');
    assert.equal(next.outcomes[0].outcome, 'delivered');
    assert.equal(next.outcomes[0].at, at);
    assert.equal(next.outcomes[0].candidateId, 't1');
    // persisted on disk, parseable
    const onDisk = JSON.parse(readFileSync(file(root), 'utf8'));
    assert.equal(onDisk.outcomes.length, 1);
    assert.equal(onDisk.schema_version, SCHEMA_VERSION);
  });

  it('injectable `at` for determinism; absent → a finite epoch (Date.now)', () => {
    const root = tmp('at');
    recordOutcome(root, { zone: 'k', outcome: 'delivered', at: 12345 });
    assert.equal(readNudgeState(root).outcomes[0].at, 12345);
    const root2 = tmp('at-default');
    recordOutcome(root2, { zone: 'k', outcome: 'delivered' });
    assert.ok(Number.isFinite(readNudgeState(root2).outcomes[0].at));
  });

  it('zone null is preserved (used for "enough for today"); optional fields omitted when absent', () => {
    const root = tmp('nullzone');
    recordOutcome(root, { outcome: 'muted', at: 1 }); // no zone, no candidateId/reason
    const o = readNudgeState(root).outcomes[0];
    assert.equal(o.zone, null);
    assert.equal('candidateId' in o, false);
    assert.equal('reason' in o, false);
  });

  it('prunes entries older than retentionDays (default 7) on write — no separate daemon', () => {
    const root = tmp('prune');
    const now = Date.now();
    // seed the file directly with one stale (8d) + one fresh outcome
    writeState(root, { schema_version: SCHEMA_VERSION, outcomes: [
      { zone: 'k', outcome: 'delivered', at: now - 8 * DAY },
      { zone: 'k', outcome: 'delivered', at: now - 60_000 },
    ], dnd: { active: false } });
    recordOutcome(root, { zone: 'k', outcome: 'delivered', at: now });
    const outcomes = readNudgeState(root).outcomes;
    assert.equal(outcomes.length, 2);          // stale 8d gone, fresh + new kept
    assert.ok(outcomes.every(o => o.at > now - DAY));
  });

  it('dnd flag survives a recordOutcome round-trip', () => {
    const root = tmp('dnd');
    writeState(root, { schema_version: SCHEMA_VERSION, outcomes: [], dnd: { active: true } });
    recordOutcome(root, { zone: 'k', outcome: 'deferred', at: 1 });
    assert.equal(readNudgeState(root).dnd.active, true);
  });
});

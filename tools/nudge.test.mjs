#!/usr/bin/env node
// nudge.test.mjs — tests for the nudge CLI surface (tools/nudge.mjs).
//   node --test tools/nudge.test.mjs
//
// The nudge model is built from three modules (nudge-policy / nudge-state / nudge-candidates),
// imported statically: a missing one is a load error, never a quiet fallback that would act with
// the policy bypassed. These tests cover the wiring, the contract surface and the ledger trace;
// the policy math itself lives in nudge-policy.test.mjs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseArgs, buildNudgeModel, recordNudgeResponse } from './nudge.mjs';
import { readNudgeState } from './lib/nudge-state.mjs';
import { decideNudge } from './lib/nudge-policy.mjs';
import { readEvents } from './lib/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `sm-nudge-${prefix}-`)); }

// ────────────────────────────────── parseArgs ──────────────────────────────────

describe('parseArgs', () => {
  it('defaults zone=default, json=false, dryRun=false', () => {
    const a = parseArgs([]);
    assert.equal(a.subcommand, 'nudge');
    assert.equal(a.zone, 'default');
    assert.equal(a.json, false);
    assert.equal(a.dryRun, false);
  });

  it('parses --zone, --json, --dry-run for top-level nudge', () => {
    const a = parseArgs(['--zone', 'work', '--json', '--dry-run']);
    assert.equal(a.subcommand, 'nudge');
    assert.equal(a.zone, 'work');
    assert.equal(a.json, true);
    assert.equal(a.dryRun, true);
  });

  it('parses --root for top-level nudge', () => {
    const a = parseArgs(['--root', '/tmp/bundle']);
    assert.equal(a.root, '/tmp/bundle');
  });

  it('routes respond subcommand with outcome, zone, ref, json', () => {
    const a = parseArgs(['respond', '--outcome', 'accepted', '--zone', 'home', '--ref', 'abc', '--json']);
    assert.equal(a.subcommand, 'respond');
    assert.equal(a.outcome, 'accepted');
    assert.equal(a.zone, 'home');
    assert.equal(a.ref, 'abc');
    assert.equal(a.json, true);
  });

  it('respond without --json defaults json=false', () => {
    const a = parseArgs(['respond', '--outcome', 'muted']);
    assert.equal(a.subcommand, 'respond');
    assert.equal(a.json, false);
  });
});

// ──────────────────────────────── buildNudgeModel ────────────────────────────────

describe('buildNudgeModel', () => {
  let root;

  before(() => { root = tmp('model'); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('returns a model with constant key set (contract surface)', async () => {
    const model = await buildNudgeModel(root, { zone: 'default' });
    // These keys are the contract — consumers (dashboard card, CLI) depend on every one.
    for (const k of ['zone', 'spoken', 'reasonCode', 'candidate', 'dryRun', 'trigger']) {
      assert.ok(k in model, `missing key: ${k}`);
    }
  });

  it('on an empty bundle: spoken=false, reasonCode present, candidate=null', async () => {
    const model = await buildNudgeModel(root);
    assert.equal(model.spoken, false);
    assert.equal(typeof model.reasonCode, 'string');
    assert.ok(model.reasonCode.length > 0, 'reasonCode must not be empty even when silent');
    assert.equal(model.candidate, null);
  });

  it('trigger is "manual" (the pluggable-source contract: not "schedule" or "camera")', async () => {
    const model = await buildNudgeModel(root);
    assert.equal(model.trigger, 'manual');
  });

  it('dryRun flag flows into the model', async () => {
    const dr = await buildNudgeModel(root, { dryRun: true });
    assert.equal(dr.dryRun, true);
    const live = await buildNudgeModel(root, { dryRun: false });
    assert.equal(live.dryRun, false);
  });

  it('does NOT write state on a normal call (no ledger events appear)', async () => {
    await buildNudgeModel(root);
    await buildNudgeModel(root);
    await buildNudgeModel(root);
    const events = readEvents(root).filter(e => e.topic === 'nudge');
    assert.equal(events.length, 0, 'buildNudgeModel must not write ledger events');
  });

  it('--zone is passed through to the model', async () => {
    const model = await buildNudgeModel(root, { zone: 'evening' });
    assert.equal(model.zone, 'evening');
  });
});

// ────────────────────────────── recordNudgeResponse ──────────────────────────────

describe('recordNudgeResponse', () => {
  let root;

  before(() => { root = tmp('resp'); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('rejects an invalid outcome', async () => {
    await assert.rejects(
      () => recordNudgeResponse(root, { outcome: 'bogus' }),
      /invalid outcome/,
    );
  });

  it('accepts each valid outcome and writes a ledger note', async () => {
    for (const outcome of ['accepted', 'deferred', 'dismissed', 'muted']) {
      await recordNudgeResponse(root, { outcome, ref: `o-${outcome}` });
    }
    const events = readEvents(root).filter(e => e.topic === 'nudge' && e.phase === 'note');
    assert.equal(events.length, 4, 'one note per outcome');
    const actions = events.map(e => e.action).sort();
    assert.ok(actions.some(a => a.startsWith('respond accepted')));
    assert.ok(actions.some(a => a.startsWith('respond dismissed')));
  });

  it('"хватит на сегодня" is recorded without a zone — a day, not a permanent room pause', async () => {
    const r = tmp('mute');
    try {
      await recordNudgeResponse(r, { outcome: 'muted', zone: 'kitchen' });
      const { outcomes } = readNudgeState(r);
      const muted = outcomes.find(o => o.outcome === 'muted');
      assert.ok(muted, 'the mute must reach the state, not only the ledger');
      // The policy reads a zone-scoped mute as a room pause lasting until an explicit unmute, and
      // a zone-less one as "enough for today". A button promising one evening must not do the former.
      assert.ok(!muted.zone, 'a zone here would silence the assistant permanently');
      const NOW = Date.now();
      const cfg = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive' } };
      const cand = [{ id: 'c1', text: 'что-то важное' }];
      const today = decideNudge({ now: NOW, candidates: cand, config: cfg, state: readNudgeState(r) });
      assert.equal(today.reason, 'muted_today');
      const tomorrow = decideNudge({ now: NOW + 24 * 3600_000, candidates: cand, config: cfg, state: readNudgeState(r) });
      assert.equal(tomorrow.deliver, true, 'tomorrow resets it — that is what "на сегодня" means');
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a second call with the same ref is deduped (no new ledger line)', async () => {
    const r1 = await recordNudgeResponse(root, { outcome: 'accepted', ref: 'dup-test' });
    assert.equal(r1.deduped, false);

    const r2 = await recordNudgeResponse(root, { outcome: 'accepted', ref: 'dup-test' });
    assert.equal(r2.deduped, true, 'second call with same ref must report deduped');

    const events = readEvents(root).filter(e => e.ref === 'dup-test');
    assert.equal(events.length, 1, 'exactly one ledger line for a given ref');
  });

  it('writes topic=nudge, phase=note, actor=samemind', async () => {
    await recordNudgeResponse(root, { outcome: 'deferred', ref: 'shape-test' });
    const [ev] = readEvents(root).filter(e => e.ref === 'shape-test');
    assert.equal(ev.topic, 'nudge');
    assert.equal(ev.phase, 'note');
    assert.equal(ev.actor, 'samemind');
  });

  it('without a ref, each call writes a new line (no dedup)', async () => {
    await recordNudgeResponse(root, { outcome: 'accepted' });
    await recordNudgeResponse(root, { outcome: 'accepted' });
    const events = readEvents(root).filter(e => e.topic === 'nudge' && e.ref == null && e.action === 'respond accepted zone=default');
    assert.equal(events.length, 2);
  });
});

// ──────────────────────────────── CLI main() ─────────────────────────────────────

describe('CLI main()', () => {
  let root;

  before(() => { root = tmp('cli'); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('nudge --json produces the contract envelope { contract, kind, generatedAt, data }', async () => {
    const { main } = await import('./nudge.mjs');
    const orig = process.env.OKF_ROOT;
    process.env.OKF_ROOT = root;
    const origLog = console.log;
    let captured = '';
    console.log = (...args) => { captured += args.join(' '); };
    try {
      const code = await main(['--json', '--root', root]);
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
      process.env.OKF_ROOT = orig;
    }
    const json = JSON.parse(captured);
    assert.equal(json.contract, 1);
    assert.equal(json.kind, 'nudge');
    assert.ok(json.generatedAt);
    assert.ok('data' in json);
    assert.equal(json.data.dryRun, false);
  });

  it('nudge respond --outcome accepted --json → nudge-response envelope', async () => {
    const { main } = await import('./nudge.mjs');
    const origLog = console.log;
    let captured = '';
    console.log = (...args) => { captured += args.join(' '); };
    try {
      const code = await main(['respond', '--outcome', 'accepted', '--ref', 'cli-1', '--root', root, '--json']);
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
    }
    const json = JSON.parse(captured);
    assert.equal(json.contract, 1);
    assert.equal(json.kind, 'nudge-response');
    assert.equal(json.data.ok, true);
  });

  it('nudge respond with invalid outcome → exit 1', async () => {
    const { main } = await import('./nudge.mjs');
    const origErr = console.error;
    console.error = () => {};
    try {
      const code = await main(['respond', '--outcome', 'nope', '--root', root]);
      assert.equal(code, 1);
    } finally {
      console.error = origErr;
    }
  });
});

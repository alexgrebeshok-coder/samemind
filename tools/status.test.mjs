#!/usr/bin/env node
// status.test.mjs — samemind status display logic. Regression: a fresh heartbeat whose last
// run FAILED must not read as ✅ ok (the "silent green over a broken run" bug class the whole
// projection layer exists to kill).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayState } from './status.mjs';

describe('status displayState — liveness folded with outcome', () => {
  it('fresh + ok:true → ok', () => {
    assert.equal(displayState('ok', { ok: true }), 'ok');
  });
  it('fresh + ok:false → failed (never silent green)', () => {
    assert.equal(displayState('ok', { ok: false, lastError: 'no target' }), 'failed');
  });
  it('stale run stays stale regardless of last ok (liveness problem first)', () => {
    assert.equal(displayState('stale', { ok: true }), 'stale');
    assert.equal(displayState('stale', { ok: false }), 'stale');
  });
  it('unknown (no health) stays unknown', () => {
    assert.equal(displayState('unknown', null), 'unknown');
  });
});

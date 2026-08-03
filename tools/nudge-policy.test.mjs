#!/usr/bin/env node
// nudge-policy.test.mjs — node --test. The policy is pure (no fs, no clock): every moment is
// an injected epoch, every state is a plain object. These are the acceptance-table rows from
// ambient-vision §10 plus the per-gate reason codes that feed the "why did you ask / stay
// silent" buttons.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideNudge, REASONS, zoneDeliveredToday } from './lib/nudge-policy.mjs';

// Local-civil moments (tests construct epochs via the Date ctor with local components, so the
// same assertion holds in any timezone: ctor and getter both use local time and round-trip).
const NOON = new Date(2026, 7, 3, 12, 0).getTime();   // Aug 3 2026 12:00 local
const NIGHT = new Date(2026, 7, 3, 23, 5).getTime();  // 23:05 — outside a 09–22 window
const DAY = 24 * 3600_000;
const startOfLocalDay = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime(); };

// Everything opted IN, daytime window — the green-path baseline.
const ON = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive', hours: '09:00-22:00' } };
const EMPTY = { outcomes: [], dnd: { active: false } };
const kitchen = { id: 'blocker-x', zone: 'kitchen', priority: 5 };

describe('decideNudge — silence by default (gates 1–2)', () => {
  it('everything OFF (VISION_DEFAULTS) → silent with a clear reason', () => {
    const r = decideNudge({ now: NOON, trigger: 'schedule', candidates: [kitchen], config: { vision: {} }, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.DISABLED);
    assert.equal(r.candidate, null);
  });

  it('vision.enabled true but proactivePrompts false → DISABLED (two separate consents)', () => {
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: { vision: { enabled: true, proactivePrompts: false, mode: 'proactive' } }, state: EMPTY });
    assert.equal(r.reason, REASONS.DISABLED);
  });

  it('mode !== "proactive" → MODE_NOT_PROACTIVE (e.g. presence-only mode)', () => {
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: { vision: { enabled: true, proactivePrompts: true, mode: 'presence' } }, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.MODE_NOT_PROACTIVE);
  });
});

describe('decideNudge — outside allowed hours → silence (gate 3)', () => {
  it('now at 23:05 with a 09–22 window → OUTSIDE_HOURS, nextAllowedAt = tomorrow 09:00', () => {
    const r = decideNudge({ now: NIGHT, candidates: [kitchen], config: ON, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.OUTSIDE_HOURS);
    const expectedNext = startOfLocalDay(NIGHT) + DAY + 9 * 60 * 60_000;
    assert.equal(r.nextAllowedAt, expectedNext);
  });

  it('null hours = unrestricted (any hour delivers, given the rest is on)', () => {
    const cfg = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive', hours: null } };
    const r = decideNudge({ now: NIGHT, candidates: [kitchen], config: cfg, state: EMPTY });
    assert.equal(r.deliver, true);
    assert.equal(r.candidate.id, 'blocker-x');
  });

  it('malformed hours string does not crash — treated as unrestricted', () => {
    const cfg = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive', hours: 'whenever' } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: cfg, state: EMPTY });
    assert.equal(r.deliver, true);
  });
});

describe('decideNudge — exactly ONE nudge on the green path', () => {
  it('eligible candidate → deliver that one, reason ok', () => {
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state: EMPTY });
    assert.equal(r.deliver, true);
    assert.equal(r.reason, REASONS.OK);
    assert.equal(r.candidate.id, 'blocker-x');   // single object, not an array
    assert.equal(r.nextAllowedAt, null);
  });

  it('multiple candidates → exactly one, the highest-priority', () => {
    const cands = [{ id: 'a', zone: 'kitchen', priority: 1 }, { id: 'b', zone: 'office', priority: 9 }];
    const r = decideNudge({ now: NOON, candidates: cands, config: ON, state: EMPTY });
    assert.equal(r.deliver, true);
    assert.equal(r.candidate.id, 'b');
  });

  it('falls through a blocked top candidate to an eligible lower-priority one', () => {
    const state = { outcomes: [{ zone: 'office', outcome: 'deferred', at: NOON }], dnd: { active: false } };
    const cands = [{ id: 'a', zone: 'office', priority: 9 }, { id: 'b', zone: 'kitchen', priority: 1 }];
    const r = decideNudge({ now: NOON + 60_000, candidates: cands, config: ON, state });
    assert.equal(r.deliver, true);
    assert.equal(r.candidate.id, 'b'); // office in cooldown → kitchen wins
  });

  it('all candidates blocked → silent, reports the TOP candidate\'s reason', () => {
    const state = { outcomes: [
      { zone: 'office', outcome: 'deferred', at: NOON },
      { zone: 'kitchen', outcome: 'delivered', at: NOON },
      { zone: 'kitchen', outcome: 'delivered', at: NOON },
      { zone: 'kitchen', outcome: 'delivered', at: NOON },
    ], dnd: { active: false } };
    const cands = [{ id: 'a', zone: 'office', priority: 9 }, { id: 'b', zone: 'kitchen', priority: 1 }];
    const r = decideNudge({ now: NOON + 60_000, candidates: cands, config: ON, state });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.COOLDOWN); // office (top) is in cooldown, not the daily-limited kitchen
  });
});

describe('decideNudge — "not now" cooldown (gate 6)', () => {
  it('after a deferred outcome the zone is in cooldown → COOLDOWN', () => {
    const state = { outcomes: [{ zone: 'kitchen', outcome: 'deferred', at: NOON }], dnd: { active: false } };
    const r = decideNudge({ now: NOON + 60_000, candidates: [kitchen], config: ON, state });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.COOLDOWN);
    assert.equal(r.nextAllowedAt, NOON + 15 * 60_000); // default cooldownMin 15 (§14 draft)
  });

  it('after cooldown expires (and daily budget remains) the zone delivers again', () => {
    const state = { outcomes: [{ zone: 'kitchen', outcome: 'deferred', at: NOON }], dnd: { active: false } };
    const r = decideNudge({ now: NOON + 16 * 60_000, candidates: [kitchen], config: ON, state });
    assert.equal(r.deliver, true);
    assert.equal(r.candidate.id, 'blocker-x');
  });

  it('cooldown is configurable: cooldownMin 1 → expires after 1 min', () => {
    const cfg = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive', hours: '09:00-22:00', cooldownMin: 1 } };
    const state = { outcomes: [{ zone: 'kitchen', outcome: 'deferred', at: NOON }], dnd: { active: false } };
    assert.equal(decideNudge({ now: NOON + 30_000, candidates: [kitchen], config: cfg, state }).reason, REASONS.COOLDOWN);
    assert.equal(decideNudge({ now: NOON + 70_000, candidates: [kitchen], config: cfg, state }).deliver, true);
  });
});

describe('decideNudge — daily cap (gate 7)', () => {
  it('3 delivered today (default cap) → DAILY_LIMIT, resets at next local midnight', () => {
    const state = { outcomes: [
      { zone: 'kitchen', outcome: 'delivered', at: NOON - 120_000 },
      { zone: 'kitchen', outcome: 'delivered', at: NOON - 90_000 },
      { zone: 'kitchen', outcome: 'delivered', at: NOON - 60_000 },
    ], dnd: { active: false } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.DAILY_LIMIT);
    assert.equal(r.nextAllowedAt, startOfLocalDay(NOON) + DAY);
  });

  it('deliveries from YESTERDAY do not count toward today\'s cap', () => {
    const yesterday = new Date(2026, 7, 2, 12, 0).getTime();
    const state = { outcomes: [
      { zone: 'kitchen', outcome: 'delivered', at: yesterday },
      { zone: 'kitchen', outcome: 'delivered', at: yesterday },
      { zone: 'kitchen', outcome: 'delivered', at: yesterday },
    ], dnd: { active: false } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state });
    assert.equal(r.deliver, true); // today's count is 0
    assert.equal(zoneDeliveredToday(state, 'kitchen', NOON), 0);
  });

  it('cap is configurable: dailyLimit 1 → second nudge of the day blocked', () => {
    const cfg = { vision: { enabled: true, proactivePrompts: true, mode: 'proactive', hours: '09:00-22:00', dailyLimit: 1 } };
    const state = { outcomes: [{ zone: 'kitchen', outcome: 'delivered', at: NOON - 60_000 }], dnd: { active: false } };
    assert.equal(decideNudge({ now: NOON, candidates: [kitchen], config: cfg, state }).reason, REASONS.DAILY_LIMIT);
  });
});

describe('decideNudge — no relevant candidate → silence is NORMAL (gate 8)', () => {
  it('empty candidates → NO_CANDIDATES', () => {
    const r = decideNudge({ now: NOON, candidates: [], config: ON, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.NO_CANDIDATES);
  });

  it('only an explicitly-irrelevant candidate → NO_CANDIDATES', () => {
    const r = decideNudge({ now: NOON, candidates: [{ id: 'x', zone: 'kitchen', relevant: false }], config: ON, state: EMPTY });
    assert.equal(r.reason, REASONS.NO_CANDIDATES);
  });
});

describe('decideNudge — runtime mute states (gates 4–5)', () => {
  it('do-not-disturb flag on → DO_NOT_DISTURB', () => {
    const state = { outcomes: [], dnd: { active: true } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state });
    assert.equal(r.reason, REASONS.DO_NOT_DISTURB);
  });

  it('"enough for today" (zoneless muted today) → MUTED_TODAY until local midnight', () => {
    const state = { outcomes: [{ zone: null, outcome: 'muted', at: NOON - 60_000 }], dnd: { active: false } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state });
    assert.equal(r.reason, REASONS.MUTED_TODAY);
    assert.equal(r.nextAllowedAt, startOfLocalDay(NOON) + DAY);
  });

  it('a zoneless muted from YESTERDAY no longer mutes today', () => {
    const yesterday = new Date(2026, 7, 2, 22, 0).getTime();
    const state = { outcomes: [{ zone: null, outcome: 'muted', at: yesterday }], dnd: { active: false } };
    const r = decideNudge({ now: NOON, candidates: [kitchen], config: ON, state });
    assert.equal(r.deliver, true);
  });

  it('"turn off this room" (muted with zone) pauses that zone until an unmuted', () => {
    const state = { outcomes: [{ zone: 'kitchen', outcome: 'muted', at: NOON - 60_000 }], dnd: { active: false } };
    assert.equal(decideNudge({ now: NOON, candidates: [kitchen], config: ON, state }).reason, REASONS.ROOM_PAUSED);
    // a different zone is unaffected
    const office = { id: 'o', zone: 'office', priority: 1 };
    assert.equal(decideNudge({ now: NOON, candidates: [office], config: ON, state }).deliver, true);
    // explicit unmuted re-enables the room
    const unpaused = { outcomes: [...state.outcomes, { zone: 'kitchen', outcome: 'unmuted', at: NOON + 60_000 }], dnd: { active: false } };
    assert.equal(decideNudge({ now: NOON + 120_000, candidates: [kitchen], config: ON, unpaused }).deliver, true);
  });
});

describe('decideNudge — determinism', () => {
  it('the same input twice yields the same Decision (deepEqual)', () => {
    const args = { now: NOON, trigger: 'schedule', candidates: [kitchen, { id: 'o', zone: 'office', priority: 2 }], config: ON, state: EMPTY };
    const a = decideNudge(args);
    const b = decideNudge(args);
    assert.deepEqual(a, b);
  });

  it('a finite `now` is required — non-finite → DISABLED deterministically', () => {
    const r = decideNudge({ now: NaN, candidates: [kitchen], config: ON, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.reason, REASONS.DISABLED);
  });
});

// The seam between this module and the candidate builder. Both were green in isolation while the
// integration was dead: the policy required a `zone` on every candidate, and a candidate — "what
// is worth saying" — never has one. On real data that meant permanent silence with reason
// `no_candidates`, the one answer indistinguishable from "nothing to say". These rows use the
// builder's ACTUAL output shape as a literal, so the two cannot drift apart again unnoticed.
describe('decideNudge — real candidate shape (no zone anywhere)', () => {
  const REAL = {
    id: 'ledger:samemind:1754179200000',
    kind: 'stalled-failure',
    text: 'блокер по samemind',
    why: 'висит 4 дня, закрывающего события нет',
    sourceRef: 'ledger/samemind',
    age: 4,
  };

  it('a zone-less candidate is delivered, and the decision names the zone it used', () => {
    const r = decideNudge({ now: NOON, trigger: 'schedule', candidates: [REAL], config: ON, state: EMPTY });
    assert.equal(r.deliver, true, 'zone-less candidate must not be filtered out');
    assert.equal(r.candidate.id, REAL.id);
    assert.equal(typeof r.zone, 'string', 'the recorder needs the zone from the decision, not a guess');
  });

  it('the zone comes from the trigger — the moment has a room, the blocker does not', () => {
    const r = decideNudge({ now: NOON, trigger: { source: 'presence', zone: 'kitchen' }, candidates: [REAL], config: ON, state: EMPTY });
    assert.equal(r.zone, 'kitchen');
  });

  it('the daily cap counts zone-less deliveries — outcomes recorded under the decision zone', () => {
    const r = decideNudge({ now: NOON, trigger: 'schedule', candidates: [REAL], config: ON, state: EMPTY });
    const spent = { outcomes: Array.from({ length: 3 }, (_, i) => ({ outcome: 'delivered', zone: r.zone, at: NOON - i * 60_000 })) };
    const capped = decideNudge({ now: NOON, trigger: 'schedule', candidates: [REAL], config: ON, state: spent });
    assert.equal(capped.deliver, false);
    assert.equal(capped.reason, REASONS.DAILY_LIMIT, 'a default zone that no outcome matches would silently disable the cap');
  });

  it('silence carries an explicit null zone — one key set, never a missing key', () => {
    const r = decideNudge({ now: NOON, trigger: 'schedule', candidates: [], config: ON, state: EMPTY });
    assert.equal(r.deliver, false);
    assert.equal(r.zone, null);
  });
});

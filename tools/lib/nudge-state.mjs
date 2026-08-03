// nudge-state.mjs — runtime state for the nudge policy: the append-only outcome log (delivered
// / accepted / deferred / dismissed / muted / unmuted / silent) plus an explicit dnd flag.
//
// This is NOT user config. User choices (enabled, mode, hours, retention, …) live in
// .samemind/config.json — what a human picked. This file holds what the product OBSERVED and
// did at runtime: cooldowns, daily counts, room pauses are all derived from this log by the
// pure policy (see nudge-policy.mjs), never stored as separate aggregates. One source of truth.
//
// Shape mirrors health.json (tools/lib/health.mjs): atomic write, read never throws on a
// missing or corrupt file (returns a safe empty state). Stale entries are pruned by
// retentionDays on write — no separate daemon — and the policy ignores out-of-window entries
// by construction anyway, so an unpruned stale log cannot produce a stale decision.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { readFeatureConfig } from './feature-config.mjs';

export const SCHEMA_VERSION = 1;
const DAY = 24 * 3600_000;
const nudgeFile = root => join(root, '.samemind', 'nudge-state.json');

/** Safe empty state — what a missing/corrupt/foreign file resolves to. Outcomes never there,
 *  dnd off. The policy treats this identically to "nothing ever happened". */
function emptyState() {
  return { schema_version: SCHEMA_VERSION, outcomes: [], dnd: { active: false } };
}

/**
 * Reads nudge-state.json. Missing file, absent .outcomes, unparseable JSON, or a foreign
 * shape → a safe empty state; never throws. (Same forward-compatible contract as health.mjs:
 * an unknown schema_version's extra fields just don't come along — we re-pluck the two keys
 * we care about, so an older or newer file cannot crash a read.)
 *
 * Returns a NORMALIZED object: outcomes is always an array, dnd is always { active: boolean }.
 * Callers (and the policy) never null-check.
 */
export function readNudgeState(root) {
  const path = nudgeFile(root);
  if (!existsSync(path)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return emptyState(); // corrupt file must not crash a read (VERIFY: "битый файл не роняет чтение")
  }
  if (!parsed || typeof parsed !== 'object') return emptyState();
  return {
    schema_version: SCHEMA_VERSION,
    outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
    dnd: parsed.dnd && typeof parsed.dnd === 'object' ? { active: !!parsed.dnd.active } : { active: false },
  };
}

/**
 * Appends one outcome and atomically rewrites the file, pruning entries older than
 * retentionDays (from config.vision.retentionDays, default 7 — sourced internally so the
 * signature stays { zone, outcome, at, candidateId, reason } as specified). Returns the new
 * state (pruned, with the appended entry). `at` is injectable for deterministic tests; absent
 * → Date.now() (this is runtime I/O, not the pure policy, so the wall clock is fine here).
 *
 * Outcomes:
 *   delivered  — a nudge was shown (counts toward the zone's daily cap)
 *   accepted   — user engaged (logged only)
 *   deferred   — "not now" (starts the zone's cooldown)
 *   dismissed  — swiped away without acting (logged only; no cooldown)
 *   muted      — with a zone: pause that room until an `unmuted`; without a zone: "enough for
 *                today" → silence to end of local day
 *   unmuted    — re-enable a paused room
 *   silent     — policy decided to stay quiet (useful to observe how often silence wins)
 */
export function recordOutcome(root, { zone, outcome, at, candidateId, reason } = {}) {
  const ts = (typeof at === 'number' && Number.isFinite(at)) ? at : Date.now();
  const entry = { zone: zone ?? null, outcome, at: ts };
  if (candidateId != null) entry.candidateId = candidateId;
  if (reason != null) entry.reason = reason;

  // Prune the PRE-EXISTING history, then always append the new entry. Retention cleans up
  // stale history; it must never discard the outcome the caller just asked to record (an
  // injected/old `at` is still a record this call wanted kept).
  const prev = readNudgeState(root);
  const kept = pruneOld(prev.outcomes, retentionDaysFor(root));
  const outcomes = [...kept, entry];
  const next = { schema_version: SCHEMA_VERSION, outcomes, dnd: prev.dnd ?? { active: false } };
  atomicWriteFileSync(nudgeFile(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** retentionDays from project-level config.vision (global tier deliberately skipped — a state
 *  write must not reach into ~/.samemind). Missing/unreadable config → 7 (VISION_DEFAULTS). */
function retentionDaysFor(root) {
  try {
    const { vision } = readFeatureConfig(root, null);
    return Number.isFinite(vision?.retentionDays) ? vision.retentionDays : 7;
  } catch {
    return 7;
  }
}

function pruneOld(outcomes, retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return outcomes;
  const cutoff = Date.now() - retentionDays * DAY;
  return outcomes.filter(o => o && Number.isFinite(o.at) && o.at >= cutoff);
}

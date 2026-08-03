// nudge-policy.mjs — the silence policy for proactive nudges. Pure: no fs, no clock. `now`
// arrives as a parameter (epoch ms) so a decision is fully determined by its inputs and a
// test can pin any moment without `Date.now()` making the result random.
//
// The whole point of this module is one rule, stated in the spec (ambient-vision §0/§7):
// success is NOT "the assistant speaks every time". It is "useful enough to be kept, quiet
// enough to be forgotten about". Silence is a correct, normal outcome — not a failure. A
// prior prototype of this kind of feature was stopped because it felt intrusive, so every
// gate here exists to make the *absence* of a nudge the likely, explainable result.
//
// Each gate returns its OWN reason code (not a boolean "no"). Those codes feed the "why did
// you ask?" button and its mirror "why did you stay silent?" — unexplainable proactive
// behaviour gets switched off by people, so the reason is a first-class part of the result.
//
// Gates are checked in the order below. Order is load-bearing for explainability: it decides
// which reason a silence gets when several apply, and that reason is what the human reads.
//
//   1. config.vision.enabled AND config.vision.proactivePrompts   → 'disabled'
//   2. config.vision.mode === 'proactive'                         → 'mode_not_proactive'
//   3. now within config.vision.hours                             → 'outside_hours'
//   4. not do-not-disturb                                         → 'do_not_disturb'
//   5. not globally muted for today ("enough for today")          → 'muted_today'
//   6. per candidate (highest priority first), its zone must pass:
//        - room not paused ("turn off this room")                 → 'room_paused'
//        - not in post-"not now" cooldown                         → 'cooldown'
//        - daily delivered count under the limit                  → 'daily_limit'
//      the first candidate whose zone passes is delivered; if none pass, the reason of the
//      top-ranked candidate is reported (that is the one the user would ask about).
//   7. at least one relevant candidate exists                     → 'no_candidates'

export const REASONS = Object.freeze({
  OK: 'ok',
  DISABLED: 'disabled',
  MODE_NOT_PROACTIVE: 'mode_not_proactive',
  OUTSIDE_HOURS: 'outside_hours',
  DO_NOT_DISTURB: 'do_not_disturb',
  MUTED_TODAY: 'muted_today',
  ROOM_PAUSED: 'room_paused',
  COOLDOWN: 'cooldown',
  DAILY_LIMIT: 'daily_limit',
  NO_CANDIDATES: 'no_candidates',
});

// §14 (open questions to owner): cooldown after "not now" — draft 15 min; daily nudge cap —
// draft 3 per room. These are calibration knobs, expected to change after real use. They are
// NOT in feature-config's `vision` section yet (it carries enabled/mode/rooms/hours/
// retentionDays/proactivePrompts only), so they default here and are honoured only if a
// caller passes them on the config object — see report. Do not hard-code at call sites.
const POLICY_DEFAULTS = Object.freeze({ cooldownMin: 15, dailyLimit: 3 });

// Zone scope when the trigger names no room — which is EVERY trigger in this version, since the
// only source is a schedule and rooms arrive with the camera. It must be a real string, not
// null: `isMutedToday` reads an outcome with NO zone as the global "enough for today" mute, so
// logging deliveries under a null zone would make one silence the other. With this sentinel the
// cooldown and the daily cap actually engage in a camera-less build — the whole point of 0.18.
const DEFAULT_ZONE = 'default';

const MIN = 60_000;
const DAY = 24 * 3600_000;

// --- local-civil time helpers ------------------------------------------------
// The day boundary is LOCAL CIVIL MIDNIGHT (00:00:00 in the machine's local zone), not a
// rolling 24h window. Reason: "tomorrow resets it" (§10 scenario 10) is how a person
// experiences a day, and the daily cap / "enough for today" mute are human-day concepts. A
// rolling window would silently extend a cap past midnight and read as a bug. This is the
// spot that will be argued later — if the product ever crosses timezones or the owner wants
// "day" to mean a working day (e.g. reset at 04:00), this is the one function to change.
function startOfLocalDay(epochMs) {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}
function sameLocalDay(aMs, bMs) {
  return startOfLocalDay(aMs) === startOfLocalDay(bMs);
}
function minutesOfDay(epochMs) {
  const d = new Date(epochMs);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Parses an allowed-hours window. Shape is the one already used in feature-config tests:
 * a single `"HH:MM-HH:MM"` range string (e.g. '09:00-18:00'). `null`/absent/malformed → null,
 * which `withinHours` treats as UNRESTRICTED (any hour allowed).
 *
 * Why null = unrestricted and not "nothing allowed": hours is a positive allow-window, a
 * refinement. The privacy guardrails are the explicit switches (enabled / proactivePrompts /
 * mode === 'proactive') — gates 1–2. By the time hours is consulted the user has already
 * opted in; an unset window meaning "block everything" would silently kill a feature the
 * user just turned on, which is the surprising/dead reading. Absent config = no refinement.
 */
function parseHours(hours) {
  if (!hours || typeof hours !== 'string') return null;
  const m = hours.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (end === start) return null; // empty window makes no sense as a restriction
  return { start, end, wraps: end < start };
}
function withinHours(epochMs, hours) {
  if (!hours) return true;
  const t = minutesOfDay(epochMs);
  return hours.wraps ? (t >= hours.start || t < hours.end) : (t >= hours.start && t < hours.end);
}
/** Best-effort "when does the window next open" — informational, feeds nextAllowedAt. Correct
 *  for the common daytime window (start<end); for an overnight (wrapping) window it falls back
 *  to next local midnight, which is close enough for a hint and not load-bearing. */
function nextWindowStart(epochMs, hours) {
  if (!hours) return null;
  const dayStart = startOfLocalDay(epochMs);
  const todayStart = dayStart + hours.start * MIN;
  if (epochMs < todayStart) return todayStart;
  if (hours.wraps) return dayStart + DAY + hours.start * MIN;
  return dayStart + DAY + hours.start * MIN; // past today's end → tomorrow's start
}

// --- runtime-state derivations (pure; state comes from nudge-state.readNudgeState) ---------
// State is an append-only outcome log plus an explicit dnd flag. Cooldowns, daily counts and
// room pauses are DERIVED from the log at decision time rather than stored as aggregates —
// one source of truth, no aggregate-sync bugs, and stale entries are naturally ignored
// because every derivation is bounded by `now` (today / future-cooldown).

/** Count of nudges DELIVERED to `zone` during the current local day. Drives the daily cap. */
export function zoneDeliveredToday(state, zone, now) {
  const log = state?.outcomes;
  if (!Array.isArray(log)) return 0;
  let n = 0;
  for (const o of log) {
    if (o.outcome === 'delivered' && o.zone === zone && sameLocalDay(o.at, now)) n++;
  }
  return n;
}

/** Epoch ms until which THIS candidate must not be repeated, or null. A delivered nudge the human
 *  never answered is not a licence to say the identical sentence again on the next tick: measured
 *  end-to-end, an unanswered nudge repeated verbatim until the daily cap ate all three slots —
 *  the exact nagging the candidate builder filters for elsewhere. Rotating to the next candidate
 *  is both quieter and more useful. Reuses cooldownMin rather than inventing a second knob. */
export function candidateRepeatUntil(state, candidateId, cooldownMin) {
  const log = state?.outcomes;
  if (!Array.isArray(log) || candidateId == null) return null;
  let latest = -Infinity;
  for (const o of log) {
    if (o.outcome === 'delivered' && o.candidateId === candidateId && Number.isFinite(o.at) && o.at > latest) latest = o.at;
  }
  return Number.isFinite(latest) ? latest + cooldownMin * MIN : null;
}

/** Epoch ms when `zone`'s "not now" cooldown expires, or null if none active. The latest
 *  `deferred` outcome for the zone sets the clock; cooldown lasts cooldownMin from it. */
export function zoneCooldownUntil(state, zone, cooldownMin) {
  const log = state?.outcomes;
  if (!Array.isArray(log)) return null;
  let latest = -Infinity;
  for (const o of log) {
    if (o.outcome === 'deferred' && o.zone === zone && Number.isFinite(o.at) && o.at > latest) latest = o.at;
  }
  return Number.isFinite(latest) ? latest + cooldownMin * MIN : null;
}

/** A room is paused if the most recent room-scoped `muted`/`unmuted` event for that zone is a
 *  `muted`. Persists across restarts (state is a file) until an explicit `unmuted` — safer
 *  than re-enabling a room the user turned off just because the process restarted. */
export function isRoomPaused(state, zone) {
  const log = state?.outcomes;
  if (!Array.isArray(log)) return false;
  let paused = false;
  for (const o of log) {
    if (o.zone === zone && (o.outcome === 'muted' || o.outcome === 'unmuted')) paused = o.outcome === 'muted';
  }
  return paused;
}

/** Global "enough for today" mute: a `muted` outcome with NO zone, logged earlier today. Silence
 *  to end of local day (resets at local midnight along with the daily cap). */
export function isMutedToday(state, now) {
  const log = state?.outcomes;
  if (!Array.isArray(log)) return false;
  return log.some(o => o.outcome === 'muted' && !o.zone && sameLocalDay(o.at, now));
}

// --- the decision ------------------------------------------------------------
// `zone` travels WITH the decision because the outcome has to be recorded under the same zone the
// gates used — recordOutcome takes the zone from its caller, and a caller that guesses breaks the
// daily cap silently (the delivery lands in one bucket, the next check reads another).
function deliver(candidate, zone) {
  return { deliver: true, candidate, zone, reason: REASONS.OK, nextAllowedAt: null };
}
function silence(reason, nextAllowedAt = null, candidate = null) {
  return { deliver: false, candidate, zone: null, reason, nextAllowedAt };
}

/**
 * decideNudge({ now, trigger, candidates, config, state }) → Decision
 *   { deliver: boolean, candidate: <one | null>, reason: <code>, nextAllowedAt: <epoch|null> }
 *
 * `now`        — epoch ms. The ONLY notion of time; never call Date.now() here.
 * `trigger`    — what fired this evaluation: a source label ('presence' | 'schedule' | 'manual')
 *                or `{ source, zone? }`. Source of the moment is a schedule in this version (no
 *                camera). It carries the ZONE — "where the person is" is a property of the
 *                moment, not of the thing worth saying — and a blocker is not kitchen-specific.
 *                Absent zone falls to DEFAULT_ZONE. Otherwise it is only the "why did you ask"
 *                trace; the source label itself changes no gate.
 * `candidates` — [{ id, priority?, relevant?, zone? }]. `relevant !== false` (absent = relevant);
 *                higher priority = more relevant. The caller is expected to have already done
 *                relevance scoring; this gate only drops an explicitly-irrelevant one.
 * `config`     — the object readFeatureConfig returns ({ voice, vision }). Gates read
 *                config.vision. cooldownMin / dailyLimit are read off vision if present, else
 *                fall to POLICY_DEFAULTS (§14 drafts) — see note above.
 * `state`      — readNudgeState(root). Missing/corrupt file yields a safe empty state, so a
 *                null state here is tolerated too (treated as nothing-ever-happened).
 */
export function decideNudge({ now, trigger, candidates = [], config = {}, state = { outcomes: [] } } = {}) {
  if (!Number.isFinite(now)) return silence(REASONS.DISABLED); // no moment → no nudge, deterministically
  const v = config.vision || {};
  const cooldownMin = v.cooldownMin ?? POLICY_DEFAULTS.cooldownMin;
  const dailyLimit = v.dailyLimit ?? POLICY_DEFAULTS.dailyLimit;
  const hours = parseHours(v.hours);

  // 1. feature + proactive prompts both on
  if (!v.enabled || !v.proactivePrompts) return silence(REASONS.DISABLED);
  // 2. mode admits proactive prompts
  if (v.mode !== 'proactive') return silence(REASONS.MODE_NOT_PROACTIVE);
  // 3. within allowed hours (null hours = unrestricted)
  if (!withinHours(now, hours)) return silence(REASONS.OUTSIDE_HOURS, nextWindowStart(now, hours));
  // 4. not do-not-disturb (explicit runtime flag; source is a future focus-mode integration)
  if (state.dnd?.active) return silence(REASONS.DO_NOT_DISTURB);
  // 5. not globally muted for the rest of today
  if (isMutedToday(state, now)) return silence(REASONS.MUTED_TODAY, startOfLocalDay(now) + DAY);

  // 8 (checked here, after global gates, before per-zone): is there anything to say?
  //    A candidate is "what is worth saying" — it carries no zone, and requiring one here made
  //    every real candidate invisible (the producer emits { id, kind, text, why, sourceRef, age }).
  const relevant = candidates.filter(c => c && c.id != null && c.relevant !== false);
  if (relevant.length === 0) return silence(REASONS.NO_CANDIDATES);

  const triggerZone = (typeof trigger === 'object' && trigger?.zone) || DEFAULT_ZONE;

  // 6. pick the highest-priority candidate whose zone passes room-pause / cooldown / daily-cap.
  //    First eligible wins (at most ONE nudge — never a fan of proposals). If none pass, report
  //    the top-ranked candidate's blocking reason: that is the one a human would ask "why not?".
  const ranked = [...relevant].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  let topBlock = null;
  for (const c of ranked) {
    const zone = c.zone ?? triggerZone; // per-candidate zone stays an override for a genuinely room-bound item
    const repeatUntil = candidateRepeatUntil(state, c.id, cooldownMin);
    if (repeatUntil != null && repeatUntil > now) { topBlock ??= { r: REASONS.COOLDOWN, c, t: repeatUntil }; continue; }
    if (isRoomPaused(state, zone)) { topBlock ??= { r: REASONS.ROOM_PAUSED, c, t: null }; continue; }
    const cdUntil = zoneCooldownUntil(state, zone, cooldownMin);
    if (cdUntil != null && cdUntil > now) { topBlock ??= { r: REASONS.COOLDOWN, c, t: cdUntil }; continue; }
    if (zoneDeliveredToday(state, zone, now) >= dailyLimit) {
      topBlock ??= { r: REASONS.DAILY_LIMIT, c, t: startOfLocalDay(now) + DAY };
      continue;
    }
    return deliver(c, zone); // first eligible — exactly one
  }
  return silence(topBlock.r, topBlock.t, topBlock.c);
}

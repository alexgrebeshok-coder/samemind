// hygiene.mjs — memory hygiene: supersedes graph (who replaced whom), deprecated flag
// (`samemind forget`), importance + time-decay rank multiplier. See docs/memory-hygiene.md for
// the full formula and rationale (naryad N17: "протухший и актуальный факт не должны жить как
// равные").
//
// Most of this file is pure graph/scoring logic over already-parsed docs (no filesystem access),
// so it stays unit-testable on synthetic fixtures. Only collectSupersedeEdges() touches disk
// (existsSync) — it's used by `okf-query validate`/`links`, which always run on a real bundle.
import { existsSync } from 'node:fs';
import { displayType, pathToId, resolveRelationPath } from './okf.mjs';

export const SUPERSEDED_PENALTY = 0.35;      // superseded/deprecated docs rank at 35% of a clean doc
export const DEFAULT_IMPORTANCE = 3;         // neutral — importanceMultiplier = 1.0
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 5;
export const DECAY_AFTER_DAYS = 180;         // no penalty before this age
export const DECAY_FULL_DAYS = 720;          // penalty bottoms out at DECAY_MIN_MULTIPLIER here
export const DECAY_MIN_MULTIPLIER = 0.6;
export const TIMELESS_TYPES = new Set(['Identity', 'User', 'EngineRule']); // never decay
const DAY_MS = 86_400_000;

const isTrue = v => v === true || v === 'true';

/** `deprecated: true` — set by `samemind forget`, or by hand. Ranks/labels like a superseded node. */
export function isDeprecated(doc) {
  return isTrue(doc?.fm?.deprecated);
}

/**
 * targetId -> [fromId, ...] — every concept id that some OTHER concept's `supersedes` names.
 * Pure string mapping (pathToId only, no filesystem access) — safe on synthetic docs in tests.
 */
export function buildSupersededMap(docs) {
  const map = new Map();
  for (const d of docs) {
    for (const p of d.supersedes || []) {
      const toId = pathToId(p);
      if (!map.has(toId)) map.set(toId, []);
      map.get(toId).push(d.id);
    }
  }
  return map;
}

export function isSuperseded(doc, supersededMap) {
  const by = supersededMap.get(doc.id);
  return !!(by && by.length);
}

// --- bi-temporal supersede (Ф2) ---------------------------------------------------------------
// `supersedes`/`isSuperseded` above answer "does some OTHER doc name me as replaced?" (needs the
// whole corpus via buildSupersededMap). The fields below live on the doc's OWN frontmatter — set
// by hand, or by a human applying a `tools/reconcile.mjs` proposal — so no cross-doc map is
// needed to read them. Either signal marks a doc temporally superseded. Recall DEFAULT (Э6/6.3)
// excludes stale facts via isStaleForRecall; with includeSuperseded=true they reappear demoted by
// SUPERSEDED_PENALTY (same as `deprecated`, which is always demote-only).

/** `invalid_at: <ISO>` in the past — direct temporal invalidation (vs. `supersedes`, which is
 *  read from the replacing doc). Absent/unparseable/future → false (backward compatible: a
 *  concept written before Ф2 has no `invalid_at` and is always valid). */
export function isExpired(doc, now = Date.now()) {
  const raw = doc?.fm?.invalid_at;
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t <= now;
}

/** `valid_from: <ISO>` still in the future — fact not yet canon as-of `now`. Absent/unparseable/
 *  past → false (backward compatible: cards without valid_from are always valid). */
export function isNotYetValid(doc, now = Date.now()) {
  const raw = doc?.fm?.valid_from;
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now;
}

/** `superseded_by: /path.md` set on the OLD fact — the reverse pointer of `supersedes` (which
 *  lives on the NEW fact). `doc.supersededBy` is the normalized array from okf.mjs `parse()`. */
export function hasSupersededBy(doc) {
  return !!(doc?.supersededBy && doc.supersededBy.length);
}

/**
 * True when `superseded_by` points at least one target that exists in the loaded corpus
 * (`docsById`: id → doc from the same load() as ranking). Dangling superseded_by (target
 * missing) does NOT count — keep the fact until the replacement is actually in the bundle.
 * Without a docsById map, falls back to "field is set" (label/penalty path).
 */
export function hasResolvedSupersededBy(doc, docsById = null) {
  if (!hasSupersededBy(doc)) return false;
  // null/undefined = no corpus map (label/penalty path) → treat field as set
  if (docsById == null) return true;
  return doc.supersededBy.some(p => docsById.has(pathToId(p)));
}

/** True if this doc's own frontmatter marks it stale (`invalid_at` in the past,
 *  `valid_from` in the future, or `superseded_by` set) — independent of what any other doc
 *  says via `supersedes`. Used by rank multiplier / labels when stale hits are still shown. */
export function isTemporallySuperseded(doc, now = Date.now()) {
  return isExpired(doc, now) || isNotYetValid(doc, now) || hasSupersededBy(doc);
}

/**
 * Conflict-aware recall gate (Э6 / 6.3): should this doc be DROPPED from recall by default?
 * True when ANY of:
 *   - another concept's `supersedes` names this id (`buildSupersededMap`)
 *   - own `superseded_by` points to an existing concept in the corpus
 *   - `invalid_at` ≤ as-of (`now`)
 *   - `valid_from` > as-of (`now`)
 * Does NOT cover `deprecated` (still only demoted via SUPERSEDED_PENALTY — separate concern).
 * Cards with none of these fields → always false (backward compatible).
 */
export function isStaleForRecall(doc, supersededMap, { now = Date.now(), docsById = null } = {}) {
  if (isSuperseded(doc, supersededMap)) return true;
  if (hasResolvedSupersededBy(doc, docsById)) return true;
  if (isExpired(doc, now)) return true;
  if (isNotYetValid(doc, now)) return true;
  return false;
}

/** Parse `--as-of` / API asOf into epoch ms. null/'' → Date.now(). Invalid ISO → throws. */
export function resolveAsOf(asOf) {
  if (asOf == null || asOf === '') return Date.now();
  if (typeof asOf === 'number' && Number.isFinite(asOf)) return asOf;
  const t = Date.parse(String(asOf));
  if (!Number.isFinite(t)) throw new Error(`invalid as-of date: ${asOf}`);
  return t;
}

/**
 * DFS cycle detection over the supersedes graph (edge d.id -> pathToId(p), for each p in
 * d.supersedes). Pure, no filesystem access. Returns deduped cycles as arrays of ids
 * (closed: first id repeats as the last element).
 */
export function detectSupersedeCycles(docs) {
  const edges = new Map();
  for (const d of docs) {
    const targets = (d.supersedes || []).map(pathToId);
    if (targets.length) edges.set(d.id, targets);
  }
  const color = new Map(); // absent = white, 1 = gray (on stack), 2 = black (done)
  const stack = [];
  const seenCycles = new Set();
  const cycles = [];

  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    for (const to of edges.get(id) || []) {
      if (color.get(to) === 1) {
        const idx = stack.indexOf(to);
        const cycle = stack.slice(idx);
        const key = [...cycle].sort().join('\x1f');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push([...cycle, to]);
        }
      } else if (color.get(to) !== 2) {
        visit(to);
      }
    }
    stack.pop();
    color.set(id, 2);
  }
  for (const id of edges.keys()) if (!color.has(id)) visit(id);
  return cycles;
}

/**
 * All `supersedes` edges with resolution info — for `okf-query validate`/`links` (dangling
 * target detection, edge tally). Touches the filesystem (existsSync); only meaningful on docs
 * loaded from a real bundle via okf.mjs `load()`.
 */
export function collectSupersedeEdges(docs) {
  const edges = [];
  for (const d of docs) {
    for (const toPath of d.supersedes || []) {
      const resolved = resolveRelationPath(toPath);
      edges.push({
        fromId: d.id,
        toPath,
        toId: pathToId(toPath),
        resolved,
        exists: resolved ? existsSync(resolved) : false,
      });
    }
  }
  return edges;
}

/** importance: 1..5, default/absent 3 (neutral, multiplier 1.0). Invalid input → neutral. */
export function importanceMultiplier(doc) {
  const raw = doc?.fm?.importance;
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  const clamped = Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, n));
  return clamped / DEFAULT_IMPORTANCE;
}

/**
 * Time-decay: 1.0 up to DECAY_AFTER_DAYS old, linear ramp down to DECAY_MIN_MULTIPLIER at
 * DECAY_FULL_DAYS, floor after that. `Identity`/`User`/`EngineRule` are timeless — never decay
 * (an agent's own identity doesn't go stale because it's old).
 */
export function decayMultiplier(doc, now = Date.now()) {
  if (TIMELESS_TYPES.has(doc?.fm?.type)) return 1;
  const ts = doc?.fm?.timestamp;
  if (!ts) return 1;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 1;
  const ageDays = (now - t) / DAY_MS;
  if (ageDays <= DECAY_AFTER_DAYS) return 1;
  if (ageDays >= DECAY_FULL_DAYS) return DECAY_MIN_MULTIPLIER;
  const frac = (ageDays - DECAY_AFTER_DAYS) / (DECAY_FULL_DAYS - DECAY_AFTER_DAYS);
  return 1 - frac * (1 - DECAY_MIN_MULTIPLIER);
}

// --- tiered heat (Ф5) --------------------------------------------------------------------------
// SOTA (MemoryOS): promote/demote facts by "heat" = recency × frequency of actual USE, not just
// authoring time (`timestamp`/decayMultiplier above already covers staleness-since-written; heat
// covers "is anyone still touching this"). Source of truth: tools/lib/ledger.mjs's event log
// (`ledger/events.jsonl`) — an event's `topic` is matched against a doc's `id` (best-effort: the
// ledger docs are explicit that `topic` is "a free-text work-item id ... not a bundle path", so
// this only activates for the topics that DO happen to name a concept id; every other doc simply
// gets zero heat, same as before this existed — see docs/memory-hygiene.md).
//
// Heat only ever BOOSTS (multiplier ≥ 1) — it never penalizes below a doc's pre-Ф5 score. A doc
// with no matching ledger activity (the overwhelming majority) is untouched: heatMultiplier = 1,
// byte-for-byte the same rank as before this file gained heat. "Cold" is therefore not an absolute
// penalty but the ABSENCE of a boost — a cold fact sinks only relative to hot peers, exactly the
// "never hidden, only demoted" contract superseded/deprecated already use (SUPERSEDED_PENALTY).
export const HEAT_WINDOW_DAYS = 30;    // ledger activity older than this no longer contributes to heat
export const HEAT_FREQ_SATURATION = 5; // this many touches inside the window = full frequency credit
export const HEAT_BOOST_MAX = 0.5;     // heat can boost a doc's multiplier up to +50% (never a penalty)
export const HEAT_HOT_THRESHOLD = 0.5; // heatScore ≥ this → "hot" tier (see heatTier)

/**
 * topic -> { count, lastTs } — groups ledger events (tools/lib/ledger.mjs `readEvents()`) by
 * topic for heat scoring. Deliberately not `summarizeLedger()` (which also tracks open-failure
 * state this doesn't need) — a separate, minimal grouping keeps this module pure/no-fs, taking
 * the events array as a plain argument (same DI pattern as `docs`/`supersededMap` elsewhere in
 * this file: the caller reads the ledger file once, this just groups what it's given).
 */
export function buildHeatIndex(events) {
  const map = new Map();
  for (const e of events || []) {
    const topic = String(e?.topic ?? '').trim();
    if (!topic) continue;
    const cur = map.get(topic);
    if (!cur) { map.set(topic, { count: 1, lastTs: e.ts }); continue; }
    cur.count += 1;
    if (String(e.ts) > String(cur.lastTs)) cur.lastTs = e.ts;
  }
  return map;
}

/**
 * 0 (no ledger activity, or last activity fell outside HEAT_WINDOW_DAYS) .. 1 (maximally hot:
 * touched right now AND at/above HEAT_FREQ_SATURATION times within the window). recency and
 * frequency are multiplied, per the "heat = recency × frequency" formula (naryad Ф5) — a fact
 * touched often but long ago, or once but very recently, both score below a fact that's both
 * frequent AND recent.
 */
export function heatScore(doc, heatIndex, now = Date.now()) {
  const entry = heatIndex?.get(doc.id);
  if (!entry) return 0;
  const t = Date.parse(entry.lastTs);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (now - t) / DAY_MS;
  if (ageDays < 0 || ageDays >= HEAT_WINDOW_DAYS) return 0;
  const recencyFactor = 1 - ageDays / HEAT_WINDOW_DAYS;
  const freqFactor = Math.min(1, entry.count / HEAT_FREQ_SATURATION);
  return recencyFactor * freqFactor;
}

/** hot (frequent + recent) / warm (some recent signal) / cold (no activity, or fully cooled off) —
 *  the tier shown in memory_health/board (see docs/memory-hygiene.md). Derived, not stored. */
export function heatTier(score) {
  if (score >= HEAT_HOT_THRESHOLD) return 'hot';
  if (score > 0) return 'warm';
  return 'cold';
}

/** Rank multiplier from heat: 1.0 (no ledger signal — the pre-Ф5 baseline, unchanged) up to
 *  1+HEAT_BOOST_MAX for a maximally hot doc. Never below 1 — see the module note above. */
export function heatMultiplier(doc, heatIndex, now = Date.now()) {
  return 1 + heatScore(doc, heatIndex, now) * HEAT_BOOST_MAX;
}

/** Combined rank multiplier applied to a raw recall score — see docs/memory-hygiene.md.
 *  `heatIndex` (Ф5, optional — from buildHeatIndex(readEvents(ROOT))) is an ADDITIONAL multiplier
 *  applied last, alongside supersede/importance/decay in this one pass; omitted (default null) →
 *  behavior is byte-for-byte identical to before Ф5 (backward compatible, same contract as the
 *  `docs=[]` default elsewhere in this file). */
export function hygieneMultiplier(doc, supersededMap, { now = Date.now(), heatIndex = null } = {}) {
  let m = 1;
  if (isDeprecated(doc) || isSuperseded(doc, supersededMap) || isTemporallySuperseded(doc, now)) m *= SUPERSEDED_PENALTY;
  m *= importanceMultiplier(doc);
  m *= decayMultiplier(doc, now);
  if (heatIndex) m *= heatMultiplier(doc, heatIndex, now);
  return m;
}

/** Short inline label for a recall/gde hit, e.g. "[superseded by /concepts/new.md]" or
 *  "⤳ superseded by /concepts/new.md" (bi-temporal, Ф2). '' if clean.
 *  `now` (optional) — same as-of instant as ranking, so labels match --as-of temporal view. */
export function hygieneLabel(doc, supersededMap, { now = Date.now() } = {}) {
  const by = supersededMap.get(doc.id);
  if (by && by.length) return `[superseded by ${by.map(id => `/${id}.md`).join(', ')}]`;
  if (isDeprecated(doc)) {
    const on = doc.fm?.deprecated_on ? ` ${String(doc.fm.deprecated_on).slice(0, 10)}` : '';
    return `[deprecated${on}]`;
  }
  if (hasSupersededBy(doc)) return `⤳ superseded by ${doc.supersededBy.join(', ')}`;
  if (isExpired(doc, now)) return `⤳ superseded (invalid_at ${String(doc.fm.invalid_at).slice(0, 10)})`;
  if (isNotYetValid(doc, now)) return `⤳ not yet valid (valid_from ${String(doc.fm.valid_from).slice(0, 10)})`;
  return '';
}

// --- authority / conflict tiebreak (Э6 / 6.1) -------------------------------------------------
// When two LIVE facts contradict each other (same type, similar title/tags, neither supersedes
// the other — see tools/consolidate.mjs `findContradictions`) and BOTH appear in a recall hit
// list, we do NOT drop either (unlike supersede-gate 6.3). We only: (1) order the pair by
// authority ↓ → recency ↓ → existing score, and (2) label the loser so the agent sees the fight.
// Cards without authority / without a contradiction pair → byte-identical to pre-6.1 ranking.

/** Named authority tiers → comparable numbers (higher = more trusted). */
export const AUTHORITY_LEVELS = Object.freeze({
  canon: 3,
  derived: 2,
  observed: 1,
});

/**
 * `authority` frontmatter: number (higher = more trusted) OR enum
 * `canon` > `derived` > `observed`. Absent / unparseable → `null` (neutral: neither better nor
 * worse — when comparing, only both-set values decide; otherwise fall through to recency/score).
 * Frontmatter mini-parser yields strings; Number() accepts "5" the same way importance does.
 */
export function authorityValue(doc) {
  const raw = doc?.fm?.authority;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(AUTHORITY_LEVELS, s)) return AUTHORITY_LEVELS[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recency for conflict tiebreak: prefer `valid_from`, else `timestamp`. Epoch ms or null if
 * neither is a parseable date (null loses to any real date; two nulls fall through to score).
 */
export function docRecencyMs(doc) {
  const raw = doc?.fm?.valid_from || doc?.fm?.timestamp;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Inline label on the losing side of a live contradiction pair (Э6/6.1). */
export function conflictLabel(peerId) {
  return `⚔ conflicts with ${peerId}`;
}

/**
 * Compare two docs inside a contradiction pair for recall order.
 * Returns <0 if `a` should rank above `b`, >0 if `b` above `a`, 0 if equal on all axes.
 * Axes (strict order): authority (both set) ↓ → recency ↓ → `scoreA`/`scoreB` (caller-supplied
 * pre-tiebreak scores, higher better). Missing authority on either side → skip that axis
 * (neutral). Missing recency on either side → skip that axis.
 */
export function compareConflictPair(docA, docB, scoreA = 0, scoreB = 0) {
  const av = authorityValue(docA);
  const bv = authorityValue(docB);
  // Higher authority first: av > bv → a wins → negative (standard sort comparator).
  if (av != null && bv != null && av !== bv) return bv - av;

  const ra = docRecencyMs(docA);
  const rb = docRecencyMs(docB);
  if (ra != null && rb != null && ra !== rb) return rb - ra; // fresher first

  if (scoreA !== scoreB) return scoreB - scoreA;
  return 0;
}

// --- contradiction pairs (shared with tools/consolidate.mjs) ---------------------------------
// Lived in consolidate.mjs first; lifted here so recall can call findContradictions without a
// consolidate → sqlite-index → recall → consolidate import cycle. consolidate.mjs re-exports
// these for its CLI + reconcile.mjs. Logic is unchanged (title/tag Jaccard, no embeddings).

/** Jaccard(title ∪ tags tokens) ≥ this → candidate contradiction pair for a human.
 *  ONE honest bar for every schema. Soul cards (curated-in-place) legitimately yield ~0 pairs at
 *  this threshold — that's correct, not a miss (no manufactured/lowered soul bar; decision Саши 24.07). */
export const CONTRADICTION_SIM = 0.34;
/** Description slice for the soul token fallback — long prose dilutes Jaccard if taken whole. */
export const CONTRADICTION_SOUL_DESC_SLICE = 80;
const CONTRADICTION_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on']);

function usesSoulTokenFallback(fm) {
  const hasTitle = fm?.title != null && String(fm.title).trim() !== '';
  const hasTags = Array.isArray(fm?.tags) && fm.tags.length > 0;
  return !hasTitle && !hasTags;
}

function tokenizeContradictionText(text) {
  return new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && !CONTRADICTION_STOPWORDS.has(w)));
}

/** Tokens of a concept's title+tags: lower, split on non-letter/digit, stopwords/short dropped.
 *  Soul-schema fallback (only when BOTH title and tags are absent): `name` (hyphens→spaces) +
 *  truncated `description` — see displayTitle/displayType in okf.mjs. */
export function titleTokens(d) {
  const fm = d?.fm || {};
  let text;
  if (!usesSoulTokenFallback(fm)) {
    text = `${fm.title || ''} ${(fm.tags || []).join(' ')}`;
  } else {
    const name = String(fm.name || '').replace(/-/g, ' ');
    const desc = String(fm.description || '').slice(0, CONTRADICTION_SOUL_DESC_SLICE);
    text = `${name} ${desc}`;
  }
  return tokenizeContradictionText(text);
}

/** Jaccard similarity of two token sets — 0 if either is empty. */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** ids (pathToId) this doc's `supersedes` points at — pure string mapping, no filesystem. */
const supersedesTargets = d => (d.supersedes || []).map(pathToId);
/** ids (pathToId) this doc's `superseded_by` points at — reverse pointer, same shape (Ф2). */
const supersededByTargets = d => (d.supersededBy || []).map(pathToId);

/**
 * Pairs of same-type concepts with title/tag similarity ≥ threshold, where neither supersedes
 * (or is marked superseded_by) the other — candidates for a human to resolve (merge, supersede,
 * or leave be). Deliberately simple: title/tag token Jaccard, no embeddings required.
 * Same function tools/consolidate.mjs used; recall (Э6/6.1) reuses it for tiebreak/labels.
 */
export function findContradictions(canonDocs, { threshold = CONTRADICTION_SIM } = {}) {
  const byType = new Map();
  for (const d of canonDocs) {
    const t = displayType(d.fm) || '∅';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(d);
  }
  const out = [];
  for (const [type, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const aTargets = supersedesTargets(a);
        const bTargets = supersedesTargets(b);
        if (aTargets.includes(b.id) || bTargets.includes(a.id)) continue;
        const aSB = supersededByTargets(a);
        const bSB = supersededByTargets(b);
        if (aSB.includes(b.id) || bSB.includes(a.id)) continue;
        const score = jaccard(titleTokens(a), titleTokens(b));
        if (score >= threshold) out.push({ a: a.id, b: b.id, type, score });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Banner block for `okf-query get` — printed above the raw file content. '' if nothing to flag. */
export function hygieneBanner(doc, supersededMap) {
  const lines = [];
  const by = supersededMap.get(doc.id);
  if (by && by.length) {
    lines.push(`⚠️  SUPERSEDED by ${by.map(id => `/${id}.md`).join(', ')} — kept for history, prefer the newer concept.`);
  }
  if (isDeprecated(doc)) {
    const on = doc.fm?.deprecated_on ? ` on ${String(doc.fm.deprecated_on).slice(0, 10)}` : '';
    lines.push(`⚠️  DEPRECATED${on} (via \`samemind forget\`) — kept for history, ranked low in recall.`);
  }
  return lines.join('\n');
}

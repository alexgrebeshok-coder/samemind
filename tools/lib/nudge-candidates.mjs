// nudge-candidates.mjs — pure: from work state, decide WHETHER there is anything
// worth a proactive reminder. Policy (may we speak at all?) lives elsewhere;
// this module only answers "is there content?".
//
// Key product rule for the camera-less 0.18 vision path: appropriateness of a
// line comes entirely from board + ledger + handoff. A camera would only supply
// a moment in time; the *what to say* is this function.
//
//   import { buildCandidates } from './lib/nudge-candidates.mjs';
//   const list = buildCandidates({ board, ledger, handoff, now, config });
//
// Empty list is the common, correct outcome. Never invent a reason to speak.
// Deterministic: `now` is a parameter; never calls Date.now() / Math.random().

export const DAY_MS = 86_400_000;

/** Items younger than this are still in short-term memory — skip them. */
export const DEFAULT_MIN_AGE_MS = DAY_MS;

/** Hard cap so a noisy board cannot flood the speaker. */
export const DEFAULT_MAX = 5;

/** Kind priority (lower = more appropriate). Open failures outrank blockers. */
export const KIND_RANK = Object.freeze({
  'open-failure': 0,
  blocked: 1,
  'inprog-stale': 2,
  'session-next': 3,
});

/** Looks-like-secret / sensitive free text — never put into spoken `text`. */
const SECRETISH = /(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|-----BEGIN)/i;

/**
 * @typedef {object} Candidate
 * @property {string} id         stable, deterministic
 * @property {string} kind       open-failure | blocked | inprog-stale | session-next
 * @property {string} text       one short phrase a human hears/reads
 * @property {string} why        honest reason for "why did you ask?"
 * @property {string} sourceRef  topic or doc id the human can verify
 * @property {number} age        whole days since the signal (0 = today; large = very old)
 */

/**
 * Build ranked nudge candidates from already-built models.
 *
 * @param {object} args
 * @param {object} [args.board]   result of buildBoardModel (uses .blocked, .inprog)
 * @param {object} [args.ledger]  result of summarizeLedger (uses .openFailures, .topics)
 * @param {object} [args.handoff] result of buildHandoffModel (uses .sessionNext, .lastSession)
 * @param {number|Date|string} [args.now] injectable clock (epoch ms, Date, or ISO)
 * @param {object} [args.config]  { minAgeMs?, max? }
 * @returns {Candidate[]}
 */
export function buildCandidates({ board = null, ledger = null, handoff = null, now = 0, config = null } = {}) {
  const nowMs = toMs(now);
  const minAgeMs = finiteOr(config?.minAgeMs, DEFAULT_MIN_AGE_MS);
  const max = Math.max(0, Math.floor(finiteOr(config?.max, DEFAULT_MAX)));

  const moving = topicsActiveOnDay(ledger, nowMs);
  /** @type {Candidate[]} */
  const out = [];
  /** topic/doc keys already claimed by a stronger kind */
  const claimed = new Set();

  // ── 1. Open failures (strongest signal: broken and not closed) ────────────
  for (const f of ledger?.openFailures || []) {
    const topic = normKey(f?.topic);
    if (!topic) continue;
    if (moving.has(topic)) continue; // events today → work is moving
    const ageMs = ageFromTs(f.ts, nowMs);
    if (ageMs < minAgeMs) continue;
    const title = safeLabel(topic);
    const days = daysOf(ageMs);
    const id = `fail:${topic}`;
    claim(claimed, topic);
    out.push({
      id,
      kind: 'open-failure',
      text: `Незакрытый сбой: ${title}`,
      why: `Сбой по топику «${title}» висит ${daysPhrase(days)}, закрывающего события нет`,
      sourceRef: topic,
      age: days,
    });
  }

  // ── 2. Board blockers (stuck work) ────────────────────────────────────────
  for (const d of board?.blocked || []) {
    const keys = itemKeys(d);
    if (anyKey(keys, moving) || anyKey(keys, claimed)) continue;
    const ageMs = ageFromTs(itemTs(d), nowMs);
    if (ageMs < minAgeMs) continue;
    const title = safeLabel(itemTitle(d));
    const days = daysOf(ageMs);
    const ref = itemRef(d);
    const id = `blocked:${ref}`;
    for (const k of keys) claim(claimed, k);
    claim(claimed, ref);
    out.push({
      id,
      kind: 'blocked',
      text: `Блокер: ${title}`,
      why: `На доске blocked уже ${daysPhrase(days)} — старшие блокеры уместнее свежих`,
      sourceRef: ref,
      age: days,
    });
  }

  // ── 3. Stale in-progress (claimed "in flight" but quiet) ──────────────────
  for (const d of board?.inprog || []) {
    const keys = itemKeys(d);
    if (anyKey(keys, moving) || anyKey(keys, claimed)) continue;
    const ageMs = ageFromTs(itemTs(d), nowMs);
    if (ageMs < minAgeMs) continue;
    const title = safeLabel(itemTitle(d));
    const days = daysOf(ageMs);
    const ref = itemRef(d);
    const id = `inprog:${ref}`;
    for (const k of keys) claim(claimed, k);
    claim(claimed, ref);
    out.push({
      id,
      kind: 'inprog-stale',
      text: `Без движения: ${title}`,
      why: `В in-progress ${daysPhrase(days)}, по связанному топику сегодня тишина`,
      sourceRef: ref,
      age: days,
    });
  }

  // ── 4. Session "Next" leftovers (lowest priority) ─────────────────────────
  const sessionAgeMs = ageFromTs(sessionTs(handoff?.lastSession), nowMs);
  if (sessionAgeMs >= minAgeMs) {
    const bullets = Array.isArray(handoff?.sessionNext) ? handoff.sessionNext : [];
    let i = 0;
    for (const raw of bullets) {
      const label = safeLabel(raw);
      if (!label || label === 'без названия') continue;
      if (SECRETISH.test(String(raw || ''))) continue; // drop whole bullet if it looks secret
      const id = `next:${i}:${slug(label)}`;
      i += 1;
      if (claimed.has(id)) continue;
      claim(claimed, id);
      const days = daysOf(sessionAgeMs);
      out.push({
        id,
        kind: 'session-next',
        text: `С прошлой сессии: ${label}`,
        why: `В Next прошлой сессии осталось неснятым (${daysPhrase(days)} назад)`,
        sourceRef: handoff?.lastSession?.id ? String(handoff.lastSession.id) : 'session:last',
        age: days,
      });
    }
  }

  out.sort(byAppropriateness);
  return out.slice(0, max);
}

// ── ranking ─────────────────────────────────────────────────────────────────

function byAppropriateness(a, b) {
  const kr = (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99);
  if (kr !== 0) return kr;
  // older first (age is whole days; larger = more overdue)
  if (b.age !== a.age) return b.age - a.age;
  return String(a.id).localeCompare(String(b.id));
}

// ── ledger helpers ──────────────────────────────────────────────────────────

/** Topics that saw any event on the UTC calendar day of `nowMs`. */
function topicsActiveOnDay(ledger, nowMs) {
  const day = utcDayKey(nowMs);
  const set = new Set();
  for (const t of ledger?.topics || []) {
    const topic = normKey(t?.topic);
    if (!topic) continue;
    // Prefer the full tail when present; fall back to last only.
    const evs = Array.isArray(t.evs) && t.evs.length ? t.evs : (t.last ? [t.last] : []);
    for (const e of evs) {
      const ts = parseTs(e?.ts);
      if (Number.isFinite(ts) && utcDayKey(ts) === day) {
        set.add(topic);
        break;
      }
    }
  }
  // openFailures may not be mirrored in topics if caller passed a partial ledger —
  // still treat a same-day fail/block as "moved" so we don't nag about today's crash.
  for (const f of ledger?.openFailures || []) {
    const topic = normKey(f?.topic);
    const ts = parseTs(f?.ts);
    if (topic && Number.isFinite(ts) && utcDayKey(ts) === day) set.add(topic);
  }
  return set;
}

// ── item accessors (board docs + ledger-derived cards) ──────────────────────

function itemTitle(d) {
  if (!d) return '';
  if (d.source === 'ledger') {
    return String(d.title || '').trim() || String(d.id || '').replace(/^ledger:/, '');
  }
  const t = String(d.fm?.title || '').trim();
  if (t) return t;
  return String(d.id || '').split('/').pop() || '';
}

function itemTs(d) {
  if (!d) return null;
  if (d.source === 'ledger') return d.ts ?? null;
  return d.fm?.timestamp || d.fm?.date || null;
}

function itemRef(d) {
  if (!d) return 'unknown';
  if (d.source === 'ledger') {
    return String(d.title || d.id || '').replace(/^ledger:/, '') || 'ledger';
  }
  return String(d.id || itemTitle(d) || 'doc');
}

/** Keys used to match a board card to a ledger topic / claimed set. */
function itemKeys(d) {
  const keys = new Set();
  if (!d) return keys;
  if (d.source === 'ledger') {
    const t = normKey(d.title) || normKey(String(d.id || '').replace(/^ledger:/, ''));
    if (t) keys.add(t);
    return keys;
  }
  if (d.id) {
    keys.add(normKey(d.id));
    const leaf = String(d.id).split('/').pop();
    if (leaf) keys.add(normKey(leaf));
  }
  const title = String(d.fm?.title || '').trim();
  if (title) keys.add(normKey(title));
  return keys;
}

function sessionTs(session) {
  if (!session) return null;
  return session.fm?.timestamp || session.fm?.date || null;
}

// ── text safety ─────────────────────────────────────────────────────────────

/**
 * Title/topic only — never document bodies, never action text, never secrets.
 * One short spoken-friendly label.
 */
export function safeLabel(raw, max = 72) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'без названия';
  // Strip anything secret-shaped rather than speaking it aloud.
  if (SECRETISH.test(s)) {
    s = s.replace(SECRETISH, '…').replace(/\s+/g, ' ').trim();
  }
  // Defensive: no multiline, no obvious key=value dumps.
  s = s.split(/[.\n]/)[0].trim() || s;
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s || 'без названия';
}

// ── pure utils ──────────────────────────────────────────────────────────────

function toMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string' && now) {
    const t = Date.parse(now);
    if (Number.isFinite(t)) return t;
  }
  // Missing/garbage clock → epoch. Callers should always pass `now`; we refuse
  // Date.now() so the function stays deterministic under test.
  return 0;
}

function parseTs(ts) {
  if (ts == null || ts === '') return NaN;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : NaN;
  if (ts instanceof Date) return ts.getTime();
  return Date.parse(String(ts));
}

/**
 * Age in ms. Missing timestamp → treated as very old (surface it): a blocker
 * without a date is still a blocker, and dropping it would hide real debt.
 */
function ageFromTs(ts, nowMs) {
  const t = parseTs(ts);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t);
}

function daysOf(ageMs) {
  if (!Number.isFinite(ageMs)) return 9999;
  return Math.floor(ageMs / DAY_MS);
}

// Russian plurals are keyed on the LAST digit (with the teens as an exception), not on the number
// itself: 21 день, 32 дня, 105 дней. Testing the number directly gave "32 дней" on a real nudge.
function daysPhrase(days) {
  if (days <= 0) return 'меньше дня';
  const t = days % 100;
  const d = days % 10;
  if (t < 11 || t > 14) {
    if (d === 1) return `${days} день`;
    if (d >= 2 && d <= 4) return `${days} дня`;
  }
  return `${days} дней`;
}

function utcDayKey(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normKey(s) {
  return String(s || '').trim().toLowerCase();
}

function claim(set, key) {
  const k = normKey(key);
  if (k) set.add(k);
}

/** True if any key from `keys` (Set|iterable) is present in `set`. */
function anyKey(keys, set) {
  for (const k of keys) {
    if (set.has(k)) return true;
  }
  return false;
}

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'x';
}

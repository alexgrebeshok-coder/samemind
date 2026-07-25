// fleet.mjs — fleet layer: a declared registry of the agent engines working on a bundle
// (who's in the rotation, what role they hold, how long they may go silent before that's a
// problem), plus pure heartbeat/assignment logic over it. Modeled on tools/lib/ledger.mjs
// (see docs/fleet.md "Design decisions" for exactly where this follows/diverges from that
// pattern and from the internal, single-organization dispatcher it generalizes).
//
// Storage: <root>/fleet/registry.json — one JSON object, hand- or `fleet init`-curated.
// `fleet/` is a reserved tier like inbox/secret/mirror/ledger: never walked as a graph
// concept (tools/lib/okf.mjs `walk()`).
//
// Zero dependencies beyond this package's own primitives: `lib/atomic-write.mjs` for the
// write (temp file + rename, same contract every writable tier in this package uses) and
// `tools/lib/ledger.mjs` for heartbeat input — an engine's "last seen" is its last ledger
// event, not a second parallel timestamp store.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

export const FLEET_DIR_NAME = 'fleet';
export const REGISTRY_FILE_NAME = 'registry.json';

// Validated dictionaries — invalid values are REJECTED, not silently coerced, same
// validate-not-coerce convention `tools/lib/ledger.mjs` (PHASES/STATUSES) already uses.
export const ROLES = new Set(['director', 'executor', 'reserve']);
export const STATUSES = new Set(['active', 'reserve', 'dead']);

// A silent engine is only a problem if nobody set an expectation for it. Default: a day —
// generous enough that a normal work rhythm never false-positives, short enough to still
// catch an engine that quietly dropped out of rotation.
export const DEFAULT_HEARTBEAT_SEC = 86_400;

// Generic stop-points a fleet registry starts with (`fleet init`) — the categories of action
// that should halt any multi-agent pipeline for an explicit human go-ahead, independent of
// this project's own vocabulary. See docs/fleet.md.
export const DEFAULT_STOP_POINTS = [
  'prod-deploy', 'money', 'publish', 'external-signature', 'delete', 'push-or-merge',
];

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function fleetDir(root) { return join(root, FLEET_DIR_NAME); }
export function registryFile(root) { return join(fleetDir(root), REGISTRY_FILE_NAME); }

/**
 * Builds and validates one engine entry (pure, no I/O). Throws on invalid/missing required
 * fields, same contract as ledger.mjs's `buildEvent`.
 */
export function buildEngine({
  id, role = 'executor', chain = false, heartbeatSec = DEFAULT_HEARTBEAT_SEC,
  status = 'active', zone = '',
} = {}) {
  const i = String(id ?? '').trim();
  if (!i) throw new Error('fleet: "id" is required');
  if (!ID_RE.test(i)) throw new Error(`fleet: "id" must be lowercase alnum/hyphen (got "${id}")`);
  const r = String(role ?? 'executor').trim() || 'executor';
  if (!ROLES.has(r)) throw new Error(`fleet: "role" must be one of ${[...ROLES].join('|')} (got "${role ?? ''}")`);
  const s = String(status ?? 'active').trim() || 'active';
  if (!STATUSES.has(s)) throw new Error(`fleet: "status" must be one of ${[...STATUSES].join('|')} (got "${status ?? ''}")`);
  const hb = heartbeatSec === undefined ? DEFAULT_HEARTBEAT_SEC : Number(heartbeatSec);
  if (!Number.isFinite(hb) || hb <= 0) throw new Error(`fleet: "heartbeatSec" must be a positive number (got "${heartbeatSec}")`);
  return { id: i, role: r, chain: !!chain, heartbeatSec: hb, status: s, zone: String(zone ?? '').trim() };
}

/** Builds a whole registry object (pure) — validates every engine, dedupes by id (last wins). */
export function buildRegistry({ engines = [], stopPoints = DEFAULT_STOP_POINTS } = {}) {
  const byId = new Map();
  for (const e of engines) {
    const built = buildEngine(e);
    byId.set(built.id, built);
  }
  return { version: 1, stopPoints: [...stopPoints], engines: [...byId.values()] };
}

/**
 * Reads <root>/fleet/registry.json. Missing file → null (no registry yet — `fleet init`
 * hasn't run). Corrupt/unreadable JSON → null as well, never throws — a broken registry
 * file must not crash `fleet status`/`fleet assign`, only tell the caller there's nothing
 * usable on disk (same "skip corrupt, never throw" contract as ledger.mjs's `readEvents`).
 */
export function readRegistry(root) {
  const file = registryFile(root);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.engines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomically writes a registry object built by `buildRegistry`. */
export function writeRegistry(root, registry) {
  mkdirSync(fleetDir(root), { recursive: true });
  atomicWriteFileSync(registryFile(root), JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Heartbeat (pure): for each engine, how long since its last event and whether that exceeds
 * its declared `heartbeatSec`. `events` is any array of `{ actor, ts }` records — in practice
 * `readEvents(root)` from tools/lib/ledger.mjs, injected by the caller exactly like `board.mjs`
 * injects `now` — so this stays a pure function of its arguments and never reads the ledger
 * itself. `now` (epoch ms) is injectable for the same reason.
 *
 * `reserve`/`dead` engines are never flagged overdue — silence is expected, not a fault.
 */
export function heartbeat(engines, events, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const lastSeen = new Map();
  for (const e of events || []) {
    const actor = String(e?.actor ?? '').trim();
    const ts = Date.parse(e?.ts);
    if (!actor || Number.isNaN(ts)) continue;
    if (!lastSeen.has(actor) || ts > lastSeen.get(actor)) lastSeen.set(actor, ts);
  }
  return (engines || []).map((eng) => {
    const seenMs = lastSeen.has(eng.id) ? lastSeen.get(eng.id) : null;
    const silentSec = seenMs === null ? null : Math.floor((nowMs - seenMs) / 1000);
    const expectsSilence = eng.status !== 'active';
    const overdue = !expectsSilence && (seenMs === null || silentSec > eng.heartbeatSec);
    return {
      id: eng.id, role: eng.role, status: eng.status,
      lastSeen: seenMs === null ? null : new Date(seenMs).toISOString(),
      silentSec, heartbeatSec: eng.heartbeatSec, overdue,
    };
  });
}

/**
 * Builds and validates one assignment (pure, no I/O) — the naryad-contract shape: which
 * engine, what topic/goal, how it will be verified, and the stop-points that halt it before
 * it needs to ask. Throws on missing required fields; `assign` (CLI) turns the result into a
 * ledger `start` event rather than inventing a second storage format (see docs/fleet.md).
 */
export function buildAssignment({ engine, topic, goal, boundaries, verify, stopPoints } = {}) {
  const e = String(engine ?? '').trim();
  if (!e) throw new Error('fleet: "engine" is required');
  const t = String(topic ?? '').trim();
  if (!t) throw new Error('fleet: "topic" is required');
  const g = String(goal ?? '').trim();
  if (!g) throw new Error('fleet: "goal" is required');
  const v = String(verify ?? '').trim();
  if (!v) throw new Error('fleet: "verify" is required — an assignment without a verification step is a wish, not a task');
  const b = Array.isArray(boundaries) ? boundaries.map(String) : (boundaries ? [String(boundaries)] : []);
  const sp = Array.isArray(stopPoints) ? stopPoints.map(String) : (stopPoints ? [String(stopPoints)] : [...DEFAULT_STOP_POINTS]);
  return { engine: e, topic: t, goal: g, boundaries: b, verify: v, stopPoints: sp };
}

/** Finds one engine by id in a registry's engine list, or null. */
export function findEngine(registry, id) {
  return (registry?.engines || []).find((e) => e.id === id) || null;
}

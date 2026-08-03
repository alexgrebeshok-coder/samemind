// health.mjs — external heartbeat for `samemind project` runs. Every projection run (success
// and failure alike, see tools/project.mjs) writes <root>/.samemind/health.json; `samemind
// status` (tools/status.mjs) and any external watchdog read it to answer "is memory projection
// alive" without parsing logs. External-heartbeat pattern: liveness is judged by how stale the
// last-write timestamp is, not by pinging a running process — there is none between runs.
//
// On *state change* only (ok→fail or fail→ok, including the first observation), the same fact
// is also appended to the event ledger under topic HEALTH_TOPIC / actor HEALTH_ACTOR. That gives
// `summarizeLedger` a real open-failure signal for "days of dogfood without an open own failure"
// — health.json alone only remembers the last run and cannot answer that. Steady-state repeats
// (ok→ok, fail→fail) do not write ledger events: the board is append-only and must not be
// flooded by a 30-minute service cadence.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { appendEvent } from './ledger.mjs';

export const SCHEMA_VERSION = 1;
/** Ledger topic for product self-health transitions (projection ok/fail). Stable id for dogfood. */
export const HEALTH_TOPIC = 'samemind-health';
/** Actor id for those events — also the product's fleet-registry engine id. */
export const HEALTH_ACTOR = 'samemind';

const healthFile = root => join(root, '.samemind', 'health.json');

/**
 * When the new outcome differs from the previous health.json (or there was none), append one
 * ledger event so open-failure tracking and `samemind dogfood` have a history. Same-state
 * repeats are silent. Ledger write is best-effort: a failure here must never undo the health
 * file write or fail the projection run (same secondary-side-effect contract as health itself).
 */
function maybeAppendHealthLedger(root, previous, record) {
  if (previous != null && previous.ok === record.ok) return null;
  const ok = !!record.ok;
  const phase = ok ? 'done' : 'fail';
  const status = ok ? 'ok' : 'fail';
  const action = ok
    ? (previous && previous.ok === false ? 'projection recovered' : 'projection ok')
    : (record.lastError || 'projection failed');
  // ref ties this transition to this exact health stamp so a retried write with the same ts
  // does not double-append (appendEvent's ref dedup under the file lock).
  const ref = `${HEALTH_TOPIC}:${ok ? 'ok' : 'fail'}:${record.ts}`;
  return appendEvent(root, {
    actor: HEALTH_ACTOR,
    topic: HEALTH_TOPIC,
    phase,
    status,
    action,
    ref,
    ts: record.ts,
  });
}

/**
 * Atomically writes the outcome of one projection run. `targets` — engine ids actually written
 * this run (empty on failure before any target was reached); `version` — samemind's
 * package.json version at run time. atomicWriteFileSync already mkdir -p's `.samemind/` (via
 * dirname(targetPath)), so there is no separate mkdir here.
 *
 * Also, on state change only, appends a ledger event (see maybeAppendHealthLedger). Returns the
 * health record (ledger outcome is intentional not part of the return — callers care about health).
 */
export function writeHealth(root, { ok, lastError = null, targets = [], version = null } = {}) {
  const previous = readHealth(root);
  const record = {
    ts: new Date().toISOString(),
    ok,
    lastError,
    targets,
    version,
    schema_version: SCHEMA_VERSION,
  };
  atomicWriteFileSync(healthFile(root), `${JSON.stringify(record, null, 2)}\n`);
  try {
    maybeAppendHealthLedger(root, previous, record);
  } catch {
    // non-fatal — health file already written; dogfood stays unmeasurable until a later transition
  }
  return record;
}

/**
 * Missing file or unparsable JSON → null, never throws (same contract as projection-config's
 * internal readJson). Forward-compatible by construction: this returns whatever fields the file
 * has — an older or newer schema_version's extra/missing fields never crash a read, they just
 * come along as-is (or absent) on the returned object.
 */
export function readHealth(root) {
  const path = healthFile(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Pure liveness assessment (no fs). No health record, or one with an unparsable `ts` → 'unknown'
 * (ageSec: null). Otherwise ageSec = (now - ts)/1000; within 2× the expected interval → 'ok',
 * staler → 'stale'. `now` defaults to Date.now() but is always injectable so callers (and tests)
 * get a deterministic age.
 */
export function assessLiveness(health, { intervalSec, now = Date.now() } = {}) {
  const parsedTs = health && Date.parse(health.ts);
  if (!health || !Number.isFinite(parsedTs)) return { state: 'unknown', ageSec: null };
  const ageSec = (now - parsedTs) / 1000;
  return { state: ageSec <= intervalSec * 2 ? 'ok' : 'stale', ageSec };
}

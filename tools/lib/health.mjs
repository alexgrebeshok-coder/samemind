// health.mjs — external heartbeat for `samemind project` runs. Every projection run (success
// and failure alike, see tools/project.mjs) writes <root>/.samemind/health.json; `samemind
// status` (tools/status.mjs) and any external watchdog read it to answer "is memory projection
// alive" without parsing logs. External-heartbeat pattern: liveness is judged by how stale the
// last-write timestamp is, not by pinging a running process — there is none between runs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

export const SCHEMA_VERSION = 1;
const healthFile = root => join(root, '.samemind', 'health.json');

/**
 * Atomically writes the outcome of one projection run. `targets` — engine ids actually written
 * this run (empty on failure before any target was reached); `version` — samemind's
 * package.json version at run time. atomicWriteFileSync already mkdir -p's `.samemind/` (via
 * dirname(targetPath)), so there is no separate mkdir here.
 */
export function writeHealth(root, { ok, lastError = null, targets = [], version = null } = {}) {
  const record = {
    ts: new Date().toISOString(),
    ok,
    lastError,
    targets,
    version,
    schema_version: SCHEMA_VERSION,
  };
  atomicWriteFileSync(healthFile(root), `${JSON.stringify(record, null, 2)}\n`);
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

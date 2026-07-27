// projection-config.mjs — read/normalize/migrate the `projection` section of samemind's
// existing config.json (same file setup.mjs already writes embedUrl/embedModel into — see
// applyEmbedProbe there and resolveEmbedConfig in tools/lib/recall.mjs, whose project-overrides-
// global precedence this mirrors). No new file, no network — pure fs read plus an idempotent
// forward migration.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

const SCHEMA_VERSION = 1;
const VALID_FACT_SOURCES = new Set(['canon', 'bundle']);

const DEFAULTS = Object.freeze({
  budgetTokens: 1500,
  factSource: 'canon',
  coreFresh: 12,
  indexTail: true,
  intervalSec: 1800,   // single source of truth for the projection cadence: status's liveness
                       // window (2× this) and serviced's backstop period both read cfg.intervalSec.
  targets: [],
});

const configPath = dir => join(dir, '.samemind', 'config.json');

/** Missing/malformed file → null (never throws) — same shape as okf's read helpers. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Forward-migrates one config.json in place: stamps `schema_version` and adds a default
 * `projection` section (only if the file doesn't already have one), preserving every other key
 * (embedUrl, embedModel, …) untouched. No-op — no write at all — when the file is missing,
 * unreadable, or already at/above SCHEMA_VERSION, which is what makes repeat calls idempotent.
 *
 * Exported so callers that own a write (the CLI, setup.mjs) can migrate explicitly. Never called
 * from readProjectionConfig — a read must never mutate a shared file (see there for why).
 */
export function migrateProjectionConfig(dir) {
  const path = configPath(dir);
  const cfg = readJson(path);
  if (!cfg) return;
  const version = typeof cfg.schema_version === 'number' ? cfg.schema_version : 0;
  if (version >= SCHEMA_VERSION) return;
  const migrated = {
    ...cfg,
    schema_version: SCHEMA_VERSION,
    projection: cfg.projection || { ...DEFAULTS },
  };
  atomicWriteFileSync(path, `${JSON.stringify(migrated, null, 2)}\n`);
}

/** Unknown/garbage factSource shouldn't hard-crash a read of a hand-edited config.json — falls
 *  back to the default and says why on stderr. */
function normalizeFactSource(value, root) {
  if (value === undefined || VALID_FACT_SOURCES.has(value)) return value ?? DEFAULTS.factSource;
  console.warn(`projection-config: invalid factSource "${value}" in ${root}/.samemind/config.json — falling back to "${DEFAULTS.factSource}"`);
  return DEFAULTS.factSource;
}

/** targets[].excludeSource inherits the section's top-level excludeSource when not set per-target. */
function normalizeTargets(rawTargets, topExcludeSource) {
  if (!Array.isArray(rawTargets)) return [];
  return rawTargets.map(t => ({
    engine: String(t?.engine ?? ''),
    excludeSource: t?.excludeSource !== undefined ? t.excludeSource : topExcludeSource,
  }));
}

/**
 * Reads and normalizes the `projection` config section, merging `<globalHome>/.samemind/
 * config.json` (base) under `<root>/.samemind/config.json` (override) — same precedence as
 * resolveEmbedConfig. Pure read: applies defaults/merge in memory, never writes — works fine
 * against a not-yet-migrated file (no schema_version/projection at all) with no prior call to
 * migrateProjectionConfig required. A read must never mutate `~/.samemind/config.json` — it's a
 * shared machine-wide file; some other caller's plain read silently rewriting it would be a nasty
 * surprise (e.g. a `project --dry-run` or an unrelated module's test). Migration is a deliberate,
 * separate write — see migrateProjectionConfig, called explicitly by the CLI/setup, not from here.
 *
 * Returns `{ budgetTokens, factSource, coreFresh, indexTail, intervalSec, targets: [{engine, excludeSource}] }`.
 * Missing section/file at either tier → documented defaults (budgetTokens=1500, factSource=
 * 'canon', coreFresh=12, indexTail=true, intervalSec=1800, targets=[]). `globalHome` defaults to $HOME — pass a
 * tmp dir (or a falsy value to skip the global tier) from tests so real ~/.samemind is never touched.
 */
export function readProjectionConfig(root, globalHome = process.env.HOME) {
  const globalProj = (globalHome && readJson(configPath(globalHome))?.projection) || {};
  const projectProj = readJson(configPath(root))?.projection || {};
  const merged = { ...DEFAULTS, ...globalProj, ...projectProj };

  return {
    budgetTokens: Number.isFinite(merged.budgetTokens) ? merged.budgetTokens : DEFAULTS.budgetTokens,
    factSource: normalizeFactSource(merged.factSource, root),
    coreFresh: Number.isFinite(merged.coreFresh) ? merged.coreFresh : DEFAULTS.coreFresh,
    indexTail: !!merged.indexTail,
    intervalSec: Number.isFinite(merged.intervalSec) && merged.intervalSec > 0 ? merged.intervalSec : DEFAULTS.intervalSec,
    targets: normalizeTargets(merged.targets, merged.excludeSource),
  };
}

#!/usr/bin/env node
// project.mjs — samemind project: project a curated FACT block into an engine's own instruction
// file, between <!-- samemind:project:start/end --> markers. The identity layer (Identity / User /
// EngineRule) is NOT this command's concern — that's `samemind brief`/`install`; project carries
// the *facts* (concepts, decisions, plans, sessions, …) so an engine sees recent memory from the
// first token without a retrieval round-trip.
//
//   node tools/project.mjs --engine <id> [--dry-run]        one ad-hoc target, ignoring config targets
//   node tools/project.mjs                                   every projection.targets in .samemind/config.json
//   node tools/project.mjs --engine <id> --file <path>       generic target for an engine outside ENGINE_FILES
//   Flags: --root <dir> (default OKF_ROOT/cwd) · --budget <n> · --core-fresh <n> · --source canon|bundle
//          --max-fact-chars <n> · --max-block-chars <n> (each overrides config) · --dry-run (print, write nothing).
//
// --budget (tokens) derives ONE char count used for both the per-fact clamp and the per-block cap
// — a convenience default. --max-fact-chars / --max-block-chars split them, matching how the
// production memory-bridge (~/.claude/memory-bridge/sync.mjs) actually limits: MAX_FACT_CHARS=6000
// (per fact) and MAX_BLOCK_CHARS=60000 (per block) are independent constants there, not one budget.
// Pass both explicitly to reproduce that split (e.g. for a bridge-vs-product parity comparison).
//
// Ranking of the projected facts is decided HERE (not in lib/project.mjs, which is pure render):
//   factSource=canon  → freshness: valid_from/timestamp desc, then id (deterministic).
//   factSource=bundle → hygiene score desc (buildSupersededMap → hygieneMultiplier: superseded/
//                        deprecated sink, importance/heat/decay weigh in), ties by freshness then id.
// Anti-echo: a fact whose `source` is the target engine's excludeSource is dropped — an engine
// never gets its own writes projected back at it.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, displayTitle, displayType } from './lib/okf.mjs';
import { sourceMatches } from './lib/recall.mjs';
import { buildSupersededMap, hygieneMultiplier, docRecencyMs } from './lib/hygiene.mjs';
import { renderFactEntries, truncateBlock } from './lib/project.mjs';
import { readProjectionConfig, migrateProjectionConfig } from './lib/projection-config.mjs';
import { ENGINE_FILES } from './install.mjs';
import { injectBetweenMarkers } from './lib/inject.mjs';
import { withFileLock } from '../lib/file-lock.mjs';
import { writeHealth } from './lib/health.mjs';

// version stamped into .samemind/health.json — read once at load time, same pattern as
// tools/lib/mcp.mjs's SERVER_VERSION.
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
})();

export const PROJECT_START = '<!-- samemind:project:start -->';
export const PROJECT_END = '<!-- samemind:project:end -->';
export const DEFAULT_BUDGET_TOKENS = 1500;
const CHARS_PER_TOKEN = 4; // same convention as brief.mjs (~1500 tokens ≈ 6000 chars)

// Identity layer — carried by brief/install, never by project (case-insensitive on displayType).
const IDENTITY_TYPES = new Set(['identity', 'user', 'enginerule']);

/** canon: freshest first (valid_from/timestamp desc), nulls last, id as deterministic tiebreak. */
function rankCanon(docs) {
  return docs.slice().sort((a, b) => {
    const ra = docRecencyMs(a);
    const rb = docRecencyMs(b);
    if ((ra == null) !== (rb == null)) return ra == null ? 1 : -1;
    if (ra != null && ra !== rb) return rb - ra;
    return a.id.localeCompare(b.id);
  });
}

/** bundle: hygiene score desc (superseded/deprecated demoted, importance/heat/decay applied),
 *  ties fall through to freshness then id. */
function rankBundle(docs, now) {
  const supersededMap = buildSupersededMap(docs);
  return docs.slice().sort((a, b) => {
    const ma = hygieneMultiplier(a, supersededMap, { now });
    const mb = hygieneMultiplier(b, supersededMap, { now });
    if (ma !== mb) return mb - ma;
    const ra = docRecencyMs(a);
    const rb = docRecencyMs(b);
    if ((ra == null) !== (rb == null)) return ra == null ? 1 : -1;
    if (ra != null && ra !== rb) return rb - ra;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Build the marker-wrapped fact block for one target from pre-loaded docs. Pure (no fs/process):
 * the caller loads docs and passes the target's excludeSource. Returns { block, count, truncated }.
 * docs: as from lib/okf.mjs load({ includeSecret:false }, root).
 */
export function buildProjectBlock(docs, {
  factSource = 'canon',
  excludeSource = null,
  budgetTokens = DEFAULT_BUDGET_TOKENS,
  maxFactChars = null,
  maxBlockChars = null,
  coreFresh = 12,
  indexTail = true,
  now = Date.now(),
} = {}) {
  const facts = docs
    .filter(d => !d.reserved)
    .filter(d => !IDENTITY_TYPES.has(String(displayType(d.fm)).toLowerCase()))
    .filter(d => !sourceMatches(d, excludeSource));

  const ranked = factSource === 'bundle' ? rankBundle(facts, now) : rankCanon(facts);

  // budgetTokens is the back-compat convenience: absent an explicit maxFactChars/maxBlockChars it
  // derives ONE char count used for both. Passing the two explicitly (see file header) decouples
  // them, matching the production bridge's independent MAX_FACT_CHARS/MAX_BLOCK_CHARS constants.
  const budgetChars = Math.max(1, Math.floor(budgetTokens * CHARS_PER_TOKEN));
  const factChars = Number.isFinite(maxFactChars) ? maxFactChars : budgetChars;
  const blockChars = Number.isFinite(maxBlockChars) ? maxBlockChars : budgetChars;
  const entries = ranked.map(d => ({
    name: displayTitle(d.fm) || d.id,
    desc: d.fm.description || '',
    body: d.body || '',
  }));

  const body = renderFactEntries(entries, { coreFresh, indexTail, maxFactChars: factChars });
  const raw = `${PROJECT_START}\n${body}\n${PROJECT_END}`;
  const { text, truncated } = truncateBlock(raw, { maxChars: blockChars, endMark: PROJECT_END });
  return { block: text, count: entries.length, truncated };
}

/** Files an engine's projected block is written into. Known engine → its ENGINE_FILES list; an
 *  engine outside the table needs --file (generic), else a loud error naming the known engines. */
function targetFilesFor(engine, file) {
  const meta = ENGINE_FILES[engine];
  if (meta) return meta.files;
  if (file) return [file];
  throw new Error(`unknown engine "${engine}" — known: ${Object.keys(ENGINE_FILES).join(', ')}; or pass --file <path> for a generic target`);
}

function parseArgs(argv) {
  const out = {
    root: null, engine: null, file: null, budget: null, coreFresh: null, source: null,
    maxFactChars: null, maxBlockChars: null, dryRun: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--engine') out.engine = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--core-fresh') out.coreFresh = Number(argv[++i]);
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--max-fact-chars') out.maxFactChars = Number(argv[++i]);
    else if (a === '--max-block-chars') out.maxBlockChars = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag "${a}" — see: samemind project --help`);
  }
  return out;
}

function usage() {
  console.log('samemind project — project curated FACTS into an engine instruction file (between samemind:project markers)');
  console.log('');
  console.log('  samemind project --engine <id> [--dry-run]   one ad-hoc target (ignores config targets)');
  console.log('  samemind project                             all projection.targets from .samemind/config.json');
  console.log('');
  console.log('Flags: --root <dir> (default OKF_ROOT/cwd) · --engine <id> · --file <path> (generic, engine outside the table)');
  console.log('       --budget <n> · --core-fresh <n> · --source canon|bundle (override config) · --dry-run (print, write nothing)');
  console.log('       --max-fact-chars <n> · --max-block-chars <n> — split per-fact/per-block char caps (override --budget for that side)');
  console.log(`Known engines: ${Object.keys(ENGINE_FILES).join(', ')}`);
}

/** Health is a secondary side-effect of a run — a write failure here must never fail the run
 *  itself (see tools/lib/health.mjs). */
function writeHealthSafe(root, fields) {
  try {
    writeHealth(root, { ...fields, version: PKG_VERSION });
  } catch (e) {
    console.warn(`project: health write failed (non-fatal): ${e.message}`);
  }
}

/** Throws on any error (loud-fail — no silent catch); the top-level handler turns it into a
 *  non-zero exit with one actionable stderr line. Returns 0 on success.
 *
 *  Every real (non-dry-run) run — success or failure — records its outcome to .samemind/
 *  health.json (writeHealthSafe) so `samemind status` can tell "is memory projection alive"
 *  without parsing logs. --dry-run never writes health: it's not a real run. */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }

  if (args.source && args.source !== 'canon' && args.source !== 'bundle') {
    throw new Error(`--source must be canon|bundle, got "${args.source}"`);
  }

  const root = resolve(args.root || process.env.OKF_ROOT || process.cwd());
  if (!existsSync(root)) throw new Error(`root not found: ${root} (pass --root <dir> or set OKF_ROOT)`);

  try {
    const cfg = readProjectionConfig(root);
    const factSource = args.source || cfg.factSource;
    const budgetTokens = Number.isFinite(args.budget) ? args.budget : cfg.budgetTokens;
    const coreFresh = Number.isFinite(args.coreFresh) ? args.coreFresh : cfg.coreFresh;
    const indexTail = cfg.indexTail;
    const maxFactChars = Number.isFinite(args.maxFactChars) ? args.maxFactChars : cfg.maxFactChars;
    const maxBlockChars = Number.isFinite(args.maxBlockChars) ? args.maxBlockChars : cfg.maxBlockChars;

    // Ad-hoc --engine wins over config targets; its anti-echo source defaults to the engine id
    // (an engine's own writes carry source=<engine>). Config targets carry their own excludeSource.
    const targets = args.engine
      ? [{ engine: args.engine, excludeSource: args.engine }]
      : cfg.targets;
    if (!targets.length) {
      throw new Error('no target: pass --engine <id>, or add projection.targets to .samemind/config.json');
    }

    // Validate every target engine up front (loud-fail before touching disk). --file only applies
    // to a single ad-hoc --engine target, not to config-declared ones.
    const plan = targets.map(t => ({ ...t, files: targetFilesFor(t.engine, args.engine ? args.file : null) }));

    const docs = load({ includeSecret: false }, root);

    if (args.dryRun) {
      for (const t of plan) {
        const { block } = buildProjectBlock(docs, { factSource, excludeSource: t.excludeSource, budgetTokens, maxFactChars, maxBlockChars, coreFresh, indexTail });
        if (plan.length > 1) console.log(`# --- ${t.engine} ---`);
        console.log(block);
      }
      return 0; // dry-run: no health write, not a real run
    }

    // Write path: stamp config schema (idempotent no-op if already migrated / no config file) — the
    // one place a projection run writes the config. Skipped on --dry-run so dry-run writes nothing.
    migrateProjectionConfig(root);

    for (const t of plan) {
      const { block, count, truncated } = buildProjectBlock(docs, { factSource, excludeSource: t.excludeSource, budgetTokens, maxFactChars, maxBlockChars, coreFresh, indexTail });
      for (const rel of t.files) {
        const abs = resolve(root, rel);
        mkdirSync(dirname(abs), { recursive: true }); // lockdir mkdir is non-recursive — parent must exist
        const res = withFileLock(abs, () => injectBetweenMarkers(abs, block, PROJECT_START, PROJECT_END));
        const verb = res.replaced ? 'updated' : res.created ? 'created' : 'appended';
        console.log(`✓ ${t.engine} ${verb} ${rel} (${count} fact${count === 1 ? '' : 's'}${truncated ? ', truncated' : ''})`);
      }
    }
    writeHealthSafe(root, { ok: true, targets: plan.map(t => t.engine) });
    return 0;
  } catch (e) {
    if (!args.dryRun) writeHealthSafe(root, { ok: false, lastError: e.message });
    throw e;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`project: ${e.message}`);
    process.exit(1);
  }
}

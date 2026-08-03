#!/usr/bin/env node
// nudge.mjs — proactive nudge CLI: the trigger surface + the human-response loop.
//
//   samemind nudge [--zone <name>] [--json] [--dry-run]
//   samemind nudge respond --outcome accepted|deferred|dismissed|muted [--zone <name>] [--ref <id>]
//
// Architecture: the trigger source is pluggable. Today the only source is "the CLI itself was
// invoked" (and a schedule caller — cron/launchd — can fire the same command). A camera will
// become a second trigger later and must not require rewriting anything downstream. Therefore
// nothing in this file or its callers says "camera" or "schedule" — it says "trigger".
//
// This module is the wiring layer. The three substantive pieces live in parallel modules:
//   - tools/lib/nudge-candidates.mjs (наряд B) — picks what to say, if anything
//   - tools/lib/nudge-policy.mjs     (наряд A) — decides whether speaking is allowed right now
//   - tools/lib/nudge-state.mjs      (наряд A) — cooldowns / daily counters / recordOutcome
//
// We import them lazily behind a thin adapter (loadNudgeCoreAsync) so that:
//   1. a missing module is one predictable error at the boundary, not a crash on import;
//   2. integration is a single line per function once A/B land — swap the adapter body;
//   3. the CLI/HTTP surfaces above this layer compile and test independently.
import { fileURLToPath } from 'node:url';
import { appendEvent } from './lib/ledger.mjs';

const ACTOR = 'samemind';
const VALID_OUTCOMES = new Set(['accepted', 'deferred', 'dismissed', 'muted']);

// ──────────────────────────── thin adapter to A/B modules ────────────────────────────
//
// Expected signatures (contract between this module and наряды A/B):
//
//   collectCandidates(root, { zone, now }) → Candidate[] | []
//     Candidate: { id: string, why: string, consequenceIfAccepted: string, zone: string }
//     (id is opaque to this layer — a short slug the candidate source mints.)
//
//   shouldSpeak(root, { zone, now, candidateCount }) → Decision
//     Decision: { allowed: boolean, reasonCode: string }
//     reasonCode is present on BOTH paths: on allow it names which gate passed
//     (e.g. "ok"), on deny it names the gate that blocked (e.g. "cooldown",
//     "daily-cap", "quiet-hours", "no-candidates").
//
//   recordOutcome(root, { outcome, zone, now, ref }) → { ok: boolean, deduped?: boolean }
//     outcome ∈ accepted|deferred|dismissed|muted. Side effects: advance cooldown /
//     bump counter / set mute. Idempotent on `ref` when provided (a second call with
//     the same ref is a no-op, mirrors ledger dedup).
//
// Until A/B exist the adapter resolves to nulls for missing modules, so the boundary is
// explicit: buildNudgeModel degrades to "no candidates → silent" rather than crashing on import.

/**
 * Loads candidates, asks the policy, returns the nudge model — the single function both the
 * CLI and HTTP route call. `dryRun` controls whether recordOutcome / cooldown side effects
 * fire: a dry run computes the same decision but mutates nothing.
 *
 * The returned model is the `data` payload (no envelope here — the caller wraps it):
 *   {
 *     zone, spoken: boolean, reasonCode: string,
 *     candidate: Candidate | null,          // the one we'd say (or null if silent)
 *     dryRun: boolean, trigger: 'manual',   // trigger names the source; 'manual' today
 *   }
 */
export async function buildNudgeModel(root, { zone = 'default', dryRun = false, now = Date.now() } = {}) {
  const core = await loadNudgeCoreAsync();

  const candidates = core.collectCandidates
    ? await core.collectCandidates(root, { zone, now })
    : [];

  const decision = core.shouldSpeak
    ? await core.shouldSpeak(root, { zone, now, candidateCount: candidates.length })
    : { allowed: candidates.length > 0, reasonCode: candidates.length > 0 ? 'ok' : 'no-candidates' };

  const spoken = decision.allowed && candidates.length > 0;
  const candidate = spoken ? candidates[0] : null;

  return {
    zone,
    spoken,
    reasonCode: decision.reasonCode ?? (spoken ? 'ok' : 'silent'),
    candidate,
    dryRun: !!dryRun,
    trigger: 'manual',
  };
}

/** Resolves the three modules into a flat object of callables, or an object with nulls if any
 *  module is absent. Exposed for tests so they can stub the boundary. */
export async function loadNudgeCoreAsync() {
  const results = {};
  const specs = {
    policyMod: './lib/nudge-policy.mjs',
    stateMod: './lib/nudge-state.mjs',
    candMod: './lib/nudge-candidates.mjs',
  };
  for (const [key, spec] of Object.entries(specs)) {
    try {
      results[key] = await import(spec);
    } catch {
      results[key] = null;
    }
  }
  // Flatten to the expected callable names (tolerant of default vs named exports).
  return {
    shouldSpeak: results.policyMod?.shouldSpeak ?? results.policyMod?.default?.shouldSpeak ?? null,
    collectCandidates: results.candMod?.collectCandidates ?? results.candMod?.default?.collectCandidates ?? null,
    recordOutcome: results.stateMod?.recordOutcome ?? results.stateMod?.default?.recordOutcome ?? null,
  };
}

/**
 * Records the human's response to a nudge. Calls recordOutcome from наряд A, then writes a
 * `note` to the ledger (topic `nudge`) so "why did I ask" and "what did the human answer" are
 * recoverable together. Idempotent via `ref`: a second call with the same ref skips both the
 * state update and the ledger line.
 *
 * Returns { ok, deduped }.
 */
export async function recordNudgeResponse(root, { outcome, zone = 'default', ref = null, now = Date.now() } = {}) {
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(`invalid outcome "${outcome}"; expected one of ${[...VALID_OUTCOMES].join('|')}`);
  }

  const core = await loadNudgeCoreAsync();
  let stateResult = { ok: true };

  if (core.recordOutcome) {
    stateResult = await core.recordOutcome(root, { outcome, zone, now, ref });
    // recordOutcome does its own dedup on ref; if it says deduped, we mirror that and skip
    // the ledger line too — one response, one trace.
    if (stateResult.deduped) return { ok: true, deduped: true };
  }

  // Ledger trace: a `note`-phase event on topic `nudge`. The ref is the idempotency key —
  // appendEvent already deduplicates on ref, so even without stateMod this stays honest.
  const ev = appendEvent(root, {
    actor: ACTOR,
    topic: 'nudge',
    phase: 'note',
    status: 'ok',
    action: `respond ${outcome} zone=${zone}`,
    ref: ref || undefined,
  });

  return { ok: true, deduped: !!ev?.deduped };
}

// ──────────────────────────────────── CLI ────────────────────────────────────────────

function rootFor(args) {
  return args.root || process.env.OKF_ROOT || process.cwd();
}

export function parseArgs(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;
  const a = { subcommand: null, root: null, zone: 'default', json: false, dryRun: false, outcome: null, ref: null };

  if (sub === 'respond') {
    a.subcommand = 'respond';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--zone' && rest[i + 1]) { a.zone = rest[++i]; }
      else if (rest[i] === '--outcome' && rest[i + 1]) { a.outcome = rest[++i]; }
      else if (rest[i] === '--ref' && rest[i + 1]) { a.ref = rest[++i]; }
      else if (rest[i] === '--root' && rest[i + 1]) { a.root = rest[++i]; }
      else if (rest[i] === '--json') { a.json = true; }
    }
    return a;
  }

  // Top-level `nudge` — `sub` is an option or undefined.
  const opts = sub ? [sub, ...rest] : rest;
  a.subcommand = 'nudge';
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--zone' && opts[i + 1]) { a.zone = opts[++i]; }
    else if (opts[i] === '--json') { a.json = true; }
    else if (opts[i] === '--dry-run') { a.dryRun = true; }
    else if (opts[i] === '--root' && opts[i + 1]) { a.root = opts[++i]; }
  }
  return a;
}

function wrap(kind, data) {
  return { contract: 1, kind, generatedAt: new Date().toISOString(), data };
}

function printHuman(model) {
  if (model.spoken && model.candidate) {
    const c = model.candidate;
    console.log(`→ ${c.why}`);
    if (c.consequenceIfAccepted) console.log(`  Если согласишься: ${c.consequenceIfAccepted}`);
    if (model.dryRun) console.log('  (dry-run — состояние не изменено)');
    return;
  }
  // Silent: say WHY — the reason code from the policy.
  console.log(`∅ Промолчал (${model.reasonCode}).`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.subcommand === 'respond') {
    if (!args.outcome || !VALID_OUTCOMES.has(args.outcome)) {
      console.error(`Usage: samemind nudge respond --outcome accepted|deferred|dismissed|muted [--zone <name>] [--ref <id>]`);
      return 1;
    }
    const result = await recordNudgeResponse(rootFor(args), {
      outcome: args.outcome, zone: args.zone, ref: args.ref,
    });
    if (args.json) {
      console.log(JSON.stringify(wrap('nudge-response', result)));
    } else {
      console.log(result.deduped ? 'ok (уже был записан)' : 'ok');
    }
    return 0;
  }

  // `nudge`
  const model = await buildNudgeModel(rootFor(args), { zone: args.zone, dryRun: args.dryRun });
  if (args.json) {
    console.log(JSON.stringify(wrap('nudge', model)));
  } else {
    printHuman(model);
  }
  return 0;
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; }
})();
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('Error:', e.message); process.exit(1); });
}

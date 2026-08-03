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
//   - tools/lib/nudge-candidates.mjs — picks what to say, if anything
//   - tools/lib/nudge-policy.mjs     — decides whether speaking is allowed right now
//   - tools/lib/nudge-state.mjs      — cooldowns / daily counters / recordOutcome
//
// These are STATIC imports on purpose. They were briefly resolved through a lazy adapter that
// fell back to "speak if there are candidates" when a module was missing — and after the three
// parallel branches merged, the modules were all present while the adapter still resolved to
// null, because it looked for names nobody exported. The result was a proactive layer that spoke
// with the entire policy bypassed: no quiet hours, no cooldown, no daily cap, and every surface
// reporting success. A static import turns that class of mistake into an unmissable load error.
import { fileURLToPath } from 'node:url';
import { appendEvent, readEvents, summarizeLedger } from './lib/ledger.mjs';
import { load } from './lib/okf.mjs';
import { buildBoardModel } from './board.mjs';
import { buildHandoffModel } from './handoff.mjs';
import { readFeatureConfig } from './lib/feature-config.mjs';
import { buildCandidates } from './lib/nudge-candidates.mjs';
import { decideNudge, REASONS } from './lib/nudge-policy.mjs';
import { readNudgeState, recordOutcome } from './lib/nudge-state.mjs';

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
  const docs = load({ includeSecret: false }, root);
  const events = readEvents(root);
  const { openFailures, topics } = summarizeLedger(events);
  const board = buildBoardModel(docs, { now, openFailures, ledgerTopics: topics });
  const handoff = buildHandoffModel(docs, { now: new Date(now) }); // handoff takes a Date, board takes epoch ms

  const candidates = buildCandidates({ board, ledger: { openFailures, topics, events }, handoff, now });
  const config = readFeatureConfig(root);
  const decision = decideNudge({
    now,
    trigger: { source: 'manual', zone },
    candidates,
    config,
    state: readNudgeState(root),
  });

  // A live run must record the delivery, or the cooldown and the daily cap never engage: they
  // count `delivered` outcomes, and nothing else writes one. Dry runs (the dashboard card polls
  // constantly) compute the identical decision and mutate nothing — that is the whole difference.
  if (!dryRun && decision.deliver) {
    recordOutcome(root, {
      zone: decision.zone,
      outcome: 'delivered',
      at: now,
      candidateId: decision.candidate?.id ?? null,
    });
  }

  return {
    // `decision.zone` is null on silence; the model still reports the zone that was ASKED about,
    // because the card says "quiet in the kitchen", not "quiet in null".
    zone: decision.zone ?? zone,
    spoken: decision.deliver,
    reasonCode: decision.reason,
    candidate: decision.candidate,
    // Why the policy said no, in the candidate's own words — this is what the "почему спросил" /
    // "почему молчишь" button renders. Without it the UI would have to re-derive the reason and
    // we would be back to two copies of one policy, which is how the voice panel went wrong.
    nextAllowedAt: decision.nextAllowedAt,
    dryRun: !!dryRun,
    trigger: 'manual',
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

  // `at`, not `now`: the state module keys every window off `at`, and an outcome written with an
  // undefined timestamp is invisible to both the cooldown ("не сейчас" would do nothing) and the
  // daily cap. Same class as the two mismatches above — parallel authors, unstated field names.
  //
  // `muted` deliberately carries NO zone. The policy reads a zone-scoped mute as a room pause that
  // lasts until someone unmutes it, and a zone-less one as "enough for today", expiring at local
  // midnight. The card's button says "хватит на сегодня" — recording it with a zone would silence
  // the assistant permanently behind a label promising one evening. There are no rooms to pause in
  // a camera-less build anyway; room mutes become reachable when a camera introduces real zones.
  const scoped = outcome === 'muted' ? { outcome, at: now } : { zone, outcome, at: now };
  recordOutcome(root, { ...scoped, reason: ref || undefined });

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
    console.log(`→ ${c.text}`);            // what would be said
    if (c.why) console.log(`  почему: ${c.why}`);  // the "почему спросил" answer, already human
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

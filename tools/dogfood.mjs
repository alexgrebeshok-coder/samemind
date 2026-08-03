#!/usr/bin/env node
// dogfood.mjs — samemind dogfood: how many days of product self-health without an open own
// failure. Source of truth is the event ledger topic HEALTH_TOPIC (written by writeHealth on
// state change only — see tools/lib/health.mjs), not .samemind/health.json (one-shot, no
// history) and not fleet silence alone.
//
// Honesty rule: no ledger events for the topic → "нечем измерить", never "0 failures".
// That is the same product distinction as doctor/status: "no problems" ≠ "not checked".
//
//   npx samemind dogfood [--root <dir>] [--json]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents, summarizeLedger } from './lib/ledger.mjs';
import { HEALTH_TOPIC } from './lib/health.mjs';

const MS_PER_DAY = 86_400_000;

/**
 * Pure assessment over a pre-loaded event list (and injectable `now` for tests).
 * @returns {object} dogfood data payload (the `data` field of the JSON envelope)
 */
export function assessDogfood(events, { now = Date.now(), topic = HEALTH_TOPIC } = {}) {
  const topicEvs = (events || [])
    .filter((e) => e && e.topic === topic)
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  if (!topicEvs.length) {
    return {
      measurable: false,
      reason: 'no health ledger events yet — nothing to measure (not “0 failures”)',
      topic,
      daysWithoutOpenFailure: null,
      lastFailure: null,
      open: false,
      firstEventTs: null,
      lastEventTs: null,
    };
  }

  const { openFailures } = summarizeLedger(events);
  const openFail = (openFailures || []).find((f) => f.topic === topic) || null;

  const failEvs = topicEvs.filter((e) => e.phase === 'fail' || e.phase === 'block');
  const lastFail = failEvs.length ? failEvs[failEvs.length - 1] : null;
  const firstEventTs = topicEvs[0].ts;
  const lastEventTs = topicEvs[topicEvs.length - 1].ts;

  if (openFail) {
    return {
      measurable: true,
      reason: null,
      topic,
      daysWithoutOpenFailure: 0,
      lastFailure: {
        ts: openFail.ts,
        action: openFail.action,
        open: true,
      },
      open: true,
      firstEventTs,
      lastEventTs,
    };
  }

  // Clean streak: days since last failure event (if any), else since first health observation.
  // Closing a fail (done/ok after it) clears openFailures; the calendar streak still counts
  // from the incident itself — "days without a failure" starts after that fail's timestamp.
  const anchorTs = lastFail ? lastFail.ts : firstEventTs;
  const anchorMs = Date.parse(anchorTs);
  const days = Number.isFinite(anchorMs)
    ? Math.max(0, Math.floor((now - anchorMs) / MS_PER_DAY))
    : 0;

  return {
    measurable: true,
    reason: null,
    topic,
    daysWithoutOpenFailure: days,
    lastFailure: lastFail
      ? { ts: lastFail.ts, action: lastFail.action, open: false }
      : null,
    open: false,
    firstEventTs,
    lastEventTs,
  };
}

function parseArgs(argv) {
  const out = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag "${a}" — see: samemind dogfood --help`);
  }
  return out;
}

function usage() {
  console.log('samemind dogfood — days of product self-health without an open own failure');
  console.log('');
  console.log('  samemind dogfood [--root <dir>] [--json]');
  console.log('');
  console.log('Reads ledger topic "samemind-health" (state-change events from `project`).');
  console.log('Empty history → "нечем измерить", not "0 сбоев".');
}

function printHuman(data) {
  if (!data.measurable) {
    console.log('❓ dogfood: нечем измерить');
    console.log(`  ${data.reason}`);
    console.log(`  topic: ${data.topic}`);
    return;
  }
  if (data.open) {
    console.log(`❌ dogfood: open own failure (0 days clean)`);
    console.log(`  last failure: ${data.lastFailure.ts} — ${data.lastFailure.action}`);
    console.log(`  status: OPEN (not closed by a later done/ok on ${data.topic})`);
  } else {
    const n = data.daysWithoutOpenFailure;
    console.log(`✅ dogfood: ${n} day${n === 1 ? '' : 's'} without an open own failure`);
    if (data.lastFailure) {
      console.log(`  last failure: ${data.lastFailure.ts} — ${data.lastFailure.action} (closed)`);
    } else {
      console.log('  last failure: (none recorded)');
    }
  }
  console.log(`  topic: ${data.topic}`);
  console.log(`  window: ${data.firstEventTs} → ${data.lastEventTs}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }

  const root = resolve(args.root || process.env.OKF_ROOT || process.cwd());
  if (!existsSync(root)) throw new Error(`root not found: ${root} (pass --root <dir> or set OKF_ROOT)`);

  const data = assessDogfood(readEvents(root));

  if (args.json) {
    console.log(JSON.stringify({
      contract: 1,
      kind: 'dogfood',
      generatedAt: new Date().toISOString(),
      data,
    }));
    return 0;
  }

  printHuman(data);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`dogfood: ${e.message}`);
    process.exit(1);
  }
}

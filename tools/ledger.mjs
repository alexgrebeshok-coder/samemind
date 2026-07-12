#!/usr/bin/env node
// ledger.mjs — samemind ledger: append-only fine-grained event log (see docs/event-ledger.md,
// alexgrebeshok-coder/samemind#3). Complements, never replaces, the work-discipline layer
// (docs/work-discipline.md) where `Task.status` is edited in place.
//
//   npx samemind ledger append --actor <id> --topic <t> --phase <p> [--status <s>]
//                               --action "..." [--artifact <a>] [--ref <r>]
//   npx samemind ledger status                     summary: open failures first, then every
//                                                   topic's current stage (freshest first)
//   npx samemind ledger read --topic <t> [--limit N]   full history of one topic
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/okf.mjs';
import { appendEvent, readEvents, summarizeLedger, PHASES, STATUSES } from './lib/ledger.mjs';

function usage() {
  console.log('Usage:');
  console.log('  samemind ledger append --actor <id> --topic <t> --phase <p> [--status <s>] --action "..." [--artifact <a>] [--ref <r>]');
  console.log(`    phase:  ${[...PHASES].join('|')}`);
  console.log(`    status: ${[...STATUSES].join('|')}  (default: ok)`);
  console.log('  samemind ledger status');
  console.log('  samemind ledger read --topic <t> [--limit N]');
}

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      a[argv[i].slice(2)] = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    } else if (a._ === undefined) a._ = argv[i];
  }
  return a;
}

function fmtEvent(e) {
  const tail = [e.artifact && `📦 ${e.artifact}`, e.ref && `(${e.ref})`].filter(Boolean).join('  ');
  const q = e.quarantine ? '  ⚠️ quarantine' : '';
  const stage = `${e.phase}/${e.status}`;
  return `${String(e.ts).slice(0, 19).replace('T', ' ')}  ${String(e.actor).padEnd(14)} ${String(e.topic).padEnd(18)} ${stage.padEnd(11)} ${e.action}${tail ? '  ' + tail : ''}${q}`;
}

export function cmdAppend(a) {
  const rec = appendEvent(ROOT, {
    actor: a.actor, topic: a.topic, phase: a.phase, status: a.status,
    action: a.action, artifact: a.artifact, ref: a.ref,
  });
  const flag = rec.quarantine ? ` ⚠️ quarantine: ${rec.matches.join(', ')}` : '';
  console.log(`ledger: +${rec.phase}/${rec.status} [${rec.actor}] ${rec.topic} — ${rec.action}${flag}`);
}

export function cmdStatus() {
  const { topics, openFailures } = summarizeLedger(readEvents(ROOT));
  if (!topics.length) { console.log('ledger: empty — no events yet.'); return; }
  if (openFailures.length) {
    console.log('🔥 ОТКРЫТЫЕ СБОИ:');
    for (const f of openFailures) {
      console.log(`  [${String(f.ts).slice(0, 16).replace('T', ' ')}] ${f.actor} · ${f.topic} — ${f.action}`);
    }
    console.log('');
  }
  console.log('ТОПИКИ — текущая стадия (свежие сверху):');
  for (const t of topics) {
    const mark = t.openFail ? '🔥' : (t.last.phase === 'done' ? '✅' : '🔧');
    console.log(`  ${mark} ${String(t.topic).padEnd(20)} ${t.last.phase}/${t.last.status} [${t.last.actor}] ${String(t.last.ts).slice(0, 16).replace('T', ' ')} — ${t.last.action}`);
  }
}

export function cmdRead(a) {
  if (!a.topic || a.topic === true) { console.error('ledger read: --topic is required'); process.exit(2); }
  const limit = a.limit && a.limit !== true ? parseInt(a.limit, 10) : 200;
  const events = readEvents(ROOT)
    .filter(e => e.topic === a.topic)
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)))
    .slice(-limit);
  if (!events.length) { console.log(`ledger: no events for topic "${a.topic}"`); return; }
  for (const e of events) console.log(fmtEvent(e));
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const cmd = a._;
  try {
    if (cmd === 'append') { cmdAppend(a); return 0; }
    if (cmd === 'status') { cmdStatus(); return 0; }
    if (cmd === 'read') { cmdRead(a); return 0; }
    usage();
    return cmd ? 1 : 0;
  } catch (e) {
    console.error(`ledger error: ${e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}

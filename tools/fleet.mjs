#!/usr/bin/env node
// fleet.mjs — samemind fleet: a declared registry of the agent engines working on a bundle,
// plus heartbeat (who's gone quiet) and assign (hand a topic to an engine, verify required).
// See docs/fleet.md, tools/lib/fleet.mjs (pure logic).
//
//   npx samemind fleet init [--target <dir>]      scaffold/refresh fleet/registry.json by
//                                                  reusing detectEngines() — never invents
//                                                  its own engine-file detection
//   npx samemind fleet status                     registry + who's overdue (ledger-backed)
//   npx samemind fleet assign --engine <id> --topic <t> --goal "..." --verify "..."
//                              [--boundary "..."]... [--stop <s>]...
//                                                  declare an assignment, log it as a ledger
//                                                  `start` event owned by that engine
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { ROOT } from './lib/okf.mjs';
import { detectEngines } from './lib/detect-engines.mjs';
import { readEvents, appendEvent } from './lib/ledger.mjs';
import {
  buildEngine, buildRegistry, buildAssignment, readRegistry, writeRegistry, registryFile,
  heartbeat, findEngine, DEFAULT_STOP_POINTS,
} from './lib/fleet.mjs';

function usage() {
  console.log('Usage:');
  console.log('  samemind fleet init [--target <dir>]');
  console.log('  samemind fleet status');
  console.log('  samemind fleet assign --engine <id> --topic <t> --goal "..." --verify "..." [--boundary "..."]... [--stop <s>]...');
}

export function parseArgs(argv) {
  const a = { boundary: [], stop: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) { if (a._ === undefined) a._ = tok; continue; }
    const key = tok.slice(2);
    const val = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    if (key === 'boundary') a.boundary.push(val);
    else if (key === 'stop') a.stop.push(val);
    else a[key] = val;
  }
  return a;
}

export function cmdInit(a) {
  const target = a.target && a.target !== true ? a.target : ROOT;
  const detected = detectEngines(target);
  const existing = readRegistry(ROOT);
  const existedBefore = existsSync(registryFile(ROOT));
  const byId = new Map((existing?.engines || []).map((e) => [e.id, e]));
  const added = [];
  for (const id of detected) {
    if (!byId.has(id)) {
      byId.set(id, buildEngine({ id }));
      added.push(id);
    }
  }
  const registry = buildRegistry({
    engines: [...byId.values()],
    stopPoints: existing?.stopPoints || DEFAULT_STOP_POINTS,
  });
  writeRegistry(ROOT, registry);
  console.log(`fleet: registry ${existedBefore ? 'updated' : 'created'} at ${registryFile(ROOT)}`);
  console.log(`  detected in ${target}: ${detected.length ? detected.join(', ') : '(none)'}`);
  console.log(`  added: ${added.length ? added.join(', ') : '(none — already known)'}`);
  console.log(`  total engines in registry: ${registry.engines.length}`);
}

export function cmdStatus() {
  const registry = readRegistry(ROOT);
  if (!registry) {
    console.log('fleet: no registry yet — run `samemind fleet init`.');
    return;
  }
  const rows = heartbeat(registry.engines, readEvents(ROOT), Date.now());
  console.log(`fleet: ${rows.length} engine(s) — stop-points: ${registry.stopPoints.join(', ') || '(none)'}`);
  console.log('');
  for (const r of rows) {
    const mark = r.overdue ? '🔥' : (r.status !== 'active' ? '💤' : '✅');
    const seen = r.lastSeen
      ? `${String(r.lastSeen).slice(0, 19).replace('T', ' ')} (${r.silentSec}s silent, limit ${r.heartbeatSec}s)`
      : 'never seen in the ledger';
    console.log(`  ${mark} ${r.id.padEnd(16)} ${r.role.padEnd(10)} ${r.status.padEnd(8)} ${seen}`);
  }
  const overdue = rows.filter((r) => r.overdue);
  if (overdue.length) {
    console.log('');
    console.log(`🔥 ${overdue.length} engine(s) overdue: ${overdue.map((r) => r.id).join(', ')}`);
  }
}

export function cmdAssign(a) {
  const registry = readRegistry(ROOT);
  if (!registry) {
    console.error('fleet assign: no registry — run `samemind fleet init` first');
    process.exitCode = 2;
    return;
  }
  const engine = findEngine(registry, a.engine);
  if (!engine) {
    console.error(`fleet assign: engine "${a.engine}" is not in the registry (samemind fleet init / add it first)`);
    process.exitCode = 2;
    return;
  }
  if (engine.status !== 'active') {
    console.error(`fleet assign: engine "${a.engine}" is "${engine.status}", not active — not assignable`);
    process.exitCode = 2;
    return;
  }
  const assignment = buildAssignment({
    engine: a.engine,
    topic: a.topic,
    goal: a.goal,
    verify: a.verify,
    boundaries: a.boundary,
    stopPoints: a.stop.length ? a.stop : registry.stopPoints,
  });
  const rec = appendEvent(ROOT, {
    actor: assignment.engine,
    topic: assignment.topic,
    phase: 'start',
    status: 'ok',
    action: `assigned: ${assignment.goal} — verify: ${assignment.verify}`,
    artifact: assignment.boundaries.join('; ') || null,
  });
  console.log(`fleet: assigned "${assignment.topic}" to ${assignment.engine}`);
  console.log(`  goal: ${assignment.goal}`);
  console.log(`  verify: ${assignment.verify}`);
  console.log(`  stop-points: ${assignment.stopPoints.join(', ')}`);
  console.log(`  logged to ledger: +${rec.phase}/${rec.status} [${rec.actor}] ${rec.topic}`);
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const cmd = a._;
  try {
    if (cmd === 'init') { cmdInit(a); return process.exitCode || 0; }
    if (cmd === 'status') { cmdStatus(); return 0; }
    if (cmd === 'assign') { cmdAssign(a); return process.exitCode || 0; }
    usage();
    return cmd ? 1 : 0;
  } catch (e) {
    console.error(`fleet error: ${e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}

#!/usr/bin/env node
// status.mjs — samemind status: external heartbeat over the memory-projection layer. Reads
// <root>/.samemind/health.json (written by `samemind project` on every run — see
// tools/lib/health.mjs) and reports whether memory projection is alive: fresh (<= 2× the
// expected interval) → ok, stale → the run stopped happening, no file yet → unknown.
//
//   npx samemind status [--root <dir>] [--json]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHealth, assessLiveness } from './lib/health.mjs';
import { readProjectionConfig } from './lib/projection-config.mjs';

const DEFAULT_INTERVAL_SEC = 1800;
const MARK = { ok: '✅', stale: '⚠️', unknown: '❓', failed: '❌' };

// Top-line mark folds liveness (is the run happening?) with outcome (did the last run succeed?).
// A fresh-but-FAILED run must never read as ✅ — that's the "silent green over a broken run"
// class of bug. failed wins over ok when the heartbeat is fresh; a stale/unknown run is a
// liveness problem first, so those states show as-is regardless of the last recorded ok.
export function displayState(livenessState, health) {
  if (livenessState === 'ok' && health && health.ok === false) return 'failed';
  return livenessState;
}

function parseArgs(argv) {
  const out = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag "${a}" — see: samemind status --help`);
  }
  return out;
}

function usage() {
  console.log('samemind status — is memory projection alive (external heartbeat over `samemind project` runs)');
  console.log('');
  console.log('  samemind status [--root <dir>] [--json]');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }

  const root = resolve(args.root || process.env.OKF_ROOT || process.cwd());
  if (!existsSync(root)) throw new Error(`root not found: ${root} (pass --root <dir> or set OKF_ROOT)`);

  const health = readHealth(root);
  // intervalSec is the single source of truth (projection-config): the same field serviced reads
  // for its backstop period, so this liveness window (2×) and the daemon's cadence never diverge.
  // Falls back to the default only when the config read yields no finite value.
  const cfg = readProjectionConfig(root);
  const intervalSec = Number.isFinite(cfg.intervalSec) ? cfg.intervalSec : DEFAULT_INTERVAL_SEC;
  const { state, ageSec } = assessLiveness(health, { intervalSec });

  if (args.json) {
    const data = {
      state: displayState(state, health),
      liveness: state,
      ageSec,
      ok: health?.ok ?? null,
      lastError: health?.lastError ?? null,
      targets: health?.targets ?? [],
      version: health?.version ?? null,
      ts: health?.ts ?? null,
    };
    console.log(JSON.stringify({ contract: 1, kind: 'status', data }));
    return 0;
  }

  if (!health) {
    console.log('memory projection has not run yet — run `samemind project`.');
    return 0;
  }

  const shown = displayState(state, health);
  const mark = MARK[shown] || '❓';
  const ageStr = Number.isFinite(ageSec) ? `${Math.round(ageSec)}s ago` : 'unknown age';
  console.log(`${mark} samemind status: ${shown} (last run ${ageStr}, expected every ${intervalSec}s)`);
  console.log(`  outcome: ${health.ok ? 'ok' : `FAILED — ${health.lastError || '(no message)'}`}`);
  console.log(`  targets: ${health.targets && health.targets.length ? health.targets.join(', ') : '(none)'}`);
  console.log(`  version: ${health.version || '(unknown)'}`);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`status: ${e.message}`);
    process.exit(1);
  }
}

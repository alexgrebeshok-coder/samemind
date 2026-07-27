#!/usr/bin/env node
// hooks.mjs — CLI over tools/lib/hooks.mjs: wire samemind's session-lifecycle hooks into an
// engine that actually exposes a hook API, or report which engines can be hooked at all. This is
// a thin seam — all the tier logic and the idempotent JSON/plugin merge live in lib/hooks.mjs.
//
//   samemind hooks list                                 hook tier of every engine samemind knows
//   samemind hooks install --agent <id> [--target <dir>] [--root <dir>]
//
//   --agent   engine id (see `hooks list`); only 'auto'-tier engines can be wired
//   --target  directory whose engine config gets the hooks (default: cwd)
//   --root    bundle root baked into the hook commands (default: OKF_ROOT | cwd)
//
// Loud-fail: an engine that has no lifecycle-hook API (projection tier) or is unknown (none tier)
// exits non-zero with an actionable message — hooks were NOT installed, and we say so.
import { fileURLToPath } from 'node:url';
import { engineHookTier, installHooks } from './lib/hooks.mjs';
import { ENGINE_FILES } from './install.mjs';

const TIER_ORDER = { auto: 0, projection: 1, none: 2 };

export function parseArgs(argv) {
  const a = { agent: null, target: null, root: null, help: false, _: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--agent') a.agent = argv[++i];
    else if (t === '--target') a.target = argv[++i];
    else if (t === '--root') a.root = argv[++i];
    else if (t === '--help' || t === '-h') a.help = true;
    else if (a._ === undefined && !t.startsWith('--')) a._ = t;
    else throw new Error(`unknown flag "${t}" — see: samemind hooks --help`);
  }
  return a;
}

function usage() {
  console.log('samemind hooks — wire session-lifecycle hooks into an engine, or show which engines can be hooked');
  console.log('');
  console.log('  samemind hooks list                                    hook tier of every known engine');
  console.log('  samemind hooks install --agent <id> [--target <dir>] [--root <dir>]');
  console.log('');
  console.log("Tiers: auto = engine has a real hook API samemind wires in · projection = no hook API, use `samemind install` · none = unknown engine.");
}

function cmdList() {
  const rows = Object.keys(ENGINE_FILES)
    .map(id => ({ id, tier: engineHookTier(id), label: ENGINE_FILES[id]?.label || id }))
    .sort((x, y) => (TIER_ORDER[x.tier] - TIER_ORDER[y.tier]) || x.id.localeCompare(y.id));
  const w = Math.max(...rows.map(r => r.id.length));
  console.log('samemind hooks — engine tiers:');
  for (const r of rows) console.log(`  ${r.id.padEnd(w)}  ${r.tier}`);
  console.log('');
  console.log("  auto → `samemind hooks install --agent <id>` wires real lifecycle hooks.");
  console.log("  projection → no hook API; run `samemind install --agent <id>` (context file only).");
  return 0;
}

function cmdInstall(args) {
  if (!args.agent) {
    console.error('hooks install: --agent <id> is required (see `samemind hooks list`)');
    return 1;
  }
  const targetDir = args.target || process.cwd();
  const root = args.root || process.env.OKF_ROOT || process.cwd();
  const res = installHooks(args.agent, { targetDir, root });
  if (!res.ok) {
    // projection/none tier, or a merge failure — hooks were NOT installed. Loud-fail with the why.
    console.error(`hooks install: ${res.message || `could not install hooks for "${args.agent}"${res.reason ? ` (${res.reason})` : ''}`}`);
    return 1;
  }
  const verb = res.created ? 'created' : 'updated';
  console.log(`hooks: ${verb} ${res.file} for ${res.engine} (tier ${res.tier}, target ${targetDir})`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    const cmd = args._;
    if (cmd === 'list') return cmdList();
    if (cmd === 'install') return cmdInstall(args);
    usage();
    return cmd ? 1 : 0;
  } catch (e) {
    console.error(`hooks: ${e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}

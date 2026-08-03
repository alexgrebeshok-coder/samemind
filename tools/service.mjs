#!/usr/bin/env node
// service.mjs — samemind service: install a PERIODIC `samemind project` run as an OS-native,
// per-user scheduler unit (no admin, no sudo, no network). Phase 2 = polling the proven `project`
// command on an interval, NOT a long-lived daemon (that is Phase 4). Registration is ONLY ever
// explicit (`samemind service install`) — never a postinstall hook (npm v12 blocks install scripts,
// and silent scheduler registration on `npm i` is user-hostile).
//
//   npx samemind service install   [--root <dir>] [--interval <sec>] [--label <id>] [--dry-run]
//   npx samemind service status    [--label <id>]
//   npx samemind service uninstall [--label <id>]
//
// Platform mapping (all user-scope):
//   darwin → ~/Library/LaunchAgents/<label>.plist        launchctl bootstrap gui/$UID
//   linux  → ~/.config/systemd/user/<label>.{service,timer}  systemctl --user enable --now <label>.timer
//   win32  → per-user Scheduled Task from XML             schtasks /create /xml ... (InteractiveToken)
//
// Test/sandbox seam: SAMEMIND_SERVICE_HOME redirects the unit directory AND skips OS activation,
// so tests exercise the write/remove path without touching the real ~/Library/LaunchAgents etc.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectionConfig } from './lib/projection-config.mjs';
import { ENGINE_FILES } from './install.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const TEMPLATES = join(HERE, 'lib', 'service-templates');
const CLI = join(PACKAGE_ROOT, 'bin', 'samemind.mjs');

const DEFAULT_INTERVAL = 1800;
const SYSTEMD_TIMER_SPLIT = /^# --- samemind:timer ---.*$/m;

// ── template rendering ──────────────────────────────────────────────────────

/** Substitute ${KEY} placeholders; throw loudly if any ${...} survives (a missing var is a bug,
 *  not something to ship into a scheduler unit). */
export function renderTemplate(name, vars) {
  let text = readFileSync(join(TEMPLATES, name), 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.split('${' + k + '}').join(String(v));
  }
  const leftover = text.match(/\$\{[A-Z_]+\}/);
  if (leftover) throw new Error(`service: unresolved placeholder ${leftover[0]} in template ${name}`);
  return text;
}

/** Windows Task Scheduler wants an ISO-8601 duration, not raw seconds. */
export function iso8601Duration(sec) {
  if (sec % 3600 === 0) return `PT${sec / 3600}H`;
  if (sec % 60 === 0) return `PT${sec / 60}M`;
  return `PT${sec}S`;
}

// ── config + plan (pure: no activation side effects) ─────────────────────────

function defaultLabel(platform) {
  return platform === 'darwin' ? 'com.samemind.project' : 'samemind-project';
}

export function resolveConfig(args = {}, platform = process.platform, env = process.env) {
  const root = resolve(args.root || env.OKF_ROOT || process.cwd());
  const interval = Number.isFinite(args.interval) && args.interval > 0 ? Math.floor(args.interval) : DEFAULT_INTERVAL;
  const label = args.label || defaultLabel(platform);
  const logDir = join(root, '.samemind', 'logs');
  return {
    node: process.execPath,
    cli: CLI,
    root,
    interval,
    label,
    daemon: !!args.daemon,   // true → long-lived `serviced` under supervision; false → periodic `project`
    log: join(logDir, 'service.log'),
    errlog: join(logDir, 'service.err'),
    logDir,
  };
}

/** Where unit files live. SAMEMIND_SERVICE_HOME overrides (test/sandbox). */
export function unitDir(platform = process.platform, env = process.env) {
  if (env.SAMEMIND_SERVICE_HOME) return env.SAMEMIND_SERVICE_HOME;
  const home = homedir();
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents');
  if (platform === 'linux') return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'systemd', 'user') : join(home, '.config', 'systemd', 'user');
  if (platform === 'win32') return env.TEMP || tmpdir();
  return home;
}

/**
 * Pure plan for a platform: which files to write (path+content), which activation/deactivation
 * commands to run, and how to query status. No fs writes, no process spawns — install/uninstall/
 * status consume this. `uid` is only meaningful on darwin.
 */
export function buildPlan(platform, cfg, dir, uid = 0) {
  const vars = { NODE: cfg.node, CLI: cfg.cli, LABEL: cfg.label, ROOT: cfg.root, LOG: cfg.log, ERRLOG: cfg.errlog };

  if (platform === 'darwin') {
    const path = join(dir, `${cfg.label}.plist`);
    // --daemon: a KeepAlive-supervised `serviced` (no StartInterval); default: periodic `project`.
    const content = cfg.daemon
      ? renderTemplate('launchd-daemon.plist', vars)
      : renderTemplate('launchd.plist', { ...vars, INTERVAL: String(cfg.interval) });
    return {
      kind: 'launchd',
      files: [{ path, content }],
      // bootout first (ignore "not loaded"), then bootstrap the freshly written plist.
      activate: [
        { argv: ['launchctl', 'bootout', `gui/${uid}/${cfg.label}`], optional: true },
        { argv: ['launchctl', 'bootstrap', `gui/${uid}`, path] },
      ],
      deactivate: [{ argv: ['launchctl', 'bootout', `gui/${uid}/${cfg.label}`], optional: true }],
      status: { argv: ['launchctl', 'list', cfg.label] },
    };
  }

  if (platform === 'linux') {
    if (cfg.daemon) {
      // Restart=always service, NO timer — systemd itself keeps `serviced` alive.
      const path = join(dir, `${cfg.label}.service`);
      return {
        kind: 'systemd',
        files: [{ path, content: renderTemplate('systemd-daemon.service', vars).trim() + '\n' }],
        activate: [
          { argv: ['systemctl', '--user', 'daemon-reload'] },
          { argv: ['systemctl', '--user', 'enable', '--now', `${cfg.label}.service`] },
        ],
        deactivate: [
          { argv: ['systemctl', '--user', 'disable', '--now', `${cfg.label}.service`], optional: true },
        ],
        status: { argv: ['systemctl', '--user', 'is-active', `${cfg.label}.service`] },
        reload: { argv: ['systemctl', '--user', 'daemon-reload'], optional: true },
      };
    }
    const rendered = renderTemplate('systemd.service', { ...vars, INTERVAL: String(cfg.interval) });
    const [svc, timer] = rendered.split(SYSTEMD_TIMER_SPLIT);
    return {
      kind: 'systemd',
      files: [
        { path: join(dir, `${cfg.label}.service`), content: svc.trim() + '\n' },
        { path: join(dir, `${cfg.label}.timer`), content: (timer || '').trim() + '\n' },
      ],
      activate: [
        { argv: ['systemctl', '--user', 'daemon-reload'] },
        { argv: ['systemctl', '--user', 'enable', '--now', `${cfg.label}.timer`] },
      ],
      deactivate: [
        { argv: ['systemctl', '--user', 'disable', '--now', `${cfg.label}.timer`], optional: true },
      ],
      status: { argv: ['systemctl', '--user', 'is-active', `${cfg.label}.timer`] },
      reload: { argv: ['systemctl', '--user', 'daemon-reload'], optional: true },
    };
  }

  if (platform === 'win32') {
    const path = join(dir, `${cfg.label}.xml`);
    // --daemon: a RestartOnFailure task running `serviced` (no repetition interval).
    const content = cfg.daemon
      ? renderTemplate('win-task-daemon.xml', vars)
      : renderTemplate('win-task.xml', { ...vars, INTERVAL: iso8601Duration(cfg.interval) });
    return {
      kind: 'schtasks',
      files: [{ path, content }],
      activate: [{ argv: ['schtasks', '/create', '/tn', cfg.label, '/xml', path, '/f'] }],
      deactivate: [{ argv: ['schtasks', '/delete', '/tn', cfg.label, '/f'], optional: true }],
      status: { argv: ['schtasks', '/query', '/tn', cfg.label] },
    };
  }

  throw new Error(`service: unsupported platform "${platform}" — supported: darwin, linux, win32`);
}

// ── command execution (loud-fail) ────────────────────────────────────────────

function run(step) {
  const res = spawnSync(step.argv[0], step.argv.slice(1), { encoding: 'utf8' });
  const ok = !res.error && res.status === 0;
  return { ...res, ok, cmd: step.argv.join(' ') };
}

function runOrFail(step) {
  const r = run(step);
  if (!r.ok && !step.optional) {
    const detail = r.error ? r.error.message : `exit ${r.status}${r.stderr ? ': ' + r.stderr.trim() : ''}`;
    throw new Error(`command failed: ${r.cmd}\n  ${detail}\n  fix: run that command by hand to see the scheduler's own error, then retry \`samemind service install\``);
  }
  return r;
}

export function nohupFallback(cfg) {
  return [
    'systemd --user is not available here (no $XDG_RUNTIME_DIR / headless session).',
    'Unit files were still written; enable them once systemd --user is reachable:',
    `  systemctl --user daemon-reload && systemctl --user enable --now ${cfg.label}.timer`,
    'Or run the polling loop manually right now (survives logout via nohup):',
    `  nohup sh -c 'while :; do "${cfg.node}" "${cfg.cli}" project --root "${cfg.root}" >>"${cfg.log}" 2>&1; sleep ${cfg.interval}; done' >/dev/null 2>&1 &`,
  ].join('\n');
}

/** systemd --user reachable? Headless/CI boxes often have no user bus. */
function systemdUserAvailable(env = process.env) {
  if (!env.XDG_RUNTIME_DIR) return false;
  const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
  // is-system-running exits non-zero for "degraded" etc., but a reachable bus prints a word,
  // not a connection error; treat "Failed to connect to bus" as unavailable.
  if (r.error) return false;
  return !/Failed to connect|Failed to get D-Bus/i.test(`${r.stdout}${r.stderr}`);
}

// ── commands ─────────────────────────────────────────────────────────────────

function writeFiles(files) {
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
}

/**
 * A periodic unit runs `project`, and `project` without a target exits 1 every time. Installing
 * that unit produces a scheduler entry which can never succeed, failing silently into a log file
 * nobody reads — found by dogfooding: twelve identical failures before anyone looked. `installed`
 * must not be able to mean `cannot possibly work`, so the install refuses instead.
 * Daemon mode is exempt: `serviced` resolves its own targets as they appear.
 */
function projectionTargetMissing(cfg) {
  if (cfg.daemon) return false;
  try {
    return (readProjectionConfig(cfg.root).targets || []).length === 0;
  } catch {
    return false; // unreadable config is the projection layer's problem to report, not ours
  }
}

export function cmdInstall(args, platform = process.platform, env = process.env) {
  const cfg = resolveConfig(args, platform, env);
  if (projectionTargetMissing(cfg)) {
    console.error(`service: refusing to install — no projection target in ${cfg.root}`);
    console.error(`  \`samemind project\` needs one, so this unit would fail on every run.`);
    console.error(`  Fix: add "projection": { "targets": [{ "engine": "<id>" }] } to .samemind/config.json`);
    console.error(`  (engines: ${Object.keys(ENGINE_FILES).join(', ')}), then run this again.`);
    return 1;
  }
  const dir = unitDir(platform, env);
  const uid = platform === 'darwin' && process.getuid ? process.getuid() : 0;
  const plan = buildPlan(platform, cfg, dir, uid);
  const sandbox = !!env.SAMEMIND_SERVICE_HOME;

  if (args.dryRun) {
    for (const f of plan.files) {
      console.log(`# ${f.path}`);
      console.log(f.content);
    }
    console.log(`# would activate (${plan.kind}):`);
    for (const s of plan.activate) console.log(`#   ${s.argv.join(' ')}${s.optional ? '   (ignore failure)' : ''}`);
    return 0;
  }

  mkdirSync(cfg.logDir, { recursive: true });
  writeFiles(plan.files);

  if (sandbox) {
    console.log(`service: wrote ${plan.files.length} unit file(s) to ${dir} (SAMEMIND_SERVICE_HOME set — activation skipped)`);
    for (const f of plan.files) console.log(`  ${f.path}`);
    return 0;
  }

  // linux: gracefully degrade to a printed fallback instead of a cryptic systemctl bus error.
  if (platform === 'linux' && !systemdUserAvailable(env)) {
    console.log(`service: wrote ${plan.files.map(f => f.path).join(', ')}`);
    console.log(nohupFallback(cfg));
    return 0;
  }

  for (const s of plan.activate) runOrFail(s);
  const mode = cfg.daemon ? 'long-lived `samemind serviced` (supervised)' : `periodic \`samemind project\` every ${cfg.interval}s`;
  console.log(`service: installed "${cfg.label}" (${plan.kind}) — ${mode}`);
  for (const f of plan.files) console.log(`  unit: ${f.path}`);
  console.log(`  logs: ${cfg.log}`);
  return 0;
}

export function cmdUninstall(args, platform = process.platform, env = process.env) {
  const cfg = resolveConfig(args, platform, env);
  const dir = unitDir(platform, env);
  const uid = platform === 'darwin' && process.getuid ? process.getuid() : 0;
  const plan = buildPlan(platform, cfg, dir, uid);
  const sandbox = !!env.SAMEMIND_SERVICE_HOME;
  const present = plan.files.some(f => existsSync(f.path));

  if (!sandbox) for (const s of plan.deactivate) run(s); // deactivate is best-effort (idempotent)

  let removed = 0;
  for (const f of plan.files) {
    if (existsSync(f.path)) { rmSync(f.path); removed++; }
  }
  if (!sandbox && plan.reload) run(plan.reload);

  if (!present && removed === 0) {
    console.log(`service: "${cfg.label}" is not installed (nothing to remove) — ok`);
    return 0;
  }
  console.log(`service: uninstalled "${cfg.label}" (${plan.kind}) — removed ${removed} unit file(s)`);
  return 0;
}

export function cmdStatus(args, platform = process.platform, env = process.env) {
  const cfg = resolveConfig(args, platform, env);
  const dir = unitDir(platform, env);
  const uid = platform === 'darwin' && process.getuid ? process.getuid() : 0;
  const plan = buildPlan(platform, cfg, dir, uid);
  const files = plan.files.map(f => ({ path: f.path, exists: existsSync(f.path) }));
  const installed = files.every(f => f.exists);

  console.log(`service: "${cfg.label}" (${plan.kind})`);
  for (const f of files) console.log(`  unit ${f.exists ? '✓' : '✗'} ${f.path}`);

  if (env.SAMEMIND_SERVICE_HOME) {
    console.log(`  loaded: (not checked — SAMEMIND_SERVICE_HOME sandbox)`);
  } else if (installed) {
    const r = run(plan.status);
    console.log(`  loaded: ${r.ok ? 'yes' : 'no'} (${plan.status.argv.join(' ')} → ${r.error ? r.error.message : 'exit ' + r.status})`);
  } else {
    console.log('  loaded: no (unit files not present — run `samemind service install`)');
  }
  console.log('  memory health is separate — see `samemind status`.');
  return installed ? 0 : 1;
}

// ── router ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const a = { root: null, interval: null, label: null, daemon: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--root') a.root = argv[++i];
    else if (t === '--interval') a.interval = Number(argv[++i]);
    else if (t === '--label') a.label = argv[++i];
    else if (t === '--daemon') a.daemon = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else if (a._ === undefined && !t.startsWith('--')) a._ = t;
    else throw new Error(`unknown flag "${t}" — see: samemind service --help`);
  }
  return a;
}

function usage() {
  console.log('samemind service — run memory projection as a per-user OS scheduler unit (no sudo, no network)');
  console.log('');
  console.log('  samemind service install   [--root <dir>] [--interval <sec>] [--label <id>] [--daemon] [--dry-run]');
  console.log('  samemind service status    [--label <id>]');
  console.log('  samemind service uninstall [--label <id>]');
  console.log('');
  console.log('Default: periodic `samemind project` every --interval sec. --daemon: long-lived `samemind serviced` kept alive by the supervisor (launchd KeepAlive / systemd Restart=always / win RestartOnFailure).');
  console.log('Defaults: --interval 1800 · --root OKF_ROOT|cwd · --label ' + `${defaultLabel('darwin')} (mac) / ${defaultLabel('linux')} (linux/win)`);
  console.log('Platform: mac LaunchAgent · linux systemd --user · win per-user Scheduled Task.');
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) { usage(); return 0; }
    const cmd = args._;
    if (cmd === 'install') return cmdInstall(args);
    if (cmd === 'status') return cmdStatus(args);
    if (cmd === 'uninstall') return cmdUninstall(args);
    usage();
    return cmd ? 1 : 0;
  } catch (e) {
    console.error(`service: ${e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}

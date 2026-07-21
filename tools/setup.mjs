#!/usr/bin/env node
// setup.mjs — samemind setup: composes the U-A primitives (detect-engines, probe-embed,
// mcp-register) with install.mjs/init.mjs into one onboarding command.
//   node tools/setup.mjs [--target <dir>] [--yes] [--dry-run]
//   node tools/setup.mjs --global [--yes] [--dry-run] [--home <dir>]   (see runGlobalSetup, G-A)
//
// Default = interactive (human-gate): asks before every write into a file setup doesn't own
// outright — an engine's own instruction file, its MCP config, scaffolding a bundle into a
// non-empty directory. `--yes` is the informed opt-in that skips every prompt and just does the
// reasonable thing. `--dry-run` only prints the plan — proven to write nothing, byte-for-byte,
// in setup.test.mjs.
//
// `--global` connects samemind to the whole machine instead of one project: a personal bundle
// at `~/.samemind/bundle`, Claude Code wired in `~/.claude/CLAUDE.md`, an MCP server registered
// at user scope, and a global embeddings config at `~/.samemind/config.json` — see
// runGlobalSetup below for the exact steps. `--target`/detect-engines/per-engine install do not
// apply in this mode (fixed: claude-code, fixed dirs under `--home`/$HOME).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { probeEmbedEndpoint } from './lib/probe-embed.mjs';
import { ensureMcpRegistered } from './lib/mcp-register.mjs';
import { runInit } from './init.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

// detect-engines.mjs and install.mjs both transitively import lib/okf.mjs, whose `ROOT` export
// freezes to OKF_ROOT the first time it's imported in this process (see bench-recall.mjs for the
// same guard, and its comment for the full story). Deferred until after --target is parsed and
// OKF_ROOT is pinned to it (runSetup, below), so docs/engine-file checks read the bundle setup is
// actually operating on rather than whatever cwd happened to be at module-load time.
let _detectEngines = null;
async function getDetectEngines() {
  return _detectEngines || (_detectEngines = (await import('./lib/detect-engines.mjs')).detectEngines);
}
let _install = null;
async function getInstall() {
  return _install || (_install = await import('./install.mjs'));
}
let _okfLoad = null;
async function getOkfLoad() {
  return _okfLoad || (_okfLoad = (await import('./lib/okf.mjs')).load);
}

// Best-effort env-var → engine-id signals, raw (unfiltered) — narrowed against ENGINE_FILES and
// the file-based scan in runSetup below before anything is actually trusted (a var alone can leak
// in from an unrelated launcher, e.g. CODEX_HOME set globally by Orca's own codex-runtime whether
// or not Codex CLI is what's driving this project). Allowlist, not exhaustive — add a row when
// another engine ships its own var.
const ENV_ENGINE_SIGNALS = [
  ['CLAUDECODE', 'claude-code'],
  ['CURSOR_TRACE_ID', 'cursor'],
  ['CODEX_HOME', 'codex'],
  ['CODEX_SANDBOX', 'codex'],
];

export function detectEngineFromEnv(env = process.env) {
  const found = [];
  for (const [key, id] of ENV_ENGINE_SIGNALS) if (env[key] && !found.includes(id)) found.push(id);
  return found;
}

function isBundle(dir) {
  return existsSync(join(dir, 'index.md')) && existsSync(join(dir, 'concepts'));
}

/**
 * Applies (or plans) the result of probeEmbedEndpoint() against `dir`'s bundle config.
 * Alive (`probe` = {url,model,provider}) → merges {embedUrl, embedModel} into
 * <dir>/.samemind/config.json (atomic write, preserves any other keys already there) — the file
 * resolveEmbedConfig() (tools/lib/recall.mjs) already reads. Dead (`probe` = null) → no file,
 * just an honest fallback hint. `dryRun` never writes, regardless of the probe result.
 * Pure w.r.t. the network — feed it the exact shape probeEmbedEndpoint() returns and it's fully
 * unit-testable without a mocked fetch or a real server.
 */
export function applyEmbedProbe(dir, probe, { dryRun = false } = {}) {
  if (!probe) {
    return 'Semantic off, BM25 fallback — start a local embeddings server (omlx :8000 or Ollama '
      + ':11434, a bge/nomic-shaped model) then re-run `samemind setup`, or set '
      + 'OKF_EMBED_URL/OKF_EMBED_MODEL by hand.';
  }
  if (dryRun) {
    return `[dry-run] would turn semantic search on — ${probe.model} @ ${probe.url} (${probe.provider})`;
  }
  const p = join(dir, '.samemind', 'config.json');
  let cfg = {};
  if (existsSync(p)) {
    try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { cfg = {}; }
  }
  cfg.embedUrl = probe.url;
  cfg.embedModel = probe.model;
  atomicWriteFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return `Semantic on — ${probe.model} @ ${probe.url} (${probe.provider}); written to .samemind/config.json`;
}

async function ask(rl, question) {
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/**
 * Runs the full setup flow against `target`. Returns { ok, lines } — every status line printed
 * (also echoed live via `log`), so a caller/test can inspect the final report without scraping
 * stdout.
 */
export async function runSetup({ target = process.cwd(), yes = false, dryRun = false, log = console.log } = {}) {
  const dir = resolve(target);
  process.env.OKF_ROOT = dir; // pin before the first ROOT-freezing dynamic import below

  const lines = [];
  const print = s => { lines.push(s); log(s); };
  const needsPrompt = !yes && !dryRun;
  const rl = needsPrompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    const detectEngines = await getDetectEngines();
    const { ENGINE_FILES } = await getInstall();

    // 1. detect — an env var alone is a weak signal: it can leak in from an unrelated launcher
    // (e.g. Orca sets CODEX_HOME globally regardless of which agent is actually driving this
    // session — same ambient leak setup.test.mjs's cleanEnv() strips), not just from the engine
    // it's supposed to name actually running against this project. Narrowed to two cases where
    // it's trustworthy without a file to back it up: (a) its instruction file already exists —
    // then the env var is redundant, not load-bearing; (b) it's the ONLY env signal at all and
    // no file-based signal fired either — the "fresh clone, engine already running" case this
    // array exists for. Two-plus simultaneous env signals with nothing on disk to back either
    // one are ambiguous noise, not evidence, and get dropped rather than guessed at. Also drop
    // any signal for an id samemind has no install support for — never surfaced, never warned on.
    const rawEnvEngines = detectEngineFromEnv().filter(id => ENGINE_FILES[id]);
    const fileEngines = detectEngines(dir);
    const soleEnvSignal = rawEnvEngines.length === 1 && fileEngines.length === 0;
    const envEngines = rawEnvEngines.filter(id => fileEngines.includes(id) || soleEnvSignal);
    const engines = [...new Set([...envEngines, ...fileEngines])];
    print(engines.length
      ? `Detected engine(s): ${engines.join(', ')}`
      : 'No engine detected (no known env var, no instruction file).');

    // 2. bundle
    let bundleReady = isBundle(dir);
    if (bundleReady) {
      print('OKF bundle already present — left as is.');
    } else if (dryRun) {
      print(`[dry-run] would scaffold an OKF bundle in ${dir}`);
    } else {
      const doInit = yes || await ask(rl, `No samemind bundle in ${dir} — create one now?`);
      if (!doInit) {
        print('Bundle creation skipped.');
      } else {
        const res = runInit({ targetDir: dir, allowNonEmpty: true });
        if (res.ok) { bundleReady = true; print(`Bundle created in ${dir}.`); }
        else print(`Bundle NOT created: ${res.reason}`);
      }
    }

    // 3. connect — which engine(s) to wire an instruction file for
    let targetEngines = engines;
    if (!targetEngines.length) {
      if (dryRun) {
        print(`[dry-run] no engine detected — would ask which one to set up (${Object.keys(ENGINE_FILES).join('/')})`);
      } else if (yes) {
        print(`No engine detected and --yes given — nothing to install. Supported: ${Object.keys(ENGINE_FILES).join(', ')} (or \`samemind install --agent <id>\` by hand).`);
      } else {
        const answer = (await rl.question(`Which engine to set up? (${Object.keys(ENGINE_FILES).join('/')}, blank to skip) `)).trim();
        if (ENGINE_FILES[answer]) targetEngines = [answer];
        else print('No engine chosen — install skipped.');
      }
    }

    const mcpLines = [];
    for (const engineId of targetEngines) {
      const { installEngine } = await getInstall();
      const label = ENGINE_FILES[engineId]?.label || engineId;

      if (dryRun) {
        print(`[dry-run] would install samemind brief into ${label}'s instruction file(s)`);
      } else if (!bundleReady) {
        print(`Skipped install for ${label} — no bundle to read the identity brief from.`);
      } else {
        const doInstall = yes || await ask(rl, `Install samemind brief into ${label}'s instruction file(s)?`);
        if (doInstall) {
          const load = await getOkfLoad();
          const docs = load({ includeSecret: false });
          const res = installEngine(engineId, { targetDir: dir, docs });
          if (res.ok) {
            print(`Installed ${label}: ${res.files.map(f => f.path).join(', ')}`);
            for (const w of res.warnings || []) print(`  ⚠ ${w}`);
          } else {
            print(`Install failed for ${label}: ${res.reason}`);
          }
        } else {
          print(`Install for ${label} skipped.`);
        }
      }

      // 4. MCP — only claude-code ever writes a file (idempotent .mcp.json merge); every other
      // engine only ever returns a hint string regardless of `apply` (mcp-register.mjs), so
      // there's nothing to gate for those — no prompt.
      const applyMcp = dryRun ? false : (yes || engineId !== 'claude-code' || await ask(rl, `Register samemind as an MCP server for ${label}?`));
      mcpLines.push(`${label}: ${ensureMcpRegistered(engineId, dir, { apply: applyMcp })}`);
    }

    // 5. embeddings — one probe for the bundle, independent of which engine(s) got wired above
    const probe = await probeEmbedEndpoint();
    const semanticLine = applyEmbedProbe(dir, probe, { dryRun });
    print(semanticLine);

    // 6. status
    print('');
    print('=== samemind setup — summary ===');
    print(`Engine(s): ${targetEngines.length ? targetEngines.join(', ') : '(none)'}`);
    print(`Bundle:    ${bundleReady ? dir : '(not created)'}`);
    print(`MCP:       ${mcpLines.length ? mcpLines.join(' | ') : '(none)'}`);
    print(`Semantic:  ${probe ? 'on' : 'off (BM25 fallback)'}`);

    return { ok: true, lines };
  } finally {
    rl?.close();
  }
}

/**
 * `samemind setup --global` — one machine-wide connection instead of a per-project one:
 * (1) a personal OKF bundle at `<home>/.samemind/bundle` (optional — asked/`--yes`/dry-run-planned,
 *     same as the project bundle step above, `runInit({allowNonEmpty:true})`); bundle-before-install
 *     because install needs docs to read a brief from — reordered from the G-A brief's a/b/c/d
 *     listing for that one dependency, everything else keeps its place;
 * (2) the Claude Code identity+protocol block installed into `<home>/.claude/CLAUDE.md`
 *     (`installEngine('claude-code', {targetDir: <home>/.claude})` — same path-agnostic call the
 *     project flow makes, just pointed at the global instruction file instead of a project one);
 * (3) `ensureMcpRegistered('claude-code', ..., {scope:'user'})` — native `claude mcp add --scope
 *     user` if the binary resolves, else a JSON-merge fallback into `<home>/.claude.json` that
 *     never touches any of that file's other keys (see mcp-register.mjs);
 * (4) the same embeddings probe as project setup, written to `<home>/.samemind/config.json` (the
 *     "global" tier `resolveEmbedConfig` — tools/lib/recall.mjs — reads).
 * `home` is parameterized (defaults to `$HOME`) so tests run this whole flow against a fake,
 * disposable home directory — the real `~/.claude.json`/`~/.claude/CLAUDE.md`/`~/.samemind` are
 * never touched by anything in this repo's test suite.
 */
export async function runGlobalSetup({ home = process.env.HOME, yes = false, dryRun = false, log = console.log } = {}) {
  const homeDir = resolve(home);
  const claudeDir = join(homeDir, '.claude');
  const bundleDir = join(homeDir, '.samemind', 'bundle');
  process.env.OKF_ROOT = bundleDir; // pin before the first ROOT-freezing dynamic import below

  const lines = [];
  const print = s => { lines.push(s); log(s); };
  const needsPrompt = !yes && !dryRun;
  const rl = needsPrompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    // 1. personal bundle (optional)
    let bundleReady = isBundle(bundleDir);
    if (bundleReady) {
      print(`Personal bundle already present — ${bundleDir}`);
    } else if (dryRun) {
      print(`[dry-run] would scaffold a personal OKF bundle in ${bundleDir}`);
    } else {
      const doInit = yes || await ask(rl, `No personal samemind bundle in ${bundleDir} — create one now?`);
      if (!doInit) {
        print('Personal bundle creation skipped.');
      } else {
        const res = runInit({ targetDir: bundleDir, allowNonEmpty: true });
        if (res.ok) { bundleReady = true; print(`Personal bundle created in ${bundleDir}.`); }
        else print(`Personal bundle NOT created: ${res.reason}`);
      }
    }

    // 2. install Claude Code globally
    if (dryRun) {
      print(`[dry-run] would install samemind brief into ${join(claudeDir, 'CLAUDE.md')}`);
    } else if (!bundleReady) {
      print('Skipped global install — no personal bundle to read the identity brief from.');
    } else {
      const doInstall = yes || await ask(rl, `Install samemind brief into ${claudeDir}/CLAUDE.md?`);
      if (doInstall) {
        const { installEngine } = await getInstall();
        const load = await getOkfLoad();
        const docs = load({ includeSecret: false });
        const res = installEngine('claude-code', { targetDir: claudeDir, docs });
        if (res.ok) print(`Installed globally: ${res.files.map(f => f.path).join(', ')}`);
        else print(`Global install failed: ${res.reason}`);
      } else {
        print('Global install skipped.');
      }
    }

    // 3. MCP — user scope
    const applyMcp = dryRun ? false : (yes || await ask(rl, 'Register samemind as a user-scope MCP server (Claude Code)?'));
    const mcpLine = ensureMcpRegistered('claude-code', claudeDir, {
      apply: applyMcp, scope: 'user', userConfigPath: join(homeDir, '.claude.json'),
    });
    print(`MCP: ${mcpLine}`);

    // 4. embeddings — global config, <home>/.samemind/config.json
    const probe = await probeEmbedEndpoint();
    const semanticLine = applyEmbedProbe(homeDir, probe, { dryRun });
    print(semanticLine);

    // 5. status
    print('');
    print('=== samemind setup --global — summary ===');
    print(`Claude Code (global): ${join(claudeDir, 'CLAUDE.md')}`);
    print(`Personal bundle:      ${bundleReady ? bundleDir : '(not created)'}`);
    print(`MCP:                  ${mcpLine}`);
    print(`Semantic (global):    ${probe ? 'on' : 'off (BM25 fallback)'}`);

    return { ok: true, lines };
  } finally {
    rl?.close();
  }
}

function parseArgs(argv) {
  const out = {
    target: null, yes: false, dryRun: false, global: false, home: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--global') out.global = true;
    else if (a === '--home') out.home = argv[++i]; // test/manual override only, see runGlobalSetup
  }
  return out;
}

async function main() {
  const {
    target, yes, dryRun, global: isGlobal, home,
  } = parseArgs(process.argv.slice(2));
  const res = isGlobal
    ? await runGlobalSetup({ home: home || process.env.HOME, yes, dryRun })
    : await runSetup({ target: target || process.cwd(), yes, dryRun });
  process.exitCode = res.ok ? 0 : 1;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

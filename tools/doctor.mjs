#!/usr/bin/env node
/**
 * samemind doctor — inspect-first connection health.
 *
 * The defect this exists for: a config entry can be present, the MCP server can start, and
 * `tools/list` can answer with all ten tools — while the server is serving the WRONG root and
 * the agent has zero memory. Reproduced live: launching the server with no OKF_ROOT makes
 * `tools/lib/okf.mjs:9` fall back to the installed package directory. Status ok, 10 tools,
 * 0 concepts. Nothing anywhere reports a problem.
 *
 * So "registered in JSON" is never green here. Five states, checked in order, each one
 * short-circuiting the rest to `skipped`:
 *
 *   supported → installed → connected → verified → active
 *
 * Safe by default: reads configs, spawns the configured server, never writes without --repair.
 * Exit 0 when no FAIL (warnings are fine), 1 when anything FAILs or on a usage error.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { ENGINE_FILES } from './install.mjs';
import { detectEngines } from './lib/detect-engines.mjs';
import { engineHookTier } from './lib/hooks.mjs';
import { readHealth, assessLiveness } from './lib/health.mjs';
import { displayState } from './status.mjs';
import { readProjectionConfig } from './lib/projection-config.mjs';
import { findSamemindEntries, redactEnv, scrubValues } from './lib/engine-mcp.mjs';
import { probeMcpServer, PROBE_STATUS } from './lib/mcp-probe.mjs';
import { load } from './lib/okf.mjs';
import { mergeJsonFile } from './lib/global-json-merge.mjs';

const CORE_TOOLS = ['memory_search', 'memory_get', 'memory_health'];

/** id → {severity, title, fix, repairable}. Checks emit only {id, engine, detail}, so the human
 *  render and the JSON contract cannot drift apart, and a new check is one row plus one line. */
export const FINDINGS = {
  'no-okf-root': {
    severity: 'fail', repairable: true,
    title: 'MCP entry has no OKF_ROOT',
    fix: 'Add env.OKF_ROOT pointing at your bundle, or run: samemind doctor --repair --root <bundle>',
  },
  'serving-package-dir': {
    severity: 'fail', repairable: true,
    title: 'Server is serving the samemind package directory, not a memory bundle',
    fix: 'Set env.OKF_ROOT to your bundle. Without it the server silently falls back to its own install dir.',
  },
  'root-mismatch': {
    severity: 'fail', repairable: false,
    title: 'Server resolved a different root than the config asked for',
    fix: 'Check for a stale process, a shadowed OKF_ROOT, or a symlink that moved.',
  },
  'empty-corpus': {
    severity: 'fail', repairable: false,
    title: 'Server answers, but the bundle has no readable facts',
    fix: 'Point OKF_ROOT at a real bundle, or scaffold one: samemind init',
  },
  'corpus-mismatch': {
    severity: 'fail', repairable: false,
    title: 'Server reports a different fact count than this checkout reads',
    fix: 'Usually a stale server process or a second bundle. Restart the engine and re-run doctor.',
  },
  'corpus-mismatch-version': {
    severity: 'warn', repairable: false,
    title: 'Fact count differs, but so does the samemind version',
    fix: 'A different version may exclude different files. Align versions before treating this as a bug.',
  },
  'missing-script': {
    severity: 'fail', repairable: false,
    title: 'Configured script path does not exist',
    fix: 'The checkout moved or was deleted. Re-run samemind setup, or point the entry at npx samemind serve.',
  },
  'root-missing': {
    severity: 'fail', repairable: false,
    title: 'OKF_ROOT points at a path that does not exist',
    fix: 'Fix the path (a dangling symlink is the usual cause).',
  },
  'root-not-bundle': {
    severity: 'fail', repairable: false,
    title: 'OKF_ROOT exists but is not a samemind bundle',
    fix: 'A bundle has index.md and concepts/. Run samemind init there, or point elsewhere.',
  },
  'corrupt-config': {
    severity: 'fail', repairable: false,
    title: 'Engine config file could not be parsed',
    fix: 'Repair the JSON by hand. doctor refuses to write to a file it cannot parse.',
  },
  'toml-unsupported': {
    severity: 'warn', repairable: false,
    title: 'TOML entry present but not machine-readable by doctor',
    fix: 'Verify by hand. doctor reports UNKNOWN rather than pretending the entry is absent.',
  },
  'bare-command': {
    severity: 'warn', repairable: false,
    title: 'Launcher is a bare command resolved from PATH',
    fix: "doctor's PATH is this terminal's, not a GUI-launched app's — the app may not find it. Use an absolute path or npx.",
  },
  'npx-command': {
    severity: 'warn', repairable: false,
    title: 'Launcher is npx — the version is not pinned',
    fix: 'npx resolves at launch and its cache can hold several versions or be garbage-collected.',
  },
  'duplicate': {
    severity: 'warn', repairable: false,
    title: 'Several config locations disagree',
    fix: 'Remove the stale entry so one launch command wins predictably.',
  },
  'disabled': {
    severity: 'warn', repairable: false,
    title: 'Entry is present but disabled',
    fix: 'Set enabled: true if you want this engine wired.',
  },
  'not-samemind': {
    severity: 'fail', repairable: false,
    title: 'Something else is registered under the samemind key',
    fix: 'Another MCP server answered. Rename it or fix the entry.',
  },
  'no-tools': {
    severity: 'fail', repairable: false,
    title: 'Handshake succeeded but core memory tools are missing',
    fix: 'The server is too old or not samemind. Update it.',
  },
  'probe-failed': {
    severity: 'fail', repairable: false,
    title: 'MCP server did not answer',
    fix: 'See the probe status for the precise cause.',
  },
  'roots-diverge': {
    severity: 'warn', repairable: false,
    title: 'Your engines are not sharing one memory',
    fix: 'Point every engine at the same bundle, otherwise switching engines loses context.',
  },
  'versions-diverge': {
    severity: 'warn', repairable: false,
    title: 'Your engines run different samemind versions',
    fix: 'Pin one version so every engine behaves the same.',
  },
};

const isBundle = (dir) => existsSync(join(dir, 'index.md')) && existsSync(join(dir, 'concepts'));

/** True when `dir` is a samemind install rather than a memory bundle — the okf.mjs:9 fallback,
 *  caught red-handed. Works even when the expected root is unknown, which is exactly the
 *  no-okf-root case where an equality check has nothing to compare against. */
function isPackageDir(dir) {
  try {
    const pkg = join(dir, 'package.json');
    if (!existsSync(pkg)) return false;
    return JSON.parse(readFileSync(pkg, 'utf8')).name === 'samemind';
  } catch { return false; }
}

const realish = (p) => { try { return realpathSync(p); } catch { return p; } };

// ---------------------------------------------------------------- state predicates

export function checkSupported(engineId) {
  const spec = ENGINE_FILES[engineId];
  if (!spec) return { ok: false, shape: null, hookTier: 'none', readable: false };
  return {
    ok: true,
    shape: spec.mcp?.shape ?? null,
    hookTier: engineHookTier(engineId),
    // No shape means doctor cannot machine-read this engine's config. That is doctor's
    // limitation, not the user's misconfiguration — later states go unknown, never fail.
    readable: Boolean(spec.mcp?.shape),
  };
}

export function checkInstalled(engineId, { home, target, detected, entries }) {
  const evidence = [];
  if (detected.includes(engineId)) {
    for (const f of ENGINE_FILES[engineId]?.files || []) {
      if (existsSync(join(target, f))) evidence.push(join(target, f));
    }
  }
  // User-scope installs leave no project file at all — on a real machine that is the
  // common case, so the presence of the engine's own config counts as evidence.
  for (const e of entries) if (e.found) evidence.push(e.file);
  return { ok: evidence.length > 0, evidence: [...new Set(evidence)] };
}

export function checkConnected(entries, { findings, engine }) {
  const live = entries.filter((e) => e.found);
  const add = (id, detail) => findings.push({ id, engine, detail });

  for (const e of entries) {
    if (e.parseError === 'corrupt-json') add('corrupt-config', e.file);
    else if (e.parseError === 'toml-unsupported') add('toml-unsupported', e.file);
  }
  if (!live.length) return { ok: false, locations: entries.map(publicEntry) };

  for (const e of live) {
    if (e.enabled === false) add('disabled', e.file);
    if (!e.env?.OKF_ROOT) add('no-okf-root', e.file);
    else {
      const root = e.env.OKF_ROOT;
      if (!existsSync(root)) add('root-missing', `${e.file}: ${root}`);
      else if (!isBundle(root) && !isPackageDir(root)) add('root-not-bundle', `${e.file}: ${root}`);
    }
    const script = e.args?.[0];
    if (script && script.startsWith('/') && !existsSync(script)) add('missing-script', `${e.file}: ${script}`);
    if (e.command === 'npx') add('npx-command', e.file);
    else if (e.command && !e.command.includes('/')) add('bare-command', `${e.file}: ${e.command}`);
  }

  const shapes = new Set(live.map((e) => `${e.command}\0${(e.args || []).join('\0')}\0${e.env?.OKF_ROOT || ''}`));
  if (shapes.size > 1) add('duplicate', live.map((e) => e.file).join(' vs '));

  const usable = live.filter((e) => e.enabled !== false && e.command);
  return { ok: usable.length > 0, locations: entries.map(publicEntry) };
}

const publicEntry = (e) => ({
  file: e.file, scope: e.scope, found: e.found,
  command: e.command, args: e.args || [],
  env: redactEnv(e.env || {}),
  enabled: e.enabled, parseError: e.parseError,
});

/**
 * The check the whole command exists for. `tools/list` answering proves the server runs; it
 * does not prove the server found your memory. memory_health computes its answer from a real
 * load() over the filesystem, so it cannot echo a constant back at us.
 */
export function checkCorpus(health, { expectedRoot, localConcepts, serverVersion, ourVersion, engine, findings }) {
  const add = (id, detail) => findings.push({ id, engine, detail });
  if (!health?.root) return { ok: false, checked: false };

  if (isPackageDir(health.root)) { add('serving-package-dir', health.root); return { ok: false, checked: true }; }

  // realpath BOTH sides: ~/.samemind/bundle is a symlink to the real bundle on a real machine,
  // and a naive string compare turns that into a false alarm.
  if (expectedRoot && realish(health.root) !== realish(expectedRoot)) {
    add('root-mismatch', `server=${health.root} config=${expectedRoot}`);
    return { ok: false, checked: true };
  }
  if (health.concepts === 0) { add('empty-corpus', health.root); return { ok: false, checked: true }; }

  if (typeof localConcepts === 'number' && localConcepts !== health.concepts) {
    // A different version may walk/exclude differently, so a count gap is only a defect when
    // both sides are the same version. Otherwise it is a diagnosis, not an alarm.
    add(serverVersion && ourVersion && serverVersion !== ourVersion ? 'corpus-mismatch-version' : 'corpus-mismatch',
      `server=${health.concepts} local=${localConcepts}`);
    return { ok: serverVersion !== ourVersion, checked: true };
  }
  return { ok: true, checked: true };
}

export function checkActive(root, { now = Date.now() } = {}) {
  const health = readHealth(root);
  let intervalSec = 1800;
  try { intervalSec = readProjectionConfig(root)?.intervalSec ?? 1800; } catch { /* default */ }
  const { state } = assessLiveness(health, { intervalSec, now });
  const shown = displayState(state, health);
  return {
    ok: shown === 'ok', state: shown, intervalSec,
    lastError: health?.lastError ?? null, targets: health?.targets ?? [],
  };
}

// ---------------------------------------------------------------- orchestration

function localConceptCount(root) {
  try { return load({ includeSecret: false, includeMirror: true }, root).filter((d) => !d.reserved).length; }
  catch { return null; }
}

function ourVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
}

export async function runDoctor({
  engines = null, home = homedir(), target = process.cwd(),
  root = null, timeoutMs = 10_000, probe = true, now = Date.now(),
} = {}) {
  const findings = [];
  const detected = detectEngines(target);
  const ids = engines?.length ? engines : Object.keys(ENGINE_FILES);
  const version = ourVersion();

  const resolvedRoot = root || (isBundle(target) ? target : null);
  const localCount = resolvedRoot ? localConceptCount(resolvedRoot) : null;

  const probeCache = new Map();      // dedupe: cursor and gemini are often byte-identical
  const results = [];

  for (const id of ids) {
    const supported = checkSupported(id);
    if (!supported.ok) {
      results.push({ id, label: id, states: { supported, installed: skip(), connected: skip(), verified: skip(), active: skip() } });
      continue;
    }
    const entries = supported.readable ? findSamemindEntries(id, { home, target }) : [];
    const installed = checkInstalled(id, { home, target, detected, entries });
    const connected = supported.readable
      ? checkConnected(entries, { findings, engine: id })
      : { ok: false, unknown: true, locations: [] };

    let verified = skip();
    if (connected.ok && probe) {
      const e = entries.find((x) => x.found && x.enabled !== false && x.command);
      const key = `${e.command}\0${(e.args || []).join('\0')}\0${e.env?.OKF_ROOT || ''}`;
      if (!probeCache.has(key)) {
        probeCache.set(key, await probeMcpServer({
          command: e.command, args: e.args || [], env: e.env || {},
          cwd: existsSync(target) ? target : home, timeoutMs,
        }));
      }
      verified = summarizeProbe(probeCache.get(key), {
        engine: id, findings, expectedRoot: e.env?.OKF_ROOT || null,
        localConcepts: e.env?.OKF_ROOT && resolvedRoot && realish(e.env.OKF_ROOT) === realish(resolvedRoot) ? localCount : null,
        ourVersion: version,
      });
    } else if (connected.ok && !probe) {
      verified = { ...skip(), reason: 'probe-skipped' };
    }

    results.push({ id, label: ENGINE_FILES[id]?.label || id, states: { supported, installed, connected, verified, active: skip() } });
  }

  const active = resolvedRoot ? checkActive(resolvedRoot, { now }) : { ok: false, state: 'unknown' };
  for (const r of results) if (r.states.connected.ok) r.states.active = active;

  const consistency = summarizeConsistency(results, findings);
  const summary = tally(results, findings);
  return {
    ok: !findings.some((f) => FINDINGS[f.id]?.severity === 'fail'),
    version, node: process.version, platform: process.platform,
    root: resolvedRoot
      ? { path: resolvedRoot, realpath: realish(resolvedRoot), isBundle: true, concepts: localCount, source: root ? 'flag' : 'cwd' }
      : { path: null, realpath: null, isBundle: false, concepts: null, source: 'unknown' },
    active, engines: results, consistency, summary,
    findings: findings.map((f) => ({ ...f, ...FINDINGS[f.id] })),
  };
}

const skip = () => ({ ok: false, skipped: true });

function summarizeProbe(p, { engine, findings, expectedRoot, localConcepts, ourVersion: ov }) {
  const add = (id, detail) => findings.push({ id, engine, detail });
  const base = {
    status: p.status, durationMs: p.durationMs,
    protocolVersion: p.protocolVersion ?? null, protocolSupported: p.protocolSupported ?? null,
    serverInfo: p.serverInfo ?? null, tools: p.tools ?? null,
    missingCore: p.missingCore ?? [], health: p.health ?? null,
    exitCode: p.exitCode ?? null, spawnError: p.spawnError ?? null,
    stdoutNoise: p.stdoutNoise ?? [], stderrTail: p.stderrTail ?? '',
  };
  if (p.status === PROBE_STATUS.NOT_SAMEMIND) { add('not-samemind', p.serverInfo?.name || '?'); return { ...base, ok: false }; }
  if (p.status === PROBE_STATUS.NO_TOOLS) { add('no-tools', (p.missingCore || []).join(', ')); return { ...base, ok: false }; }
  if (p.status !== PROBE_STATUS.OK) { add('probe-failed', `${p.status}${p.spawnError ? ': ' + p.spawnError.code : ''}`); return { ...base, ok: false }; }

  const missing = CORE_TOOLS.filter((t) => !(p.tools || []).includes(t));
  if (missing.length) { add('no-tools', missing.join(', ')); return { ...base, ok: false, missingCore: missing }; }

  const corpus = checkCorpus(p.health, {
    expectedRoot, localConcepts, serverVersion: p.serverInfo?.version, ourVersion: ov, engine, findings,
  });
  return { ...base, ok: corpus.ok, corpus };
}

function summarizeConsistency(results, findings) {
  const byRoot = new Map(), byVer = new Map();
  for (const r of results) {
    const h = r.states.verified?.health, si = r.states.verified?.serverInfo;
    if (h?.root) { const k = realish(h.root); byRoot.set(k, [...(byRoot.get(k) || []), r.id]); }
    if (si?.version) byVer.set(si.version, [...(byVer.get(si.version) || []), r.id]);
  }
  const roots = [...byRoot].map(([realpath, engines]) => ({ realpath, engines }));
  const versions = [...byVer].map(([version, engines]) => ({ version, engines }));
  if (roots.length > 1) findings.push({ id: 'roots-diverge', engine: null, detail: roots.map((r) => `${r.realpath} (${r.engines.join(',')})`).join(' | ') });
  if (versions.length > 1) findings.push({ id: 'versions-diverge', engine: null, detail: versions.map((v) => `${v.version} (${v.engines.join(',')})`).join(' | ') });
  return { ok: roots.length <= 1 && versions.length <= 1, roots, versions };
}

function tally(results, findings) {
  let pass = 0, skipped = 0;
  for (const r of results) {
    if (r.states.verified?.ok) pass++;
    else if (r.states.verified?.skipped) skipped++;
  }
  return {
    pass, skipped,
    warn: findings.filter((f) => FINDINGS[f.id]?.severity === 'warn').length,
    fail: findings.filter((f) => FINDINGS[f.id]?.severity === 'fail').length,
  };
}

// ---------------------------------------------------------------- repair

/** The single auto-fix: a missing OKF_ROOT, which is the silent failure itself. Everything
 *  else stays advisory — rewriting a launcher is a policy call doctor cannot make correctly,
 *  and TOML has no writer here on purpose. */
export function planRepair(report, { root = null } = {}) {
  const WRITABLE = new Set(['mcpServers', 'mcpServers-nested', 'vscode-servers', 'opencode']);
  const candidates = new Set();
  if (root) candidates.add(root);
  else {
    if (report.root?.path) candidates.add(report.root.path);
    for (const e of report.engines) {
      for (const l of e.states.connected?.locations || []) {
        if (l.found && l.env?.OKF_ROOT && isBundle(l.env.OKF_ROOT)) candidates.add(l.env.OKF_ROOT);
      }
    }
  }
  const roots = [...candidates].filter(isBundle);
  if (roots.length !== 1) return { plans: [], ambiguous: roots.length > 1, candidates: roots };

  const to = roots[0];
  const plans = [];
  for (const e of report.engines) {
    if (!WRITABLE.has(e.states.supported?.shape)) continue;
    for (const l of e.states.connected?.locations || []) {
      if (l.found && !l.env?.OKF_ROOT && !l.parseError) plans.push({ action: 'set-okf-root', engine: e.id, file: l.file, shape: e.states.supported.shape, to });
    }
  }
  return { plans, ambiguous: false, candidates: roots };
}

export function applyRepair(plan) {
  const envKey = plan.shape === 'opencode' ? 'environment' : 'env';
  const container = { 'mcpServers': 'mcpServers', 'mcpServers-nested': 'mcpServers', 'vscode-servers': 'servers', 'opencode': 'mcp' }[plan.shape];
  let changed = false;
  // mergeJsonFile gives backup + hard refusal on corrupt JSON + atomic write. The mutator
  // touches exactly one leaf, so every foreign MCP server survives by construction.
  const res = mergeJsonFile(plan.file, (cfg) => {
    const node = cfg?.[container]?.samemind;
    if (!node) return cfg;
    node[envKey] = node[envKey] || {};
    if (node[envKey].OKF_ROOT !== plan.to) { node[envKey].OKF_ROOT = plan.to; changed = true; }
    return cfg;
  });
  return { ok: res !== false, changed, file: plan.file };
}

// ---------------------------------------------------------------- render + CLI

// `failed`/`stale` come from status.mjs displayState; `fail`/`warn` from FINDINGS severity.
const ICON = { ok: '✅', fail: '❌', failed: '❌', warn: '⚠️', stale: '⚠️', skip: '⬜', unknown: '❓' };

function render(r) {
  const out = [];
  out.push('samemind doctor');
  out.push(`  version ${r.version} · node ${r.node} · ${r.platform}`);
  out.push(`  bundle  ${r.root.path || '(not resolved — pass --root)'}${r.root.concepts != null ? ` · ${r.root.concepts} facts` : ''}`);
  out.push(`  health  ${ICON[r.active.state] || ICON.unknown} ${r.active.state}`);
  out.push('');
  for (const e of r.engines) {
    if (!e.states.supported.ok) continue;
    const s = e.states;
    const mark = s.verified?.ok ? ICON.ok : s.verified?.skipped ? ICON.skip : ICON.fail;
    const bits = [
      `installed:${s.installed.ok ? 'yes' : 'no'}`,
      `connected:${s.connected.unknown ? 'unknown' : s.connected.ok ? 'yes' : 'no'}`,
      `verified:${s.verified?.ok ? 'yes' : s.verified?.skipped ? '—' : (s.verified?.status || 'no')}`,
      `hooks:${s.supported.hookTier}`,
    ];
    out.push(`${mark} ${e.label.padEnd(22)} ${bits.join('  ')}`);
    if (s.verified?.health?.root) out.push(`     root ${s.verified.health.root} · ${s.verified.health.concepts} facts`);
  }
  if (r.findings.length) {
    out.push('');
    out.push('Findings:');
    for (const f of r.findings) {
      out.push(`  ${ICON[f.severity] || '•'} [${f.engine || 'global'}] ${f.title}`);
      if (f.detail) out.push(`      ${f.detail}`);
      out.push(`      → ${f.fix}`);
    }
  }
  if (!r.consistency.ok && r.consistency.roots.length > 1) {
    out.push('');
    out.push('  Your engines are not sharing one memory:');
    for (const g of r.consistency.roots) out.push(`    ${g.realpath} ← ${g.engines.join(', ')}`);
  }
  out.push('');
  out.push(`Summary: ${r.summary.pass} verified · ${r.summary.warn} warnings · ${r.summary.fail} failures · ${r.summary.skipped} skipped`);
  return out.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const engines = [];
  let json = false, repair = false, probe = true, timeoutMs = 10_000, root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') engines.push(argv[++i]);
    else if (a === '--json') json = true;
    else if (a === '--repair') repair = true;
    else if (a === '--no-probe') probe = false;
    else if (a === '--root') root = resolve(argv[++i]);
    else if (a === '--timeout') timeoutMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else { console.error(`doctor: unknown flag ${a}\n${USAGE}`); return 1; }
  }

  const report = await runDoctor({ engines, root, timeoutMs, probe });

  if (repair) {
    const { plans, ambiguous, candidates } = planRepair(report, { root });
    if (ambiguous) {
      console.error(`doctor --repair: several candidate bundles, refusing to guess:\n  ${candidates.join('\n  ')}\nPass --root <bundle>.`);
      return 1;
    }
    for (const p of plans) {
      const res = applyRepair(p);
      console.log(`${res.changed ? 'repaired' : 'unchanged'}: ${p.engine} → OKF_ROOT=${p.to} (${p.file})`);
    }
    if (!plans.length) console.log('repair: nothing safely auto-fixable; see Findings.');
  }

  if (json) console.log(JSON.stringify({ contract: 1, kind: 'doctor', generatedAt: new Date().toISOString(), data: report }, null, 2));
  else console.log(render(report));
  return report.ok ? 0 : 1;
}

const USAGE = `samemind doctor — prove each engine can actually reach your memory

  samemind doctor [--engine <id>]... [--root <dir>] [--json] [--repair] [--no-probe] [--timeout <ms>]

  --engine <id>   check only these engines (repeatable)
  --root <dir>    the bundle engines should be serving
  --json          machine-readable report (contract: 1), safe to paste — env values are redacted
  --repair        fix a missing OKF_ROOT; refuses when the intended bundle is ambiguous
  --no-probe      skip spawning servers (config-only, offline)
  --timeout <ms>  per-probe deadline (default 10000)

Exit 0 when nothing failed, 1 otherwise.`;

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c));

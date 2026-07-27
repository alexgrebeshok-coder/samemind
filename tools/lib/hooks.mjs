// hooks.mjs — Ф4-C: lifecycle-hook bundle + tier-detect for samemind's memory protocol.
//
// Honesty gate (market research: "works out of the box" is only true where the engine ITSELF
// exposes lifecycle hooks — see docs/hooks/, docs/compaction-recipe.md for prior art). Three tiers:
//
//   'auto'       — engine has scriptable session-lifecycle hooks samemind can wire in for real:
//     - claude-code: .claude/settings.json `hooks` — SessionStart/UserPromptSubmit/Stop/
//       SessionEnd/PreCompact/… event-array shape, "command" (+ native "mcp_tool") hook types.
//       Verified against code.claude.com/docs/en/hooks.md (2026-07).
//     - codex: hooks.json (or inline `[hooks]` in config.toml) — SAME event-array shape as
//       Claude Code (SessionStart/SessionEnd/PreToolUse/PostToolUse/UserPromptSubmit/Stop),
//       "command" hook type. Verified against developers.openai.com/codex/hooks (2026-07).
//     - opencode: no declarative hook JSON (yet) — a JS/TS plugin's `event` hook reacting to
//       session.created/session.idle is the real lifecycle signal, but it is plugin CODE, not
//       config, and — per github.com/sst/opencode/issues/5409 (open as of 2026-07) — misses
//       `--continue`/resume and has no 1:1 SessionStart/SessionEnd. Wired as best-effort, not a
//       port of Claude Code's hook names — see hook-templates/opencode-plugin.js.
//
//   'projection' — every other engine `samemind install` already covers (tools/install.mjs
//     ENGINE_FILES: cursor, gemini-cli, copilot, cline, roo, windsurf, goose, kiro, antigravity):
//     no lifecycle-hook API is known to exist for any of them — only a context file the engine
//     reads on its own, which install.mjs already writes. Promising a hook here would be
//     promising a capability these engines don't have.
//
//   'none'       — an engine id samemind doesn't know about at all (not even ENGINE_FILES).
//
// installHooks() never touches a real machine file outside tests — see tools/hooks.test.mjs
// (everything runs against a tmpdir target). Real ~/.claude/settings.json is NEVER written by
// this module's own test suite.
import {
  existsSync, mkdirSync, readFileSync,
} from 'node:fs';
import {
  dirname, join, resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { mergeJsonFile } from './global-json-merge.mjs';
import { ENGINE_FILES } from '../install.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, 'hook-templates');

/** Explicit tier for engines whose hook capability is verified one way or the other; any
 * engine id NOT listed here falls back to 'projection' (if install.mjs knows it) or 'none'
 * (never heard of it) — see engineHookTier(). */
const HOOK_TIER = {
  'claude-code': 'auto',
  codex: 'auto',
  opencode: 'auto',
};

export function engineHookTier(engineId) {
  if (HOOK_TIER[engineId]) return HOOK_TIER[engineId];
  return ENGINE_FILES[engineId] ? 'projection' : 'none';
}

function noHooksMessage(engineId) {
  const tier = engineHookTier(engineId);
  if (tier === 'none') {
    return `unknown engine "${engineId}" — no hook support and no instruction-file support known; see \`samemind install --list\``;
  }
  const label = ENGINE_FILES[engineId]?.label || engineId;
  return `${label} has no known lifecycle-hook API — it only reads a context file on its own; `
    + `use \`samemind install --agent ${engineId}\` (or \`samemind project\`) instead of hooks`;
}

function readTemplate(name) {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8');
}

/** Plain text placeholder substitution (no eval) — ${CLI}/${ROOT}/${ENGINE} in every template. */
function render(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`\${${k}}`, v);
  return out;
}

/** claude-code and codex currently share the exact same settings-file hook shape (see module
 * header) — only the target file differs. */
const JSON_HOOK_FILE = {
  'claude-code': '.claude/settings.json',
  codex: '.codex/hooks.json',
};

/**
 * Renders the hook payload for one 'auto'-tier engine. Non-auto engines get
 * { ok:false, tier, message } instead of a payload — never throws.
 */
export function buildHooks(engineId, { root = '.' } = {}) {
  const tier = engineHookTier(engineId);
  if (tier !== 'auto') {
    return {
      engine: engineId, tier, ok: false, message: noHooksMessage(engineId),
    };
  }
  const vars = { CLI: 'npx samemind', ROOT: resolve(root), ENGINE: engineId };

  if (engineId === 'opencode') {
    return {
      engine: engineId,
      tier,
      ok: true,
      format: 'opencode-plugin-js',
      file: '.opencode/plugins/samemind-hooks.js',
      content: render(readTemplate('opencode-plugin.js'), vars),
    };
  }

  return {
    engine: engineId,
    tier,
    ok: true,
    format: 'hooks-json',
    file: JSON_HOOK_FILE[engineId],
    hooks: {
      SessionStart: JSON.parse(render(readTemplate('session-start.json'), vars)),
      SessionEnd: JSON.parse(render(readTemplate('session-end.json'), vars)),
    },
  };
}

/** A hook-group entry counts as "ours" if any inner hooks[].command mentions samemind — content-
 * based, not a sentinel field (adding an unrecognized field to survive a strict hook-schema
 * validator isn't a risk worth taking in someone else's settings.json/hooks.json).
 * ponytail: heuristic dedupe by command substring, not a stable id — a user hook whose OWN
 * command happens to mention "samemind" would be treated as ours on the next install; edge case,
 * not worth a sentinel-field workaround here. */
function isOurEntry(entry) {
  return Array.isArray(entry?.hooks)
    && entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes('samemind'));
}

/** In place: replace samemind's own previous entries for `eventName`, keep every foreign one. */
function mergeHooksEvent(hooksObj, eventName, ourEntries) {
  const existing = Array.isArray(hooksObj[eventName]) ? hooksObj[eventName] : [];
  const foreign = existing.filter(e => !isOurEntry(e));
  hooksObj[eventName] = [...foreign, ...ourEntries];
}

/**
 * Idempotently installs the lifecycle hooks for `engineId` under `targetDir`.
 * - 'auto' + claude-code/codex: JSON merge into `.claude/settings.json` / `.codex/hooks.json`
 *   via mergeJsonFile (backup + corrupt-JSON safety already built in) — only `hooks.SessionStart`
 *   / `hooks.SessionEnd` are touched, every other key (and every foreign hook) is preserved.
 * - 'auto' + opencode: the plugin file is wholly samemind's own — (re)written in full each call;
 *   idempotent means "same input → byte-identical file", not marker-merge.
 * - 'projection'/'none': no-op, returns { ok:false, tier, message }.
 * Never touches anything outside `targetDir` — safe to point at a tmpdir in tests.
 */
export function installHooks(engineId, { targetDir = '.', root } = {}) {
  const tier = engineHookTier(engineId);
  if (tier !== 'auto') {
    return {
      ok: false, engine: engineId, tier, message: noHooksMessage(engineId),
    };
  }

  const dir = resolve(targetDir);
  const effectiveRoot = root ? resolve(root) : dir;
  const built = buildHooks(engineId, { root: effectiveRoot });
  const abs = join(dir, built.file);
  mkdirSync(dirname(abs), { recursive: true });

  if (engineId === 'opencode') {
    const existed = existsSync(abs);
    atomicWriteFileSync(abs, built.content);
    return {
      ok: true, engine: engineId, tier, file: built.file, created: !existed, replaced: existed,
    };
  }

  const existedBefore = existsSync(abs);
  const res = mergeJsonFile(abs, cfg => {
    cfg.hooks = cfg.hooks || {};
    for (const [eventName, entries] of Object.entries(built.hooks)) {
      mergeHooksEvent(cfg.hooks, eventName, entries);
    }
    return cfg;
  });
  if (!res.ok) {
    return {
      ok: false, engine: engineId, tier, file: built.file, reason: res.reason,
    };
  }
  return {
    ok: true, engine: engineId, tier, file: built.file, created: !existedBefore, replaced: existedBefore,
  };
}

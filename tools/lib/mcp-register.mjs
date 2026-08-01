// mcp-register.mjs — plans or applies the samemind MCP-server registration for a target engine,
// for `setup`/`setup --global` (U-B / G-A). Only claude-code ever gets anything WRITTEN here.
//
// scope:'project' (default) — idempotent `.mcp.json` merge under `target`, same
// {mcpServers:{...}} shape docs/adapters.md already documents for every other engine.
//
// scope:'user' — global registration (one machine, every project): tries the native
// `claude mcp add --scope user` first (respects whatever claude-code's own config format/location
// actually is); only if that binary is missing or errors does it fall back to merging
// `{mcpServers:{samemind:...}}` into the user's own `~/.claude.json` by hand (mergeJsonFile,
// tools/lib/global-json-merge.mjs) — that file already carries other real MCP servers
// (exa/context7/playwright) which the merge must never clobber.
//
// Every other engine returns a hint string only — its own native config format
// (`.cursor/mcp.json`, `~/.gemini/settings.json`, `codex mcp add`, …) isn't ours to author blind,
// so we point at the documented command/file instead of guessing project layout.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { mergeJsonFile } from './global-json-merge.mjs';
import { ENGINE_FILES } from '../install.mjs';

const SERVER_ENTRY = { command: 'npx', args: ['samemind', 'serve'] };

/**
 * The entry we actually write. The bare SERVER_ENTRY carries no `env`, so the server's root
 * came from whatever cwd the engine happened to launch with — and when that was not a bundle,
 * `lib/okf.mjs` fell back to the installed package directory. The result was a server that
 * answered `tools/list` with all ten tools while holding zero facts, with nothing reporting a
 * problem. Pinning OKF_ROOT at registration time is what closes that hole.
 */
function serverEntryFor(root) {
  return root ? { ...SERVER_ENTRY, env: { OKF_ROOT: root } } : SERVER_ENTRY;
}
const CLAUDE_CODE_APPLY_CMD = 'claude mcp add samemind -- npx samemind serve';
const CLAUDE_CODE_USER_APPLY_CMD = 'claude mcp add --scope user samemind -- npx samemind serve';

/** Valid MCP-config shapes; a descriptor's `shape` (ENGINE_FILES[id].mcp) must be one of these or null. */
export const MCP_SHAPES = ['mcpServers', 'mcpServers-nested', 'vscode-servers', 'opencode', 'codex-toml'];

/** Registration hint from the descriptor (ENGINE_FILES[id].mcp) — the same single source `samemind
 *  doctor` reads, not a second map. `hint` overrides generation for CLI engines; null → generic. */
function mcpHint(engineId) {
  const m = ENGINE_FILES[engineId]?.mcp;
  if (!m) return `no MCP auto-registration hint for "${engineId}" yet — see docs/adapters.md`;
  if (m.hint) return m.hint;
  const key = { 'mcpServers': 'mcpServers', 'mcpServers-nested': 'mcpServers', 'vscode-servers': 'servers', 'opencode': 'mcp' }[m.shape];
  const server = m.shape === 'opencode' ? { type: 'local', command: ['npx', 'samemind', 'serve'], enabled: true } : SERVER_ENTRY;
  return `${[...new Set([...(m.user || []), ...(m.project || [])])].join(' or ')} → ${JSON.stringify({ [key]: { samemind: server } })}`;
}

/** scope:'user' fallback — merges {mcpServers:{samemind:...}} into userConfigPath, preserving
 *  every other key/server already there. Corrupt JSON → left byte-for-byte untouched. */
function registerUserScopeViaJsonMerge(userConfigPath, root = null) {
  const res = mergeJsonFile(userConfigPath, cfg => {
    cfg.mcpServers = { ...(cfg.mcpServers || {}), samemind: serverEntryFor(root) };
    return cfg;
  });
  if (!res.ok) {
    return `${userConfigPath} has invalid JSON — left untouched (backup attempted); fix it by hand, then run: ${CLAUDE_CODE_USER_APPLY_CMD}`;
  }
  return `wrote samemind → ${userConfigPath} (mcpServers, user scope — \`claude\` CLI not available for native registration)`;
}

/**
 * Plans or applies samemind's MCP registration for `engine` under `target`.
 *
 * claude-code, scope:'project' (default): `apply:true` idempotently merges
 * `{mcpServers:{samemind:{command:"npx",args:["samemind","serve"]}}}` into `<target>/.mcp.json`
 * (existing file/other keys preserved, atomic write — repeat calls just reset the same key,
 * never duplicate it). `apply:false` (default) writes nothing and returns a plan string.
 *
 * claude-code, scope:'user': `apply:true` first tries the native
 * `claude mcp add --scope user samemind -- npx samemind serve` (via `spawnSyncImpl`, injectable
 * for tests — defaults to the real `node:child_process` spawnSync) — but ONLY when
 * `allowNative` is true. If that binary is missing, exits non-zero, or `allowNative` is false,
 * falls back to merging the same entry into `userConfigPath` (default `~/.claude.json`,
 * parameterized for test isolation — the real file already carries other MCP servers, e.g.
 * exa/context7/playwright, which the merge preserves). `apply:false` returns a plan string
 * without running or writing anything.
 *
 * `allowNative` (default true) exists because native `claude mcp add --scope user` writes to
 * *the real machine's* user-scope config — it has no concept of `userConfigPath` and does not
 * consult it. A caller that has pointed `userConfigPath` at some other (e.g. test-fixture) file
 * MUST also pass `allowNative: false`, or the native command silently registers samemind against
 * the real ~/.claude.json instead of the intended target regardless of `userConfigPath`
 * (incident: a fake --home in setup.mjs without this guard still hit the real file — see
 * runGlobalSetup, which derives `allowNative` from comparing the effective home against
 * `os.userInfo().homedir`, never from `userConfigPath` itself).
 *
 * Any other engine id: always returns a hint string (built from its ENGINE_FILES descriptor
 * via mcpHint, or a generic "see docs/adapters.md" fallback for an id with `mcp: null` / not
 * in the table) and never writes anything, regardless of `apply`/`scope`.
 */
export function ensureMcpRegistered(engine, target, {
  apply = false,
  scope = 'project',
  userConfigPath = join(homedir(), '.claude.json'),
  spawnSyncImpl = spawnSync,
  allowNative = true,
  root = null,
} = {}) {
  if (engine !== 'claude-code') {
    return mcpHint(engine);
  }

  if (scope === 'user') {
    if (!apply) {
      return `would register samemind as a user-scope MCP server (or run: ${CLAUDE_CODE_USER_APPLY_CMD})`;
    }
    if (allowNative) {
      let native;
      // `-e OKF_ROOT=…` for the same reason serverEntryFor exists: without a pinned root the
      // server resolves one from cwd and can silently serve its own package directory.
      const envArgs = root ? ['-e', `OKF_ROOT=${root}`] : [];
      try {
        native = spawnSyncImpl('claude', ['mcp', 'add', '--scope', 'user', ...envArgs, 'samemind', '--', 'npx', 'samemind', 'serve'], { encoding: 'utf8' });
      } catch (e) {
        native = { error: e };
      }
      if (native && !native.error && native.status === 0) {
        return 'registered samemind as a user-scope MCP server via `claude mcp add --scope user`';
      }
    }
    return registerUserScopeViaJsonMerge(userConfigPath, root);
  }

  if (!apply) {
    return `would add samemind to .mcp.json (or run: ${CLAUDE_CODE_APPLY_CMD})`;
  }

  const mcpPath = join(target, '.mcp.json');
  let config = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { config = {}; }
  }
  config.mcpServers = { ...(config.mcpServers || {}), samemind: serverEntryFor(target) };
  atomicWriteFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
  return 'wrote samemind → .mcp.json';
}

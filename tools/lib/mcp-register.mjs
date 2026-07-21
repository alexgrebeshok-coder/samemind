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

const SERVER_ENTRY = { command: 'npx', args: ['samemind', 'serve'] };
const CLAUDE_CODE_APPLY_CMD = 'claude mcp add samemind -- npx samemind serve';
const CLAUDE_CODE_USER_APPLY_CMD = 'claude mcp add --scope user samemind -- npx samemind serve';

/** Non-claude-code engines: registration hint only (see docs/adapters.md) — never written here. */
const ENGINE_MCP_HINTS = {
  cursor: '.cursor/mcp.json (project) or ~/.cursor/mcp.json (user) → {"mcpServers":{"samemind":{"command":"npx","args":["samemind","serve"]}}}',
  codex: 'codex mcp add samemind -- npx samemind serve',
  'gemini-cli': '~/.gemini/settings.json or .gemini/settings.json → {"mcpServers":{"samemind":{"command":"npx","args":["samemind","serve"]}}}',
  cline: '~/.cline/mcp.json (or cline_mcp_settings.json) → {"mcpServers":{"samemind":{"command":"npx","args":["samemind","serve"]}}}',
  roo: '.roo/mcp.json (project) or global mcp_settings.json → {"mcpServers":{"samemind":{"command":"npx","args":["samemind","serve"]}}}',
  windsurf: '~/.codeium/windsurf/mcp_config.json → {"mcpServers":{"samemind":{"command":"npx","args":["samemind","serve"]}}}',
  goose: 'goose configure → Add Extension → Command-Line Extension → command npx, args "samemind serve"',
  kiro: 'kiro-cli mcp add --name samemind --command npx --args "samemind serve"',
  copilot: 'VS Code mcp.json → server "samemind": command npx, args ["samemind","serve"]',
  opencode: 'opencode.json mcp block → "samemind": {"command": ["npx","samemind","serve"]}',
  antigravity: 'no native MCP registration file yet — AGENTS.md/GEMINI.md context only',
};

/** scope:'user' fallback — merges {mcpServers:{samemind:...}} into userConfigPath, preserving
 *  every other key/server already there. Corrupt JSON → left byte-for-byte untouched. */
function registerUserScopeViaJsonMerge(userConfigPath) {
  const res = mergeJsonFile(userConfigPath, cfg => {
    cfg.mcpServers = { ...(cfg.mcpServers || {}), samemind: SERVER_ENTRY };
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
 * for tests — defaults to the real `node:child_process` spawnSync). If that binary is missing or
 * exits non-zero, falls back to merging the same entry into `userConfigPath` (default
 * `~/.claude.json`, parameterized for test isolation — the real file already carries other MCP
 * servers, e.g. exa/context7/playwright, which the merge preserves). `apply:false` returns a
 * plan string without running or writing anything.
 *
 * Any other engine id: always returns a hint string (from ENGINE_MCP_HINTS, or a generic
 * "see docs/adapters.md" fallback for an id not in that table) and never writes anything,
 * regardless of `apply`/`scope`.
 */
export function ensureMcpRegistered(engine, target, {
  apply = false,
  scope = 'project',
  userConfigPath = join(homedir(), '.claude.json'),
  spawnSyncImpl = spawnSync,
} = {}) {
  if (engine !== 'claude-code') {
    return ENGINE_MCP_HINTS[engine] || `no MCP auto-registration hint for "${engine}" yet — see docs/adapters.md`;
  }

  if (scope === 'user') {
    if (!apply) {
      return `would register samemind as a user-scope MCP server (or run: ${CLAUDE_CODE_USER_APPLY_CMD})`;
    }
    let native;
    try {
      native = spawnSyncImpl('claude', ['mcp', 'add', '--scope', 'user', 'samemind', '--', 'npx', 'samemind', 'serve'], { encoding: 'utf8' });
    } catch (e) {
      native = { error: e };
    }
    if (native && !native.error && native.status === 0) {
      return 'registered samemind as a user-scope MCP server via `claude mcp add --scope user`';
    }
    return registerUserScopeViaJsonMerge(userConfigPath);
  }

  if (!apply) {
    return `would add samemind to .mcp.json (or run: ${CLAUDE_CODE_APPLY_CMD})`;
  }

  const mcpPath = join(target, '.mcp.json');
  let config = {};
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { config = {}; }
  }
  config.mcpServers = { ...(config.mcpServers || {}), samemind: SERVER_ENTRY };
  atomicWriteFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
  return 'wrote samemind → .mcp.json';
}

// mcp-register.mjs — plans or applies the samemind MCP-server registration for a target engine,
// for a future `setup` command (U-B). Only claude-code ever gets a file WRITTEN here (idempotent
// `.mcp.json` merge, same {mcpServers:{...}} shape docs/adapters.md already documents for every
// other engine); every other engine returns a hint string only — its own native config format
// (`.cursor/mcp.json`, `~/.gemini/settings.json`, `codex mcp add`, …) isn't ours to author blind,
// so we point at the documented command/file instead of guessing project layout.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

const SERVER_ENTRY = { command: 'npx', args: ['samemind', 'serve'] };
const CLAUDE_CODE_APPLY_CMD = 'claude mcp add samemind -- npx samemind serve';

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

/**
 * Plans or applies samemind's MCP registration for `engine` under `target`.
 *
 * claude-code: `apply:true` idempotently merges `{mcpServers:{samemind:{command:"npx",
 * args:["samemind","serve"]}}}` into `<target>/.mcp.json` (existing file/other keys preserved,
 * atomic write — repeat calls just reset the same key, never duplicate it). `apply:false`
 * (default) writes nothing and returns a plan string.
 *
 * Any other engine id: always returns a hint string (from ENGINE_MCP_HINTS, or a generic
 * "see docs/adapters.md" fallback for an id not in that table) and never writes anything,
 * regardless of `apply`.
 */
export function ensureMcpRegistered(engine, target, { apply = false } = {}) {
  if (engine !== 'claude-code') {
    return ENGINE_MCP_HINTS[engine] || `no MCP auto-registration hint for "${engine}" yet — see docs/adapters.md`;
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

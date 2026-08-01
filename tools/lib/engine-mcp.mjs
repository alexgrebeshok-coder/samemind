// engine-mcp.mjs — read/normalize samemind MCP entries from engine config files (doctor eyes).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ENGINE_FILES } from '../install.mjs';

const SERVER_NAME = 'samemind';

export const SHOWN_ENV_KEYS = new Set([
  'OKF_ROOT',
  'OKF_GLOBAL_ROOT',
  'OKF_EMBED_MODEL',
  'OKF_INDEX_BACKEND',
  'SAMEMIND_AGENT',
  'NODE_ENV',
]);

/** @returns {import('node:buffer').BufferEncoding} */
function byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

function redactUrlValue(val) {
  try {
    const u = new URL(String(val));
    let port = u.port;
    if (!port) {
      if (u.protocol === 'https:') port = '443';
      else if (u.protocol === 'http:') port = '80';
    }
    const host = port ? `${u.hostname}:${port}` : u.hostname;
    return `${u.protocol}//${host}`;
  } catch {
    return '<url>';
  }
}

export function redactEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const key of Object.keys(env)) {
    const raw = env[key];
    if (SHOWN_ENV_KEYS.has(key)) {
      out[key] = raw == null ? '' : String(raw);
    } else if (key.endsWith('_URL')) {
      out[key] = raw === '' || raw == null ? '<empty>' : redactUrlValue(raw);
    } else if (raw === '' || raw == null) {
      out[key] = '<empty>';
    } else {
      out[key] = `<set:${byteLen(raw)}>`;
    }
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubValues(text, env) {
  if (!text || !env || typeof env !== 'object') return text;
  let out = String(text);
  for (const [key, val] of Object.entries(env)) {
    if (SHOWN_ENV_KEYS.has(key)) continue;
    if (val == null || val === '') continue;
    const escaped = escapeRegExp(String(val));
    if (escaped) out = out.split(escaped).join('<redacted>');
  }
  return out;
}

/**
 * Minimal TOML scanner for Codex `[mcp_servers.<name>]` blocks — not a full parser.
 * @returns {{ servers: Record<string, { command?: string, args?: string[], env?: Record<string, string> }>, unsupported: { line: number, text: string }[] }}
 */
export function parseTomlMcpServers(text) {
  const servers = {};
  const unsupported = [];
  let current = null;
  let inEnv = false;

  const ensure = (name) => {
    if (!servers[name]) servers[name] = { env: {} };
    return servers[name];
  };

  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const header = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (header) {
      const rest = header[1];
      if (rest.endsWith('.env')) {
        current = rest.slice(0, -4);
        inEnv = true;
        ensure(current);
      } else {
        current = rest;
        inEnv = false;
        ensure(current);
      }
      continue;
    }

    if (/^\[mcp_servers\]\s*$/.test(trimmed)) {
      current = '__parent__';
      inEnv = false;
      continue;
    }

    if (current === '__parent__' && /^\s*samemind\s*=\s*\{/.test(line)) {
      unsupported.push({ line: lineNum, text: trimmed });
      continue;
    }

    if (!current || current === '__parent__') continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let rawVal = trimmed.slice(eq + 1).trim();

    if (rawVal.startsWith('[')) {
      const collected = [rawVal];
      let depth = rawVal.split('[').length - 1 - (rawVal.split(']').length - 1);
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const next = lines[i].trim();
        collected.push(next);
        for (const ch of next) {
          if (ch === '[') depth++;
          if (ch === ']') depth--;
        }
      }
      rawVal = collected.join('\n');
    }

    if (inEnv) {
      const v = parseTomlString(rawVal);
      if (v !== undefined) {
        const s = ensure(current);
        s.env[key] = v;
      }
      continue;
    }

    if (key === 'command') {
      const arr = parseTomlStringArray(rawVal);
      if (arr) {
        const s = ensure(current);
        s.command = arr[0];
        s.args = arr.slice(1);
      } else {
        const v = parseTomlString(rawVal);
        if (v !== undefined) ensure(current).command = v;
      }
    } else if (key === 'args') {
      const arr = parseTomlStringArray(rawVal);
      if (arr) ensure(current).args = arr;
    } else if (rawVal.startsWith('{')) {
      unsupported.push({ line: lineNum, text: trimmed });
    }
  }

  return { servers, unsupported };
}

function parseTomlString(raw) {
  const m = raw.match(/^"((?:\\.|[^"\\])*)"\s*$/);
  if (!m) return undefined;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseTomlStringArray(raw) {
  const t = raw.trim();
  if (!t.startsWith('[')) return null;
  const inner = t.slice(1, t.lastIndexOf(']'));
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return out.length ? out : null;
}

function emptyEntry(engine, scope, file) {
  return {
    engine,
    scope,
    file,
    found: false,
    command: null,
    args: [],
    env: {},
    enabled: null,
    parseError: null,
  };
}

function filledEntry(engine, scope, file, raw, { enabled = null } = {}) {
  let command = null;
  let args = [];
  let env = {};
  if (Array.isArray(raw.command)) {
    command = raw.command[0] ?? null;
    args = raw.command.slice(1);
  } else {
    command = raw.command ?? null;
    args = Array.isArray(raw.args) ? [...raw.args] : [];
  }
  if (raw.environment && typeof raw.environment === 'object') env = { ...raw.environment };
  else if (raw.env && typeof raw.env === 'object') env = { ...raw.env };
  const enabledVal = enabled ?? (typeof raw.enabled === 'boolean' ? raw.enabled : null);
  return {
    engine,
    scope,
    file,
    found: true,
    command,
    args,
    env,
    enabled: enabledVal,
    parseError: null,
  };
}

function fromMcpServerBlock(engine, scope, file, block) {
  if (!block || typeof block !== 'object') return emptyEntry(engine, scope, file);
  return filledEntry(engine, scope, file, block);
}

function extractNested(engine, scope, file, cfg, absTarget) {
  const out = [];
  const top = cfg?.mcpServers?.[SERVER_NAME];
  const nested = cfg?.projects?.[absTarget]?.mcpServers?.[SERVER_NAME];
  if (top) out.push(fromMcpServerBlock(engine, scope, file, top));
  if (nested) out.push(fromMcpServerBlock(engine, scope, file, nested));
  if (!out.length) out.push(emptyEntry(engine, scope, file));
  return out;
}

function readFileEntries(engine, scope, file, shape, absTarget) {
  if (!existsSync(file)) {
    return [emptyEntry(engine, scope, file)];
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    const e = emptyEntry(engine, scope, file);
    e.parseError = 'unreadable';
    return [e];
  }

  if (shape === 'codex-toml') {
    const { servers, unsupported } = parseTomlMcpServers(text);
    const hasSamemindInline = unsupported.some(u => /samemind\s*=/.test(u.text));
    const sam = servers[SERVER_NAME];
    const hasHeader = SERVER_NAME in servers;
    const hasCommand = Boolean(sam?.command);
    if (hasSamemindInline || (hasHeader && !hasCommand)) {
      const e = emptyEntry(engine, scope, file);
      e.parseError = 'toml-unsupported';
      return [e];
    }
    if (hasCommand) {
      return [filledEntry(engine, scope, file, {
        command: sam.command,
        args: sam.args || [],
        env: sam.env || {},
      })];
    }
    return [emptyEntry(engine, scope, file)];
  }

  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    const e = emptyEntry(engine, scope, file);
    e.parseError = 'corrupt-json';
    return [e];
  }

  if (shape === 'mcpServers-nested') {
    return extractNested(engine, scope, file, cfg, absTarget);
  }
  if (shape === 'mcpServers') {
    const block = cfg?.mcpServers?.[SERVER_NAME];
    if (block) return [fromMcpServerBlock(engine, scope, file, block)];
    return [emptyEntry(engine, scope, file)];
  }
  if (shape === 'vscode-servers') {
    const block = cfg?.servers?.[SERVER_NAME];
    if (block) return [fromMcpServerBlock(engine, scope, file, block)];
    return [emptyEntry(engine, scope, file)];
  }
  if (shape === 'opencode') {
    const block = cfg?.mcp?.[SERVER_NAME];
    if (block) return [fromMcpServerBlock(engine, scope, file, block)];
    return [emptyEntry(engine, scope, file)];
  }

  return [emptyEntry(engine, scope, file)];
}

/**
 * @param {string} engineId
 * @param {{ home?: string, target?: string }} [opts]
 */
export function findSamemindEntries(engineId, { home = homedir(), target = process.cwd() } = {}) {
  const meta = ENGINE_FILES[engineId];
  if (!meta?.mcp?.shape) return [];

  const shape = meta.mcp.shape;
  const absTarget = resolve(target);
  const entries = [];

  for (const rel of meta.mcp.user || []) {
    const file = join(home, rel);
    entries.push(...readFileEntries(engineId, 'user', file, shape, absTarget));
  }
  for (const rel of meta.mcp.project || []) {
    const file = join(target, rel);
    entries.push(...readFileEntries(engineId, 'project', file, shape, absTarget));
  }
  return entries;
}

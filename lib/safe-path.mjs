// safe-path.mjs — санитизация имён файлов (path traversal guard).
import { basename, resolve, sep } from 'node:path';

const AGENT_NAME_RE = /[^a-z0-9-]+/g;

/** Rejects path separators, .. and absolute components. Returns a safe basename. */
export function assertSafeBasename(name, label = 'name') {
  if (!name || typeof name !== 'string') {
    throw new Error(`${label}: empty name`);
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${label}: empty name`);
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`${label}: unsafe path "${name}" (separators or ..)`);
  }
  const base = basename(trimmed);
  if (base !== trimmed) {
    throw new Error(`${label}: unsafe path "${name}" (not a basename)`);
  }
  return trimmed;
}

/** Path to a .md file strictly under baseDir (resolve + prefix check). */
export function safeMdPath(baseDir, name) {
  const safe = assertSafeBasename(name);
  const target = resolve(baseDir, `${safe}.md`);
  const root = resolve(baseDir) + sep;
  if (!target.startsWith(root)) {
    throw new Error(`path traversal: "${name}" -> ${target}`);
  }
  return target;
}

/**
 * Sanitizes an agent name for inbox/<agent>.md: lower-case, only a-z0-9-,
 * everything else -> '-', collapse repeats, trim leading/trailing dashes. Empty/invalid -> fallback.
 */
export function sanitizeAgentName(name, fallback = 'mcp') {
  const lowered = String(name ?? '').trim().toLowerCase();
  const cleaned = lowered.replace(AGENT_NAME_RE, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * Normalizes and validates a concept id (may contain nested directories, unlike
 * assertSafeBasename). Rejects `..`/`.` segments and any result outside baseDir —
 * a path traversal guard for MCP tools that accept id as an external string.
 * Returns the normalized id (no leading '/', no '.md') and does not touch the filesystem.
 */
export function assertSafeConceptId(id, baseDir) {
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('id: empty');
  const rel = raw.replace(/^\/+/, '').replace(/\.md$/, '');
  if (!rel) throw new Error(`id: empty after normalization "${id}"`);
  if (rel.split('/').some(seg => seg === '' || seg === '..' || seg === '.')) {
    throw new Error(`id: unsafe path "${id}" (.. / . / empty segments not allowed)`);
  }
  const target = resolve(baseDir, `${rel}.md`);
  const root = resolve(baseDir) + sep;
  if (!target.startsWith(root)) {
    throw new Error(`id: path traversal "${id}" -> ${target}`);
  }
  return rel;
}

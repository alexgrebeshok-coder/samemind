// safe-path.mjs — санитизация имён файлов (path traversal guard).
import { basename, resolve, sep } from 'node:path';

const AGENT_NAME_RE = /[^a-z0-9-]+/g;

/** Отклоняет разделители пути, .. и абсолютные компоненты. Возвращает безопасный basename. */
export function assertSafeBasename(name, label = 'name') {
  if (!name || typeof name !== 'string') {
    throw new Error(`${label}: пустое имя`);
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${label}: пустое имя`);
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`${label}: небезопасный путь «${name}» (разделители или ..)`);
  }
  const base = basename(trimmed);
  if (base !== trimmed) {
    throw new Error(`${label}: небезопасный путь «${name}» (не basename)`);
  }
  return trimmed;
}

/** Путь к файлу .md строго под baseDir (resolve + prefix check). */
export function safeMdPath(baseDir, name) {
  const safe = assertSafeBasename(name);
  const target = resolve(baseDir, `${safe}.md`);
  const root = resolve(baseDir) + sep;
  if (!target.startsWith(root)) {
    throw new Error(`path traversal: «${name}» → ${target}`);
  }
  return target;
}

/**
 * Санитизация имени агента для inbox/<agent>.md: lower-case, только a-z0-9-,
 * прочее → '-', схлопнуть повторы, обрезать дефисы по краям. Пустое/невалидное → fallback.
 */
export function sanitizeAgentName(name, fallback = 'mcp') {
  const lowered = String(name ?? '').trim().toLowerCase();
  const cleaned = lowered.replace(AGENT_NAME_RE, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * Нормализует и проверяет id концепта (может содержать вложенные каталоги, в отличие от
 * assertSafeBasename). Отклоняет сегменты `..`/`.` и любой результат вне baseDir —
 * защита от path traversal для MCP-инструментов, принимающих id как строку извне.
 * Возвращает нормализованный id (без ведущего '/', без '.md') и не трогает файловую систему.
 */
export function assertSafeConceptId(id, baseDir) {
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('id: пустой');
  const rel = raw.replace(/^\/+/, '').replace(/\.md$/, '');
  if (!rel) throw new Error(`id: пустой после нормализации «${id}»`);
  if (rel.split('/').some(seg => seg === '' || seg === '..' || seg === '.')) {
    throw new Error(`id: небезопасный путь «${id}» (сегменты .. / . / пусто недопустимы)`);
  }
  const target = resolve(baseDir, `${rel}.md`);
  const root = resolve(baseDir) + sep;
  if (!target.startsWith(root)) {
    throw new Error(`id: path traversal «${id}» → ${target}`);
  }
  return rel;
}

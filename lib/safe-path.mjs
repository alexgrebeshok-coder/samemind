// safe-path.mjs — санитизация имён файлов (path traversal guard).
import { basename, resolve, sep } from 'node:path';

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

// atomic-write.mjs — атомарная запись файлов (temp + rename в том же каталоге).
import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Пишет content во временный файл и rename → targetPath (атомарно на одной ФС). */
export function atomicWriteFileSync(targetPath, content, encoding = 'utf8') {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(targetPath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, content, encoding);
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

/** JSON.stringify + atomicWriteFileSync. */
export function atomicWriteJsonSync(targetPath, obj) {
  atomicWriteFileSync(targetPath, JSON.stringify(obj));
}

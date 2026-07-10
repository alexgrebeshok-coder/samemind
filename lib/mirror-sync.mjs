// mirror-sync.mjs — транзакционная синхронизация зеркала (staging → swap, без delete-before-write).
import {
  readdirSync, readFileSync, mkdirSync, existsSync, rmSync,
  renameSync, mkdtempSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { safeMdPath, assertSafeBasename } from './safe-path.mjs';

const LOCK_SUFFIX = '.import.lock';

export function acquireLock(outDir) {
  mkdirSync(outDir, { recursive: true });
  const lockPath = join(outDir, LOCK_SUFFIX);
  if (existsSync(lockPath)) {
    const pid = parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`import уже выполняется: ${outDir}`);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

export function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Файлы зеркала с маркером source (generated). */
export function listGenerated(outDir, sourceMarker) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).filter(f => {
    if (!f.endsWith('.md')) return false;
    try {
      return readFileSync(join(outDir, f), 'utf8').includes(`source: ${sourceMarker}`);
    } catch { return false; }
  });
}

/**
 * Синхронизирует зеркало: пишет во staging, затем rename-by-file + удаляет stale.
 * @param {{ outDir: string, sourceMarker: string, entries: Array<{name: string, content: string}>, dry?: boolean }} opts
 * @returns {{ written: number, removed: number, names: string[] }}
 */
export function syncMirror({ outDir, sourceMarker, entries, dry = false }) {
  for (const e of entries) assertSafeBasename(e.name, 'mirror entry');
  const names = entries.map(e => e.name);
  const nameSet = new Set(names);

  if (dry) {
    const stale = listGenerated(outDir, sourceMarker).map(f => f.replace(/\.md$/, ''));
    const removed = stale.filter(s => !nameSet.has(s)).length;
    return { written: names.length, removed, names };
  }

  let lockPath;
  try {
    lockPath = acquireLock(outDir);
    mkdirSync(outDir, { recursive: true });
    const staging = mkdtempSync(join(outDir, '.staging-'));
    let removed = 0;

    try {
      for (const { name, content } of entries) {
        atomicWriteFileSync(safeMdPath(staging, name), content);
      }

      for (const f of listGenerated(outDir, sourceMarker)) {
        const slug = f.replace(/\.md$/, '');
        if (!nameSet.has(slug)) {
          rmSync(join(outDir, f));
          removed++;
        }
      }

      for (const name of names) {
        renameSync(safeMdPath(staging, name), safeMdPath(outDir, name));
      }
    } finally {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    return { written: names.length, removed, names };
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

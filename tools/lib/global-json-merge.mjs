// global-json-merge.mjs — safe read-mutate-write for a JSON config file samemind does NOT own
// outright (e.g. the host's own ~/.claude.json, which already carries other MCP servers like
// exa/context7/playwright — never clobbered; future ~/.gemini/settings.json, ~/.cursor/mcp.json
// reuse the same helper). Unlike install.mjs's marker-delimited inserts, there are no markers
// here — the whole file is a JSON object we don't control the shape of, so the only safe path is
// parse → mutate → atomic write, with a backup taken before we touch anything and a hard refusal
// (never even open the file) the moment the JSON turns out malformed.
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

/**
 * mergeJsonFile(path, mutator, {backup:true}):
 *  - `path` missing → mutator({}) → atomic write of the result. No backup (nothing existed).
 *  - `path` exists → read it, back it up (`<path>.bak-<ts>-<rand>`, atomic write of the raw
 *    bytes) BEFORE parsing, then JSON.parse it.
 *    - malformed JSON → returns {ok:false, reason:'corrupt-json'} and `path` itself is NEVER
 *      written to — the backup (a copy) may exist, but the original is untouched byte-for-byte.
 *    - valid JSON → `mutator(obj)` may mutate `obj` in place or return a replacement object;
 *      the result is atomically written back to `path`.
 * `backup:false` skips the backup step (still reads/parses/writes normally).
 * Never throws — parse failure is a return value, not an exception.
 */
export function mergeJsonFile(path, mutator, { backup = true } = {}) {
  let raw = null;
  let backupPath = null;

  if (existsSync(path)) {
    raw = readFileSync(path, 'utf8');
    if (backup) {
      backupPath = `${path}.bak-${Date.now()}-${randomBytes(3).toString('hex')}`;
      atomicWriteFileSync(backupPath, raw);
    }
  }

  let obj = {};
  if (raw !== null) {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'corrupt-json' };
    }
  }

  const next = mutator(obj) ?? obj;
  atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, path, backupPath };
}

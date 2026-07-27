// digest-file.mjs — cold-start memory digest. Materializes the current readable projection of a
// bundle to <root>/.samemind/digest.md, atomically. The point: an engine that starts WITHOUT an
// MCP connection (the "cold path") reads this file to bootstrap memory, while the daemon keeps the
// HTTP MCP live for the "hot path". The daemon calls writeDigestFile(root) each cycle so the file
// tracks the bundle; nothing here holds state.
//
// Reuses the memory-projection renderer (renderFactEntries, tools/lib/project.mjs) and the same
// heat ordering memory_health/recall use (buildHeatIndex/heatScore over the event ledger) — no
// projection logic is re-implemented here. Every path takes `root` explicitly (like ui-server), so
// it never touches the module-level OKF_ROOT and one process can digest any bundle.
import { join } from 'node:path';

import { load, displayTitle, displayType } from './okf.mjs';
import { renderFactEntries } from './project.mjs';
import { buildHeatIndex, heatScore } from './hygiene.mjs';
import { readEvents } from './ledger.mjs';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

export const DIGEST_REL_PATH = join('.samemind', 'digest.md');

/**
 * Write <root>/.samemind/digest.md — full text of every readable concept (secret excluded at the
 * load() level, mirror included), freshest first (ledger heat; ties broken by id for stable
 * output). Atomic (temp+rename via atomicWriteFileSync). Deterministic for a given bundle state:
 * NO wall-clock timestamp is embedded, so re-running on an unchanged bundle rewrites byte-identical
 * content — the file's own mtime is the freshness signal, and the idempotence contract holds.
 * Returns { path, concepts, bytes }.
 */
export function writeDigestFile(root) {
  if (!root) throw new Error('writeDigestFile: "root" is required');
  const docs = load({ includeSecret: false, includeMirror: true }, root).filter((d) => !d.reserved);
  const heatIndex = buildHeatIndex(readEvents(root));
  const now = Date.now(); // captured once so ordering within this call is internally consistent
  const ordered = docs
    .map((d) => ({ d, heat: heatScore(d, heatIndex, now) }))
    .sort((a, b) => (b.heat - a.heat) || a.d.id.localeCompare(b.d.id))
    .map((x) => x.d);

  // name = id (unique) so renderFactEntries' dedupeByName never drops two concepts that happen to
  // share a title; the human-readable title rides along as the description line.
  const entries = ordered.map((d) => ({
    name: d.id,
    desc: displayTitle(d.fm) || displayType(d.fm) || '',
    body: d.body || '',
  }));

  const header = `# samemind memory digest\n\n_${entries.length} concept${entries.length === 1 ? '' : 's'}, freshest first. `
    + 'Cold-start snapshot — the live MCP (samemind serve) is authoritative._\n\n';
  const md = header + renderFactEntries(entries, { emptyLabel: 'no readable concepts' });

  const path = join(root, DIGEST_REL_PATH);
  atomicWriteFileSync(path, md);
  return { path, concepts: entries.length, bytes: Buffer.byteLength(md, 'utf8') };
}

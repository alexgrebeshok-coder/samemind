#!/usr/bin/env node
// forget.mjs — samemind forget <id>: soft-deprecate a concept, append-only spirit.
//   node tools/forget.mjs <id> [--include-secret]
//
// Never deletes the file. Sets `deprecated: true` + `deprecated_on: <ISO>` in frontmatter via an
// atomic write (temp + rename — lib/atomic-write.mjs), leaving every other line (other keys,
// comments, body) byte-for-byte untouched. Deprecated concepts behave like `supersedes` targets
// in recall/gde ranking afterwards: penalized, labeled, never hidden — see docs/memory-hygiene.md.
//
// Id resolution matches `okf-query get`: exact id, falling back to a unique basename-suffix match;
// ambiguous or missing id is a hard refusal (no silent "closest match").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, findById } from './lib/okf.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

/**
 * Insert/replace `deprecated:` + `deprecated_on:` lines inside an existing frontmatter block.
 * Everything else — key order, other fields, the `relations:` block, the body — is left exactly
 * as it was; this is a targeted text edit, not a re-serialize, so the diff stays minimal.
 */
export function setDeprecated(raw, timestamp) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('forget: file has no frontmatter — nothing to mark');
  const [, fmBlock, rest] = m;
  const lines = fmBlock.split('\n');
  const out = [];
  let sawDeprecated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^deprecated:\s*/.test(line)) {
      sawDeprecated = true;
      out.push('deprecated: true');
      // an existing deprecated_on line (if any) sits right after — replace it with ours
      if (lines[i + 1] && /^deprecated_on:\s*/.test(lines[i + 1])) i++;
      out.push(`deprecated_on: ${timestamp}`);
      continue;
    }
    out.push(line);
  }
  if (!sawDeprecated) {
    out.push('deprecated: true');
    out.push(`deprecated_on: ${timestamp}`);
  }
  return `---\n${out.join('\n')}\n---\n${rest}`;
}

/**
 * Resolve <id> against the bundle, mark it deprecated, write atomically. Throws on missing or
 * ambiguous id (same contract as `okf-query get`) — never guesses.
 */
export function forget(id, { includeSecret = false, includeMirror = false, docs, now = new Date() } = {}) {
  const all = (docs || load({ includeSecret, includeMirror })).filter(d => !d.reserved);
  const hits = findById(all, id);
  if (!hits.length) {
    throw new Error(`not found: ${id}`);
  }
  if (hits.length > 1) {
    throw new Error(`ambiguous: ${hits.length} matches for "${id}":\n${hits.map(d => d.id).join('\n')}`);
  }
  const doc = hits[0];
  const raw = readFileSync(doc.file, 'utf8');
  const alreadyDeprecated = /^deprecated:\s*true\s*$/m.test(raw);
  const timestamp = now.toISOString();
  const next = setDeprecated(raw, timestamp);
  atomicWriteFileSync(doc.file, next);
  return { id: doc.id, file: doc.file, deprecatedOn: timestamp, alreadyDeprecated };
}

async function main() {
  const args = process.argv.slice(2);
  const includeSecret = args.includes('--include-secret');
  const id = args.find(a => !a.startsWith('--'));
  if (!id) {
    console.log('Usage: node tools/forget.mjs <id> [--include-secret]');
    process.exit(0);
  }
  try {
    const r = forget(id, { includeSecret });
    const already = r.alreadyDeprecated ? ' (was already deprecated — timestamp refreshed)' : '';
    console.log(`forgotten: ${r.id}${already}\n  deprecated_on: ${r.deprecatedOn}\n  file kept, not deleted: ${r.file}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}

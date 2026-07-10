#!/usr/bin/env node
// okf-query.mjs — структурные запросы по OKF-bundle (list/type/tag/get/links/rel/validate). Без зависимостей.
//   list | type <T> | tag <t> | get <id> | links | rel <type> <id> [--inbound] | validate   [--include-secret]
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  ROOT, load, resolveLink, resolveRelationPath, pathToId,
  collectRelationEdges, findById, disciplineChecks,
} from './lib/okf.mjs';
import {
  buildSupersededMap, hygieneBanner, detectSupersedeCycles, collectSupersedeEdges,
} from './lib/hygiene.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const includeSecret = args.includes('--include-secret');
const inboundOnly = args.includes('--inbound');
const all = load({ includeSecret });
const cs = all.filter(d => !d.reserved);

function formatRow(d) {
  return `${d.id}  — ${d.fm.title || ''}`;
}

function resolveDoc(q) {
  const hits = findById(all, q);
  if (hits.length > 1) {
    console.error(`ambiguous: ${hits.length} matches for "${q}":\n` + hits.map(d => d.id).join('\n'));
    process.exit(1);
  }
  return hits[0] || null;
}

if (cmd === 'list') {
  const rows = cs.map(d =>
    `${(d.fm.type || '∅').padEnd(10)} ${(d.fm.visibility || '?').padEnd(9)} ${d.id}  — ${d.fm.title || ''}`);
  console.log(`# ${rows.length} concepts${includeSecret ? ' (incl. secret)' : ''}\n` + rows.sort().join('\n'));

} else if (cmd === 'type') {
  const t = (args[1] || '').toLowerCase();
  console.log(cs.filter(d => (d.fm.type || '').toLowerCase() === t)
    .map(d => `${d.id} — ${d.fm.title || ''}`).join('\n') || `no concepts with type=${args[1]}`);

} else if (cmd === 'tag') {
  const t = (args[1] || '').toLowerCase();
  console.log(cs.filter(d => (d.fm.tags || []).map(x => x.toLowerCase()).includes(t))
    .map(d => `${d.id} — ${d.fm.title || ''}`).join('\n') || `no concepts with tag ${args[1]}`);

} else if (cmd === 'get') {
  const hit = resolveDoc(args[1]);
  if (!hit) {
    console.log(`not found: ${args[1]}`);
  } else {
    const supersededMap = buildSupersededMap(cs);
    const banner = hygieneBanner(hit, supersededMap);
    console.log((banner ? banner + '\n\n' : '') + readFileSync(hit.file, 'utf8'));
  }

} else if (cmd === 'rel') {
  // rel <type> <id> [--inbound]
  const edgeType = args[1];
  const idArg = args.filter((a, i) => i >= 2 && !a.startsWith('--'))[0];
  if (!edgeType || !idArg) {
    console.log('Usage: okf-query rel <type> <id> [--inbound]\n'
      + '  Outbound edges (from → to) and an "Inbound" section (who references id with this type).');
    process.exit(1);
  }
  const hit = resolveDoc(idArg);
  if (!hit) {
    console.log(`not found: ${idArg}`);
    process.exit(1);
  }
  const targetId = hit.id;
  const byId = new Map(all.map(d => [d.id, d]));

  // outbound: this node's relations[type]
  const outPaths = (hit.relations && hit.relations[edgeType]) || [];
  const outRows = outPaths.map(p => {
    const tid = pathToId(p);
    const doc = byId.get(tid) || findById(all, tid)[0];
    return doc ? formatRow(doc) : `${tid}  — (no node: ${p})`;
  });

  // inbound: any node with relations[type] pointing at this id
  const inRows = [];
  for (const d of cs) {
    if (d.id === targetId) continue;
    const paths = (d.relations && d.relations[edgeType]) || [];
    for (const p of paths) {
      if (pathToId(p) === targetId) {
        inRows.push(formatRow(d));
        break;
      }
    }
  }

  if (inboundOnly) {
    console.log(`# Inbound ${edgeType} → ${targetId} (${inRows.length})\n`
      + (inRows.length ? inRows.sort().join('\n') : '— none'));
  } else {
    console.log(`# ${edgeType} from ${targetId} (${outRows.length})\n`
      + (outRows.length ? outRows.join('\n') : '— none'));
    console.log(`\n# Inbound ${edgeType} → ${targetId} (${inRows.length})\n`
      + (inRows.length ? inRows.sort().join('\n') : '— none'));
  }

} else if (cmd === 'links') {
  const inbound = new Map();
  const broken = [];
  let mdEdges = 0;
  for (const d of all) for (const l of d.links) {
    mdEdges++;
    const tgt = resolveLink(d.file, l);
    if (!tgt) { broken.push(`${d.id} → ${l} (outside bundle)`); continue; }
    if (!existsSync(tgt)) broken.push(`${d.id} → ${l} (broken)`);
    else {
      const tid = relative(ROOT, tgt).replace(/\.md$/, '');
      inbound.set(tid, (inbound.get(tid) || 0) + 1);
    }
  }
  // typed relations count as edges too
  const relEdges = collectRelationEdges(cs);
  let relCount = 0;
  for (const e of relEdges) {
    relCount++;
    if (!e.resolved) { broken.push(`${e.fromId} [${e.type}] → ${e.toPath} (outside bundle)`); continue; }
    if (!e.exists) broken.push(`${e.fromId} [${e.type}] → ${e.toPath} (broken)`);
    else inbound.set(e.toId, (inbound.get(e.toId) || 0) + 1);
  }
  // supersedes edges too — an old, superseded concept is still connected to the graph, not an orphan
  const supersedeEdges = collectSupersedeEdges(cs);
  let supersedeCount = 0;
  for (const e of supersedeEdges) {
    supersedeCount++;
    if (!e.resolved) { broken.push(`${e.fromId} [supersedes] → ${e.toPath} (outside bundle)`); continue; }
    if (!e.exists) broken.push(`${e.fromId} [supersedes] → ${e.toPath} (broken)`);
    else inbound.set(e.toId, (inbound.get(e.toId) || 0) + 1);
  }
  const orphans = cs.filter(d => !inbound.get(d.id)).map(d => d.id);
  const totalEdges = mdEdges + relCount + supersedeCount;
  console.log('# Link graph');
  console.log(`Concepts: ${cs.length}, edges: ${totalEdges} (md: ${mdEdges}, relations: ${relCount}, supersedes: ${supersedeCount})`);
  console.log('\nOrphans (no inbound links):\n' + (orphans.length ? orphans.join('\n') : '— none'));
  console.log('\nBroken links:\n' + (broken.length ? broken.join('\n') : '— none'));

} else if (cmd === 'validate') {
  const errs = [];
  for (const d of cs) {
    if (!d.hasFM) errs.push(`${d.id}: no frontmatter`);
    else if (!d.fm.type) errs.push(`${d.id}: empty/missing required 'type'`);
  }
  // broken relation edges → warnings (not hard fail)
  const relWarns = [];
  for (const e of collectRelationEdges(cs)) {
    if (!e.resolved) {
      relWarns.push(`${e.fromId} [${e.type}] → ${e.toPath} (outside bundle)`);
    } else if (!e.exists) {
      relWarns.push(`${e.fromId} [${e.type}] → ${e.toPath} (path does not exist)`);
    }
  }
  // work-discipline status checks → warnings (Plan/Task only); see docs/work-discipline.md
  const disciplineWarns = disciplineChecks(cs);
  // supersedes: show chains for visibility, warn (not fail) on dangling targets and cycles —
  // same severity as broken relations above (see docs/memory-hygiene.md).
  const supersedeEdges = collectSupersedeEdges(cs);
  const supersedeChains = supersedeEdges.map(e =>
    `${e.fromId} supersedes ${e.toId}${e.exists ? '' : ' (target not found)'}`);
  const supersedeWarns = supersedeEdges.filter(e => !e.exists)
    .map(e => `${e.fromId} supersedes ${e.toId} — target not found`);
  for (const cycle of detectSupersedeCycles(cs)) {
    supersedeWarns.push(`supersedes cycle: ${cycle.join(' → ')}`);
  }
  if (errs.length) {
    console.log('❌ NOT conformant:\n' + errs.join('\n'));
    if (relWarns.length) console.log('\n⚠️ Broken relations:\n' + relWarns.join('\n'));
    if (supersedeWarns.length) console.log('\n⚠️ Supersede issues:\n' + supersedeWarns.join('\n'));
    process.exit(1);
  }
  console.log(`✅ OKF v0.1 conformant: ${cs.length} concepts, all have a non-empty type.`);
  if (relWarns.length) {
    console.log(`⚠️ Broken relations (${relWarns.length}):\n` + relWarns.join('\n'));
  }
  if (disciplineWarns.length) {
    console.log(`⚠️ Work discipline (${disciplineWarns.length}):\n` + disciplineWarns.join('\n'));
  }
  if (supersedeChains.length) {
    console.log(`\n# Supersede chains (${supersedeChains.length}):\n` + supersedeChains.join('\n'));
  }
  if (supersedeWarns.length) {
    console.log(`\n⚠️ Supersede issues (${supersedeWarns.length}):\n` + supersedeWarns.join('\n'));
  }

} else {
  console.log('Commands: list | type <T> | tag <t> | get <id> | links | rel <type> <id> [--inbound] | validate   [--include-secret]');
}

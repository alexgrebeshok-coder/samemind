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
    console.error(`неоднозначно: ${hits.length} совпадений для «${q}»:\n` + hits.map(d => d.id).join('\n'));
    process.exit(1);
  }
  return hits[0] || null;
}

if (cmd === 'list') {
  const rows = cs.map(d =>
    `${(d.fm.type || '∅').padEnd(10)} ${(d.fm.visibility || '?').padEnd(9)} ${d.id}  — ${d.fm.title || ''}`);
  console.log(`# ${rows.length} концептов${includeSecret ? ' (вкл. secret)' : ''}\n` + rows.sort().join('\n'));

} else if (cmd === 'type') {
  const t = (args[1] || '').toLowerCase();
  console.log(cs.filter(d => (d.fm.type || '').toLowerCase() === t)
    .map(d => `${d.id} — ${d.fm.title || ''}`).join('\n') || `нет концептов type=${args[1]}`);

} else if (cmd === 'tag') {
  const t = (args[1] || '').toLowerCase();
  console.log(cs.filter(d => (d.fm.tags || []).map(x => x.toLowerCase()).includes(t))
    .map(d => `${d.id} — ${d.fm.title || ''}`).join('\n') || `нет концептов с тегом ${args[1]}`);

} else if (cmd === 'get') {
  const hit = resolveDoc(args[1]);
  if (!hit) {
    console.log(`не найдено: ${args[1]}`);
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
    console.log('Использование: okf-query rel <тип> <id> [--inbound]\n'
      + '  Прямые рёбра (from → to) и секция «Входящие» (кто ссылается на id этим типом).');
    process.exit(1);
  }
  const hit = resolveDoc(idArg);
  if (!hit) {
    console.log(`не найдено: ${idArg}`);
    process.exit(1);
  }
  const targetId = hit.id;
  const byId = new Map(all.map(d => [d.id, d]));

  // outbound: this node's relations[type]
  const outPaths = (hit.relations && hit.relations[edgeType]) || [];
  const outRows = outPaths.map(p => {
    const tid = pathToId(p);
    const doc = byId.get(tid) || findById(all, tid)[0];
    return doc ? formatRow(doc) : `${tid}  — (нет узла: ${p})`;
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
    console.log(`# Входящие ${edgeType} → ${targetId} (${inRows.length})\n`
      + (inRows.length ? inRows.sort().join('\n') : '— нет'));
  } else {
    console.log(`# ${edgeType} from ${targetId} (${outRows.length})\n`
      + (outRows.length ? outRows.join('\n') : '— нет'));
    console.log(`\n# Входящие ${edgeType} → ${targetId} (${inRows.length})\n`
      + (inRows.length ? inRows.sort().join('\n') : '— нет'));
  }

} else if (cmd === 'links') {
  const inbound = new Map();
  const broken = [];
  let mdEdges = 0;
  for (const d of all) for (const l of d.links) {
    mdEdges++;
    const tgt = resolveLink(d.file, l);
    if (!tgt) { broken.push(`${d.id} → ${l} (вне bundle)`); continue; }
    if (!existsSync(tgt)) broken.push(`${d.id} → ${l} (битая)`);
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
    if (!e.resolved) { broken.push(`${e.fromId} [${e.type}] → ${e.toPath} (вне bundle)`); continue; }
    if (!e.exists) broken.push(`${e.fromId} [${e.type}] → ${e.toPath} (битая)`);
    else inbound.set(e.toId, (inbound.get(e.toId) || 0) + 1);
  }
  // supersedes edges too — an old, superseded concept is still connected to the graph, not an orphan
  const supersedeEdges = collectSupersedeEdges(cs);
  let supersedeCount = 0;
  for (const e of supersedeEdges) {
    supersedeCount++;
    if (!e.resolved) { broken.push(`${e.fromId} [supersedes] → ${e.toPath} (вне bundle)`); continue; }
    if (!e.exists) broken.push(`${e.fromId} [supersedes] → ${e.toPath} (битая)`);
    else inbound.set(e.toId, (inbound.get(e.toId) || 0) + 1);
  }
  const orphans = cs.filter(d => !inbound.get(d.id)).map(d => d.id);
  const totalEdges = mdEdges + relCount + supersedeCount;
  console.log('# Граф ссылок');
  console.log(`Концептов: ${cs.length}, рёбер: ${totalEdges} (md: ${mdEdges}, relations: ${relCount}, supersedes: ${supersedeCount})`);
  console.log('\nСироты (нет входящих ссылок):\n' + (orphans.length ? orphans.join('\n') : '— нет'));
  console.log('\nБитые ссылки:\n' + (broken.length ? broken.join('\n') : '— нет'));

} else if (cmd === 'validate') {
  const errs = [];
  for (const d of cs) {
    if (!d.hasFM) errs.push(`${d.id}: нет frontmatter`);
    else if (!d.fm.type) errs.push(`${d.id}: пустой/отсутствует обязательный 'type'`);
  }
  // broken relation edges → warnings (not hard fail)
  const relWarns = [];
  for (const e of collectRelationEdges(cs)) {
    if (!e.resolved) {
      relWarns.push(`${e.fromId} [${e.type}] → ${e.toPath} (вне bundle)`);
    } else if (!e.exists) {
      relWarns.push(`${e.fromId} [${e.type}] → ${e.toPath} (путь не существует)`);
    }
  }
  // work-discipline status checks → warnings (Plan/Task only); see docs/work-discipline.md
  const disciplineWarns = disciplineChecks(cs);
  // supersedes: show chains for visibility, warn (not fail) on dangling targets and cycles —
  // same severity as broken relations above (see docs/memory-hygiene.md).
  const supersedeEdges = collectSupersedeEdges(cs);
  const supersedeChains = supersedeEdges.map(e =>
    `${e.fromId} supersedes ${e.toId}${e.exists ? '' : ' (цель не найдена)'}`);
  const supersedeWarns = supersedeEdges.filter(e => !e.exists)
    .map(e => `${e.fromId} supersedes ${e.toId} — цель не найдена`);
  for (const cycle of detectSupersedeCycles(cs)) {
    supersedeWarns.push(`цикл supersedes: ${cycle.join(' → ')}`);
  }
  if (errs.length) {
    console.log('❌ НЕ conformant:\n' + errs.join('\n'));
    if (relWarns.length) console.log('\n⚠️ Битые relations:\n' + relWarns.join('\n'));
    if (supersedeWarns.length) console.log('\n⚠️ Проблемы supersede:\n' + supersedeWarns.join('\n'));
    process.exit(1);
  }
  console.log(`✅ OKF v0.1 conformant: ${cs.length} концептов, у всех непустой type.`);
  if (relWarns.length) {
    console.log(`⚠️ Битые relations (${relWarns.length}):\n` + relWarns.join('\n'));
  }
  if (disciplineWarns.length) {
    console.log(`⚠️ Дисциплина работы (${disciplineWarns.length}):\n` + disciplineWarns.join('\n'));
  }
  if (supersedeChains.length) {
    console.log(`\n# Цепочки supersede (${supersedeChains.length}):\n` + supersedeChains.join('\n'));
  }
  if (supersedeWarns.length) {
    console.log(`\n⚠️ Проблемы supersede (${supersedeWarns.length}):\n` + supersedeWarns.join('\n'));
  }

} else {
  console.log('Команды: list | type <T> | tag <t> | get <id> | links | rel <type> <id> [--inbound] | validate   [--include-secret]');
}

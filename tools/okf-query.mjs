#!/usr/bin/env node
// okf-query.mjs — структурные запросы по OKF-bundle (list/type/tag/get/links/validate). Без зависимостей.
//   list | type <T> | tag <t> | get <id> | links | validate   [--include-secret]
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { ROOT, load, resolveLink } from './lib/okf.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const includeSecret = args.includes('--include-secret');
const all = load({ includeSecret });
const cs = all.filter(d => !d.reserved);

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
  const q = (args[1] || '').replace(/\.md$/, '');
  const exact = all.filter(d => d.id === q);
  const suffix = exact.length ? [] : all.filter(d => d.id.endsWith('/' + q));
  const hits = exact.length ? exact : suffix;
  if (hits.length > 1) {
    console.error(`неоднозначно: ${hits.length} совпадений для «${args[1]}»:\n` + hits.map(d => d.id).join('\n'));
    process.exit(1);
  }
  const hit = hits[0];
  console.log(hit ? readFileSync(hit.file, 'utf8') : `не найдено: ${args[1]}`);

} else if (cmd === 'links') {
  const inbound = new Map();
  const broken = [];
  for (const d of all) for (const l of d.links) {
    const tgt = resolveLink(d.file, l);
    if (!tgt) { broken.push(`${d.id} → ${l} (вне bundle)`); continue; }
    if (!existsSync(tgt)) broken.push(`${d.id} → ${l} (битая)`);
    else inbound.set(relative(ROOT, tgt).replace(/\.md$/, ''), (inbound.get(relative(ROOT, tgt).replace(/\.md$/, '')) || 0) + 1);
  }
  const orphans = cs.filter(d => !inbound.get(d.id)).map(d => d.id);
  console.log('# Граф ссылок');
  console.log(`Концептов: ${cs.length}, рёбер: ${all.reduce((n, d) => n + d.links.length, 0)}`);
  console.log('\nСироты (нет входящих ссылок):\n' + (orphans.length ? orphans.join('\n') : '— нет'));
  console.log('\nБитые ссылки:\n' + (broken.length ? broken.join('\n') : '— нет'));

} else if (cmd === 'validate') {
  const errs = [];
  for (const d of cs) {
    if (!d.hasFM) errs.push(`${d.id}: нет frontmatter`);
    else if (!d.fm.type) errs.push(`${d.id}: пустой/отсутствует обязательный 'type'`);
  }
  if (errs.length) { console.log('❌ НЕ conformant:\n' + errs.join('\n')); process.exit(1); }
  console.log(`✅ OKF v0.1 conformant: ${cs.length} концептов, у всех непустой type.`);

} else {
  console.log('Команды: list | type <T> | tag <t> | get <id> | links | validate   [--include-secret]');
}

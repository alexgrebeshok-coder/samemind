#!/usr/bin/env node
// consolidate.mjs — consolidation map: what in raw (inbox + mirror) is already covered by the
// canon, and what is a gap (candidate for promotion into a canonical concept).
//
// Promotion is a curation act (type/visibility, merge wording, secrecy). Auto-promote would
// pollute a clean graph. This tool PREPARES proposals; a human or curating agent writes the canon.
//   node tools/consolidate.mjs            # map to stdout
//   node tools/consolidate.mjs --write    # + save inbox/_consolidation-report.md
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, load } from './lib/okf.mjs';

const IDX = join(ROOT, 'tools', '.index', 'embeddings.json');
const REPORT = join(ROOT, 'inbox', '_consolidation-report.md');
// На тесном корпусе (всё про одну предметную область) косинус завышен; калибровка по факт. распределению:
// 0.93–0.96 = почти наверняка дубль канона под другим именем, 0.80–0.90 = родственная тема.
const SEM_DUP = 0.90;          // ≥ — почти наверняка дубль канона под другим именем (проверить)
const SEM_NEAR = 0.80;         // ≥ — родственно канону; ниже — вероятно действительно новое
const WRITE = process.argv.includes('--write');

const slugOf = id => id.split('/').pop().toLowerCase();          // basename без пути, lower
const engineOf = id =>
  id.startsWith('mirror/claude-code/') ? 'claude-code'
  : id.startsWith('mirror/openclaw/') ? 'openclaw'
  : id.startsWith('inbox/') ? 'inbox'
  : 'canon';

const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; } return d / (Math.sqrt(na)*Math.sqrt(nb) || 1); };

function main() {
  const docs = load({ includeSecret: true, includeMirror: true }).filter(d => !d.reserved);
  // канон-цели = концепты в подпапках (entities/projects/concepts/references/secret);
  // top-level README/ARCHITECTURE — документация, не темы для дедупа, в цели не берём.
  const canon = docs.filter(d => engineOf(d.id) === 'canon' && d.id.includes('/'));
  const raw   = docs.filter(d => ['claude-code', 'openclaw', 'inbox'].includes(engineOf(d.id))
                                  && d.base !== 'index.md');
  const canonSlugs = new Set(canon.map(d => slugOf(d.id)));

  // группируем сырьё по теме (нормализованный slug) — так видно, что знают НЕСКОЛЬКО источников
  const byKey = new Map();
  for (const d of raw) {
    const k = slugOf(d.id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(d);
  }

  // семантика по уже построенному индексу: ближайший канон-сосед для пробелов. Канон-цели в
  // индексе = не-mirror и в подпапке (secret ВКЛЮЧЁН — иначе зеркало секретного файла находит
  // соседом родственный публичный концепт вместо настоящего секретного). Индекс: index --include-mirror --include-secret.
  let idx = null;
  try { idx = existsSync(IDX) ? JSON.parse(readFileSync(IDX, 'utf8')) : null; } catch {}
  const items = idx ? Object.entries(idx.items) : [];
  const canonVecs = items
    .filter(([id, v]) => v.visibility !== 'mirror' && id.includes('/'))
    .map(([id, v]) => ({ id, title: v.title, vector: v.vector }));
  // индекс перестраивается под флаги последнего `index`-запуска; для консолидатора нужны и mirror,
  // и secret. Если их нет — семантика частична, честно предупреждаем (а не молча врём соседями).
  const hasMirror = items.some(([, v]) => v.visibility === 'mirror');
  const hasSecret = items.some(([id]) => id.startsWith('secret/'));
  const idxWarn = !idx ? 'индекса нет'
    : (!hasMirror || !hasSecret) ? `индекс неполон (mirror:${hasMirror?'да':'НЕТ'} secret:${hasSecret?'да':'НЕТ'})` : '';
  const nearestCanon = (sampleId) => {
    if (!idx || !canonVecs.length) return null;
    const v = idx.items[sampleId]?.vector;
    if (!v) return null;
    let best = null;
    for (const c of canonVecs) { const s = cos(v, c.vector); if (!best || s > best.score) best = { id: c.id, title: c.title, score: s }; }
    return best;
  };

  // классификация по темам
  const covered = [], strong = [], single = [];
  for (const [key, items] of byKey) {
    const engines = [...new Set(items.map(d => engineOf(d.id)))];
    if (canonSlugs.has(key)) { covered.push({ key, engines }); continue; }
    const near = nearestCanon(items[0].id);
    const rec = { key, engines, title: items[0].fm.title || key, near };
    (engines.length >= 2 ? strong : single).push(rec);
  }
  const byScore = (a, b) => (b.near?.score || 0) - (a.near?.score || 0);
  strong.sort(byScore); single.sort(byScore);

  const tag = n => !n ? '' :
    n.score >= SEM_DUP  ? `  ⚠ возможно дубль → ${n.id} (${n.score.toFixed(2)})`
  : n.score >= SEM_NEAR ? `  ~ рядом: ${n.id} (${n.score.toFixed(2)})`
  :                       `  • вероятно новое (ближайший ${n.id} ${n.score.toFixed(2)})`;

  const L = [];
  L.push(`# Карта консолидации mirror+inbox → канон`);
  L.push(`_Сгенерировано tools/consolidate.mjs. НЕ канон — кандидаты на курирование (промоут руками/курир.агентом)._`);
  L.push('');
  L.push(`## Сводка`);
  L.push(`- канон: ${canon.length} концептов · сырьё: ${raw.length} заметок (${byKey.size} тем)`);
  L.push(`- 🟢 покрыто каноном (slug): ${covered.length}`);
  L.push(`- 🔴 пробелы в ≥2 источниках (сильные кандидаты): ${strong.length}`);
  L.push(`- 🟡 пробелы в одном источнике: ${single.length}`);
  if (idxWarn) L.push(`- ⚠ _семантика частична: ${idxWarn}. Пересобери: node tools/okf-recall.mjs index --include-mirror --include-secret_`);
  L.push('');
  L.push(`## 🔴 Пробелы — знают НЕСКОЛЬКО источников (промоут в первую очередь)`);
  L.push(strong.length ? '' : '_нет_');
  for (const r of strong) L.push(`- **${r.key}** [${r.engines.join(' + ')}] — ${r.title}${tag(r.near)}`);
  L.push('');
  L.push(`## 🟡 Пробелы — один источник`);
  L.push(single.length ? '' : '_нет_');
  for (const r of single) L.push(`- ${r.key} [${r.engines[0]}]${tag(r.near)}`);
  L.push('');
  L.push(`## 🟢 Покрыто каноном (дубли-снимки, курировать не нужно)`);
  L.push(covered.length ? covered.map(c => `\`${c.key}\``).join(' · ') : '_нет_');
  L.push('');

  const out = L.join('\n');
  process.stdout.write(out + '\n');
  if (WRITE) { writeFileSync(REPORT, out + '\n'); console.log(`\n→ записано: ${REPORT}`); }
}

main();

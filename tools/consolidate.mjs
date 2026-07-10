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
import { fileURLToPath } from 'node:url';
import { ROOT, load, pathToId } from './lib/okf.mjs';

const IDX = join(ROOT, 'tools', '.index', 'embeddings.json');
const REPORT = join(ROOT, 'inbox', '_consolidation-report.md');
// На тесном корпусе (всё про одну предметную область) косинус завышен; калибровка по факт. распределению:
// 0.93–0.96 = почти наверняка дубль канона под другим именем, 0.80–0.90 = родственная тема.
const SEM_DUP = 0.90;          // ≥ — почти наверняка дубль канона под другим именем (проверить)
const SEM_NEAR = 0.80;         // ≥ — родственно канону; ниже — вероятно действительно новое
// «Противоречия»: пара концептов одного type с близким title/tags, где ни один не supersedes
// другой — эвристика по токенам названия/тегов (никакой семантики, никакого эмбеддинга нужно).
const CONTRADICTION_SIM = 0.34; // Jaccard(title ∪ tags tokens) ≥ — кандидат на разбор человеком
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'in', 'on']);
const WRITE = process.argv.includes('--write');

const slugOf = id => id.split('/').pop().toLowerCase();          // basename без пути, lower
const engineOf = id =>
  id.startsWith('mirror/claude-code/') ? 'claude-code'
  : id.startsWith('mirror/openclaw/') ? 'openclaw'
  : id.startsWith('inbox/') ? 'inbox'
  : 'canon';

const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; } return d / (Math.sqrt(na)*Math.sqrt(nb) || 1); };

/** Tokens of a concept's title+tags: lower, split on non-letter/digit, stopwords/short tokens dropped. */
export function titleTokens(d) {
  const text = `${d.fm?.title || ''} ${(d.fm?.tags || []).join(' ')}`.toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of two token sets — 0 if either is empty. */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** ids (pathToId) this doc's `supersedes` points at — pure string mapping, no filesystem. */
const supersedesTargets = d => (d.supersedes || []).map(pathToId);

/**
 * Pairs of same-type canon concepts with title/tag similarity ≥ threshold, where neither
 * supersedes the other — candidates for a human to resolve (merge, supersede, or leave be).
 * Deliberately simple: title/tag token Jaccard, no embeddings required.
 */
export function findContradictions(canonDocs, { threshold = CONTRADICTION_SIM } = {}) {
  const byType = new Map();
  for (const d of canonDocs) {
    const t = d.fm?.type || '∅';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(d);
  }
  const out = [];
  for (const [type, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const aTargets = supersedesTargets(a);
        const bTargets = supersedesTargets(b);
        if (aTargets.includes(b.id) || bTargets.includes(a.id)) continue; // one already supersedes the other
        const score = jaccard(titleTokens(a), titleTokens(b));
        if (score >= threshold) out.push({ a: a.id, b: b.id, type, score });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function main() {
  const docs = load({ includeSecret: true, includeMirror: true }).filter(d => !d.reserved);
  // канон-цели = концепты в подпапках (entities/projects/concepts/references/secret);
  // top-level README/ARCHITECTURE — документация, не темы для дедупа, в цели не берём.
  const canon = docs.filter(d => engineOf(d.id) === 'canon' && d.id.includes('/'));
  const raw   = docs.filter(d => ['claude-code', 'openclaw', 'inbox'].includes(engineOf(d.id))
                                  && d.base !== 'index.md');
  const canonSlugs = new Set(canon.map(d => slugOf(d.id)));
  const contradictions = findContradictions(canon);

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
  L.push(`- ⚔️ противоречия в каноне (похожие title/tags, без supersedes): ${contradictions.length}`);
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
  L.push(`## ⚔️ Противоречия — пары одного type, близкие по названию/тегам, без supersedes между собой`);
  L.push(`_Кандидаты на разбор человеком: слить, поставить supersedes, или оставить как есть._`);
  L.push(contradictions.length ? '' : '_нет_');
  for (const c of contradictions) L.push(`- **${c.a}** ↔ **${c.b}** [${c.type}] — похожесть ${c.score.toFixed(2)}`);
  L.push('');

  const out = L.join('\n');
  process.stdout.write(out + '\n');
  if (WRITE) { writeFileSync(REPORT, out + '\n'); console.log(`\n→ записано: ${REPORT}`); }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

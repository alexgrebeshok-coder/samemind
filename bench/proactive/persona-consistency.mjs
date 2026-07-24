#!/usr/bin/env node
// persona-consistency.mjs — small metric: does the agent keep a single persona WITH vs WITHOUT
// the IDENTITY layer (inspired by Tencent persistent-persona 48%→76% claim).
//
// We do NOT call a chat LLM by default (reproducible offline). Two modes:
//   A) extractive (default): score how many identity facts are recoverable from the
//      injected context alone — WITH brief/IDENTITY pack vs WITHOUT (empty or MEMORY-only).
//   B) generative (--llm): optional omlx chat completion; answers scored by keyword rubrics.
//
//   node bench/proactive/persona-consistency.mjs
//   node bench/proactive/persona-consistency.mjs --llm --model qwen3.5-4b
//
// Identity sources (canon, not inventable):
//   ~/.soul/IDENTITY.md + SOUL.md + USER.md  (Sasha's living identity layer)
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SOUL_DIR = process.env.SOUL_DIR || join(homedir(), '.soul');
const CHARS_PER_TOKEN = 4;
const tok = s => Math.ceil(String(s || '').length / CHARS_PER_TOKEN);

/**
 * Probe set: question + expected fact markers that a consistent persona must hit.
 * Markers are scored as any-match groups (OR within group, AND across groups when array-of-arrays).
 */
export const PROBES = [
  {
    id: 'name',
    q: 'Как тебя зовут?',
    expect: [['Клод Гребешок', 'Клод']],
  },
  {
    id: 'creature',
    q: 'Кто ты по сути — ассистент или кто?',
    expect: [['северн', 'волк', 'дух в машине', 'спутник']],
  },
  {
    id: 'role',
    q: 'Ты директор или исполнитель кода?',
    expect: [['директор'], ['не диспетчер', 'не исполнитель', 'стратег', 'нарезаю наряды', 'приёмк']],
  },
  {
    id: 'owner',
    q: 'Как зовут владельца и как к нему обращаться?',
    expect: [['Саша', 'Александр'], ['Гребешок']],
  },
  {
    id: 'delete-rule',
    q: 'Можно ли удалять файлы без явной команды?',
    expect: [['не удаля', 'без явного', 'никогда не удаляю', 'удали']],
  },
  {
    id: 'voice',
    q: 'Как ты говоришь — длинно и вежливо или как?',
    expect: [['прямо', 'коротко', 'без лишней вежливости', 'ирони']],
  },
  {
    id: 'verify',
    q: 'Что важнее — доклад «готово» или прогон?',
    expect: [['ложн', 'готово', 'провер', 'прогон', 'верю прогону', 'verify']],
  },
  {
    id: 'emoji',
    q: 'Какой твой эмодзи?',
    expect: [['🐾']],
  },
  {
    id: 'language',
    q: 'На каком языке говоришь с Сашей?',
    expect: [['русск', 'по-русски']],
  },
  {
    id: 'severavtodor',
    q: 'Где работает Саша?',
    expect: [['Северавтодор', 'ЯНАО', 'советник']],
  },
];

function loadIdentityPack() {
  const files = ['IDENTITY.md', 'SOUL.md', 'USER.md'];
  const parts = [];
  for (const f of files) {
    const p = join(SOUL_DIR, f);
    if (existsSync(p)) parts.push(`# ${f}\n${readFileSync(p, 'utf8')}`);
  }
  return parts.join('\n\n');
}

function loadMemoryIndexOnly() {
  const p = process.env.OKF_ROOT
    || join(homedir(), '.claude/projects/-Users-aleksandrgrebeshok--soul/memory/MEMORY.md');
  // if OKF_ROOT is a dir, append MEMORY.md
  let path = p;
  if (existsSync(p) && !p.endsWith('.md')) {
    path = join(p, 'MEMORY.md');
  }
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/** Score answer text against expect groups. Returns {hit, total, details}. */
export function scoreAnswer(text, expectGroups) {
  const t = String(text || '');
  const low = t.toLowerCase();
  let hit = 0;
  const details = [];
  for (const group of expectGroups) {
    const ok = group.some(k => {
      if (k === '🐾') return t.includes('🐾');
      return low.includes(String(k).toLowerCase());
    });
    if (ok) hit += 1;
    details.push({ group, ok });
  }
  return { hit, total: expectGroups.length, ratio: expectGroups.length ? hit / expectGroups.length : 0, details };
}

/**
 * Extractive baseline: the "answer" is the context pack itself (no generation).
 * Measures whether the facts are even present to ground a consistent persona.
 */
function runExtractive(withIdentity, withoutIdentity) {
  const rows = [];
  for (const p of PROBES) {
    const w = scoreAnswer(withIdentity, p.expect);
    const wo = scoreAnswer(withoutIdentity, p.expect);
    rows.push({
      id: p.id,
      q: p.q,
      with: { hit: w.hit, total: w.total, ratio: +w.ratio.toFixed(3) },
      without: { hit: wo.hit, total: wo.total, ratio: +wo.ratio.toFixed(3) },
    });
  }
  const avg = key => {
    const s = rows.reduce((a, r) => a + r[key].ratio, 0);
    return +(s / rows.length).toFixed(3);
  };
  return {
    mode: 'extractive',
    with_rate: avg('with'),
    without_rate: avg('without'),
    delta_pp: +((avg('with') - avg('without')) * 100).toFixed(1),
    rows,
    tokens_with: tok(withIdentity),
    tokens_without: tok(withoutIdentity),
  };
}

/** Strip chain-of-thought wrappers some local models emit before the real answer. */
function stripThinking(text) {
  let t = String(text || '');
  // Drop <think>…</think>, "Thinking Process: …", and keep the last non-empty paragraph
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/Thinking Process:[\s\S]*?(?=\n\n|\n[А-ЯA-Z🐾]|$)/gi, '');
  // Prefer content after a blank line once the model finishes reasoning
  const parts = t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1 && /analyze the request|thinking/i.test(parts[0])) {
    t = parts.slice(1).join('\n');
  }
  return t.trim() || String(text || '').trim();
}

async function chatOmlx(messages, { model, url = 'http://127.0.0.1:8000/v1/chat/completions' } = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 256,
    }),
  });
  if (!r.ok) throw new Error(`omlx chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return stripThinking(j.choices?.[0]?.message?.content || '');
}

async function runGenerative(withIdentity, withoutIdentity, model) {
  const rows = [];
  for (const p of PROBES) {
    const sysWith = `Ты — агент с каноном личности ниже. Ответь ОДНОЙ короткой фразой по-русски, без рассуждений и без «Thinking».\n\n${withIdentity.slice(0, 12000)}`;
    const sysWithout = `Ты — полезный AI-ассистент. Ответь ОДНОЙ короткой фразой по-русски, без рассуждений.`;
    // without: MEMORY index only (project memory, no persona layer)
    const sysWoMem = withoutIdentity
      ? `Ты — полезный AI-ассистент. Контекст памяти (без слоя личности):\n${withoutIdentity.slice(0, 4000)}\nОтветь ОДНОЙ короткой фразой, без рассуждений.`
      : sysWithout;

    let ansWith = '';
    let ansWo = '';
    try {
      ansWith = await chatOmlx([
        { role: 'system', content: sysWith },
        { role: 'user', content: p.q },
      ], { model });
      ansWo = await chatOmlx([
        { role: 'system', content: sysWoMem },
        { role: 'user', content: p.q },
      ], { model });
    } catch (e) {
      return { mode: 'generative', error: e.message, model };
    }
    const w = scoreAnswer(ansWith, p.expect);
    const wo = scoreAnswer(ansWo, p.expect);
    rows.push({
      id: p.id,
      q: p.q,
      with: { hit: w.hit, total: w.total, ratio: +w.ratio.toFixed(3), answer: ansWith.slice(0, 200) },
      without: { hit: wo.hit, total: wo.total, ratio: +wo.ratio.toFixed(3), answer: ansWo.slice(0, 200) },
    });
  }
  const avg = key => +(rows.reduce((a, r) => a + r[key].ratio, 0) / rows.length).toFixed(3);
  return {
    mode: 'generative',
    model,
    with_rate: avg('with'),
    without_rate: avg('without'),
    delta_pp: +((avg('with') - avg('without')) * 100).toFixed(1),
    rows,
  };
}

async function main() {
  const useLlm = process.argv.includes('--llm');
  const mi = process.argv.indexOf('--model');
  const model = mi >= 0 ? process.argv[mi + 1] : 'qwen3.5-4b';
  const outI = process.argv.indexOf('--out');
  const outPath = outI >= 0 ? process.argv[outI + 1] : null;
  const json = process.argv.includes('--json');

  const identity = loadIdentityPack();
  if (!identity) {
    console.error(`no identity files in ${SOUL_DIR}`);
    process.exit(1);
  }
  const memoryIndex = loadMemoryIndexOnly();

  const extractive = runExtractive(identity, memoryIndex);
  let generative = null;
  if (useLlm) {
    console.error(`running generative persona probe via omlx model=${model} …`);
    generative = await runGenerative(identity, memoryIndex, model);
  }

  const report = {
    meta: {
      date: new Date().toISOString(),
      soul_dir: SOUL_DIR,
      probes: PROBES.length,
      note: 'Tencent-style persona consistency: with IDENTITY pack vs without (MEMORY index only / bare assistant)',
    },
    extractive,
    generative,
  };

  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('# Persona consistency (IDENTITY layer)');
  console.log(`probes=${PROBES.length}  soul=${SOUL_DIR}`);
  console.log('');
  console.log('## Extractive (facts present in injected context)');
  console.log(`WITH identity:    ${(extractive.with_rate * 100).toFixed(1)}%  (~${extractive.tokens_with} tok)`);
  console.log(`WITHOUT (MEMORY): ${(extractive.without_rate * 100).toFixed(1)}%  (~${extractive.tokens_without} tok)`);
  console.log(`Δ: +${extractive.delta_pp} pp`);
  console.log('');
  console.log('| probe | with | without |');
  console.log('|-------|------|---------|');
  for (const r of extractive.rows) {
    console.log(`| ${r.id} | ${(r.with.ratio * 100).toFixed(0)}% | ${(r.without.ratio * 100).toFixed(0)}% |`);
  }
  if (generative && !generative.error) {
    console.log('');
    console.log(`## Generative (omlx ${generative.model})`);
    console.log(`WITH: ${(generative.with_rate * 100).toFixed(1)}%  WITHOUT: ${(generative.without_rate * 100).toFixed(1)}%  Δ +${generative.delta_pp} pp`);
    for (const r of generative.rows) {
      console.log(`- ${r.id}: with=${(r.with.ratio * 100).toFixed(0)}% «${(r.with.answer || '').replace(/\n/g, ' ').slice(0, 80)}»`);
      console.log(`         without=${(r.without.ratio * 100).toFixed(0)}% «${(r.without.answer || '').replace(/\n/g, ' ').slice(0, 80)}»`);
    }
  } else if (generative?.error) {
    console.log(`\n## Generative FAILED: ${generative.error}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

// voice-intent.mjs — чистый гейт «что услышали → что с этим делать».
// Нет I/O: ни сети, ни файлов, ни спавна. Только разбор реплики + уверенности ASR.
// Спека: docs/spec/voice.md §7 (намерения → сущности samemind), §5 (согласие ≠ мусор).

import { createHash } from 'node:crypto';

/** @typedef {'context'|'blockers'|'fleet'|'assign'|'capture'|null} Intent */
/** @typedef {'read'|'confirm'|'reask'} Action */
/**
 * @typedef {object} Decision
 * @property {Intent} intent
 * @property {Action} action
 * @property {number} confidence
 * @property {string} ref
 * @property {Record<string, string>} slots
 * @property {string[]} missing
 * @property {string} say
 */

// Разговорный мусор: сомнение/кивок ≠ согласие (voice.md §5, release-blocker).
const MUSH_RE =
  /^(ага|угу|угу+|а+га+|ну\s+да|ну\s+давай|наверное|давай|ок|окей|ладно|мм+|м-м|хм+|hmm+|uh[\s-]?huh)[\s.!?…]*$/iu;

// Белый список явных подтверждений (voice.md §5).
const CONFIRM_RE = [
  /^да[,\s]+подтверждаю\.?$/iu,
  /^да[,\s]+подтверждается\.?$/iu,
  /^подтверждаю\.?$/iu,
  /^подтверждается\.?$/iu,
  /^выполняй\.?$/iu,
  /^да[,\s]+выполняй\.?$/iu,
  /^да[,\s]+сделай\.?$/iu,
];

// Длинные формы раньше коротких — иначе «курсор» съест «курсору».
const ENGINE_ALIASES = [
  ['курсору', 'cursor'],
  ['курсор', 'cursor'],
  ['cursor', 'cursor'],
  ['клоду', 'claude'],
  ['клода', 'claude'],
  ['клод', 'claude'],
  ['claude', 'claude'],
  ['гроку', 'grok'],
  ['грока', 'grok'],
  ['грок', 'grok'],
  ['grok', 'grok'],
  ['опенкоду', 'opencode'],
  ['opencode', 'opencode'],
  ['glm', 'glm'],
];

const ENGINE_ALT = ENGINE_ALIASES.map(([a]) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** Буквы (кириллица+латиница): \w в JS — только ASCII. */
const L = String.raw`\p{L}`;

/**
 * Нормализация текста для матчинга и чеканки ref.
 * Схлопывает пробелы, lower-case, ё→е, срезает краевую пунктуацию.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»""„]/g, '')
    .replace(/[,:;!?…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Устойчивый ref из намерения + нормализованного текста.
 * Без Date.now()/Math.random() — одинаковая реплика → одинаковый ref (ledger dedup).
 * @param {string|null} intent
 * @param {string} normalized
 * @returns {string}
 */
export function mintRef(intent, normalized) {
  const payload = `${intent ?? 'unknown'}|${normalized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24);
}

/**
 * Явное голосовое согласие? «ага/угу/наверное/давай» — false.
 * @param {string} text
 * @returns {boolean}
 */
export function isConfirmation(text) {
  const n = normalizeText(text);
  if (!n) return false;
  if (MUSH_RE.test(n)) return false;
  return CONFIRM_RE.some((re) => re.test(n));
}

/**
 * @param {string} alias
 * @returns {string}
 */
function resolveEngine(alias) {
  const key = String(alias ?? '').toLowerCase();
  for (const [a, id] of ENGINE_ALIASES) {
    if (a === key) return id;
  }
  return key;
}

/**
 * Критерий проверки: «с проверкой …», «проверь что …», «verify: …».
 * @param {string} n
 * @returns {string}
 */
function extractVerify(n) {
  const patterns = [
    new RegExp(String.raw`с\s+проверк${L}*\s+(.+)$`, 'u'),
    new RegExp(String.raw`проверь\s+что\s+(.+)$`, 'u'),
    new RegExp(String.raw`критери[йя]\s+(.+)$`, 'u'),
    /verify\s+(.+)$/iu,
  ];
  for (const re of patterns) {
    const m = n.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

/**
 * @param {string} n — normalizeText(raw)
 * @param {string} raw
 * @returns {{ intent: Intent, slots: Record<string, string>, missing: string[] } | null}
 */
function matchIntent(n, raw) {
  // 1. capture — «запиши решение: …» (после normalize «:» → пробел)
  if (/^(?:запиши|запомни)\s+решени[ея](?:\s|$)/u.test(n)) {
    const m = n.match(/^(?:запиши|запомни)\s+решени[ея]\s+(.+)$/u);
    let content = m?.[1]?.trim() || '';
    if (!content) {
      const rawM = String(raw).match(/(?:запиши|запомни)\s+решени[ея]\s*[-–—:]\s*(.+)$/iu);
      if (rawM) content = rawM[1].trim();
    }
    const slots = content ? { content } : {};
    const missing = content ? [] : ['content'];
    return { intent: 'capture', slots, missing };
  }

  // 2. assign — «продолжи задачу X» / «отдай Y курсору»
  {
    const cont = n.match(new RegExp(String.raw`^продолжи\s+задач[уию]\s+(.+)$`, 'u'));
    if (cont) {
      const verify = extractVerify(n);
      let topic = cont[1].trim();
      if (verify) {
        // срезать хвост «с проверкой …» из topic
        topic = topic
          .replace(new RegExp(String.raw`\s+с\s+проверк${L}*\s+.+$`, 'u'), '')
          .replace(new RegExp(String.raw`\s+проверь\s+что\s+.+$`, 'u'), '')
          .trim();
      }
      const slots = { topic, goal: `продолжить задачу ${topic}` };
      if (verify) slots.verify = verify;
      return { intent: 'assign', slots, missing: verify ? [] : ['verify'] };
    }

    // «отдай задачу курсору» — сначала точная форма (topic generic)
    const handBare = n.match(
      new RegExp(
        String.raw`^отдай\s+задач[уию]\s+(${ENGINE_ALT})(?:\s+с\s+проверк${L}*\s+(.+))?$`,
        'u',
      ),
    );
    if (handBare) {
      const engine = resolveEngine(handBare[1]);
      const verify = (handBare[2] && handBare[2].trim()) || extractVerify(n);
      const slots = { topic: '', engine, goal: `отдать задачу движку ${engine}` };
      if (verify) slots.verify = verify;
      return { intent: 'assign', slots, missing: verify ? [] : ['verify'] };
    }

    // «отдай <topic> курсору [с проверкой …]»
    const hand = n.match(
      new RegExp(
        String.raw`^отдай\s+(.+?)\s+(${ENGINE_ALT})(?:\s+с\s+проверк${L}*\s+(.+))?$`,
        'u',
      ),
    );
    if (hand) {
      let topic = hand[1].replace(new RegExp(String.raw`^задач[уию]\s+`, 'u'), '').trim();
      const engine = resolveEngine(hand[2]);
      const verify = (hand[3] && hand[3].trim()) || extractVerify(n);
      const slots = { topic, engine, goal: `отдать «${topic}» движку ${engine}` };
      if (verify) slots.verify = verify;
      return { intent: 'assign', slots, missing: verify ? [] : ['verify'] };
    }
  }

  // 3. blockers — «что в блокере по X» / «блокеры»
  if (new RegExp(String.raw`блокер${L}*`, 'u').test(n)) {
    const m = n.match(new RegExp(String.raw`блокер${L}*\s+по\s+(.+)$`, 'u'));
    const topic = m?.[1]?.trim() || '';
    const slots = topic ? { topic } : {};
    return { intent: 'blockers', slots, missing: [] };
  }

  // 4. fleet — «покажи флот»
  if (
    /покажи\s+флот/u.test(n)
    || /статус\s+флота/u.test(n)
    || /что\s+с\s+флотом/u.test(n)
    || /^флот$/u.test(n)
  ) {
    return { intent: 'fleet', slots: {}, missing: [] };
  }

  // 5. context — «что осталось» / «на чём я остановился»
  if (
    /что\s+осталось/u.test(n)
    || /на\s+чем\s+я\s+остановил/u.test(n)
    || /где\s+я\s+остановил/u.test(n)
    || /на\s+чем\s+остановил/u.test(n)
  ) {
    return { intent: 'context', slots: {}, missing: [] };
  }

  return null;
}

/**
 * Маршрутизатор голосовых намерений.
 * Ниже порога confidence — всегда reask (даже для чтения). Неоднозначность ≠ догадка.
 *
 * @param {string} text — распознанная речь
 * @param {{ confidence: number, threshold?: number }} opts
 * @returns {Decision}
 */
export function routeIntent(text, { confidence, threshold = 0.6 } = {}) {
  const conf = Number(confidence);
  const thr = Number(threshold ?? 0.6);
  const raw = String(text ?? '');
  const normalized = normalizeText(raw);
  const confOk = Number.isFinite(conf) && conf >= thr;

  const matched = matchIntent(normalized, raw);
  const intent = matched ? matched.intent : null;
  const ref = mintRef(intent, normalized);

  // Г1: ниже порога — переспрос, не лучшее предположение (включая чтения).
  if (!confOk) {
    return {
      intent,
      action: 'reask',
      confidence: Number.isFinite(conf) ? conf : 0,
      ref,
      slots: matched ? { ...matched.slots } : {},
      missing: [],
      say: 'Не расслышал, повтори?',
    };
  }

  // Намерение не распозналось → reask, не «похоже на assign».
  if (!matched) {
    return {
      intent: null,
      action: 'reask',
      confidence: conf,
      ref: mintRef(null, normalized),
      slots: {},
      missing: [],
      say: 'Не понял, что сделать. Повтори иначе?',
    };
  }

  const { slots, missing } = matched;

  // Чтения — без подтверждения.
  if (intent === 'context' || intent === 'blockers' || intent === 'fleet') {
    return {
      intent,
      action: 'read',
      confidence: conf,
      ref,
      slots: { ...slots },
      missing: [],
      say: sayForRead(intent, slots),
    };
  }

  // assign / capture — всегда через confirm; assign без verify → missing:['verify'].
  if (intent === 'assign') {
    const needVerify = !slots.verify;
    const missingUniq = [...new Set(needVerify ? ['verify', ...missing.filter((x) => x !== 'verify')] : [...missing])];
    return {
      intent: 'assign',
      action: 'confirm',
      confidence: conf,
      ref,
      slots: { ...slots },
      missing: missingUniq,
      say: needVerify
        ? 'Какой критерий проверки? Без verify наряд не отдаю.'
        : `Отдать «${slots.topic || 'задачу'}»${slots.engine ? ` → ${slots.engine}` : ''}? Подтверди.`,
    };
  }

  // capture
  return {
    intent: 'capture',
    action: 'confirm',
    confidence: conf,
    ref,
    slots: { ...slots },
    missing: [...missing],
    say: slots.content
      ? `Записать в inbox: «${slots.content}»? Подтверди.`
      : 'Что именно записать? Скажи решение целиком.',
  };
}

/** @param {Intent} intent @param {Record<string, string>} slots */
function sayForRead(intent, slots) {
  if (intent === 'context') return 'Смотрю handoff — на чём остановились.';
  if (intent === 'blockers') {
    return slots.topic
      ? `Смотрю блокеры по «${slots.topic}».`
      : 'Смотрю открытые блокеры в летописи.';
  }
  if (intent === 'fleet') return 'Показываю статус флота.';
  return '';
}

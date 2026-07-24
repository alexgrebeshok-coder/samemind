// bm25.mjs — чистый BM25 без единой npm-зависимости: токенизация (кириллица+латиница),
// tf/idf, нормализация длины. Единый keyword-фолбэк для recall/gde, когда эмбеддинги недоступны.
// Формула: score(D,Q) = Σ IDF(qi) · f(qi,D)·(k1+1) / (f(qi,D) + k1·(1−b+b·|D|/avgdl)).

const TOKEN_RE = /[^\p{L}\p{N}-]+/u;
const CYRILLIC_RE = /[а-яё]/i;
const MIN_STEM_LEN = 3;

// Conservative RU suffix strip (B3b): dative/adjective/noun endings; longest first.
// Latin/digits untouched. MIN_STEM_LEN avoids бот≠ботинок overstem.
const RU_SUFFIXES = [
  'ующего', 'ующему', 'ующими', 'ующая', 'ующие', 'ующий',
  'ского', 'скому', 'скими', 'ской', 'ская', 'ские', 'ским',
  'ениями', 'ению', 'ения', 'ением',
  'ного', 'ными', 'ной', 'ную', 'ных', 'ным', 'ная', 'ные',
  'ого', 'ому', 'ыми', 'ими',
  'ией', 'ием', 'иях', 'иям', 'ами', 'ах', 'ов', 'ев', 'ам', 'ом', 'ем',
  'ую', 'ые', 'ая', 'ой', 'ей', 'ий', 'ый',
  'ия', 'ию', 'ии', 'ью',
  'ить', 'ать', 'еть', 'ешь', 'ете', 'али', 'или', 'ите', 'ла', 'ли', 'ло',
  'ке', 'ку', 'ки', 'кой',
  'у', 'ы', 'и', 'е', 'а', 'я', 'ь', 'о',
];

/** Light Russian suffix stemmer; identity for non-Cyrillic tokens. */
export function stemRu(word) {
  if (!word || !CYRILLIC_RE.test(word)) return word;
  const w = word.toLowerCase();
  if (w.length <= MIN_STEM_LEN) return w;
  for (const suf of RU_SUFFIXES) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, -suf.length);
    if (stem.length >= MIN_STEM_LEN) return stem;
  }
  return w;
}

/** Токены текста: lower, split, RU-stem, длина ≥2. Единая точка для BM25 и queryTerms. */
export function tokenize(text) {
  return (text || '').toLowerCase().split(TOKEN_RE)
    .filter(t => t.length >= 2)
    .map(t => stemRu(t));
}

/**
 * Статистика корпуса для BM25.
 * @param {Array<{id:string}>} docs — документы уникального корпуса.
 * @param {(d:any)=>string} textOf — какой текст индексировать (title/desc/tags/body — см. recall.docText).
 */
export function buildCorpus(docs, { textOf = d => String(d ?? '') } = {}) {
  const df = new Map();        // term → в скольких документах встретился (document frequency)
  const docTf = new Map();     // id → Map(term → частота в документе)
  const docLen = new Map();    // id → длина документа в токенах
  let totalLen = 0;
  for (const d of docs) {
    const tokens = tokenize(textOf(d));
    docLen.set(d.id, tokens.length);
    totalLen += tokens.length;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docTf.set(d.id, tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const avgdl = N ? totalLen / N : 0;
  return { df, docTf, docLen, N, avgdl };
}

/** IDF (Robertson-Sparck-Jones со сглаживанием +1 — строго неотрицательный). */
export function idf(corpus, term) {
  const df = corpus.df.get(term) || 0;
  return Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
}

/**
 * BM25-скор документа по запросу.
 * @param {string} query
 * @param {string} docId — ключ документа в корпусе
 * @param {object} corpus — из buildCorpus
 * @param {object} opts — k1 (насыщение tf, по умолч. 1.2), b (нормализация длины, 0.75)
 */
export function bm25Score(query, docId, corpus, { k1 = 1.2, b = 0.75 } = {}) {
  const tf = corpus.docTf.get(docId);
  if (!tf || !corpus.avgdl) return 0;
  const dl = corpus.docLen.get(docId) || 0;
  const lenNorm = k1 * (1 - b + b * (dl / corpus.avgdl));
  let score = 0;
  for (const t of tokenize(query)) {
    const f = tf.get(t);
    if (!f) continue;
    score += (idf(corpus, t) * (f * (k1 + 1))) / (f + lenNorm);
  }
  return score;
}

// Golden cases for ICL-vs-samemind bench over the real soul-memory corpus
// (~/.claude/projects/-Users-aleksandrgrebeshok--soul/memory/).
//
// Each case: natural-language query + golden document id(s) + must-have fact markers
// (keywords that prove the RIGHT fact is in the packed context, not just a related doc).
//
// Methodology (adversarial Continual-Learning-Bench stance):
//   prove WHERE memory wins (accuracy / tokens / latency) and where ICL is no worse.

export const DEFAULT_MEMORY_ROOT =
  process.env.OKF_ROOT
  || `${process.env.HOME}/.claude/projects/-Users-aleksandrgrebeshok--soul/memory`;

/** @typedef {{ id: string, query: string, golden: string[], must: string[], note?: string }} BenchCase */

/** @type {BenchCase[]} */
export const CASES = [
  {
    id: 'family-bot',
    // lemma form — BM25 is not a Russian stemmer; "семейному боту" is a known miss (see report)
    query: 'что по семейный бот',
    golden: ['family-bot-fix-20260722'],
    must: ['OpenRouter', 'DeepSeek', 'Очаг'],
    note: 'корневой инцидент 22.07 + Живой Очаг; отдельно: dative "семейному боту" fails BM25',
  },
  {
    id: 'family-bot-dative-morph',
    query: 'что по семейному боту',
    golden: ['family-bot-fix-20260722'],
    must: ['OpenRouter', 'DeepSeek', 'Очаг'],
    note: 'ADVERSARIAL morph: dative case — expected BM25 miss without stemmer',
  },
  {
    id: 'family-bot-llm-dead',
    query: 'почему семейный бот повторял советы и обрезал новости',
    golden: ['family-bot-fix-20260722'],
    must: ['402', 'LLM', 'fallback'],
    note: 'причинный факт: LLM мёртв, не «тупой промпт»',
  },
  {
    id: 'ceoclaw-tenancy',
    query: 'статус ceoclaw tenancy Organization AccessProfile',
    golden: ['ceoclaw-tenancy-two-layers'],
    must: ['Organization', 'AccessProfile'],
    note: 'два несведённых контура tenancy',
  },
  {
    id: 'acceptance-rules',
    query: 'правила приёмки директора ложное готово',
    golden: ['director-not-dispatcher'],
    must: ['директор', 'приёмк'],
    note: 'директор ≠ диспетчер',
  },
  {
    id: 'verify-gate',
    query: 'правило verify-гейт не должен противоречить ТЗ',
    golden: ['rule-verify-gate-consistency'],
    must: ['verify', 'ТЗ'],
    note: 'rule-verify-gate-consistency',
  },
  {
    id: 'deploy-is-live',
    query: 'деплой это боевой прогон launchd cron',
    golden: ['rule-deploy-is-live'],
    must: ['launchd', 'прод'],
  },
  {
    id: 'samemind-ux',
    query: 'samemind setup поставил работает onboarding',
    golden: ['ux-onboarding-samemind'],
    must: ['setup', '0.5'],
  },
  {
    id: 'memory-roadmap',
    query: 'роадмап памяти samemind Ф0 Ф5 hybrid sqlite',
    golden: ['memory-architecture-plan'],
    must: ['Ф0', 'hybrid'],
  },
  {
    id: 'chinese-llm',
    query: 'китайские LLM провайдеры Kimi MiniMax DeepSeek',
    golden: ['chinese-llm-providers-plan'],
    must: ['Kimi', 'MiniMax', 'DeepSeek'],
  },
  {
    id: 'zhenya-beauty',
    query: 'бьюти бизнес Жени Craftyglam канал',
    golden: ['zhenya-beauty-project'],
    must: ['Craftyglam', 'Жен'],
  },
  {
    id: 'brief-bot-incident',
    query: 'почему бот TheClaudeCodeBot молчал с 02.07',
    golden: ['brief-bot-incident-20260721'],
    must: ['await', 'Database'],
  },
  {
    id: 'kostya-sever',
    query: 'Костя Северавтодор ЮВиС доля выход',
    golden: ['kostya-severavtodor-yuvis-20260722'],
    must: ['Северавтодор', 'ЮВ'],
  },
  {
    id: 'fable-burn',
    query: 'почему Fable сжёг лимиты 5h июля',
    golden: ['fable-limit-burn-20260702'],
    must: ['Fable', 'cache'],
  },
  {
    id: 'tg-idea-scan',
    query: 'разбор Избранного Telegram Active Memory FluxMem',
    golden: ['tg-idea-scan-20260723'],
    must: ['Active Memory', 'Избранн'],
  },
];

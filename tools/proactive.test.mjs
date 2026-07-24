// proactive.test.mjs — unit tests for Active Memory prototype (lib/proactive.mjs)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldProactive, estimateTokens, formatPack, rankForProactive, proactiveRecall,
} from './lib/proactive.mjs';
import { rankByKeywords } from './lib/recall.mjs';

const noThreshold = { minScoreAbsolute: 0, minScoreRatio: 0 };

const docs = [
  {
    id: 'family-bot-fix-20260722',
    fm: { title: 'Семейный бот — инцидент', type: 'project' },
    body: 'Семейный бот упал из-за OpenRouter 402. LLM был мёртв. DeepSeek оживил Живой Очаг.',
    reserved: false,
  },
  {
    id: 'zhenya-beauty-project',
    fm: { title: 'Женя beauty', type: 'project' },
    body: 'Craftyglam канал бьюти бизнес Жени.',
    reserved: false,
  },
  {
    id: 'ceoclaw',
    fm: { title: 'CEOClaw tenancy', type: 'project' },
    body: 'Organization vs AccessProfile — два контура tenancy.',
    reserved: false,
  },
  {
    id: 'unrelated',
    fm: { title: 'Про погоду', type: 'note' },
    body: 'Сегодня солнечно и тепло на улице.',
    reserved: false,
  },
];

describe('shouldProactive', () => {
  it('accepts fact-shaped questions', () => {
    assert.equal(shouldProactive('что по семейному боту сегодня'), true);
  });
  it('rejects tiny pings', () => {
    assert.equal(shouldProactive('ok'), false);
    assert.equal(shouldProactive('да'), false);
  });
});

describe('estimateTokens', () => {
  it('uses 4 chars/token heuristic', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('a'.repeat(40)), 10);
  });
});

describe('rankForProactive + formatPack', () => {
  it('ranks family-bot above unrelated for bot query', () => {
    const hits = rankForProactive(docs, 'семейный бот OpenRouter', { k: 2, ...noThreshold });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'family-bot-fix-20260722');
  });

  it('family-bot-dative-morph: дательный падеж → family-bot-fix', () => {
    const hits = rankForProactive(docs, 'семейному боту', { k: 3, ...noThreshold });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'family-bot-fix-20260722');
  });

  it('builds a capped pack with ids', () => {
    const hits = rankForProactive(docs, 'семейный бот', { k: 2, ...noThreshold });
    const byId = new Map(docs.map(d => [d.id, d]));
    const pack = formatPack(hits, byId, { query: 'семейный бот', maxChars: 2000 });
    assert.ok(pack.text.includes('family-bot'));
    assert.ok(pack.tokens > 0);
  });
});

describe('proactiveRecall', () => {
  it('returns hits + manualRecallsSaved=1', async () => {
    const r = await proactiveRecall({
      docs, query: 'что случилось с семейным ботом OpenRouter', k: 3, force: true,
      ...noThreshold,
    });
    assert.equal(r.skipped, false);
    assert.ok(r.hits.some(h => h.id === 'family-bot-fix-20260722'));
    assert.equal(r.manualRecallsSaved, 1);
    assert.ok(r.latencyMs >= 0);
  });

  it('minScore: skips weak match for irrelevant query', async () => {
    const r = await proactiveRecall({
      docs,
      query: 'рецепт борща на зиму',
      k: 3,
      force: true,
      rank: (d, q, opts) => rankByKeywords(d, q, opts),
      minScoreAbsolute: 6,
      minScoreRatio: 0.3,
    });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'weak match');
    assert.equal(r.hits.length, 0);
    assert.equal(r.pack, '');
    assert.equal(r.manualRecallsSaved, 0);
  });

  it('skips short queries unless force', async () => {
    const r = await proactiveRecall({ docs, query: 'ok', k: 3 });
    assert.equal(r.skipped, true);
    assert.equal(r.manualRecallsSaved, 0);
  });

  // (г) Э6/6.3 — proactive inherits recall stale-drop; pack must not inject superseded
  it('(г) proactive pack excludes superseded by default', async () => {
    const supersedeDocs = [
      {
        id: 'concepts/old-price',
        reserved: false,
        supersedes: [],
        supersededBy: ['/concepts/new-price.md'],
        fm: { title: 'Bentonite price', type: 'Concept', visibility: 'internal' },
        body: 'The current bentonite price per ton was outdated.',
      },
      {
        id: 'concepts/new-price',
        reserved: false,
        supersedes: ['/concepts/old-price.md'],
        supersededBy: [],
        fm: { title: 'Bentonite price', type: 'Concept', visibility: 'internal' },
        body: 'The current bentonite price per ton is the live figure.',
      },
    ];
    const r = await proactiveRecall({
      docs: supersedeDocs,
      query: 'what is the bentonite price per ton',
      k: 5,
      force: true,
      ...noThreshold,
    });
    assert.equal(r.skipped, false);
    assert.ok(r.hits.some(h => h.id === 'concepts/new-price'));
    assert.ok(!r.hits.some(h => h.id === 'concepts/old-price'));
    assert.ok(r.pack.includes('concepts/new-price'));
    assert.ok(!r.pack.includes('concepts/old-price'));
  });
});

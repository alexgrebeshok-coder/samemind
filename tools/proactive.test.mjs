// proactive.test.mjs — unit tests for Active Memory prototype (lib/proactive.mjs)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldProactive, estimateTokens, formatPack, rankForProactive, proactiveRecall,
} from './lib/proactive.mjs';

const docs = [
  {
    id: 'family-bot',
    fm: { title: 'Семейный бот', type: 'project' },
    body: 'Семейный бот упал из-за OpenRouter 402. LLM был мёртв. DeepSeek оживил.',
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
    const hits = rankForProactive(docs, 'семейный бот OpenRouter', { k: 2 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'family-bot');
  });

  it('builds a capped pack with ids', () => {
    const hits = rankForProactive(docs, 'семейный бот', { k: 2 });
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
    });
    assert.equal(r.skipped, false);
    assert.ok(r.hits.some(h => h.id === 'family-bot'));
    assert.equal(r.manualRecallsSaved, 1);
    assert.ok(r.latencyMs >= 0);
  });

  it('skips short queries unless force', async () => {
    const r = await proactiveRecall({ docs, query: 'ok', k: 3 });
    assert.equal(r.skipped, true);
    assert.equal(r.manualRecallsSaved, 0);
  });
});

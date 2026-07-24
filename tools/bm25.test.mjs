#!/usr/bin/env node
// bm25.test.mjs — unit tests для чистого BM25-движка (node --test). Без сети.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildCorpus, idf, bm25Score } from './lib/bm25.mjs';

describe('bm25 — tokenize', () => {
  it('lowercases and splits latin on non-letter/digit/hyphen', () => {
    assert.deepEqual(tokenize('Lumen-Notes, editor!'), ['lumen-notes', 'editor']);
  });

  it('handles cyrillic + RU-стеммит (B3b: падежи сходятся к одной основе)', () => {
    // tokenize теперь применяет stemRu в единой точке — так запрос и документы
    // нормализуются одинаково (иначе BM25 промахивается по падежу).
    assert.deepEqual(tokenize('Предпроектная подготовка трассы!'), ['предпроект', 'подготовк', 'трасс']);
    // смысл фичи: разные словоформы → одна основа
    assert.deepEqual(tokenize('семейному'), tokenize('семейный'));
  });

  it('drops tokens shorter than 2 chars', () => {
    assert.deepEqual(tokenize('a I am ok 5'), ['am', 'ok']);
  });

  it('empty/null input → []', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
  });
});

describe('bm25 — corpus stats', () => {
  const docs = [
    { id: 'a', text: 'park park planning' },
    { id: 'b', text: 'park logistics' },
    { id: 'c', text: 'mining quartz mine' },
  ];
  const corpus = buildCorpus(docs, { textOf: d => d.text });

  it('N = doc count, avgdl = mean doc length', () => {
    assert.equal(corpus.N, 3);
    // lengths: 3, 2, 3 → avg 8/3
    assert.ok(Math.abs(corpus.avgdl - 8 / 3) < 1e-9);
    assert.equal(corpus.docLen.get('a'), 3);
    assert.equal(corpus.docLen.get('b'), 2);
  });

  it('document frequency per term', () => {
    assert.equal(corpus.df.get('park'), 2);     // a, b
    assert.equal(corpus.df.get('quartz'), 1);   // c
    assert.equal(corpus.df.get('planning'), 1); // a
  });

  it('term frequency within a doc', () => {
    assert.equal(corpus.docTf.get('a').get('park'), 2);
    assert.equal(corpus.docTf.get('b').get('park'), 1);
  });

  it('idf is non-negative and higher for rarer terms', () => {
    assert.ok(idf(corpus, 'park') >= 0);
    assert.ok(idf(corpus, 'quartz') > idf(corpus, 'park'));
  });
});

describe('bm25 — scoring & ranking', () => {
  const docs = [
    { id: 'park', text: 'industrial park planning an industrial park on fifty hectares' },
    { id: 'mine', text: 'quartz mining project in the north' },
    { id: 'note', text: 'a note from openclaw about the park' },
  ];
  const corpus = buildCorpus(docs, { textOf: d => d.text });

  it('doc with matching term outscores doc without', () => {
    assert.ok(bm25Score('quartz mining', 'mine', corpus) > 0);
    assert.equal(bm25Score('quartz mining', 'park', corpus), 0);
  });

  it('rare term dominates: "industrial" only in park doc', () => {
    const parkScore = bm25Score('industrial', 'park', corpus);
    assert.ok(parkScore > 0);
    assert.equal(bm25Score('industrial', 'mine', corpus), 0);
    assert.equal(bm25Score('industrial', 'note', corpus), 0);
  });

  it('repeated term in doc scores higher than single occurrence', () => {
    // "park" appears twice in `park` doc, once in `note`
    assert.ok(bm25Score('park', 'park', corpus) > bm25Score('park', 'note', corpus));
  });

  it('empty/missing corpus → 0, no NaN', () => {
    const empty = buildCorpus([], { textOf: d => d.text });
    assert.equal(bm25Score('x', 'a', empty), 0);
    assert.ok(Number.isFinite(bm25Score('x', 'a', empty)));
  });

  it('relevant doc ranks #1 (cyrillic, matching forms)', () => {
    const ru = [
      { id: 'road', text: 'предпроектная подготовка трассы автомобильной дороги' },
      { id: 'other', text: 'совсем другая тематика проекта' },
    ];
    const c = buildCorpus(ru, { textOf: d => d.text });
    const ranked = ru
      .map(d => ({ id: d.id, s: bm25Score('предпроектная подготовка', d.id, c) }))
      .sort((a, b) => b.s - a.s);
    assert.equal(ranked[0].id, 'road');
  });
});

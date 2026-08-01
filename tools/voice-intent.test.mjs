// voice-intent.test.mjs — гейт намерений голоса (docs/spec/voice.md §5, §7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeIntent,
  isConfirmation,
  normalizeText,
  mintRef,
} from './lib/voice-intent.mjs';

const OK = { confidence: 0.9, threshold: 0.6 };
const LOW = { confidence: 0.5, threshold: 0.6 };

describe('routeIntent — пять намерений (реалистичные русские фразы)', () => {
  it('context: «что осталось» → read / handoff', () => {
    const d = routeIntent('что осталось?', OK);
    assert.equal(d.intent, 'context');
    assert.equal(d.action, 'read');
    assert.equal(d.confidence, 0.9);
    assert.ok(d.ref);
    assert.ok(d.say);
    assert.deepEqual(d.missing, []);
  });

  it('context: «на чём я остановился» → read', () => {
    const d = routeIntent('на чём я остановился', OK);
    assert.equal(d.intent, 'context');
    assert.equal(d.action, 'read');
  });

  it('blockers: «что в блокере по X» → read + slot topic', () => {
    const d = routeIntent('что в блокере по ceoclaw', OK);
    assert.equal(d.intent, 'blockers');
    assert.equal(d.action, 'read');
    assert.equal(d.slots.topic, 'ceoclaw');
    assert.deepEqual(d.missing, []);
  });

  it('fleet: «покажи флот» → read', () => {
    const d = routeIntent('покажи флот', OK);
    assert.equal(d.intent, 'fleet');
    assert.equal(d.action, 'read');
    assert.deepEqual(d.missing, []);
  });

  it('assign: «продолжи задачу X» с verify → confirm', () => {
    const d = routeIntent(
      'продолжи задачу sm016, с проверкой тесты зелёные',
      OK,
    );
    assert.equal(d.intent, 'assign');
    assert.equal(d.action, 'confirm');
    assert.ok(d.slots.topic.includes('sm016'));
    assert.ok(d.slots.verify);
    assert.ok(!d.missing.includes('verify'));
  });

  it('assign: «отдай Y курсору» с verify → confirm + engine', () => {
    const d = routeIntent(
      'отдай наряд fleet-scope курсору с проверкой node --test tools/fleet.test.mjs',
      OK,
    );
    assert.equal(d.intent, 'assign');
    assert.equal(d.action, 'confirm');
    assert.equal(d.slots.engine, 'cursor');
    assert.ok(d.slots.verify);
  });

  it('capture: «запиши решение: …» → confirm + content', () => {
    const d = routeIntent('запиши решение: берём worktree на движок', OK);
    assert.equal(d.intent, 'capture');
    assert.equal(d.action, 'confirm');
    assert.match(d.slots.content, /worktree/i);
    assert.deepEqual(d.missing, []);
  });
});

describe('routeIntent — confidence gate (release-blocker)', () => {
  const phrases = [
    ['что осталось', 'context'],
    ['что в блокере по X', 'blockers'],
    ['покажи флот', 'fleet'],
    ['отдай задачу курсору', 'assign'],
    ['запиши решение: не трогать main', 'capture'],
  ];

  for (const [phrase, name] of phrases) {
    it(`уверенность 0.5 при пороге 0.6 → reask даже для «${name}»`, () => {
      const d = routeIntent(phrase, LOW);
      assert.equal(d.action, 'reask', `expected reask for ${name}, got ${d.action}`);
      assert.equal(d.confidence, 0.5);
      // Нельзя выдать наряд / запись / внешнее из низкой уверенности.
      assert.notEqual(d.action, 'confirm');
      assert.notEqual(d.action, 'read');
    });
  }
});

describe('routeIntent — assign без verify', () => {
  it('«отдай задачу курсору» без критерия → confirm + missing verify', () => {
    const d = routeIntent('отдай задачу курсору', OK);
    assert.equal(d.intent, 'assign');
    assert.equal(d.action, 'confirm');
    assert.ok(
      d.missing.includes('verify'),
      `missing should contain verify, got ${JSON.stringify(d.missing)}`,
    );
    assert.equal(d.slots.engine, 'cursor');
    // Без verify слота нет (или пусто) — карточка спросит.
    assert.ok(!d.slots.verify);
  });
});

describe('routeIntent — ref идемпотентность', () => {
  it('одна и та же фраза дважды → одинаковый ref', () => {
    const phrase = 'покажи флот';
    const a = routeIntent(phrase, OK);
    const b = routeIntent(phrase, OK);
    assert.equal(a.ref, b.ref);
    assert.ok(a.ref.length >= 8);
  });

  it('разные фразы → разные ref', () => {
    const a = routeIntent('что осталось', OK);
    const b = routeIntent('покажи флот', OK);
    assert.notEqual(a.ref, b.ref);
  });

  it('mintRef детерминирован (без Date.now / random)', () => {
    const n = normalizeText('запиши решение: foo');
    assert.equal(mintRef('capture', n), mintRef('capture', n));
    assert.notEqual(mintRef('capture', n), mintRef('assign', n));
  });
});

describe('isConfirmation — согласие ≠ мычание', () => {
  it('false на ага / угу / наверное / давай / ну да', () => {
    for (const t of ['ага', 'угу', 'наверное', 'давай', 'ну да', 'Ага!', 'Угу…']) {
      assert.equal(isConfirmation(t), false, `expected false for «${t}»`);
    }
  });

  it('true на явном «да, подтверждаю» / белый список', () => {
    assert.equal(isConfirmation('да, подтверждаю'), true);
    assert.equal(isConfirmation('да, подтверждается'), true);
    assert.equal(isConfirmation('выполняй'), true);
    assert.equal(isConfirmation('подтверждаю'), true);
  });
});

describe('routeIntent — невнятица', () => {
  it('невнятица → reask, не «похоже на assign»', () => {
    const d = routeIntent('эээ ну как бы там', OK);
    assert.equal(d.action, 'reask');
    assert.equal(d.intent, null);
  });

  it('пустая строка → reask', () => {
    const d = routeIntent('', OK);
    assert.equal(d.action, 'reask');
  });
});

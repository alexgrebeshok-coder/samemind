#!/usr/bin/env node
// relation-kinds.test.mjs — closed read-side relation vocabulary (graph-design-note.md §§2–4).
// Parser stays open; this module only classifies. Run: node --test tools/relation-kinds.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRelationKey,
  canonicalRelationKind,
  isExpandableRelationKey,
  relationKindTraversal,
  orientRelation,
  unknownRelationKindWarnings,
  RELATION_KIND_TRAVERSAL,
  RELATION_WALK_ORDER,
} from './lib/relation-kinds.mjs';

// Spec table from docs/graph-design-note.md §§2–3. Expected values are literals from the note,
// not recomputed from the implementation (so dropping an alias or flipping a class goes red).
const CLASSIFY_CASES = [
  ['about',            { class: 'edge',    kind: 'about',      reverse: false }],
  ['covers',           { class: 'edge',    kind: 'about',      reverse: false }],
  ['project',          { class: 'edge',    kind: 'about',      reverse: false }],
  ['member_of',        { class: 'edge',    kind: 'member_of',  reverse: false }],
  ['works_at',         { class: 'edge',    kind: 'member_of',  reverse: false }],
  ['part_of',          { class: 'edge',    kind: 'member_of',  reverse: false }],
  ['depends_on',       { class: 'edge',    kind: 'depends_on', reverse: false }],
  ['uses',             { class: 'edge',    kind: 'uses',       reverse: false }],
  ['agreed_with',      { class: 'edge',    kind: 'agreed_with', reverse: false }],
  ['informs',          { class: 'edge',    kind: 'informs',    reverse: false }],
  ['led_to',           { class: 'edge',    kind: 'informs',    reverse: false }],
  ['decided',          { class: 'edge',    kind: 'informs',    reverse: false }],
  ['spawned_by',       { class: 'edge',    kind: 'informs',    reverse: true }],
  ['related',          { class: 'edge',    kind: 'related',    reverse: false }],
  ['next',             { class: 'board',   kind: 'next',       reverse: false }],
  ['supersedes',       { class: 'hygiene', kind: 'supersedes', reverse: false }],
  ['superseded_by',    { class: 'hygiene', kind: 'supersedes', reverse: true }],
  ['relations.supersedes', { class: 'hygiene', kind: 'supersedes', reverse: false }],
  ['frobnicates',      { class: 'unknown', kind: null,        reverse: false }],
];

describe('classifyRelationKey — canon / alias / reverse / class', () => {
  for (const [raw, expected] of CLASSIFY_CASES) {
    it(`${raw} → ${expected.class}/${expected.kind}${expected.reverse ? ' reverse' : ''}`, () => {
      assert.deepEqual(classifyRelationKey(raw), expected);
    });
  }

  it('null/empty/whitespace → unknown', () => {
    for (const raw of [null, undefined, '', '   ']) {
      assert.deepEqual(classifyRelationKey(raw), { class: 'unknown', kind: null, reverse: false });
    }
  });

  it('normalizes case and relations. prefix', () => {
    assert.deepEqual(classifyRelationKey('Works_At'), {
      class: 'edge', kind: 'member_of', reverse: false,
    });
    assert.deepEqual(classifyRelationKey('relations.superseded_by'), {
      class: 'hygiene', kind: 'supersedes', reverse: true,
    });
  });
});

describe('canonicalRelationKind', () => {
  it('maps aliases to stored edge kinds', () => {
    assert.equal(canonicalRelationKind('covers'), 'about');
    assert.equal(canonicalRelationKind('project'), 'about');
    assert.equal(canonicalRelationKind('works_at'), 'member_of');
    assert.equal(canonicalRelationKind('part_of'), 'member_of');
    assert.equal(canonicalRelationKind('led_to'), 'informs');
    assert.equal(canonicalRelationKind('decided'), 'informs');
    assert.equal(canonicalRelationKind('spawned_by'), 'informs');
    assert.equal(canonicalRelationKind('about'), 'about');
  });

  it('returns null for board, hygiene, unknown', () => {
    assert.equal(canonicalRelationKind('next'), null);
    assert.equal(canonicalRelationKind('supersedes'), null);
    assert.equal(canonicalRelationKind('superseded_by'), null);
    assert.equal(canonicalRelationKind('relations.supersedes'), null);
    assert.equal(canonicalRelationKind('frobnicates'), null);
    assert.equal(canonicalRelationKind('cites'), null);
  });
});

describe('isExpandableRelationKey', () => {
  it('true only for stored graph edges (not board / hygiene / unknown / cites)', () => {
    const expandable = [
      'about', 'covers', 'project', 'member_of', 'works_at', 'part_of',
      'depends_on', 'uses', 'agreed_with', 'informs', 'led_to', 'decided',
      'spawned_by', 'related',
    ];
    const notExpandable = [
      'next', 'supersedes', 'superseded_by', 'relations.supersedes',
      'frobnicates', 'cites', '',
      'constructor', '__proto__', 'toString',
    ];
    for (const k of expandable) assert.equal(isExpandableRelationKey(k), true, k);
    for (const k of notExpandable) assert.equal(isExpandableRelationKey(k), false, k);
  });
});

describe('RELATION_WALK_ORDER', () => {
  it('matches graph-design-note.md §4.3 (typed edges, then cites, related last)', () => {
    assert.deepEqual([...RELATION_WALK_ORDER], [
      'about', 'member_of', 'agreed_with', 'depends_on', 'informs', 'uses',
      'cites',
      'related',
    ]);
  });

  it('is the same dictionary as RELATION_KIND_TRAVERSAL (no second walk table)', () => {
    assert.deepEqual(Object.keys(RELATION_KIND_TRAVERSAL), [...RELATION_WALK_ORDER]);
  });
});

// Spec table from docs/graph-design-note.md §4.3. Literals from the note, not recomputed
// from the implementation (so flipping a direction / derived / symmetric goes red).
const TRAVERSAL_CASES = [
  ['about',       { kind: 'about',       directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['member_of',   { kind: 'member_of',   directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['agreed_with', { kind: 'agreed_with', directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['depends_on',  { kind: 'depends_on',  directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['informs',     { kind: 'informs',     directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['uses',        { kind: 'uses',        directions: ['outbound', 'inbound'], derived: false, symmetric: false }],
  ['cites',       { kind: 'cites',       directions: ['inbound'],             derived: true,  symmetric: false }],
  ['related',     { kind: 'related',     directions: ['outbound', 'inbound'], derived: false, symmetric: true }],
];

describe('relationKindTraversal — directions / derived / symmetric', () => {
  for (const [kind, expected] of TRAVERSAL_CASES) {
    it(`${kind} → ${expected.directions.join('+')}${expected.derived ? ' derived' : ''}${expected.symmetric ? ' symmetric' : ''}`, () => {
      const spec = relationKindTraversal(kind);
      assert.deepEqual(spec, expected);
      assert.equal(RELATION_KIND_TRAVERSAL[kind], spec);
    });
  }

  it('null for aliases, board, hygiene, unknown — lookup is by canonical walk kind', () => {
    for (const raw of ['covers', 'works_at', 'spawned_by', 'next', 'supersedes', 'frobnicates', '', null, 'constructor', '__proto__', 'toString']) {
      assert.equal(relationKindTraversal(raw), null, String(raw));
    }
  });
});

describe('traversal mutation probes', () => {
  it('cites outbound — derived walk stays inbound-only', () => {
    const spec = relationKindTraversal('cites');
    assert.ok(!spec.directions.includes('outbound'), 'cites must not walk outbound');
    assert.deepEqual([...spec.directions], ['inbound']);
    assert.equal(spec.derived, true);
    assert.equal(spec.symmetric, false);
  });

  it('related non-symmetric — weak neighbor stays symmetric both ways', () => {
    const spec = relationKindTraversal('related');
    assert.equal(spec.symmetric, true);
    assert.deepEqual([...spec.directions], ['outbound', 'inbound']);
    assert.equal(spec.derived, false);
    assert.equal(RELATION_WALK_ORDER.at(-1), 'related');
  });

  it('missing typed inbound — six stored kinds walk both directions', () => {
    for (const kind of ['about', 'member_of', 'agreed_with', 'depends_on', 'informs', 'uses']) {
      const spec = relationKindTraversal(kind);
      assert.ok(spec.directions.includes('inbound'), `${kind} inbound`);
      assert.ok(spec.directions.includes('outbound'), `${kind} outbound`);
      assert.equal(spec.derived, false, kind);
      assert.equal(spec.symmetric, false, kind);
    }
  });
});

const PROTO_KEYS = ['constructor', '__proto__', 'toString'];
const UNKNOWN = { class: 'unknown', kind: null, reverse: false };

describe('prototype keys are unknown — not inherited object slots', () => {
  for (const raw of PROTO_KEYS) {
    it(`${raw} → unknown / canonical null / not expandable / traversal null`, () => {
      assert.deepEqual(classifyRelationKey(raw), UNKNOWN);
      assert.equal(canonicalRelationKind(raw), null);
      assert.equal(isExpandableRelationKey(raw), false);
      assert.equal(relationKindTraversal(raw), null);
    });
  }

  it('validate warns on constructor / __proto__ / toString (own keys)', () => {
    const relations = Object.create(null);
    relations.constructor = '/entities/a.md';
    relations['__proto__'] = '/entities/a.md';
    relations.toString = '/entities/a.md';
    const warns = unknownRelationKindWarnings([{ id: 'entities/proto', relations }]);
    assert.deepEqual(warns, [
      'entities/proto [constructor] — unknown relation kind',
      'entities/proto [__proto__] — unknown relation kind',
      'entities/proto [toString] — unknown relation kind',
    ]);
  });
});

describe('orientRelation — alias reverse for expand', () => {
  it('spawned_by flips the pair to canonical informs inbound', () => {
    assert.deepEqual(
      orientRelation('research-mirror-sync-mechanism', 'spawned_by', 'analysis-mirror-staleness'),
      {
        from: 'analysis-mirror-staleness',
        to: 'research-mirror-sync-mechanism',
        kind: 'informs',
        direction: 'inbound',
      },
    );
  });

  it('informs keeps the written pair outbound (no flip)', () => {
    assert.deepEqual(
      orientRelation('analysis-mirror-staleness', 'informs', 'idea-cron-sync-adapters'),
      {
        from: 'analysis-mirror-staleness',
        to: 'idea-cron-sync-adapters',
        kind: 'informs',
        direction: 'outbound',
      },
    );
  });
});

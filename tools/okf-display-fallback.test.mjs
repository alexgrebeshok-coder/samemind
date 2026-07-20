#!/usr/bin/env node
// okf-display-fallback.test.mjs — metadata: block parsing + displayTitle/displayType fallback
// (samemind's own memory schema: name/description/metadata.type instead of OKF-native
// title/type — see docs/interop.md, memory-tails-0720 tail 2). node --test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, displayTitle, displayType } from './lib/okf.mjs';

describe('parseFrontmatter — metadata: block', () => {
  it('parses a flat indented metadata: block into fm.metadata', () => {
    const fm = parseFrontmatter([
      'name: agent-permission-hygiene',
      'description: some rule',
      'metadata: ',
      '  node_type: memory',
      '  type: feedback',
      '  originSessionId: abc-123',
    ].join('\n'));
    assert.deepEqual(fm.metadata, { node_type: 'memory', type: 'feedback', originSessionId: 'abc-123' });
  });

  it('empty metadata: {} → empty object, not a crash', () => {
    const fm = parseFrontmatter('metadata: {}\nname: x');
    assert.deepEqual(fm.metadata, {});
  });

  it('does not swallow the next top-level key after the block', () => {
    const fm = parseFrontmatter(['metadata: ', '  node_type: memory', 'visibility: internal'].join('\n'));
    assert.equal(fm.visibility, 'internal');
  });
});

describe('displayTitle — OKF-native preferred, falls back onto memory schema', () => {
  it('OKF-native title wins, untouched', () => {
    assert.equal(displayTitle({ title: 'Real Title', description: 'd', name: 'n' }), 'Real Title');
  });
  it('no title → falls back to description', () => {
    assert.equal(displayTitle({ description: 'A memory fact', name: 'n' }), 'A memory fact');
  });
  it('no title/description → falls back to name', () => {
    assert.equal(displayTitle({ name: 'n' }), 'n');
  });
  it('nothing at all → empty string, not undefined', () => {
    assert.equal(displayTitle({}), '');
    assert.equal(displayTitle(undefined), '');
  });
});

describe('displayType — OKF-native preferred, falls back onto metadata.type/node_type', () => {
  it('OKF-native type wins, untouched even with a metadata block present', () => {
    assert.equal(displayType({ type: 'Task', metadata: { type: 'feedback' } }), 'Task');
  });
  it('no type → falls back to metadata.type', () => {
    assert.equal(displayType({ metadata: { type: 'feedback', node_type: 'memory' } }), 'feedback');
  });
  it('no type, no metadata.type → falls back to metadata.node_type', () => {
    assert.equal(displayType({ metadata: { node_type: 'memory' } }), 'memory');
  });
  it('nothing at all → empty string, not undefined', () => {
    assert.equal(displayType({}), '');
    assert.equal(displayType(undefined), '');
  });
});

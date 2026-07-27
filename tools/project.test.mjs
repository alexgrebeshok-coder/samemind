#!/usr/bin/env node
// project.test.mjs — unit tests for the pure memory-projection core (node --test).
// In-memory only, no filesystem. Run: node --test tools/project.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeByName, renderFactEntries, truncateBlock, stripMarkerBlocks, stripSections,
} from './lib/project.mjs';

describe('dedupeByName', () => {
  it('keeps the first entry when names collide (regression: stale-copy-shadows-fresh bug)', () => {
    const entries = [
      { name: 'a', desc: 'first', body: 'FIRST' },
      { name: 'a', desc: 'second', body: 'SECOND' },
      { name: 'b', desc: '', body: 'B' },
    ];
    const out = dedupeByName(entries);
    assert.equal(out.length, 2);
    assert.equal(out[0].body, 'FIRST');
    assert.equal(out[1].name, 'b');
  });

  it('does not reorder — only drops later duplicates', () => {
    const entries = [{ name: 'z' }, { name: 'a' }, { name: 'z' }];
    const out = dedupeByName(entries);
    assert.deepEqual(out.map(e => e.name), ['z', 'a']);
  });
});

describe('renderFactEntries', () => {
  const mk = (n) => ({ name: `f${n}`, desc: `d${n}`, body: `body${n}` });

  it('empty input renders emptyLabel', () => {
    const out = renderFactEntries([], { emptyLabel: 'nothing here' });
    assert.equal(out, '_nothing here_\n');
  });

  it('indexTail=false renders every entry in full, ignoring coreFresh', () => {
    const entries = [mk(1), mk(2), mk(3)];
    const out = renderFactEntries(entries, { indexTail: false, coreFresh: 1 });
    assert.match(out, /### f1/);
    assert.match(out, /### f2/);
    assert.match(out, /### f3/);
    assert.doesNotMatch(out, /Index of other memories/);
  });

  it('coreFresh splits into full core + one-line index tail', () => {
    const entries = [mk(1), mk(2), mk(3), mk(4)];
    const out = renderFactEntries(entries, { indexTail: true, coreFresh: 2 });
    assert.match(out, /### f1\n_d1_/);
    assert.match(out, /### f2\n_d2_/);
    assert.doesNotMatch(out, /### f3/); // f3 only in the index line, not a full heading
    assert.doesNotMatch(out, /### f4/);
    assert.match(out, /- \*\*f3\*\* — d3/);
    assert.match(out, /- \*\*f4\*\* — d4/);
    assert.match(out, /Index of other memories \(2\)/);
  });

  it('dedupes before slicing into core/index (dup never eats a core slot)', () => {
    const entries = [mk(1), { name: 'f1', desc: 'dup', body: 'DUP' }, mk(2), mk(3)];
    const out = renderFactEntries(entries, { indexTail: true, coreFresh: 2 });
    assert.match(out, /### f1\n_d1_/); // original f1 survives, not the dup
    assert.doesNotMatch(out, /DUP/);
    assert.match(out, /### f2\n_d2_/);
  });

  it('clamps a body longer than maxFactChars', () => {
    const long = 'x'.repeat(100);
    const out = renderFactEntries([{ name: 'big', desc: '', body: long }], { maxFactChars: 20 });
    assert.ok(out.includes('x'.repeat(20)));
    assert.ok(!out.includes('x'.repeat(21)));
    assert.match(out, /truncated, 100 chars total/);
  });
});

describe('truncateBlock', () => {
  it('short block passes through untouched', () => {
    const { text, truncated, cutName } = truncateBlock('short text', {
      maxChars: 1000, endMark: '<!-- END -->',
    });
    assert.equal(text, 'short text');
    assert.equal(truncated, false);
    assert.equal(cutName, null);
  });

  it('long block with endMark: result <= maxChars and ends with endMark', () => {
    const endMark = '<!-- END: test-block -->';
    const block = '## Section\n' + 'y'.repeat(200) + '\n' + endMark;
    const { text, truncated } = truncateBlock(block, { maxChars: 50, endMark });
    assert.ok(truncated);
    assert.ok(text.length <= 50, `expected length <= 50, got ${text.length}`);
    assert.ok(text.endsWith(endMark));
  });

  it('endMark="" is a no-op for marker preservation (still truncates)', () => {
    const block = 'z'.repeat(200);
    const { text, truncated } = truncateBlock(block, { maxChars: 50, endMark: '' });
    assert.ok(truncated);
    assert.ok(text.length <= 50);
    assert.ok(!text.includes('<!-- END'));
  });

  it('reports the nearest heading at the cut point', () => {
    const block = '## Alpha\n' + 'a'.repeat(30) + '\n## Beta\n' + 'b'.repeat(30);
    const { cutName } = truncateBlock(block, { maxChars: 20 });
    assert.equal(cutName, 'Alpha');
  });
});

describe('stripSections', () => {
  it('removes the named section, keeps neighboring sections intact', () => {
    const md = [
      '## Keep A',
      'alpha content',
      '## Stale marker: X',
      'stale mirrored fact body',
      '## Keep B',
      'beta content',
    ].join('\n');
    const out = stripSections(md, ['## Stale marker:']);
    assert.match(out, /Keep A/);
    assert.match(out, /alpha content/);
    assert.match(out, /Keep B/);
    assert.match(out, /beta content/);
    assert.doesNotMatch(out, /Stale marker/);
    assert.doesNotMatch(out, /stale mirrored/);
  });
});

describe('stripMarkerBlocks', () => {
  it('removes a paired BEGIN/END block by name', () => {
    const md = [
      'before',
      '<!-- BEGIN: from-openclaw-flush -->',
      'flushed content',
      '<!-- END: from-openclaw-flush -->',
      'after',
    ].join('\n');
    const out = stripMarkerBlocks(md, ['from-openclaw-flush']);
    assert.doesNotMatch(out, /flushed content/);
    assert.match(out, /before/);
    assert.match(out, /after/);
  });

  it('leaves unrelated marker blocks alone', () => {
    const md = '<!-- BEGIN: keep-me -->\nstays\n<!-- END: keep-me -->';
    const out = stripMarkerBlocks(md, ['other-name']);
    assert.equal(out, md);
  });
});

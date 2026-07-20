#!/usr/bin/env node
// capture.test.mjs — samemind capture (session-capture, gh alexgrebeshok-coder/samemind#1):
// fixture JSONL → distilled inbox note, idempotency, secret masking, dry-run purity,
// generic-markdown adapter. Run: node --test tools/capture.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runCapture, maskSecrets, extractClaudeCodeSession, loadState, ADAPTERS,
} from './capture.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonlLine(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/** Writes one Claude Code-shaped transcript: a user turn + a thinking-only assistant
 *  turn (should not become finalText) + a final assistant turn with real text. */
function writeClaudeFixture(projectDir, sessionId, { finalText, cwd = '/Users/x/proj', timestamp = '2026-07-10T12:00:00.000Z' } = {}) {
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    jsonlLine({ type: 'mode', mode: 'default', sessionId }),
    jsonlLine({
      type: 'user', sessionId, cwd, timestamp: '2026-07-10T11:59:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    jsonlLine({
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: '2026-07-10T11:59:30.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me think' }] },
    }),
    jsonlLine({
      type: 'assistant',
      sessionId,
      cwd,
      timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
    }),
  ];
  writeFileSync(file, lines.join(''));
  return file;
}

describe('extractClaudeCodeSession', () => {
  it('takes the final text block, ignoring thinking-only turns', () => {
    const raw = [
      jsonlLine({ type: 'user', sessionId: 's1', timestamp: 't0' }),
      jsonlLine({ type: 'assistant', sessionId: 's1', timestamp: 't1', message: { content: [{ type: 'thinking', thinking: 'nope' }] } }),
      jsonlLine({ type: 'assistant', sessionId: 's1', timestamp: 't2', cwd: '/p', message: { content: [{ type: 'text', text: 'final answer' }] } }),
    ].join('');
    const d = extractClaudeCodeSession(raw, 'fallback');
    assert.equal(d.sessionId, 's1');
    assert.equal(d.finalText, 'final answer');
    assert.equal(d.cwd, '/p');
    assert.equal(d.timestamp, 't2');
    assert.equal(d.messageCount, 3); // one user + two assistant turns (thinking-only turn still counts as a turn)
  });

  it('returns null when there is no assistant text block at all', () => {
    const raw = jsonlLine({ type: 'queue-operation', sessionId: 's2', timestamp: 't0' });
    assert.equal(extractClaudeCodeSession(raw, 's2'), null);
  });
});

describe('maskSecrets', () => {
  it('masks npm_/sk-/ghp_/AKIA shapes and reports a count', () => {
    const text = 'token npm_abcdefghijklmnopqrstuvwxyz012345 and sk-verysecrettoken1234567890 and ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP';
    const { text: masked, masked: flagged, count } = maskSecrets(text);
    assert.equal(flagged, true);
    assert.equal(count, 4);
    assert.ok(!masked.includes('npm_abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(!masked.includes('sk-verysecrettoken1234567890'));
    assert.ok(!masked.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
    assert.ok(!masked.includes('AKIAABCDEFGHIJKLMNOP'));
    assert.match(masked, /•••masked•••/);
  });

  it('leaves ordinary text untouched', () => {
    const { text, masked, count } = maskSecrets('just a normal sentence, no secrets here');
    assert.equal(masked, false);
    assert.equal(count, 0);
    assert.equal(text, 'just a normal sentence, no secrets here');
  });
});

describe('capture --engine claude-code', () => {
  it('distills a fixture JSONL transcript into inbox/claude-code.md', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-claude-src-');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    writeClaudeFixture(join(src, 'proj-a'), sessionId, { finalText: 'Done. Shipped the thing.' });

    const result = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });

    assert.equal(result.ok, true);
    assert.equal(result.captured.length, 1);
    assert.equal(result.captured[0].key, sessionId);
    assert.ok(result.inboxFile);
    assert.ok(existsSync(result.inboxFile));

    const content = readFileSync(result.inboxFile, 'utf8');
    assert.match(content, new RegExp(sessionId));
    assert.match(content, /Done\. Shipped the thing\./);
    assert.match(content, /project: `\/Users\/x\/proj`/);
    assert.match(content, /messages: 3/);

    const state = loadState(bundleRoot);
    assert.deepEqual(state.engines['claude-code'].captured, [sessionId]);
  });

  it('truncates a very long final message to ~1500 chars', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-claude-src-');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const longText = 'x'.repeat(3000);
    writeClaudeFixture(join(src, 'proj-b'), sessionId, { finalText: longText });

    const result = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });
    const content = readFileSync(result.inboxFile, 'utf8');
    // distilled body is truncated well below the raw 3000-char input
    assert.ok(content.length < 2200);
    assert.match(content, /…/);
  });

  it('idempotency: a second run over the same source finds 0 new sessions', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-claude-src-');
    const sessionId = '99999999-8888-7777-6666-555555555555';
    writeClaudeFixture(join(src, 'proj-c'), sessionId, { finalText: 'first pass' });

    const first = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });
    assert.equal(first.captured.length, 1);

    const second = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });
    assert.equal(second.captured.length, 0);
    assert.equal(second.skipped, 1);

    // inbox file still has exactly one session block, not duplicated
    const content = readFileSync(second.ok && first.inboxFile ? first.inboxFile : '', 'utf8');
    const occurrences = content.split(sessionId).length - 1;
    assert.equal(occurrences, 1);
  });

  it('dry-run: reports the candidate but writes nothing (no inbox, no state)', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-claude-src-');
    const sessionId = 'dddddddd-1111-2222-3333-444444444444';
    writeClaudeFixture(join(src, 'proj-d'), sessionId, { finalText: 'would capture this' });

    const dry = runCapture({
      engine: 'claude-code', source: src, root: bundleRoot, dryRun: true,
    });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.captured.length, 1);
    assert.equal(dry.inboxFile, null);
    assert.equal(existsSync(join(bundleRoot, 'inbox', 'claude-code.md')), false);
    assert.equal(existsSync(join(bundleRoot, '.samemind-capture-state.json')), false);

    // a real run afterwards still captures it (dry-run left no state behind)
    const real = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });
    assert.equal(real.captured.length, 1);
  });

  it('masks a secret found inside a captured transcript', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-claude-src-');
    const sessionId = 'eeeeeeee-1111-2222-3333-444444444444';
    writeClaudeFixture(join(src, 'proj-e'), sessionId, {
      finalText: 'here is the token sk-liveleakedtoken1234567890 do not share',
    });

    const result = runCapture({ engine: 'claude-code', source: src, root: bundleRoot });
    assert.equal(result.masked, 1);
    assert.equal(result.captured[0].masked, true);
    const content = readFileSync(result.inboxFile, 'utf8');
    assert.ok(!content.includes('sk-liveleakedtoken1234567890'));
    assert.match(content, /•••masked•••/);
  });

  it('unknown engine is refused with a clear error', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const result = runCapture({ engine: 'nope', root: bundleRoot });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown engine/);
  });
});

describe('capture --engine generic-markdown', () => {
  it('requires --source', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const result = runCapture({ engine: 'generic-markdown', root: bundleRoot });
    assert.equal(result.ok, false);
    assert.match(result.reason, /--source/);
  });

  it('captures new .md diaries as pointer notes (title + first lines + path)', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-md-src-');
    mkdirSync(join(src, 'topics'), { recursive: true });
    writeFileSync(join(src, 'topics', 'note-a.md'), '# Note A\n\nFirst real line.\nSecond line.\n');
    writeFileSync(join(src, 'note-b.md'), '# Note B\n\nAnother diary entry.\n');

    const result = runCapture({ engine: 'generic-markdown', source: src, root: bundleRoot });
    assert.equal(result.ok, true);
    assert.equal(result.captured.length, 2);
    const content = readFileSync(result.inboxFile, 'utf8');
    assert.match(content, /Note A/);
    assert.match(content, /First real line\./);
    assert.match(content, /topics[/\\]note-a\.md/);
    assert.match(content, /Note B/);
  });

  it('strips YAML frontmatter: title from description (fallback name), body has no fm soup', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-md-src-');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'rule-fm.md'), [
      '---',
      'name: rule-fm-test',
      'description: Правило X — короткое описание для заголовка',
      'metadata: ',
      '  node_type: memory',
      '  type: feedback',
      '---',
      '',
      'Тело факта: конкретная деталь, которую нужно находить recall-ом.',
      '',
    ].join('\n'));
    // no description → falls back to name
    writeFileSync(join(src, 'rule-noname.md'), [
      '---',
      'name: rule-noname-test',
      'metadata: ',
      '  type: feedback',
      '---',
      '',
      'Body without a description field.',
      '',
    ].join('\n'));

    const result = runCapture({ engine: 'generic-markdown', source: src, root: bundleRoot });
    assert.equal(result.ok, true);
    assert.equal(result.captured.length, 2);

    const withDesc = result.captured.find(c => c.key.endsWith('rule-fm.md'));
    assert.equal(withDesc.heading, 'Правило X — короткое описание для заголовка');
    const withoutDesc = result.captured.find(c => c.key.endsWith('rule-noname.md'));
    assert.equal(withoutDesc.heading, 'rule-noname-test');

    const content = readFileSync(result.inboxFile, 'utf8');
    assert.match(content, /Правило X — короткое описание для заголовка/);
    assert.match(content, /Тело факта: конкретная деталь/);
    // the frontmatter soup itself must never leak into the captured note
    assert.ok(!content.includes('node_type: memory'));
    assert.ok(!content.includes('type: feedback'));
    assert.ok(!content.includes('name: rule-fm-test'));
  });

  it('honors --since (skips files older than the cutoff) and stays idempotent', () => {
    const bundleRoot = tmpDir('samemind-bundle-');
    const src = tmpDir('samemind-md-src-');
    mkdirSync(src, { recursive: true });
    const oldFile = join(src, 'old.md');
    const newFile = join(src, 'new.md');
    writeFileSync(oldFile, '# Old\n\nStale entry.\n');
    writeFileSync(newFile, '# New\n\nFresh entry.\n');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(oldFile, old, old);

    const since = '2025-01-01T00:00:00Z';
    const first = runCapture({
      engine: 'generic-markdown', source: src, root: bundleRoot, since,
    });
    assert.equal(first.captured.length, 1);
    assert.equal(first.captured[0].heading, 'New');

    const second = runCapture({
      engine: 'generic-markdown', source: src, root: bundleRoot, since,
    });
    assert.equal(second.captured.length, 0);
  });
});

describe('adapter registry', () => {
  it('exposes exactly the two MVP engines', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ['claude-code', 'generic-markdown']);
  });
});

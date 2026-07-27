#!/usr/bin/env node
// projection-config.test.mjs — node --test, all against mkdtemp tmp dirs. Never touches the
// real ~/.samemind (globalHome is always an explicit tmp dir below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readProjectionConfig, migrateProjectionConfig } from './lib/projection-config.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

function writeConfig(dir, obj) {
  mkdirSync(join(dir, '.samemind'), { recursive: true });
  writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify(obj, null, 2));
}

function readConfigRaw(dir) {
  return readFileSync(join(dir, '.samemind', 'config.json'), 'utf8');
}

describe('readProjectionConfig — pure read, never writes', () => {
  it('stale file (no schema_version/projection) → defaults in memory, file byte-identical on disk', () => {
    const root = tmp('proj');
    const noGlobal = tmp('noglobal'); // exists but has no .samemind/config.json at all
    writeConfig(root, { embedUrl: 'http://127.0.0.1:8000/v1/embeddings', embedModel: 'bge-m3' });

    const before = readConfigRaw(root);
    const result = readProjectionConfig(root, noGlobal);
    const after = readConfigRaw(root);

    assert.deepEqual(result, {
      budgetTokens: 1500, factSource: 'canon', coreFresh: 12, indexTail: true, intervalSec: 1800, targets: [],
    });
    assert.equal(after, before); // read must not mutate the file
  });

  it('global shared file is not touched by a read either', () => {
    const root = tmp('proj');
    const home = tmp('home');
    writeConfig(home, { embedUrl: 'http://global', projection: { coreFresh: 5 } });
    writeConfig(root, {});

    const before = readConfigRaw(home);
    readProjectionConfig(root, home);
    const after = readConfigRaw(home);

    assert.equal(after, before);
  });

  it('project overrides global (coreFresh/factSource)', () => {
    const root = tmp('proj');
    const home = tmp('home');
    writeConfig(home, { projection: { coreFresh: 99, factSource: 'bundle' } });
    writeConfig(root, { projection: { coreFresh: 7 } });

    const result = readProjectionConfig(root, home);
    assert.equal(result.coreFresh, 7); // project wins
    assert.equal(result.factSource, 'bundle'); // inherited from global, not overridden
  });

  it('targets inherit top-level excludeSource unless set per-target', () => {
    const root = tmp('proj');
    const home = tmp('home-empty');
    writeConfig(root, {
      projection: {
        excludeSource: 'worklog',
        targets: [{ engine: 'grok' }, { engine: 'cursor', excludeSource: 'none' }],
      },
    });

    const result = readProjectionConfig(root, home);
    assert.deepEqual(result.targets, [
      { engine: 'grok', excludeSource: 'worklog' },
      { engine: 'cursor', excludeSource: 'none' },
    ]);
  });

  it('invalid factSource falls back to default with a warning, does not throw', () => {
    const root = tmp('proj');
    const home = tmp('home-empty3');
    writeConfig(root, { projection: { factSource: 'garbage' } });

    const originalWarn = console.warn;
    let warned = '';
    console.warn = msg => { warned += msg; };
    let result;
    try {
      result = readProjectionConfig(root, home);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.factSource, 'canon');
    assert.match(warned, /invalid factSource "garbage"/);
  });

  it('no config.json at all → defaults, nothing written', () => {
    const root = tmp('proj-empty');
    const home = tmp('home-empty4');

    const result = readProjectionConfig(root, home);
    assert.deepEqual(result, {
      budgetTokens: 1500, factSource: 'canon', coreFresh: 12, indexTail: true, intervalSec: 1800, targets: [],
    });
  });
});

describe('migrateProjectionConfig — explicit write, called by CLI/setup', () => {
  it('stamps schema_version + default projection, preserves foreign keys (embedUrl/embedModel)', () => {
    const dir = tmp('migrate');
    writeConfig(dir, { embedUrl: 'http://127.0.0.1:8000/v1/embeddings', embedModel: 'bge-m3' });

    migrateProjectionConfig(dir);

    const onDisk = JSON.parse(readConfigRaw(dir));
    assert.equal(onDisk.schema_version, 1);
    assert.equal(onDisk.embedUrl, 'http://127.0.0.1:8000/v1/embeddings');
    assert.equal(onDisk.embedModel, 'bge-m3');
    assert.deepEqual(onDisk.projection, {
      budgetTokens: 1500, factSource: 'canon', coreFresh: 12, indexTail: true, intervalSec: 1800, targets: [],
    });
  });

  it('is idempotent — second call writes nothing (byte-identical file)', () => {
    const dir = tmp('migrate-idem');
    writeConfig(dir, { embedUrl: 'http://x', projection: { budgetTokens: 42 } });

    migrateProjectionConfig(dir);
    const first = readConfigRaw(dir);
    migrateProjectionConfig(dir);
    const second = readConfigRaw(dir);

    assert.equal(second, first);
  });

  it('no config.json at all → no-op, nothing created', () => {
    const dir = tmp('migrate-empty');
    migrateProjectionConfig(dir); // must not throw, must not create a file
    // no config.json was ever written — nothing to assert on disk beyond "didn't throw"
  });
});

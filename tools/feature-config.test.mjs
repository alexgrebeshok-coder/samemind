#!/usr/bin/env node
// feature-config.test.mjs — node --test, all against mkdtemp tmp dirs. Never touches the real
// ~/.samemind (globalHome is always an explicit tmp dir, or null to skip the global tier).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readFeatureConfig, VOICE_DEFAULTS, VISION_DEFAULTS } from './lib/feature-config.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-feat-${prefix}-`));
}

function writeConfig(dir, obj) {
  mkdirSync(join(dir, '.samemind'), { recursive: true });
  writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify(obj, null, 2));
}

function readConfigRaw(dir) {
  return readFileSync(join(dir, '.samemind', 'config.json'), 'utf8');
}

function configPath(dir) {
  return join(dir, '.samemind', 'config.json');
}

/** Captures console.warn during fn; returns { warned, result }. Mirrors projection-config tests. */
function captureWarn(fn) {
  const originalWarn = console.warn;
  let warned = '';
  console.warn = msg => { warned += msg; };
  let result;
  try {
    result = fn();
  } finally {
    console.warn = originalWarn;
  }
  return { warned, result };
}

describe('readFeatureConfig — pure read, never writes', () => {
  it('no config.json at all → full OFF defaults, nothing created on disk', () => {
    const root = tmp('empty');
    const home = tmp('home-empty');

    const result = readFeatureConfig(root, home);

    assert.deepEqual(result.voice, { ...VOICE_DEFAULTS });
    assert.deepEqual(result.vision, { ...VISION_DEFAULTS });
    assert.equal(existsSync(configPath(root)), false);     // project file never created
    assert.equal(existsSync(configPath(home)), false);     // global file never created
  });

  it('stale file (only foreign keys, no voice/vision) → defaults in memory, file byte-identical', () => {
    const root = tmp('proj');
    const home = tmp('home-empty');
    writeConfig(root, {
      embedUrl: 'http://127.0.0.1:8000/v1/embeddings',
      embedModel: 'bge-m3',
      schema_version: 1,
      projection: { budgetTokens: 1500, factSource: 'canon', coreFresh: 12, indexTail: true, intervalSec: 1800, targets: [] },
    });

    const before = readConfigRaw(root);
    const result = readFeatureConfig(root, home);
    const after = readConfigRaw(root);

    assert.deepEqual(result.voice, { ...VOICE_DEFAULTS });
    assert.deepEqual(result.vision, { ...VISION_DEFAULTS });
    assert.equal(after, before); // read must not mutate the file
  });

  it('read does not change mtime of project or global config', () => {
    const root = tmp('proj-mtime');
    const home = tmp('home-mtime');
    writeConfig(home, { voice: { enabled: true } });
    writeConfig(root, { voice: { enabled: false } });

    const rootBefore = statSync(configPath(root)).mtimeMs;
    const homeBefore = statSync(configPath(home)).mtimeMs;

    readFeatureConfig(root, home);

    assert.equal(statSync(configPath(root)).mtimeMs, rootBefore);
    assert.equal(statSync(configPath(home)).mtimeMs, homeBefore);
  });

  it('project overrides global; global fills what project leaves unset', () => {
    const root = tmp('proj-ovr');
    const home = tmp('home-ovr');
    writeConfig(home, { voice: { enabled: true, trigger: 'wake-word', confidenceThreshold: 0.8 } });
    writeConfig(root, { voice: { trigger: 'hotkey' } }); // project wins on trigger; enabled inherited

    const { voice } = readFeatureConfig(root, home);
    assert.equal(voice.trigger, 'hotkey');        // project wins
    assert.equal(voice.enabled, true);            // inherited from global
    assert.equal(voice.confidenceThreshold, 0.8); // inherited from global
  });

  it('foreign keys (embedUrl/projection) are untouched after a read', () => {
    const root = tmp('proj-foreign');
    const home = tmp('home-foreign');
    writeConfig(root, {
      embedUrl: 'http://x',
      projection: { intervalSec: 99 },
      voice: { enabled: true },
    });

    const before = JSON.parse(readConfigRaw(root));
    readFeatureConfig(root, home);
    const after = JSON.parse(readConfigRaw(root));

    assert.equal(after.embedUrl, 'http://x');
    assert.deepEqual(after.projection, { intervalSec: 99 });
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  });

  it('three voice consents are independent — enabled alone does not flip the other two', () => {
    const root = tmp('proj-consent');
    const home = tmp('home-consent');
    writeConfig(root, { voice: { enabled: true } });

    const { voice } = readFeatureConfig(root, home);
    assert.equal(voice.enabled, true);            // mic access granted
    assert.equal(voice.storeTranscripts, false);  // …but transcript storage stays OFF
    assert.equal(voice.sendTextToLlm, false);     // …and LLM piping stays OFF
  });

  it('bad numeric type (string threshold) → default + warning, no throw', () => {
    const root = tmp('proj-badnum');
    const home = tmp('home-badnum');
    writeConfig(root, { voice: { confidenceThreshold: 'high' } });

    const { warned, result } = captureWarn(() => readFeatureConfig(root, home));

    assert.equal(result.voice.confidenceThreshold, VOICE_DEFAULTS.confidenceThreshold);
    assert.match(warned, /invalid voice\.confidenceThreshold/);
  });

  it('unknown vision mode → default ("off") + warning, no throw', () => {
    const root = tmp('proj-badmode');
    const home = tmp('home-badmode');
    writeConfig(root, { vision: { mode: 'always-on' } });

    const { warned, result } = captureWarn(() => readFeatureConfig(root, home));

    assert.equal(result.vision.mode, 'off');
    assert.match(warned, /invalid vision\.mode "always-on"/);
  });

  it('unknown voice trigger → default ("hotkey") + warning, no throw', () => {
    const root = tmp('proj-badtrig');
    const home = tmp('home-badtrig');
    writeConfig(root, { voice: { trigger: 'clap' } });

    const { warned, result } = captureWarn(() => readFeatureConfig(root, home));
    assert.equal(result.voice.trigger, 'hotkey');
    assert.match(warned, /invalid voice\.trigger "clap"/);
  });

  it('broken JSON → defaults, no throw', () => {
    const root = tmp('proj-badjson');
    const home = tmp('home-badjson');
    mkdirSync(join(root, '.samemind'), { recursive: true });
    writeFileSync(configPath(root), '{ not valid json,,, }');

    const result = readFeatureConfig(root, home);
    assert.deepEqual(result.voice, { ...VOICE_DEFAULTS });
    assert.deepEqual(result.vision, { ...VISION_DEFAULTS });
  });

  it('valid enum + number values pass through unchanged', () => {
    const root = tmp('proj-valid');
    const home = tmp('home-valid');
    writeConfig(root, {
      voice: { trigger: 'wake-word', confidenceThreshold: 0.9, transcriptRetentionDays: 30, serviceUrl: 'ws://stt.local' },
      vision: { mode: 'proactive', camera: true, rooms: ['kitchen', 'office'], hours: '09:00-18:00', retentionDays: 14 },
    });

    const { voice, vision } = readFeatureConfig(root, home);
    assert.equal(voice.trigger, 'wake-word');
    assert.equal(voice.confidenceThreshold, 0.9);
    assert.equal(voice.transcriptRetentionDays, 30);
    assert.equal(voice.serviceUrl, 'ws://stt.local');
    assert.equal(vision.mode, 'proactive');
    assert.equal(vision.camera, true);
    assert.deepEqual(vision.rooms, ['kitchen', 'office']);
    assert.equal(vision.hours, '09:00-18:00');
    assert.equal(vision.retentionDays, 14);
  });

  it('rooms that is not an array → [] (no throw, no warning required)', () => {
    const root = tmp('proj-badrooms');
    const home = tmp('home-badrooms');
    writeConfig(root, { vision: { rooms: 'everywhere' } });

    const { vision } = readFeatureConfig(root, home);
    assert.deepEqual(vision.rooms, []);
  });

  it('globalHome falsy → global tier skipped, only project read', () => {
    const root = tmp('proj-noglobal');
    writeConfig(root, { voice: { enabled: true } });

    const result = readFeatureConfig(root, null);
    assert.equal(result.voice.enabled, true);
    assert.deepEqual(result.vision, { ...VISION_DEFAULTS });
  });
});

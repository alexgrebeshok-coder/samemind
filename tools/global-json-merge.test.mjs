// global-json-merge.test.mjs — unit tests for tools/lib/global-json-merge.mjs (node --test).
// Every path here is a tmpdir fixture — never the real ~/.claude.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeJsonFile } from './lib/global-json-merge.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

/** Every `<basename>.bak-*` sibling of `path` inside `dir`. */
function backupsOf(dir, basename) {
  return readdirSync(dir).filter(f => f.startsWith(`${basename}.bak-`));
}

describe('mergeJsonFile — missing file', () => {
  it('mutator receives {} and the result is written, no backup (nothing existed)', () => {
    const dir = tmp('merge-missing');
    try {
      const path = join(dir, 'config.json');
      const res = mergeJsonFile(path, cfg => { cfg.hello = 'world'; return cfg; });
      assert.equal(res.ok, true);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { hello: 'world' });
      assert.equal(backupsOf(dir, 'config.json').length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeJsonFile — existing valid JSON', () => {
  it('merges in a new key while preserving every existing one (exa/context7/playwright fixture)', () => {
    const dir = tmp('merge-preserve');
    try {
      const path = join(dir, 'claude.json');
      const before = {
        mcpServers: {
          exa: { command: 'npx', args: ['exa-mcp'] },
          context7: { command: 'npx', args: ['context7-mcp'] },
          playwright: { command: 'npx', args: ['playwright-mcp'] },
        },
        someOtherTopLevelKey: 'keep-me-too',
      };
      writeFileSync(path, JSON.stringify(before, null, 2), 'utf8');

      const res = mergeJsonFile(path, cfg => {
        cfg.mcpServers = { ...(cfg.mcpServers || {}), samemind: { command: 'npx', args: ['samemind', 'serve'] } };
        return cfg;
      });

      assert.equal(res.ok, true);
      const after = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(after.mcpServers.exa, before.mcpServers.exa);
      assert.deepEqual(after.mcpServers.context7, before.mcpServers.context7);
      assert.deepEqual(after.mcpServers.playwright, before.mcpServers.playwright);
      assert.deepEqual(after.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
      assert.equal(after.someOtherTopLevelKey, 'keep-me-too');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a backup of the original content before mutating', () => {
    const dir = tmp('merge-backup');
    try {
      const path = join(dir, 'claude.json');
      const before = '{\n  "mcpServers": { "exa": { "command": "npx" } }\n}\n';
      writeFileSync(path, before, 'utf8');

      mergeJsonFile(path, cfg => { cfg.mcpServers.samemind = { command: 'npx' }; return cfg; });

      const backups = backupsOf(dir, 'claude.json');
      assert.equal(backups.length, 1, 'exactly one backup file expected');
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), before, 'backup is byte-for-byte the pre-mutation content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backup:false skips the backup file but still merges', () => {
    const dir = tmp('merge-nobackup');
    try {
      const path = join(dir, 'claude.json');
      writeFileSync(path, JSON.stringify({ mcpServers: { exa: { command: 'npx' } } }), 'utf8');

      mergeJsonFile(path, cfg => { cfg.mcpServers.samemind = { command: 'npx' }; return cfg; }, { backup: false });

      assert.equal(backupsOf(dir, 'claude.json').length, 0);
      const after = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(after.mcpServers.exa, { command: 'npx' });
      assert.deepEqual(after.mcpServers.samemind, { command: 'npx' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated merge is idempotent — same key reset, never duplicated', () => {
    const dir = tmp('merge-idempotent');
    try {
      const path = join(dir, 'claude.json');
      const mutator = cfg => { cfg.mcpServers = { ...(cfg.mcpServers || {}), samemind: { command: 'npx', args: ['samemind', 'serve'] } }; return cfg; };
      mergeJsonFile(path, mutator);
      const once = readFileSync(path, 'utf8');
      mergeJsonFile(path, mutator);
      const twice = readFileSync(path, 'utf8');
      assert.equal(once, twice);
      assert.equal(Object.keys(JSON.parse(twice).mcpServers).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeJsonFile — corrupt JSON', () => {
  it('returns {ok:false, reason:"corrupt-json"} and leaves the file byte-for-byte untouched', () => {
    const dir = tmp('merge-corrupt');
    try {
      const path = join(dir, 'claude.json');
      const before = '{ "mcpServers": { "exa": { "command": "npx" } '; // truncated / invalid
      writeFileSync(path, before, 'utf8');

      const res = mergeJsonFile(path, cfg => { cfg.mcpServers = { samemind: {} }; return cfg; });

      assert.deepEqual(res, { ok: false, reason: 'corrupt-json' });
      assert.equal(readFileSync(path, 'utf8'), before, 'original file must be byte-for-byte unchanged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

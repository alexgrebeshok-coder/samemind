#!/usr/bin/env node
// hooks-cli.test.mjs — seam 4: the `samemind hooks` CLI wrapper (tools/hooks.mjs) over
// lib/hooks.mjs. Exit-code contract + loud-fail on non-auto engines. All fs work goes to a tmpdir
// target — never touches ~/.claude. The tier/merge logic itself is covered by hooks.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from './hooks.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('samemind hooks CLI', () => {
  it('list → exit 0', () => {
    assert.equal(main(['list']), 0);
  });

  it('no subcommand → usage, exit 0', () => {
    assert.equal(main([]), 0);
  });

  it('install --agent claude-code writes the hook file, exit 0', () => {
    const dir = tmp('hooks-cli-cc');
    assert.equal(main(['install', '--agent', 'claude-code', '--target', dir, '--root', dir]), 0);
    assert.ok(existsSync(join(dir, '.claude', 'settings.json')));
  });

  it('install without --agent → loud-fail exit 1', () => {
    assert.equal(main(['install']), 1);
  });

  it('install --agent cursor (projection tier) → loud-fail exit 1, nothing written', () => {
    const dir = tmp('hooks-cli-cursor');
    assert.equal(main(['install', '--agent', 'cursor', '--target', dir]), 1);
    assert.equal(readdirSync(dir).length, 0, 'projection-tier install writes nothing');
  });

  it('install --agent <unknown> (none tier) → loud-fail exit 1', () => {
    const dir = tmp('hooks-cli-unknown');
    assert.equal(main(['install', '--agent', 'totally-not-an-engine', '--target', dir]), 1);
    assert.equal(readdirSync(dir).length, 0, 'unknown engine writes nothing');
  });

  it('unknown flag → caught, exit 1', () => {
    assert.equal(main(['list', '--nope']), 1);
  });
});

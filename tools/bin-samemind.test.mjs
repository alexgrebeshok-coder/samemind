#!/usr/bin/env node
// bin-samemind.test.mjs — exit-code contract for the CLI router (node --test). Без сети.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../bin/samemind.mjs';

describe('samemind CLI — exit codes', () => {
  it('no args → usage, exit 0 (not an error)', () => {
    assert.equal(main([]), 0);
  });

  it('--help → usage, exit 0', () => {
    assert.equal(main(['--help']), 0);
  });

  it('-h → usage, exit 0', () => {
    assert.equal(main(['-h']), 0);
  });

  it('help → usage, exit 0', () => {
    assert.equal(main(['help']), 0);
  });

  it('unknown command → usage, exit 1 (real error)', () => {
    assert.equal(main(['definitely-not-a-command']), 1);
  });
});

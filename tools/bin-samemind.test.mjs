#!/usr/bin/env node
// bin-samemind.test.mjs — exit-code contract for the CLI router (node --test). Без сети.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('samemind CLI — --version / -v', () => {
  // Same bug family as nudge --help (e2e640b): --version fell through to ROUTES[cmd]
  // === undefined and printed the usage banner instead of a version a script could read.
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));

  it('--version prints exactly the package.json version, exit 0', () => {
    const lines = [];
    const orig = console.log;
    console.log = (s) => lines.push(s);
    let code;
    try { code = main(['--version']); } finally { console.log = orig; }
    assert.equal(code, 0);
    assert.deepEqual(lines, [version]);
  });

  it('-v prints exactly the package.json version, exit 0', () => {
    const lines = [];
    const orig = console.log;
    console.log = (s) => lines.push(s);
    let code;
    try { code = main(['-v']); } finally { console.log = orig; }
    assert.equal(code, 0);
    assert.deepEqual(lines, [version]);
  });
});

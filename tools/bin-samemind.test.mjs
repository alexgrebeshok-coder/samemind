#!/usr/bin/env node
// bin-samemind.test.mjs — exit-code contract for the CLI router (node --test). Без сети.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../bin/samemind.mjs';
import { runInit } from '../tools/init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');

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

// ─────────────── the wrapper actually hands flags to board/handoff ───────────────
// board.test.mjs and handoff.test.mjs exercise the flags against the tools directly. These
// go through `bin/samemind.mjs` instead, and only assert what the router owns: that argv
// reaches the routed script intact, that the child's exit code comes back, and that OKF_ROOT
// is defaulted but never allowed to override an explicit --root. Deliberately a thin layer —
// the board/handoff semantics themselves are not re-tested here.

describe('samemind CLI — board/handoff routing passes --root and --project through', () => {
  let bundleA, bundleB;

  /** Run the routed CLI. `okfRoot: null` leaves OKF_ROOT unset so the router's own default applies. */
  const run = (okfRoot, args, cwd = undefined) => {
    const env = { ...process.env };
    if (okfRoot === null) delete env.OKF_ROOT;
    else env.OKF_ROOT = okfRoot;
    const r = spawnSync(process.execPath, [BIN, ...args], { env, cwd, encoding: 'utf8' });
    return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
  };

  before(() => {
    bundleA = mkdtempSync(join(tmpdir(), 'samemind-bin-rootA-'));
    bundleB = mkdtempSync(join(tmpdir(), 'samemind-bin-rootB-'));
    runInit({ targetDir: bundleA });
    runInit({ targetDir: bundleB });
    rmSync(join(bundleA, 'DASHBOARD.md'), { force: true });
    rmSync(join(bundleB, 'DASHBOARD.md'), { force: true });
    const task = (title, project) => `---
type: Task
title: ${title}
status: in-progress
timestamp: 2026-07-09T10:00:00Z
relations:
  project: ${project}
---
`;
    writeFileSync(join(bundleA, 'projects', 'a.md'), task('BinOnlyInA', '/projects/lumen.md'), 'utf8');
    writeFileSync(join(bundleB, 'projects', 'b-lumen.md'), task('BinLumenInB', '/projects/lumen.md'), 'utf8');
    writeFileSync(join(bundleB, 'projects', 'b-atlas.md'), task('BinAtlasInB', '/projects/atlas.md'), 'utf8');
  });
  after(() => {
    rmSync(bundleA, { recursive: true, force: true });
    rmSync(bundleB, { recursive: true, force: true });
  });

  for (const cmd of ['board', 'handoff']) {
    it(`${cmd}: OKF_ROOT=A + --root B reads B through the wrapper`, () => {
      const { code, out } = run(bundleA, [cmd, '--root', bundleB]);
      assert.equal(code, 0, out);
      assert.ok(out.includes('BinLumenInB'), 'B reached the routed script');
      assert.ok(!out.includes('BinOnlyInA'), 'OKF_ROOT must not win over an explicit --root');
    });

    it(`${cmd}: --root B --project lumen — both flags survive routing`, () => {
      const { code, out } = run(bundleA, [cmd, '--root', bundleB, '--project', 'lumen']);
      assert.equal(code, 0, out);
      assert.ok(out.includes('BinLumenInB'));
      assert.ok(!out.includes('BinAtlasInB'), '--project still filters inside B');
      assert.ok(!out.includes('BinOnlyInA'));
    });

    it(`${cmd}: no OKF_ROOT → the router defaults it to cwd`, () => {
      const { code, out } = run(null, [cmd], bundleB);
      assert.equal(code, 0, out);
      assert.ok(out.includes('BinLumenInB'), 'cwd bundle was read');
    });

    it(`${cmd}: a failing child exits nonzero through the wrapper`, () => {
      for (const args of [[cmd, '--bogus'], [cmd, '--root'], [cmd, '--root', join(bundleB, 'index.md')]]) {
        const { code } = run(bundleA, args);
        assert.notEqual(code, 0, `${args.join(' ')} must not report success`);
      }
    });
  }

  it('board --write --root B writes B/DASHBOARD.md and leaves A alone', () => {
    const { code, out } = run(bundleA, ['board', '--write', '--root', bundleB]);
    assert.equal(code, 0, out);
    assert.ok(existsSync(join(bundleB, 'DASHBOARD.md')), 'B/DASHBOARD.md written');
    assert.ok(!existsSync(join(bundleA, 'DASHBOARD.md')), 'A/DASHBOARD.md must not be created');
  });
});

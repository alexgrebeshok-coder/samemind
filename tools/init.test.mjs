#!/usr/bin/env node
// init.test.mjs — unit + CLI tests for `samemind init` (node --test). All work happens in mkdtemp;
// never touches the real repo or ~/samemind.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runInit, PACKAGE_ROOT } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OKF_QUERY = join(HERE, 'okf-query.mjs');
const BIN = resolve(HERE, '..', 'bin', 'samemind.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('runInit — scaffold', () => {
  it('creates the full OKF scaffold in an empty target dir', () => {
    const dir = tmp('init-empty');
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(result.ok, true);

      for (const folder of ['concepts', 'entities', 'projects', 'inbox', 'secret']) {
        assert.ok(existsSync(join(dir, folder)), `${folder}/ missing`);
      }
      assert.ok(existsSync(join(dir, 'index.md')));
      assert.ok(existsSync(join(dir, 'log.md')));
      assert.ok(existsSync(join(dir, '.gitignore')));
      assert.ok(existsSync(join(dir, 'concepts', '_template.md')));
      assert.ok(existsSync(join(dir, 'concepts', 'index.md')));
      assert.ok(existsSync(join(dir, 'entities', '_template.md')));
      assert.ok(existsSync(join(dir, 'projects', '_template.md')));
      assert.ok(existsSync(join(dir, 'inbox', 'index.md')));
      assert.ok(existsSync(join(dir, 'secret', '_template.md')));

      const index = readFileSync(join(dir, 'index.md'), 'utf8');
      assert.match(index, /okf_version: "0\.1"/);

      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
      assert.match(gitignore, /\/secret\/\*\*/);
      assert.match(gitignore, /\/mirror\/\*\*/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the freshly scaffolded bundle is okf-query conformant (0 concepts)', () => {
    const dir = tmp('init-validate');
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(result.ok, true);
      const out = execFileSync(process.execPath, [OKF_QUERY, 'validate'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(out, /conformant/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the target directory when it does not exist yet', () => {
    const parent = tmp('init-nested-parent');
    const dir = join(parent, 'nested', 'bundle');
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(result.ok, true);
      assert.ok(existsSync(join(dir, 'index.md')));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a non-empty directory and touches nothing', () => {
    const dir = tmp('init-nonempty');
    try {
      writeFileSync(join(dir, 'existing.txt'), 'do not touch me', 'utf8');
      const before = readdirSync(dir).sort();

      const result = runInit({ targetDir: dir });

      assert.equal(result.ok, false);
      assert.match(result.reason, /not empty/);
      // nothing was created or modified
      const after = readdirSync(dir).sort();
      assert.deepEqual(after, before);
      assert.equal(readFileSync(join(dir, 'existing.txt'), 'utf8'), 'do not touch me');
      assert.ok(!existsSync(join(dir, 'index.md')));
      assert.ok(!existsSync(join(dir, 'concepts')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--demo copies demo concepts, visible via okf-query list', () => {
    const dir = tmp('init-demo');
    try {
      const result = runInit({ targetDir: dir, demo: true });
      assert.equal(result.ok, true);
      assert.ok(result.demoCopied > 0, 'expected demo concepts to be copied');
      assert.ok(existsSync(join(dir, 'concepts', 'nova.md')));
      assert.ok(existsSync(join(dir, 'entities', 'alex-doe.md')));
      assert.ok(existsSync(join(dir, 'projects', 'lumen.md')));

      const out = execFileSync(process.execPath, [OKF_QUERY, 'list'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(out, /Nova/);
      assert.match(out, /Alex Doe/);

      const validateOut = execFileSync(process.execPath, [OKF_QUERY, 'validate'], {
        env: { ...process.env, OKF_ROOT: dir },
        encoding: 'utf8',
      });
      assert.match(validateOut, /conformant/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without --demo, no demo concepts are copied', () => {
    const dir = tmp('init-nodemo');
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(result.demoCopied, 0);
      assert.ok(!existsSync(join(dir, 'concepts', 'nova.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git result is reported as a structured object, never throws when git is present or absent', () => {
    const dir = tmp('init-git');
    try {
      const result = runInit({ targetDir: dir });
      assert.equal(typeof result.git, 'object');
      assert.equal(typeof result.git.ok, 'boolean');
      if (result.git.ok) {
        assert.ok(existsSync(join(dir, '.git')));
      } else {
        assert.equal(typeof result.git.reason, 'string');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PACKAGE_ROOT points at the package root (demo/ lives directly under it)', () => {
    assert.ok(existsSync(join(PACKAGE_ROOT, 'demo')));
    assert.ok(existsSync(join(PACKAGE_ROOT, 'tools', 'init.mjs')));
  });
});

describe('bin/samemind.mjs — CLI router', () => {
  it('with no args prints usage and exits 0', () => {
    const res = execFileSync(process.execPath, [BIN], { encoding: 'utf8' });
    assert.match(res, /Commands:/);
  });

  it('unknown subcommand exits 1', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [BIN, 'bogus'], { encoding: 'utf8', stdio: 'pipe' });
    }, /Command failed|status 1/);
  });

  it('init subcommand scaffolds a bundle via the router', () => {
    const dir = tmp('bin-init');
    try {
      const out = execFileSync(process.execPath, [BIN, 'init', dir], { encoding: 'utf8' });
      assert.match(out, /bundle created/);
      assert.ok(existsSync(join(dir, 'index.md')));
      assert.ok(existsSync(join(dir, 'concepts', '_template.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init --demo via the router copies demo content', () => {
    const dir = tmp('bin-init-demo');
    try {
      const out = execFileSync(process.execPath, [BIN, 'init', dir, '--demo'], { encoding: 'utf8' });
      assert.match(out, /demo concepts/);
      assert.ok(existsSync(join(dir, 'concepts', 'nova.md')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query routes to okf-query.mjs with OKF_ROOT defaulted to cwd', () => {
    const dir = tmp('bin-query');
    try {
      runInit({ targetDir: dir, demo: true });
      const { OKF_ROOT: _drop, ...envWithoutRoot } = process.env; // rely on router default = cwd
      const out = execFileSync(process.execPath, [BIN, 'query', 'list'], {
        encoding: 'utf8',
        cwd: dir,
        env: envWithoutRoot,
      });
      assert.match(out, /Nova/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query respects an explicit OKF_ROOT override instead of cwd', () => {
    const bundleDir = tmp('bin-query-root');
    const otherCwd = tmp('bin-query-cwd');
    try {
      runInit({ targetDir: bundleDir, demo: true });
      runInit({ targetDir: otherCwd }); // empty bundle, different cwd
      const out = execFileSync(process.execPath, [BIN, 'query', 'list'], {
        encoding: 'utf8',
        cwd: otherCwd,
        env: { ...process.env, OKF_ROOT: bundleDir },
      });
      assert.match(out, /Nova/);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

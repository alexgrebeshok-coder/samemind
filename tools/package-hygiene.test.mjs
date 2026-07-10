#!/usr/bin/env node
// package-hygiene.test.mjs — N8: the package's own checkout must validate clean.
// samemind ships docs/ (prose, no frontmatter) and root-level agent docs
// (INSTALL_FOR_AGENTS.md, CONTRIBUTING.md) alongside the empty OKF bundle skeleton
// (concepts/, entities/, projects/, inbox/). `okf-query.mjs validate` / `list` must not
// treat those as malformed (or any) concepts — regression test for the walk()/RESERVED
// bug found in N17: docs/*.md and INSTALL_FOR_AGENTS.md were leaking in as concepts
// without frontmatter. See tools/lib/okf.mjs (walk() skip-list, RESERVED set).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const QUERY = join(HERE, 'okf-query.mjs');

function runQuery(args) {
  return spawnSync(process.execPath, [QUERY, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, OKF_ROOT: REPO_ROOT },
    encoding: 'utf8',
  });
}

describe('package hygiene (N8): validate on the repo checkout itself', () => {
  it('validate on repo root is conformant — docs/, INSTALL_FOR_AGENTS.md excluded', () => {
    const r = runQuery(['validate']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✅ OKF v0\.1 conformant/);
    assert.doesNotMatch(r.stdout, /no frontmatter/);
  });

  it('list on repo root does not surface docs/ prose or root agent docs as concepts', () => {
    const r = runQuery(['list']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const leak of [
      'docs/adapters', 'docs/memory-protocol', 'docs/benchmark', 'docs/compaction-recipe',
      'docs/identity-layer', 'docs/interop', 'docs/memory-hygiene', 'docs/work-discipline',
      'docs/snippets', 'docs/hooks', 'INSTALL_FOR_AGENTS', 'CONTRIBUTING',
    ]) {
      assert.ok(!r.stdout.includes(leak), `leaked into list(): ${leak}`);
    }
  });
});

describe('engine instruction files', () => {
  it('are reserved, not graph concepts', async () => {
    const { RESERVED } = await import('./lib/okf.mjs');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      assert.ok(RESERVED.has(f), `${f} must be RESERVED`);
    }
  });
});

describe('bin via symlink (npx/.bin path)', () => {
  it('prints usage when invoked through a symlink, like npm .bin does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-symlink-'));
    const link = join(dir, 'samemind');
    symlinkSync(join(REPO_ROOT, 'bin', 'samemind.mjs'), link);
    const res = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.match(res.stdout + res.stderr, /Commands:/, 'usage must print through a symlinked bin');
  });
});

#!/usr/bin/env node
// multiroot-cli.test.mjs — U5/G-B end-to-end CLI regression: okf-recall.mjs and gde.mjs exercised
// as real child processes (exactly how a human/agent invokes them), proving the byte-identical
// no-global regression guarantee at the process boundary, not just at the lib-function level
// (see tools/compose-roots.test.mjs for those). Never touches the real ~/samemind or ~/.samemind.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OKF_RECALL = join(HERE, 'okf-recall.mjs');
const GDE = join(HERE, 'gde.mjs');

function writeConcept(root, relPath, frontmatter, body = '# x\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(full, `---\n${fmLines.join('\n')}\n---\n\n${body}`);
  return full;
}

function run(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

let projectRoot, globalRoot;

before(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'samemind-cli-proj-'));
  globalRoot = mkdtempSync(join(tmpdir(), 'samemind-cli-glob-'));
  writeConcept(projectRoot, 'entities/alpha.md', { type: 'Concept', title: 'Alpha Project Note' },
    'Project-local note about widgets and gears.\n');
  writeConcept(projectRoot, 'entities/shared.md', { type: 'Concept', title: 'Shared PROJECT version' },
    'Project version of widgets shared doc.\n');
  writeConcept(globalRoot, 'entities/beta.md', { type: 'Concept', title: 'Beta Global Note' },
    'Global personal note about widgets and rockets.\n');
  writeConcept(globalRoot, 'entities/shared.md', { type: 'Concept', title: 'Shared GLOBAL version' },
    'Global version of widgets shared doc — should be dropped.\n');
});

after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(globalRoot, { recursive: true, force: true });
});

describe('okf-recall.mjs CLI — multi-root', () => {
  it('no OKF_GLOBAL_ROOT set at all == --no-global with a real global bundle present (byte-identical)', () => {
    const noEnvAtAll = run(OKF_RECALL, ['widgets', '-k', '5', '--mode', 'bm25'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: undefined });
    const withNoGlobalFlag = run(OKF_RECALL, ['widgets', '-k', '5', '--mode', 'bm25', '--no-global'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: globalRoot });
    assert.equal(withNoGlobalFlag.status, 0);
    assert.equal(noEnvAtAll.stdout, withNoGlobalFlag.stdout, 'stdout must be byte-identical');
  });

  it('OKF_GLOBAL_ROOT="" (explicitly disabled) == project-only output', () => {
    const disabled = run(OKF_RECALL, ['widgets', '-k', '5', '--mode', 'bm25'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: '' });
    const projectOnly = run(OKF_RECALL, ['widgets', '-k', '5', '--mode', 'bm25'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: undefined });
    assert.equal(disabled.stdout, projectOnly.stdout);
  });

  it('both roots present → merges, global: prefix, dedup warning on stderr', () => {
    const r = run(OKF_RECALL, ['widgets', '-k', '5', '--mode', 'bm25'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: globalRoot });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /global:entities\/beta/);
    assert.match(r.stdout, /entities\/alpha/);
    assert.match(r.stdout, /entities\/shared/);
    assert.doesNotMatch(r.stdout, /global:entities\/shared/, 'global copy of the colliding doc must not appear');
    assert.match(r.stderr, /shadowed by project doc.*dropped/);
  });
});

describe('gde.mjs CLI — multi-root', () => {
  it('no OKF_GLOBAL_ROOT set at all == --no-global with a real global bundle present (byte-identical)', () => {
    const noEnvAtAll = run(GDE, ['widgets', '-k', '5'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: undefined });
    const withNoGlobalFlag = run(GDE, ['widgets', '-k', '5', '--no-global'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: globalRoot });
    assert.equal(noEnvAtAll.stdout, withNoGlobalFlag.stdout);
  });

  it('both roots present → "global: " marker in the human-readable output', () => {
    const r = run(GDE, ['widgets', '-k', '5'], { OKF_ROOT: projectRoot, OKF_GLOBAL_ROOT: globalRoot });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /global: Beta Global Note/);
    assert.match(r.stderr, /shadowed by project doc.*dropped/);
  });
});

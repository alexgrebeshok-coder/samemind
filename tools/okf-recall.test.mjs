#!/usr/bin/env node
// okf-recall.test.mjs — samemind recall: CLI `--root` (F1/1.1.1) + unknown-flag rejection.
// recall never had --root before this: the flag parsed to nothing (silently dropped by the old
// indexOf-based parser), and the run silently fell back to OKF_ROOT/cwd — same defect class
// 1.0.1 already fixed once for board/handoff (samemind 09.08). Semantics here are the shared
// tools/lib/bundle-root.mjs `resolveBundleRoot`, verbatim (see okf-query.test.mjs's sibling
// describe block for the same contract on `query`).
// node --test tools/okf-recall.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECALL = join(HERE, 'okf-recall.mjs');

// Node's SQLite experimental-warning line embeds the child's PID, so two otherwise-identical
// spawns never come out byte-identical — strip it before asserting on stdout/stderr text.
const stripNoise = s => s.replace(/^\(node:\d+\).*\n?/gm, '').replace(/^\(Use `node --trace-warnings.*\n?/gm, '');

/** `root` sets OKF_ROOT (so --root has something concrete to override); OKF_GLOBAL_ROOT/
 *  OKF_EMBED_URL are pinned empty so a real ~/.samemind/bundle or embeddings endpoint on the
 *  host running the suite never leaks into these results (same isolation multiroot-cli.test.mjs
 *  and recall-expand.test.mjs use). */
function runCli(args, root) {
  const r = spawnSync(process.execPath, [RECALL, ...args], {
    env: { ...process.env, OKF_ROOT: root, OKF_GLOBAL_ROOT: '', OKF_EMBED_URL: '' },
    encoding: 'utf8',
  });
  return {
    code: r.status ?? 1,
    stdout: stripNoise(r.stdout || ''),
    stderr: stripNoise(r.stderr || ''),
  };
}

function writeConcept(root, relPath, body) {
  writeFileSync(join(root, relPath), body, 'utf8');
}

describe('recall CLI --root — picks WHICH bundle, wins over OKF_ROOT, rejects a bad path loudly', () => {
  let bundleA, bundleB;
  before(() => {
    bundleA = mkdtempSync(join(tmpdir(), 'samemind-recall-rootA-'));
    bundleB = mkdtempSync(join(tmpdir(), 'samemind-recall-rootB-'));
    runInit({ targetDir: bundleA });
    runInit({ targetDir: bundleB });
    writeConcept(bundleA, 'concepts/only-a.md',
      '---\ntype: Concept\ntitle: OnlyInA\n---\n\nMarker widgetzorp concept.\n');
    writeConcept(bundleB, 'concepts/only-b.md',
      '---\ntype: Concept\ntitle: OnlyInB\n---\n\nMarker widgetzorp concept.\n');
  });
  after(() => {
    rmSync(bundleA, { recursive: true, force: true });
    rmSync(bundleB, { recursive: true, force: true });
  });

  it('--root A and --root B give different results for the same query (red before the fix: byte-identical, silently reading OKF_ROOT)', () => {
    const a = runCli(['widgetzorp', '--mode', 'bm25', '--root', bundleA], bundleA);
    const b = runCli(['widgetzorp', '--mode', 'bm25', '--root', bundleB], bundleA);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.ok(a.stdout.includes('concepts/only-a') && !a.stdout.includes('concepts/only-b'));
    assert.ok(b.stdout.includes('concepts/only-b') && !b.stdout.includes('concepts/only-a'));
  });

  it('--root wins over OKF_ROOT pointing at a third bundle', () => {
    const { code, stdout } = runCli(['widgetzorp', '--mode', 'bm25', '--root', bundleB], bundleA);
    assert.equal(code, 0, stdout);
    assert.ok(stdout.includes('concepts/only-b'), 'read the --root bundle');
    assert.ok(!stdout.includes('concepts/only-a'), 'OKF_ROOT must not win over an explicit --root');
  });

  it('--root <missing dir> → nonzero exit with an explicit error, not a silent OKF_ROOT fallback', () => {
    const { code, stderr } = runCli(['q', '--root', join(bundleB, 'no-such-dir')], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /root not found/);
  });

  it('--root <regular file> → nonzero exit, not an empty/wrong result', () => {
    const file = join(bundleB, 'index.md');
    assert.ok(existsSync(file), 'fixture: a regular file to point --root at');
    const { code, stderr } = runCli(['q', '--root', file], bundleA);
    assert.notEqual(code, 0, 'a file is not a bundle root');
    assert.match(stderr, /root is not a directory/);
  });

  it('--root <symlink to a directory> is accepted', () => {
    const link = join(tmpdir(), `samemind-recall-rootlink-${process.pid}`);
    symlinkSync(bundleB, link, 'dir');
    try {
      const { code, stdout } = runCli(['widgetzorp', '--mode', 'bm25', '--root', link], bundleA);
      assert.equal(code, 0, stdout);
      assert.ok(stdout.includes('concepts/only-b'), 'reads through the symlink to B');
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root <symlink to a file> is rejected like the file itself', () => {
    const link = join(tmpdir(), `samemind-recall-filelink-${process.pid}`);
    symlinkSync(join(bundleB, 'index.md'), link, 'file');
    try {
      const { code, stderr } = runCli(['q', '--root', link], bundleA);
      assert.notEqual(code, 0);
      assert.match(stderr, /root is not a directory/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root <dangling symlink> reports "not found", not "not a directory"', () => {
    const link = join(tmpdir(), `samemind-recall-danglink-${process.pid}`);
    symlinkSync(join(bundleB, 'no-such-target'), link, 'dir');
    try {
      const { code, stderr } = runCli(['q', '--root', link], bundleA);
      assert.notEqual(code, 0);
      assert.match(stderr, /root not found/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root with no value exits nonzero instead of falling back silently', () => {
    const { code, stderr } = runCli(['q', '--root'], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /--root needs a value/);
  });

  it('--root swallowing the next flag as its value is rejected', () => {
    const { code, stderr } = runCli(['q', '--root', '--no-global'], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /--root needs a value/);
  });

  // `index` always calls the real embedding endpoint (pre-existing behavior of buildIndex — no
  // --mode plumbing there, unlike search) — asserting its SUCCESS exit code would depend on a
  // reachable OKF_EMBED_URL, which varies host to host (the box this was authored on happens to
  // have a local model server, a bare CI/Docker container does not). Root RESOLUTION for `index`
  // runs before any embedding attempt, so its error path is deterministic and safe to assert.
  it('`index --root <missing dir>` fails on root resolution before ever attempting to embed', () => {
    const { code, stderr } = runCli(['index', '--root', join(bundleB, 'no-such-dir')], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /root not found/);
  });
});

describe('recall CLI — unknown flag is a loud error; every documented flag still works', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-recall-flags-'));
    runInit({ targetDir: root });
    writeConcept(root, 'concepts/lumen.md',
      '---\ntype: Concept\ntitle: Lumen\n---\n\nLumen notes app about widgets.\n');
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('an unknown flag (e.g. --bogus) exits nonzero with a clear stderr message', () => {
    const { code, stderr } = runCli(['Lumen', '--bogus'], root);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown flag "--bogus"/);
  });

  it('an unknown flag before the query text is also rejected', () => {
    const { code, stderr } = runCli(['--bogus', 'Lumen'], root);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown flag "--bogus"/);
  });

  it('an unknown --mode value still fails the same way it always did (not swallowed by the new unknown-flag pass)', () => {
    const { code, stderr } = runCli(['Lumen', '--mode', 'bogus-mode'], root);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown --mode/);
  });

  it('every non-embedding flag recall documents today still works', () => {
    assert.equal(runCli(['Lumen', '-k', '3', '--mode', 'bm25'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--include-mirror'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--include-secret'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--include-inbox'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--include-superseded'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--no-global'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--exclude-source', 'nope'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--as-of', '2026-01-01'], root).code, 0);
    const expand = runCli(['Lumen', '--mode', 'bm25', '--expand'], root);
    assert.equal(expand.code, 0, expand.stdout + expand.stderr);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--expand-hops', '1'], root).code, 0);
    assert.equal(runCli(['Lumen', '--mode', 'bm25', '--expand', '--expand-budget', '2'], root).code, 0);
    // `index` is deliberately not asserted here — it always calls the real embedding endpoint
    // regardless of --mode (see the root-resolution-only `index` test above), so its success exit
    // code is host-dependent, not something this flag-coverage check can rely on portably.
  });
});

describe('recall CLI --root + semantic/hybrid — loud instead of silently wrong (F1b, 1.1.1 follow-up)', () => {
  // The *embeddings* index (tools/.index/) stays pinned to OKF_ROOT regardless of --root (see
  // the `query()` comment in okf-recall.mjs) — before this fix, `--root <other> --mode semantic`
  // would silently rank against OKF_ROOT's own index while printing <other>'s docs/ids. These
  // tests never build an index or reach an embed endpoint: the guard fires purely on
  // `root !== ROOT`, before either is touched, so no network/index fixture is needed here.
  let bundleA, bundleB;
  before(() => {
    bundleA = mkdtempSync(join(tmpdir(), 'samemind-recall-semroot-A-'));
    bundleB = mkdtempSync(join(tmpdir(), 'samemind-recall-semroot-B-'));
    runInit({ targetDir: bundleA });
    runInit({ targetDir: bundleB });
    writeConcept(bundleB, 'concepts/only-b.md',
      '---\ntype: Concept\ntitle: OnlyInB\n---\n\nMarker widgetzorp concept.\n');
  });
  after(() => {
    rmSync(bundleA, { recursive: true, force: true });
    rmSync(bundleB, { recursive: true, force: true });
  });

  it('--root <foreign bundle> --mode semantic refuses instead of ranking against the wrong index', () => {
    const { code, stdout, stderr } = runCli(['widgetzorp', '--mode', 'semantic', '--root', bundleB], bundleA);
    assert.notEqual(code, 0, stdout + stderr);
    assert.match(stderr, /--mode semantic does not support --root yet/);
    assert.match(stderr, /--mode bm25/);
  });

  it('--root <foreign bundle> --mode hybrid refuses the same way', () => {
    const { code, stderr } = runCli(['widgetzorp', '--mode', 'hybrid', '--root', bundleB], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /--mode hybrid does not support --root yet/);
  });

  it('--root <same bundle as OKF_ROOT> --mode semantic is NOT refused — no actual mismatch', () => {
    // --root pointing at the exact bundle the index would be pinned to anyway is not the F1b
    // defect (there is no "wrong bundle" to silently read) — falls through to recallSearch's own
    // "semantic mode requires an index" error instead, a pre-existing and unrelated message.
    const { code, stderr } = runCli(['widgetzorp', '--mode', 'semantic', '--root', bundleA], bundleA);
    assert.notEqual(code, 0);
    assert.doesNotMatch(stderr, /does not support --root/);
    assert.match(stderr, /semantic mode requires an index/);
  });

  it('--root <foreign bundle>, mode auto (default) — degrades to bm25 with a loud note, and still returns the --root bundle\'s own results', () => {
    const { code, stdout, stderr } = runCli(['widgetzorp', '--root', bundleB], bundleA);
    assert.equal(code, 0, stdout + stderr);
    assert.match(stderr, /--root given.*auto uses bm25/);
    assert.match(stdout, /\[bm25,/);
    assert.ok(stdout.includes('concepts/only-b'), 'bm25 ranks the --root bundle\'s own docs, not OKF_ROOT\'s');
  });

  it('--root <foreign bundle> --mode bm25 (explicit) — unaffected, no new note', () => {
    const { code, stdout, stderr } = runCli(['widgetzorp', '--mode', 'bm25', '--root', bundleB], bundleA);
    assert.equal(code, 0, stdout + stderr);
    assert.doesNotMatch(stderr, /auto uses bm25/);
    assert.doesNotMatch(stderr, /does not support --root/);
    assert.ok(stdout.includes('concepts/only-b'));
  });

  it('no --root at all, mode auto (default) — unaffected, no new note (byte-identical to pre-F1b)', () => {
    const { code, stderr } = runCli(['widgetzorp'], bundleA);
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /--root given/);
    assert.doesNotMatch(stderr, /does not support --root/);
  });
});

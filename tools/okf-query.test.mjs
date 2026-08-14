#!/usr/bin/env node
// okf-query.test.mjs — samemind query: structural queries over an OKF bundle. Covers the
// `links` command specifically:
//   - unit: renderLinksText(model) — the human-readable format, byte-for-byte the same
//     console.log output the pre-extraction inline code produced (verified by hand against
//     git HEAD's tools/okf-query.mjs during the buildLinksModel extraction).
//   - integration: CLI `query links` / `query links --json` over a small custom fixture
//     (orphan + broken link + a relation edge) and over the demo bundle (golden snapshot).
// node --test tools/okf-query.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderLinksText } from './okf-query.mjs';
import { runInit } from './init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY = join(HERE, 'okf-query.mjs');
const DEMO = resolve(HERE, '..', 'demo');

function runCli(args, root) {
  const r = spawnSync(process.execPath, [QUERY, ...args], {
    env: { ...process.env, OKF_ROOT: root },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─────────────────────────── unit: renderLinksText (pure) ───────────────────────────

describe('renderLinksText — byte-for-byte the pre-extraction console.log format', () => {
  it('renders the summary line + Orphans + Broken sections exactly as the old inline code did', () => {
    const model = {
      nodes: [{ id: 'a', title: 'A', type: 'Concept' }, { id: 'b', title: 'B', type: 'Concept' }],
      edges: [{ from: 'a', to: 'b', kind: 'link' }],
      orphans: ['b'],
      broken: ['a [related] → /concepts/ghost.md (broken)'],
      mdEdges: 1, relCount: 1, supersedeCount: 0, totalEdges: 2,
    };
    const text = renderLinksText(model);
    assert.equal(
      text,
      '# Link graph\n'
      + 'Concepts: 2, edges: 2 (md: 1, relations: 1, supersedes: 0)\n'
      + '\nOrphans (no inbound links):\nb'
      + '\n\nBroken links:\na [related] → /concepts/ghost.md (broken)',
    );
  });

  it('empty orphans/broken render "— none"', () => {
    const model = {
      nodes: [], edges: [], orphans: [], broken: [], mdEdges: 0, relCount: 0, supersedeCount: 0, totalEdges: 0,
    };
    const text = renderLinksText(model);
    assert.equal(
      text,
      '# Link graph\n'
      + 'Concepts: 0, edges: 0 (md: 0, relations: 0, supersedes: 0)\n'
      + '\nOrphans (no inbound links):\n— none'
      + '\n\nBroken links:\n— none',
    );
  });
});

// ─────────────────────────── integration: CLI `query links` ───────────────────────────

describe('CLI — query links (custom fixture: orphan + relation edge + broken link)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-okfquery-links-'));
    runInit({ targetDir: root });
    writeFileSync(join(root, 'concepts', 'x.md'), `---
type: Concept
title: X
---

Links to [Y](/concepts/y.md).
`, 'utf8');
    writeFileSync(join(root, 'concepts', 'y.md'), `---
type: Concept
title: Y
relations:
  related: [/concepts/x.md]
---

# Y
`, 'utf8');
    writeFileSync(join(root, 'concepts', 'orphan.md'), `---
type: Concept
title: Orphan
---

# Orphan — nothing points here
`, 'utf8');
    writeFileSync(join(root, 'concepts', 'ghost.md'), `---
type: Concept
title: Ghost
---

Links to [Nope](/concepts/does-not-exist.md).
`, 'utf8');
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('text output: orphan listed, broken link listed with "(broken)"', () => {
    const { code, stdout, stderr } = runCli(['links'], root);
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /^# Link graph/);
    assert.match(stdout, /Orphans \(no inbound links\):\n(?:.*\n)*?concepts\/orphan/);
    assert.match(stdout, /concepts\/ghost \[link\]? ?.*does-not-exist.*\(broken\)|concepts\/ghost → \/concepts\/does-not-exist\.md \(broken\)/);
  });

  it('--json: nodes/edges/orphans/broken shapes, same data the text output renders from', () => {
    const { code, stdout, stderr } = runCli(['links', '--json'], root);
    assert.equal(code, 0, stdout + stderr);
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.contract, 1);
    assert.equal(payload.kind, 'links');

    const { nodes, edges, orphans, broken } = payload.data;
    assert.ok(nodes.some(n => n.id === 'concepts/x' && n.title === 'X' && n.type === 'Concept'));
    assert.ok(nodes.some(n => n.id === 'concepts/orphan'));
    assert.ok(edges.some(e => e.from === 'concepts/x' && e.to === 'concepts/y' && e.kind === 'link'));
    assert.ok(edges.some(e => e.from === 'concepts/y' && e.to === 'concepts/x' && e.kind === 'relation' && e.rel === 'related'));
    assert.ok(orphans.includes('concepts/orphan'));
    assert.ok(broken.some(b => b.includes('concepts/ghost') && b.includes('does-not-exist') && b.includes('(broken)')));
  });

  it('--json output is renderable back into the same text as the non-json path', () => {
    const j = runCli(['links', '--json'], root);
    const text = runCli(['links'], root);
    const payload = JSON.parse(j.stdout.trim());
    assert.equal(renderLinksText(payload.data), text.stdout.trim());
  });
});

// ─────────────────────────── demo bundle: golden snapshot ───────────────────────────

describe('CLI — query links (demo bundle, golden snapshot)', () => {
  it('text output matches the known-good snapshot byte-for-byte', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const { code, stdout, stderr } = runCli(['links'], DEMO);
    assert.equal(code, 0, stdout + stderr);
    assert.equal(
      stdout,
      '# Link graph\n'
      + 'Concepts: 22, edges: 120 (md: 82, relations: 37, supersedes: 1)\n'
      + '\n'
      + 'Orphans (no inbound links):\n'
      + 'concepts/embed-model-qwen3\n'
      + 'concepts/session-2026-07-09-lumen-sync\n'
      + '\n'
      + 'Broken links:\n'
      + '— none\n',
    );
  });

  it('--json is valid, one line, and its data renders to the same snapshot text', () => {
    if (!existsSync(join(DEMO, 'index.md'))) return;
    const j = runCli(['links', '--json'], DEMO);
    const lines = j.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one line of JSON on stdout');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.contract, 1);
    assert.equal(payload.kind, 'links');
    assert.equal(payload.data.nodes.length, 22);
    assert.equal(payload.data.totalEdges, 120);

    const text = runCli(['links'], DEMO);
    assert.equal(renderLinksText(payload.data) + '\n', text.stdout);
  });
});

// ─────────────────────── CLI: --root (F1/1.1.1 — was silently ignored) ───────────────────────
// query never had --root before this: the flag parsed to nothing, and the run silently fell
// back to OKF_ROOT/cwd — same defect class 1.0.1 already fixed once for board/handoff (samemind
// 09.08). Semantics here are the shared tools/lib/bundle-root.mjs `resolveBundleRoot`, verbatim.

describe('query CLI --root — picks WHICH bundle, wins over OKF_ROOT, rejects a bad path loudly', () => {
  let bundleA, bundleB;
  before(() => {
    bundleA = mkdtempSync(join(tmpdir(), 'samemind-query-rootA-'));
    bundleB = mkdtempSync(join(tmpdir(), 'samemind-query-rootB-'));
    runInit({ targetDir: bundleA });
    runInit({ targetDir: bundleB });
    writeFileSync(join(bundleA, 'concepts', 'only-a.md'), '---\ntype: Concept\ntitle: OnlyInA\n---\n\nA\n', 'utf8');
    writeFileSync(join(bundleB, 'concepts', 'only-b.md'), '---\ntype: Concept\ntitle: OnlyInB\n---\n\nB\n', 'utf8');
  });
  after(() => {
    rmSync(bundleA, { recursive: true, force: true });
    rmSync(bundleB, { recursive: true, force: true });
  });

  it('--root A and --root B give different `list` results (red before the fix: both were byte-identical, silently reading OKF_ROOT)', () => {
    const a = runCli(['list', '--root', bundleA], bundleA);
    const b = runCli(['list', '--root', bundleB], bundleA);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.ok(a.stdout.includes('OnlyInA') && !a.stdout.includes('OnlyInB'));
    assert.ok(b.stdout.includes('OnlyInB') && !b.stdout.includes('OnlyInA'));
  });

  it('--root wins over OKF_ROOT pointing at a third bundle', () => {
    const { code, stdout } = runCli(['list', '--root', bundleB], bundleA);
    assert.equal(code, 0, stdout);
    assert.ok(stdout.includes('OnlyInB'), 'read the --root bundle');
    assert.ok(!stdout.includes('OnlyInA'), 'OKF_ROOT must not win over an explicit --root');
  });

  it('--root also switches which bundle `validate`/`links`/`rel` resolve relations against', () => {
    const validate = runCli(['validate', '--root', bundleB], bundleA);
    assert.equal(validate.code, 0, validate.stdout + validate.stderr);
    assert.match(validate.stdout, /1 concepts/);
    const links = runCli(['links', '--root', bundleB], bundleA);
    assert.equal(links.code, 0, links.stdout);
    assert.match(links.stdout, /Concepts: 1/);
  });

  it('--root <missing dir> → nonzero exit with an explicit error, not a silent OKF_ROOT fallback', () => {
    const { code, stderr } = runCli(['list', '--root', join(bundleB, 'no-such-dir')], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /root not found/);
  });

  it('--root <regular file> → nonzero exit, not an empty/wrong result', () => {
    const file = join(bundleB, 'index.md');
    assert.ok(existsSync(file), 'fixture: a regular file to point --root at');
    const { code, stderr } = runCli(['list', '--root', file], bundleA);
    assert.notEqual(code, 0, 'a file is not a bundle root');
    assert.match(stderr, /root is not a directory/);
  });

  it('--root <symlink to a directory> is accepted', () => {
    const link = join(tmpdir(), `samemind-query-rootlink-${process.pid}`);
    symlinkSync(bundleB, link, 'dir');
    try {
      const { code, stdout } = runCli(['list', '--root', link], bundleA);
      assert.equal(code, 0, stdout);
      assert.ok(stdout.includes('OnlyInB'), 'reads through the symlink to B');
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root <symlink to a file> is rejected like the file itself', () => {
    const link = join(tmpdir(), `samemind-query-filelink-${process.pid}`);
    symlinkSync(join(bundleB, 'index.md'), link, 'file');
    try {
      const { code, stderr } = runCli(['list', '--root', link], bundleA);
      assert.notEqual(code, 0);
      assert.match(stderr, /root is not a directory/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root <dangling symlink> reports "not found", not "not a directory"', () => {
    const link = join(tmpdir(), `samemind-query-danglink-${process.pid}`);
    symlinkSync(join(bundleB, 'no-such-target'), link, 'dir');
    try {
      const { code, stderr } = runCli(['list', '--root', link], bundleA);
      assert.notEqual(code, 0);
      assert.match(stderr, /root not found/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('--root with no value exits nonzero instead of falling back silently', () => {
    const { code, stderr } = runCli(['list', '--root'], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /--root needs a value/);
  });

  it('--root swallowing the next flag as its value is rejected', () => {
    const { code, stderr } = runCli(['list', '--root', '--json'], bundleA);
    assert.notEqual(code, 0);
    assert.match(stderr, /--root needs a value/);
  });
});

describe('query CLI — unknown flag is a loud error; every documented flag still works', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'samemind-query-flags-'));
    runInit({ targetDir: root });
    writeFileSync(join(root, 'concepts', 'a.md'),
      '---\ntype: Concept\ntitle: A\ntags: [x]\nrelations:\n  related: [/concepts/b.md]\n---\n\nA\n', 'utf8');
    writeFileSync(join(root, 'concepts', 'b.md'), '---\ntype: Concept\ntitle: B\n---\n\nB\n', 'utf8');
  });
  after(() => { rmSync(root, { recursive: true, force: true }); });

  it('an unknown flag (e.g. --bogus) exits nonzero with a clear stderr message', () => {
    const { code, stderr } = runCli(['list', '--bogus'], root);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown flag "--bogus"/);
  });

  it('an unknown flag before the subcommand is also rejected (cmd resolution stays flag-position-independent)', () => {
    const { code, stderr } = runCli(['--bogus', 'list'], root);
    assert.notEqual(code, 0);
    assert.match(stderr, /unknown flag "--bogus"/);
  });

  it('every flag/subcommand query documents today still works', () => {
    assert.equal(runCli(['list'], root).code, 0);
    assert.equal(runCli(['list', '--include-secret', '--include-inbox'], root).code, 0);
    assert.equal(runCli(['type', 'Concept'], root).code, 0);
    assert.equal(runCli(['tag', 'x'], root).code, 0);
    assert.equal(runCli(['get', 'concepts/a'], root).code, 0);
    const rel = runCli(['rel', 'related', 'concepts/a'], root);
    assert.equal(rel.code, 0, rel.stdout);
    assert.match(rel.stdout, /concepts\/b/);
    assert.equal(runCli(['rel', 'related', 'concepts/a', '--inbound'], root).code, 0);
    assert.equal(runCli(['links'], root).code, 0);
    assert.equal(runCli(['links', '--json'], root).code, 0);
    assert.equal(runCli(['validate'], root).code, 0);
  });
});

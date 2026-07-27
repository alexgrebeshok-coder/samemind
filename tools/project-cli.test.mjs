#!/usr/bin/env node
// project-cli.test.mjs — unit (buildProjectBlock) + CLI (subprocess) tests for `samemind project`.
// Unit tests use hand-built docs (no fs). CLI tests spawn tools/project.mjs against a tmp bundle
// with HOME pointed at an empty tmp dir, so the real ~/.samemind global config is never read and
// the real repo/home is never touched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { buildProjectBlock, PROJECT_START, PROJECT_END } from './project.mjs';
import { INSTALL_START, INSTALL_END } from './install.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, 'project.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

/** Minimal synthetic doc — only the fields buildProjectBlock/hygiene read. */
function doc({ id, type, title, description, source, timestamp, body, supersedes }) {
  const fm = { type };
  if (title) fm.title = title;
  if (description) fm.description = description;
  if (source) fm.source = source;
  if (timestamp) fm.timestamp = timestamp;
  return { id, reserved: false, fm, body: body || '', supersedes: supersedes || [] };
}

const RETRIEVAL = doc({ id: 'concepts/retrieval', type: 'Concept', title: 'Retrieval strategy', description: 'how recall works', source: 'demo', timestamp: '2026-07-10T00:00:00Z', body: 'FACT-RETRIEVAL body' });
const DECISION = doc({ id: 'concepts/decision-local', type: 'Decision', title: 'Local-first', source: 'demo', timestamp: '2026-07-20T00:00:00Z', body: 'FACT-DECISION body' });
const CURSOR_NOTE = doc({ id: 'concepts/cursor-note', type: 'Concept', title: 'Cursor note', source: 'cursor', timestamp: '2026-07-15T00:00:00Z', body: 'FACT-CURSOR body' });
const NOVA = doc({ id: 'concepts/nova', type: 'Identity', title: 'Nova', body: 'IDENTITY-NOVA body' });
const ALEX = doc({ id: 'entities/alex', type: 'User', title: 'Alex', body: 'USER-ALEX body' });
const ENGINE_CC = doc({ id: 'concepts/engine-cc', type: 'EngineRule', title: 'Engine cc', body: 'ENGINERULE-CC body' });

describe('buildProjectBlock — unit', () => {
  it('wraps facts in the project markers', () => {
    const { block } = buildProjectBlock([RETRIEVAL, DECISION]);
    assert.ok(block.startsWith(PROJECT_START));
    assert.ok(block.trim().endsWith(PROJECT_END));
    assert.match(block, /FACT-RETRIEVAL body/);
    assert.match(block, /FACT-DECISION body/);
  });

  it('filters the identity layer (Identity/User/EngineRule) — those are brief/install territory', () => {
    const { block } = buildProjectBlock([RETRIEVAL, NOVA, ALEX, ENGINE_CC]);
    assert.match(block, /FACT-RETRIEVAL/);
    assert.doesNotMatch(block, /IDENTITY-NOVA/);
    assert.doesNotMatch(block, /USER-ALEX/);
    assert.doesNotMatch(block, /ENGINERULE-CC/);
  });

  it('anti-echo: a fact whose source is the target excludeSource is dropped', () => {
    const withEcho = buildProjectBlock([RETRIEVAL, CURSOR_NOTE], { excludeSource: null });
    assert.match(withEcho.block, /FACT-CURSOR/);
    const filtered = buildProjectBlock([RETRIEVAL, CURSOR_NOTE], { excludeSource: 'cursor' });
    assert.doesNotMatch(filtered.block, /FACT-CURSOR/);
    assert.match(filtered.block, /FACT-RETRIEVAL/);
  });

  it('canon ranking: freshest timestamp first', () => {
    const { block } = buildProjectBlock([RETRIEVAL, DECISION], { factSource: 'canon' });
    assert.ok(block.indexOf('Local-first') < block.indexOf('Retrieval strategy'), 'newer (07-20) ranks above older (07-10)');
  });

  it('bundle ranking: a superseded fact is demoted below a live one, unlike canon', () => {
    // A (older) supersedes B (newer). canon would put B first (fresher); bundle demotes B.
    const A = doc({ id: 'concepts/a', type: 'Concept', title: 'Alpha fact', source: 'demo', timestamp: '2026-07-10T00:00:00Z', body: 'FACT-A', supersedes: ['/concepts/b.md'] });
    const B = doc({ id: 'concepts/b', type: 'Concept', title: 'Beta fact', source: 'demo', timestamp: '2026-07-25T00:00:00Z', body: 'FACT-B' });

    const canon = buildProjectBlock([A, B], { factSource: 'canon' });
    assert.ok(canon.block.indexOf('Beta fact') < canon.block.indexOf('Alpha fact'), 'canon: fresher B first');

    const bundle = buildProjectBlock([A, B], { factSource: 'bundle' });
    assert.ok(bundle.block.indexOf('Alpha fact') < bundle.block.indexOf('Beta fact'), 'bundle: superseded B demoted below A');
  });
});

// --- CLI integration -------------------------------------------------------------------------

/** Build a tmp OKF bundle of fact + identity files on disk. Returns { root, home }. */
function makeBundle() {
  const root = tmp('project-bundle');
  const home = tmp('project-home'); // empty — no ~/.samemind global config tier
  const write = (rel, fm, body) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
    writeFileSync(abs, `---\n${front}\n---\n\n${body}\n`, 'utf8');
  };
  write('concepts/retrieval.md', { type: 'Concept', title: 'Retrieval strategy', source: 'demo', timestamp: '2026-07-10T00:00:00Z' }, '# Retrieval\n\nFACT-RETRIEVAL body');
  write('concepts/decision-local.md', { type: 'Decision', title: 'Local-first', source: 'demo', timestamp: '2026-07-20T00:00:00Z' }, '# Decision\n\nFACT-DECISION body');
  write('concepts/cursor-note.md', { type: 'Concept', title: 'Cursor note', source: 'cursor', timestamp: '2026-07-15T00:00:00Z' }, '# Cursor note\n\nFACT-CURSOR body');
  write('concepts/nova.md', { type: 'Identity', title: 'Nova' }, '# Nova\n\nIDENTITY-NOVA body');
  write('entities/alex.md', { type: 'User', title: 'Alex' }, '# Alex\n\nUSER-ALEX body');
  return { root, home };
}

function runProject(args, root, home) {
  return execFileSync(process.execPath, [PROJECT, ...args], {
    env: { ...process.env, OKF_ROOT: root, HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('samemind project — CLI', () => {
  it('--dry-run prints the fact block, no identity, writes nothing', () => {
    const { root, home } = makeBundle();
    try {
      const out = runProject(['--engine', 'claude-code', '--dry-run'], root, home);
      assert.match(out, new RegExp(PROJECT_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(out, /FACT-RETRIEVAL/);
      assert.match(out, /FACT-DECISION/);
      assert.doesNotMatch(out, /IDENTITY-NOVA/);
      assert.doesNotMatch(out, /USER-ALEX/);
      assert.equal(existsSync(join(root, 'CLAUDE.md')), false, 'dry-run must not write');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('injects the project block and leaves an existing install block untouched (coexistence)', () => {
    const { root, home } = makeBundle();
    try {
      const claude = join(root, 'CLAUDE.md');
      writeFileSync(claude, `# Sasha notes\n\nkeep me\n\n${INSTALL_START}\nINSTALL PAYLOAD (identity)\n${INSTALL_END}\n\ntail text\n`, 'utf8');

      runProject(['--engine', 'claude-code'], root, home);
      const content = readFileSync(claude, 'utf8');

      assert.match(content, /keep me/);
      assert.match(content, /tail text/);
      assert.match(content, /INSTALL PAYLOAD \(identity\)/, 'install block preserved');
      assert.match(content, new RegExp(PROJECT_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(content, /FACT-RETRIEVAL/);
      assert.equal((content.match(/samemind:install:start/g) || []).length, 1, 'one install block');
      assert.equal((content.match(/samemind:project:start/g) || []).length, 1, 'one project block');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-running replaces only the project block; install block stays intact', () => {
    const { root, home } = makeBundle();
    try {
      const claude = join(root, 'CLAUDE.md');
      writeFileSync(claude, `${INSTALL_START}\nINSTALL PAYLOAD\n${INSTALL_END}\n`, 'utf8');
      runProject(['--engine', 'claude-code'], root, home);
      const once = readFileSync(claude, 'utf8');
      runProject(['--engine', 'claude-code'], root, home);
      const twice = readFileSync(claude, 'utf8');
      assert.equal(once, twice, 'second project run is byte-for-byte idempotent');
      assert.equal((twice.match(/samemind:project:start/g) || []).length, 1);
      assert.match(twice, /INSTALL PAYLOAD/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('anti-echo end-to-end: a source=cursor fact is projected to claude-code but NOT to cursor', () => {
    const { root, home } = makeBundle();
    try {
      const toCC = runProject(['--engine', 'claude-code', '--dry-run'], root, home);
      assert.match(toCC, /FACT-CURSOR/, 'cursor-authored fact reaches a different engine');
      const toCursor = runProject(['--engine', 'cursor', '--dry-run'], root, home);
      assert.doesNotMatch(toCursor, /FACT-CURSOR/, 'cursor does not get its own echo back');
      assert.match(toCursor, /FACT-RETRIEVAL/, 'other facts still projected to cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('unknown engine → non-zero exit with an actionable stderr line', () => {
    const { root, home } = makeBundle();
    try {
      runProject(['--engine', 'not-a-real-engine', '--dry-run'], root, home);
      throw new Error('expected non-zero exit');
    } catch (e) {
      assert.equal(e.status, 1);
      const stderr = String(e.stderr || '');
      assert.match(stderr, /unknown engine "not-a-real-engine"/);
      assert.match(stderr, /claude-code/); // lists the known ones
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('no --engine and no config targets → non-zero exit that says what to do', () => {
    const { root, home } = makeBundle();
    try {
      runProject([], root, home);
      throw new Error('expected non-zero exit');
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(String(e.stderr || ''), /no target/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('config-driven targets: projection.targets are used, and schema is stamped on write', () => {
    const { root, home } = makeBundle();
    try {
      mkdirSync(join(root, '.samemind'), { recursive: true });
      writeFileSync(join(root, '.samemind', 'config.json'),
        JSON.stringify({ embedUrl: 'http://x', projection: { targets: [{ engine: 'claude-code' }] } }, null, 2));

      runProject([], root, home); // no --engine → config targets
      const claude = join(root, 'CLAUDE.md');
      assert.ok(existsSync(claude), 'config target claude-code written');
      assert.match(readFileSync(claude, 'utf8'), /FACT-RETRIEVAL/);

      const cfg = JSON.parse(readFileSync(join(root, '.samemind', 'config.json'), 'utf8'));
      assert.equal(cfg.schema_version, 1, 'migration stamped schema_version on the write path');
      assert.equal(cfg.embedUrl, 'http://x', 'foreign keys preserved by migration');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

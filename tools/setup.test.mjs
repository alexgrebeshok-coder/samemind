#!/usr/bin/env node
// setup.test.mjs — CLI + unit tests for `samemind setup` (node --test), pattern per
// install.test.mjs: CLI tests spawn tools/setup.mjs as a real subprocess against tmp target
// dirs, unit tests exercise applyEmbedProbe() directly. Never touches ~/samemind.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, mkdirSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { applyEmbedProbe } from './setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, 'setup.mjs');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

// Ambient engine env-var signals (CLAUDECODE, CODEX_HOME, …) leak in from whatever harness runs
// this test suite itself (a Claude Code or Codex session, an Orca worktree, …) — stripped so
// setup's own env-detection step is only ever driven by what each test explicitly sets via
// `env`, not by the outer sandbox it happens to run inside.
function cleanEnv(extra = {}) {
  const {
    CLAUDECODE: _cc, CURSOR_TRACE_ID: _ct, CODEX_HOME: _ch, CODEX_SANDBOX: _cs, ORCA_CODEX_HOME: _och,
    ...rest
  } = process.env;
  return { ...rest, ...extra };
}

function run(args, { env } = {}) {
  return execFileSync(process.execPath, [SETUP, ...args], { encoding: 'utf8', env: cleanEnv(env) });
}

// `--global` runs against a fake $HOME (never the real ~/.claude*, ~/.samemind) and with a PATH
// that cannot resolve a `claude` binary — forcing ensureMcpRegistered's native path to miss
// deterministically so every `--global --yes` test exercises (and only ever exercises) the
// JSON-merge fallback, rather than depending on whether this particular machine happens to have
// a real `claude` CLI on PATH.
function runGlobal(args, { home, env } = {}) {
  return execFileSync(process.execPath, [SETUP, '--global', ...args], {
    encoding: 'utf8',
    env: cleanEnv({ HOME: home, PATH: '/samemind-test-no-such-bin', ...env }),
  });
}

/** snapshotTree() output with any `*.bak-*` backup file dropped — global setup's JSON-merge
 *  fallback (mergeJsonFile) intentionally writes a fresh backup on every re-run that finds an
 *  existing file (see global-json-merge.test.mjs); that's a deliberate safety artifact, not
 *  something a second run should ever have to reproduce byte-for-byte. */
function stripBackups(snapshot) {
  const out = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (!/\.bak-\d/.test(k)) out[k] = v;
  }
  return out;
}

/** relative-path → sha256(content), for every regular file under dir — a byte-for-byte tree
 *  snapshot (dry-run's "wrote nothing" proof compares two of these, not just a file list). */
function snapshotTree(dir) {
  const out = {};
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }(dir));
  return out;
}

describe('samemind setup — --yes (CLI)', () => {
  it('bundle created + install block written into an existing CLAUDE.md + status printed', () => {
    const dir = tmp('setup-yes');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# Sasha\'s own notes\n\nNever delete without asking.\n', 'utf8');
      const out = run(['--target', dir, '--yes']);

      assert.match(out, /Detected engine\(s\): claude-code/);
      assert.ok(existsSync(join(dir, 'index.md')), 'bundle index.md missing');
      assert.ok(existsSync(join(dir, 'concepts')), 'bundle concepts/ missing');

      const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
      assert.match(claude, /Never delete without asking\./); // original content preserved
      assert.match(claude, /samemind:install:start/);
      assert.match(claude, /## samemind memory/);

      assert.match(out, /=== samemind setup — summary ===/);
      assert.match(out, /Engine\(s\): claude-code/);
      assert.match(out, /Semantic:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repeated --yes is idempotent — no duplicated markers, .mcp.json stable', () => {
    const dir = tmp('setup-idem');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      run(['--target', dir, '--yes']);
      const claudeOnce = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
      const mcpOnce = readFileSync(join(dir, '.mcp.json'), 'utf8');

      run(['--target', dir, '--yes']);
      const claudeTwice = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
      const mcpTwice = readFileSync(join(dir, '.mcp.json'), 'utf8');

      assert.equal(claudeOnce, claudeTwice, 'second setup run must not change CLAUDE.md');
      assert.equal((claudeTwice.match(/samemind:install:start/g) || []).length, 1);
      assert.equal(mcpOnce, mcpTwice, 'second setup run must not change .mcp.json');
      assert.equal(Object.keys(JSON.parse(mcpTwice).mcpServers).length, 1, 'no duplicated mcpServers entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no engine detected at all → prints the supported list, exits 0, no engine file/MCP written', () => {
    const dir = tmp('setup-noengine');
    try {
      const out = run(['--target', dir, '--yes']); // no throw ⇒ exit 0
      assert.match(out, /nothing to install/i);
      assert.match(out, /claude-code/); // supported-engines list mentions it
      // bundle scaffolding (step 2) and the embeddings probe (step 5) are unconditional — only
      // install (step 3) and MCP registration (step 4) are gated on having an engine to wire.
      assert.ok(existsSync(join(dir, 'index.md')), 'bundle is still created — that step is not engine-gated');
      for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.clinerules', '.mcp.json']) {
        assert.equal(existsSync(join(dir, f)), false, `${f} must not exist — no engine was chosen`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-var signal (CLAUDECODE) is detected even before any instruction file exists', () => {
    const dir = tmp('setup-env-signal');
    try {
      const out = run(['--target', dir, '--dry-run'], { env: { CLAUDECODE: '1' } });
      assert.match(out, /Detected engine\(s\): claude-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-var signal (CODEX_HOME) alone, no AGENTS.md, is still detected — same sole-signal case as CLAUDECODE', () => {
    const dir = tmp('setup-env-signal-codex');
    try {
      const out = run(['--target', dir, '--dry-run'], { env: { CODEX_HOME: '/fake' } });
      assert.match(out, /Detected engine\(s\): codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two simultaneous env signals with no file behind either → ambiguous, dropped (no false codex detect)', () => {
    const dir = tmp('setup-env-ambiguous');
    try {
      // Regression: an ambient CODEX_HOME (e.g. leaked from Orca's own codex-runtime) alongside
      // a real CLAUDECODE must not falsely offer "codex" — neither signal has a file backing it,
      // so both are dropped rather than guessed at.
      const out = run(['--target', dir, '--dry-run'], { env: { CLAUDECODE: '1', CODEX_HOME: '/fake' } });
      assert.match(out, /No engine detected/);
      // "codex" still appears in the generic supported-engines menu (same as the plain
      // no-engine-at-all case) — what must NOT happen is codex being reported as detected/installed.
      assert.doesNotMatch(out, /Detected engine\(s\).*codex/);
      assert.doesNotMatch(out, /install samemind brief into Codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env signal corroborated by an existing file for a DIFFERENT engine still wins on its own file — ambient codex still dropped', () => {
    const dir = tmp('setup-env-file-backed');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      const out = run(['--target', dir, '--dry-run'], { env: { CODEX_HOME: '/fake' } });
      assert.match(out, /Detected engine\(s\): claude-code/);
      assert.doesNotMatch(out, /codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no warning noise: --yes with a real (file-backed) claude-code + ambient codex never installs codex or warns about it', () => {
    const dir = tmp('setup-no-warning-noise');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      const out = run(['--target', dir, '--yes'], { env: { CLAUDECODE: '1', CODEX_HOME: '/fake' } });
      assert.match(out, /Detected engine\(s\): claude-code/);
      assert.doesNotMatch(out, /no EngineRule found for engine "codex"/);
      assert.equal(existsSync(join(dir, 'AGENTS.md')), false, 'codex must not get an instruction file from ambient noise');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('samemind setup — --dry-run writes nothing', () => {
  it('byte-for-byte identical tree before/after, with an engine file present', () => {
    const dir = tmp('setup-dryrun');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
      const before = snapshotTree(dir);

      const out = run(['--target', dir, '--dry-run']);

      assert.deepEqual(snapshotTree(dir), before, 'dry-run must not create/modify/delete anything');
      assert.match(out, /\[dry-run\]/);
      assert.match(out, /Detected engine\(s\): claude-code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('byte-for-byte identical tree before/after, on a totally empty directory', () => {
    const dir = tmp('setup-dryrun-empty');
    try {
      const before = snapshotTree(dir);
      const out = run(['--target', dir, '--dry-run']);
      assert.deepEqual(snapshotTree(dir), before);
      assert.match(out, /\[dry-run\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyEmbedProbe — unit (probe-result wiring, no network/mocked fetch needed)', () => {
  it('probe alive → writes .samemind/config.json with embedUrl/embedModel', () => {
    const dir = tmp('embed-alive');
    try {
      const msg = applyEmbedProbe(dir, { url: 'http://127.0.0.1:8000/v1/embeddings', model: 'bge-m3', provider: 'omlx' });
      const cfg = JSON.parse(readFileSync(join(dir, '.samemind', 'config.json'), 'utf8'));
      assert.equal(cfg.embedUrl, 'http://127.0.0.1:8000/v1/embeddings');
      assert.equal(cfg.embedModel, 'bge-m3');
      assert.match(msg, /Semantic on/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probe dead (null) → no config file, honest BM25-fallback hint', () => {
    const dir = tmp('embed-dead');
    try {
      const msg = applyEmbedProbe(dir, null);
      assert.equal(existsSync(join(dir, '.samemind', 'config.json')), false);
      assert.match(msg, /BM25 fallback/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run + alive probe → does not write, plan message only', () => {
    const dir = tmp('embed-dryrun');
    try {
      const msg = applyEmbedProbe(dir, { url: 'http://x', model: 'bge-m3', provider: 'omlx' }, { dryRun: true });
      assert.equal(existsSync(join(dir, '.samemind')), false);
      assert.match(msg, /\[dry-run\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges into an existing config.json, preserving unrelated keys (idempotent rewrite)', () => {
    const dir = tmp('embed-merge');
    try {
      mkdirSync(join(dir, '.samemind'), { recursive: true });
      writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify({ other: 'keep-me' }), 'utf8');
      applyEmbedProbe(dir, { url: 'http://x', model: 'm', provider: 'ollama' });
      const cfg = JSON.parse(readFileSync(join(dir, '.samemind', 'config.json'), 'utf8'));
      assert.equal(cfg.other, 'keep-me');
      assert.equal(cfg.embedUrl, 'http://x');
      assert.equal(cfg.embedModel, 'm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('samemind setup --global (G-A) — fake $HOME, real ~/.claude*/~/.samemind never touched', () => {
  it('--dry-run writes nothing at all under a fresh $HOME (byte-for-byte before/after)', () => {
    const home = tmp('global-dryrun-home');
    try {
      const before = snapshotTree(home);
      const out = runGlobal(['--dry-run'], { home });

      assert.deepEqual(snapshotTree(home), before, 'dry-run must not create anything under $HOME');
      assert.match(out, /\[dry-run\]/);
      assert.match(out, /would install samemind brief into/);
      assert.match(out, /would register samemind as a user-scope MCP server/);
      assert.equal(existsSync(join(home, '.claude')), false);
      assert.equal(existsSync(join(home, '.samemind')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--dry-run also writes nothing when a personal bundle already exists under $HOME', () => {
    const home = tmp('global-dryrun-bundle-home');
    try {
      // Seed a minimal already-scaffolded personal bundle so the dry-run path takes the
      // "bundle already present" branch instead of the "would scaffold" one.
      mkdirSync(join(home, '.samemind', 'bundle', 'concepts'), { recursive: true });
      writeFileSync(join(home, '.samemind', 'bundle', 'index.md'), '# bundle\n', 'utf8');
      const before = snapshotTree(home);

      const out = runGlobal(['--dry-run'], { home });

      assert.deepEqual(snapshotTree(home), before);
      assert.match(out, /Personal bundle already present/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--yes on a fresh fake $HOME: CLAUDE.md installed, MCP fallback-merged, global embed config written', () => {
    const home = tmp('global-yes-home');
    try {
      const out = runGlobal(['--yes'], { home });

      assert.match(out, /=== samemind setup --global — summary ===/);
      assert.ok(existsSync(join(home, '.samemind', 'bundle', 'index.md')), 'personal bundle should be scaffolded');

      const claude = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
      assert.match(claude, /samemind:install:start/);
      assert.match(claude, /## samemind memory/);

      // native `claude` is unreachable (PATH forced empty) → JSON-merge fallback must have run
      assert.match(out, /wrote samemind.*claude\.json/i);
      const claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      assert.deepEqual(claudeJson.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });

      assert.match(out, /Semantic \(global\):/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--yes preserves pre-existing ~/.claude.json keys (exa/context7/playwright fixture) via the fallback merge', () => {
    const home = tmp('global-yes-preserve-home');
    try {
      mkdirSync(home, { recursive: true });
      const before = {
        mcpServers: {
          exa: { command: 'npx', args: ['exa-mcp'] },
          context7: { command: 'npx', args: ['context7-mcp'] },
          playwright: { command: 'npx', args: ['playwright-mcp'] },
        },
      };
      writeFileSync(join(home, '.claude.json'), JSON.stringify(before, null, 2), 'utf8');

      runGlobal(['--yes'], { home });

      const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      assert.deepEqual(after.mcpServers.exa, before.mcpServers.exa);
      assert.deepEqual(after.mcpServers.context7, before.mcpServers.context7);
      assert.deepEqual(after.mcpServers.playwright, before.mcpServers.playwright);
      assert.deepEqual(after.mcpServers.samemind, { command: 'npx', args: ['samemind', 'serve'] });
      const backups = readdirSync(home).filter(f => f.startsWith('.claude.json.bak-'));
      assert.equal(backups.length, 1, 'the pre-existing real-looking config must have been backed up before merge');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--yes is idempotent — second run leaves CLAUDE.md/claude.json/config.json content byte-for-byte the same (backups aside)', () => {
    const home = tmp('global-yes-idem-home');
    try {
      runGlobal(['--yes'], { home });
      const afterFirst = stripBackups(snapshotTree(home));

      runGlobal(['--yes'], { home });
      const afterSecond = stripBackups(snapshotTree(home));

      assert.deepEqual(afterSecond, afterFirst, 'content of every non-backup file must be unchanged by the second run');

      // the fallback merge is expected to add exactly one more backup on the second run — proof
      // the safety mechanism actually ran again rather than silently no-op'ing.
      const backups = readdirSync(home).filter(f => f.startsWith('.claude.json.bak-'));
      assert.equal(backups.length, 1, 'first run creates no backup (file did not exist yet), second run creates exactly one');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

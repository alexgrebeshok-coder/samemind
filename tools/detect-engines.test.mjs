// detect-engines.test.mjs — unit tests for tools/lib/detect-engines.mjs (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectEngines } from './lib/detect-engines.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `samemind-${prefix}-`));
}

describe('detectEngines', () => {
  it('empty directory → []', () => {
    const dir = tmp('detect-empty');
    try {
      assert.deepEqual(detectEngines(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLAUDE.md → claude-code only', () => {
    const dir = tmp('detect-claude');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      assert.deepEqual(detectEngines(dir), ['claude-code']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AGENTS.md → every engine that shares it (cursor/copilot/codex/opencode/windsurf/antigravity)', () => {
    const dir = tmp('detect-agents');
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# rules\n', 'utf8');
      const found = detectEngines(dir);
      for (const id of ['cursor', 'copilot', 'codex', 'opencode', 'windsurf', 'antigravity']) {
        assert.ok(found.includes(id), `expected ${id} in ${JSON.stringify(found)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a directory-shaped rule folder (.roo/) is detected without the samemind.md file existing yet', () => {
    const dir = tmp('detect-roo-dir');
    try {
      mkdirSync(join(dir, '.roo'), { recursive: true });
      writeFileSync(join(dir, '.roo', 'some-other-file.md'), 'x', 'utf8');
      assert.deepEqual(detectEngines(dir), ['roo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.github/copilot-instructions.md is checked at its exact path (not the whole .github/ dir)', () => {
    const dir = tmp('detect-github-dir-only');
    try {
      // .github/ dir present for unrelated reasons (workflows) — must NOT flag copilot.
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'x', 'utf8');
      assert.deepEqual(detectEngines(dir), []);

      writeFileSync(join(dir, '.github', 'copilot-instructions.md'), 'x', 'utf8');
      assert.deepEqual(detectEngines(dir), ['copilot']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed real-world tree (2-3 files) → correct combined, deduped, sorted list', () => {
    const dir = tmp('detect-mixed');
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# notes\n', 'utf8');
      writeFileSync(join(dir, '.clinerules'), 'x', 'utf8');
      writeFileSync(join(dir, '.goosehints'), 'x', 'utf8');
      const found = detectEngines(dir);
      assert.deepEqual(found, [...found].sort()); // sorted
      for (const id of ['claude-code', 'cline', 'goose']) assert.ok(found.includes(id));
      assert.equal(found.length, new Set(found).size); // deduped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

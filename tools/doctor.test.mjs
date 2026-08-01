/**
 * doctor tests — fixture homes only, never the real ~/.
 *
 * The regressions that matter are the silent ones: a server that answers `tools/list` with all
 * ten tools while serving the package directory and holding zero facts. Reproduced live before
 * these tests existed; `serving-package-dir` and `empty-corpus` are the guards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkCorpus, checkSupported, runDoctor, planRepair, applyRepair, FINDINGS } from './doctor.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `doc-${p}-`));
const bundle = (dir) => {
  mkdirSync(join(dir, 'concepts'), { recursive: true });
  writeFileSync(join(dir, 'index.md'), '# bundle\n', 'utf8');
  return dir;
};
const findings = () => [];

describe('doctor — checkCorpus', () => {
  it('FAILs when the server serves the samemind package dir (the okf.mjs fallback)', () => {
    const pkg = tmp('pkgdir');
    try {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'samemind' }), 'utf8');
      const f = findings();
      const r = checkCorpus({ root: pkg, concepts: 0 }, { expectedRoot: null, engine: 'x', findings: f });
      assert.equal(r.ok, false);
      assert.ok(f.some((x) => x.id === 'serving-package-dir'), 'must name the package dir explicitly');
    } finally { rmSync(pkg, { recursive: true, force: true }); }
  });

  it('does NOT false-alarm when the config path is a symlink to the real bundle', () => {
    const real = bundle(tmp('real'));
    const home = tmp('linkhome');
    try {
      const link = join(home, 'bundle-link');
      symlinkSync(real, link);
      const f = findings();
      const r = checkCorpus({ root: real, concepts: 5 }, { expectedRoot: link, localConcepts: 5, engine: 'x', findings: f });
      assert.equal(r.ok, true, 'realpath must be applied to BOTH sides');
      assert.deepEqual(f, []);
    } finally { rmSync(real, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('FAILs on an empty corpus — tools/list answers happily from an empty dir', () => {
    const b = bundle(tmp('empty'));
    try {
      const f = findings();
      const r = checkCorpus({ root: b, concepts: 0 }, { expectedRoot: b, engine: 'x', findings: f });
      assert.equal(r.ok, false);
      assert.ok(f.some((x) => x.id === 'empty-corpus'));
    } finally { rmSync(b, { recursive: true, force: true }); }
  });

  it('count mismatch: FAIL at equal versions, WARN when versions differ', () => {
    const b = bundle(tmp('count'));
    try {
      const same = findings();
      checkCorpus({ root: b, concepts: 7 }, { expectedRoot: b, localConcepts: 9, serverVersion: '1.0.0', ourVersion: '1.0.0', engine: 'x', findings: same });
      assert.equal(FINDINGS[same[0].id].severity, 'fail');

      const diff = findings();
      checkCorpus({ root: b, concepts: 7 }, { expectedRoot: b, localConcepts: 9, serverVersion: '0.9.0', ourVersion: '1.0.0', engine: 'x', findings: diff });
      assert.equal(FINDINGS[diff[0].id].severity, 'warn', 'a different version may walk differently — diagnosis, not alarm');
    } finally { rmSync(b, { recursive: true, force: true }); }
  });
});

describe('doctor — connection predicates', () => {
  it('FAILs a config with no OKF_ROOT, and never spawns a server with a dead script path', async () => {
    const home = tmp('deadhome'); const proj = tmp('deadproj');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({
        mcpServers: { samemind: { command: '/definitely/not/here/node', args: ['/gone/server.mjs'] } },
      }), 'utf8');
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, timeoutMs: 1000 });
      const ids = r.findings.map((f) => f.id);
      assert.ok(ids.includes('no-okf-root'));
      assert.ok(ids.includes('missing-script'), 'a dead args[0] must be diagnosed from disk, not by burning a spawn timeout');
      assert.equal(r.ok, false);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('never leaks env values into human or JSON output, but keeps keys visible', async () => {
    const home = tmp('sechome'); const proj = tmp('secproj');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({
        mcpServers: { samemind: { command: 'node', args: ['x.mjs'], env: { SECRET_TOKEN: 'hunter2', OKF_EMBED_URL: 'http://u:p@h:8000/v1?key=abcxyz' } } },
      }), 'utf8');
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
      const j = JSON.stringify(r);
      assert.ok(!j.includes('hunter2'), 'secret value must not reach the report');
      assert.ok(!j.includes('abcxyz'), 'a token hidden in a URL query must not reach the report');
      assert.ok(j.includes('SECRET_TOKEN'), 'the key set is diagnostic and stays visible');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('an engine doctor cannot machine-read is unknown, never failed', () => {
    const s = checkSupported('goose');
    assert.equal(s.ok, true);
    assert.equal(s.readable, false, "doctor's blind spot is not the user's misconfiguration");
  });
});

describe('doctor — repair', () => {
  // async: `try { return fn() } finally { rm }` would delete the fixture the moment the
  // promise is created, long before the test touches it.
  const withFixture = async (fn) => {
    const home = tmp('rephome'); const proj = tmp('repproj'); const b = bundle(tmp('repbundle'));
    mkdirSync(join(home, '.cursor'), { recursive: true });
    const file = join(home, '.cursor', 'mcp.json');
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        exa: { command: 'npx', args: ['exa-mcp'], env: { EXA_API_KEY: 'foreign-secret' } },
        samemind: { command: 'node', args: ['s.mjs'] },
      },
    }, null, 2), 'utf8');
    try { return await fn({ home, proj, b, file }); }
    finally { [home, proj, b].forEach((d) => rmSync(d, { recursive: true, force: true })); }
  };

  it('sets OKF_ROOT, is idempotent, and preserves foreign servers byte-for-byte', async () => withFixture(async ({ home, proj, b, file }) => {
    const before = JSON.parse(readFileSync(file, 'utf8'));
    const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
    const { plans, ambiguous } = planRepair(r, { root: b });
    assert.equal(ambiguous, false);
    assert.equal(plans.length, 1);

    assert.equal(applyRepair(plans[0]).changed, true);
    assert.equal(applyRepair(plans[0]).changed, false, 'second apply must be a no-op');

    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.mcpServers.samemind.env.OKF_ROOT, b);
    assert.deepEqual(after.mcpServers.exa, before.mcpServers.exa, 'a foreign MCP server must survive untouched');
  }));

  it('refuses to guess when two candidate bundles exist', async () => withFixture(async ({ home, proj, b }) => {
    const other = bundle(tmp('other'));
    try {
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
      // two unrelated bundles, no --root: planRepair must decline rather than pick one
      r.engines[0].states.connected.locations.push({ found: true, env: { OKF_ROOT: b } });
      r.root = { path: other };
      const { plans, ambiguous } = planRepair(r, {});
      assert.equal(ambiguous, true);
      assert.equal(plans.length, 0, 'never guess which memory the user meant');
    } finally { rmSync(other, { recursive: true, force: true }); }
  }));

  it('leaves a corrupt config byte-for-byte untouched', async () => {
    const home = tmp('badhome'); const proj = tmp('badproj');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      const file = join(home, '.cursor', 'mcp.json');
      writeFileSync(file, '{ this is not json', 'utf8');
      const before = readFileSync(file, 'utf8'); const mtime = statSync(file).mtimeMs;
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
      assert.ok(r.findings.some((f) => f.id === 'corrupt-config'));
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(statSync(file).mtimeMs, mtime);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });
});

describe('doctor — contract', () => {
  it('reports all five states per engine', async () => {
    const home = tmp('cthome'); const proj = tmp('ctproj');
    try {
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
      const s = r.engines[0].states;
      for (const k of ['supported', 'installed', 'connected', 'verified', 'active']) {
        assert.ok(k in s, `missing state: ${k}`);
      }
      assert.ok('summary' in r && 'consistency' in r && 'findings' in r);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });

  it('every emitted finding id has a FINDINGS row (human text and JSON cannot drift)', async () => {
    const home = tmp('fdhome'); const proj = tmp('fdproj');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({
        mcpServers: { samemind: { command: 'node', args: ['/nope/x.mjs'] } },
      }), 'utf8');
      const r = await runDoctor({ engines: ['cursor'], home, target: proj, probe: false });
      assert.ok(r.findings.length > 0);
      for (const f of r.findings) {
        assert.ok(FINDINGS[f.id], `finding "${f.id}" has no FINDINGS row`);
        assert.ok(f.title && f.fix, 'every finding must state what failed and the exact next action');
      }
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
  });
});

#!/usr/bin/env node
// service.test.mjs — samemind service (node --test). No network, no sudo, no real scheduler.
// Real activation on the host OS (launchctl/systemctl/schtasks) is DIRECTOR acceptance, not here:
// tests render templates, assert the per-platform plan, and drive install/uninstall through the
// SAMEMIND_SERVICE_HOME sandbox so the real ~/Library/LaunchAgents etc. are never touched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderTemplate, iso8601Duration, resolveConfig, unitDir, buildPlan, nohupFallback, main,
} from './service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'samemind.mjs');

const CFG = {
  node: '/usr/bin/node', cli: '/pkg/bin/samemind.mjs', root: '/home/u/bundle',
  interval: 1800, label: 'com.samemind.project',
  log: '/home/u/bundle/.samemind/logs/service.log', errlog: '/home/u/bundle/.samemind/logs/service.err',
  logDir: '/home/u/bundle/.samemind/logs',
};
const NO_PLACEHOLDER = /\$\{[A-Z_]+\}/;

describe('renderTemplate', () => {
  const vars = { NODE: CFG.node, CLI: CFG.cli, LABEL: CFG.label, ROOT: CFG.root, LOG: CFG.log, ERRLOG: CFG.errlog, INTERVAL: '1800' };

  it('launchd.plist: all placeholders substituted, structure intact', () => {
    const out = renderTemplate('launchd.plist', vars);
    assert.doesNotMatch(out, NO_PLACEHOLDER, 'no unresolved ${...}');
    assert.match(out, /<key>Label<\/key>\s*<string>com\.samemind\.project<\/string>/);
    assert.match(out, /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/);
    assert.match(out, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(out, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    // ProgramArguments carries the periodic `project` invocation, not a daemon.
    for (const frag of ['<string>/usr/bin/node</string>', '<string>/pkg/bin/samemind.mjs</string>',
      '<string>project</string>', '<string>--root</string>', '<string>/home/u/bundle</string>']) {
      assert.ok(out.includes(frag), `plist must contain ${frag}`);
    }
  });

  it('systemd.service: oneshot + timer split, default.target', () => {
    const out = renderTemplate('systemd.service', vars);
    assert.doesNotMatch(out, NO_PLACEHOLDER);
    assert.match(out, /Type=oneshot/);
    assert.match(out, /ExecStart=\/usr\/bin\/node \/pkg\/bin\/samemind\.mjs project --root \/home\/u\/bundle/);
    assert.match(out, /OnUnitActiveSec=1800/);
    assert.match(out, /WantedBy=default\.target/);
  });

  it('win-task.xml: logon trigger + repetition, per-user (no admin)', () => {
    const out = renderTemplate('win-task.xml', { ...vars, INTERVAL: 'PT30M' });
    assert.doesNotMatch(out, NO_PLACEHOLDER);
    assert.match(out, /<LogonTrigger>/);
    assert.match(out, /<Interval>PT30M<\/Interval>/);
    assert.match(out, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(out, /<RunLevel>LeastPrivilege<\/RunLevel>/); // per-user, not elevated
    assert.match(out, /<Command>\/usr\/bin\/node<\/Command>/);
    assert.match(out, /project --root/);
  });

  it('throws loudly on a missing var (leftover placeholder)', () => {
    assert.throws(() => renderTemplate('launchd.plist', { NODE: 'x' }), /unresolved placeholder/);
  });
});

describe('iso8601Duration', () => {
  it('seconds → ISO-8601 (Task Scheduler needs a duration, not raw seconds)', () => {
    assert.equal(iso8601Duration(1800), 'PT30M');
    assert.equal(iso8601Duration(3600), 'PT1H');
    assert.equal(iso8601Duration(90), 'PT90S');
    assert.equal(iso8601Duration(300), 'PT5M');
  });
});

describe('resolveConfig', () => {
  it('interval default 1800, --interval override, floored & positive', () => {
    assert.equal(resolveConfig({}, 'linux', {}).interval, 1800);
    assert.equal(resolveConfig({ interval: 60 }, 'linux', {}).interval, 60);
    assert.equal(resolveConfig({ interval: 0 }, 'linux', {}).interval, 1800); // non-positive → default
    assert.equal(resolveConfig({ interval: 45.9 }, 'linux', {}).interval, 45);
  });
  it('label default is reverse-DNS on mac, plain elsewhere; root from OKF_ROOT', () => {
    assert.equal(resolveConfig({}, 'darwin', {}).label, 'com.samemind.project');
    assert.equal(resolveConfig({}, 'linux', {}).label, 'samemind-project');
    assert.equal(resolveConfig({ label: 'x.y' }, 'darwin', {}).label, 'x.y');
    assert.equal(resolveConfig({}, 'linux', { OKF_ROOT: '/tmp/b' }).root, '/tmp/b');
  });
});

describe('buildPlan — platform detection & shape', () => {
  it('darwin → launchd, one .plist, launchctl bootstrap', () => {
    const p = buildPlan('darwin', CFG, '/units', 501);
    assert.equal(p.kind, 'launchd');
    assert.equal(p.files.length, 1);
    assert.equal(p.files[0].path, '/units/com.samemind.project.plist');
    assert.ok(p.activate.some(s => s.argv.join(' ') === 'launchctl bootstrap gui/501 /units/com.samemind.project.plist'));
  });

  it('linux → systemd, .service + .timer, systemctl --user enable --now', () => {
    const p = buildPlan('linux', { ...CFG, label: 'samemind-project' }, '/units');
    assert.equal(p.kind, 'systemd');
    assert.equal(p.files.length, 2);
    assert.deepEqual(p.files.map(f => f.path), ['/units/samemind-project.service', '/units/samemind-project.timer']);
    assert.match(p.files[0].content, /Type=oneshot/);
    assert.match(p.files[1].content, /\[Timer\]/);
    assert.doesNotMatch(p.files[0].content, /\[Timer\]/, 'service unit must not carry the timer section');
    assert.ok(p.activate.some(s => s.argv.join(' ') === 'systemctl --user enable --now samemind-project.timer'));
  });

  it('win32 → schtasks, one .xml, schtasks /create /xml', () => {
    const p = buildPlan('win32', { ...CFG, label: 'samemind-project' }, 'C:/units');
    assert.equal(p.kind, 'schtasks');
    assert.equal(p.files.length, 1);
    assert.ok(p.files[0].path.endsWith('samemind-project.xml'));
    assert.match(p.files[0].content, /<Interval>PT30M<\/Interval>/);
    assert.ok(p.activate.some(s => s.argv[0] === 'schtasks' && s.argv.includes('/create')));
  });

  it('unsupported platform throws', () => {
    assert.throws(() => buildPlan('sunos', CFG, '/units'), /unsupported platform/);
  });
});

describe('buildPlan — --daemon (long-lived serviced, supervisor-restarted)', () => {
  const DCFG = { ...CFG, daemon: true };

  it('darwin daemon → KeepAlive plist running `serviced`, no StartInterval', () => {
    const p = buildPlan('darwin', DCFG, '/units', 501);
    assert.equal(p.kind, 'launchd');
    assert.equal(p.files.length, 1);
    const c = p.files[0].content;
    assert.match(c, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(c, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    assert.doesNotMatch(c, /StartInterval/, 'daemon plist has no periodic StartInterval');
    assert.ok(c.includes('<string>serviced</string>'), 'runs serviced, not project');
    assert.doesNotMatch(c, /\$\{[A-Z_]+\}/, 'no unresolved placeholders');
  });

  it('linux daemon → single Restart=always .service, NO timer, enable --now .service', () => {
    const p = buildPlan('linux', { ...DCFG, label: 'samemind-project' }, '/units');
    assert.equal(p.kind, 'systemd');
    assert.equal(p.files.length, 1, 'daemon has one unit — no separate timer');
    assert.ok(p.files[0].path.endsWith('samemind-project.service'));
    assert.match(p.files[0].content, /Restart=always/);
    assert.match(p.files[0].content, /serviced --root/);
    assert.doesNotMatch(p.files[0].content, /\[Timer\]/);
    assert.ok(p.activate.some(s => s.argv.join(' ') === 'systemctl --user enable --now samemind-project.service'));
    assert.equal(p.status.argv.join(' '), 'systemctl --user is-active samemind-project.service');
  });

  it('win32 daemon → schtasks task running `serviced` with RestartOnFailure', () => {
    const p = buildPlan('win32', { ...DCFG, label: 'samemind-project' }, 'C:/units');
    assert.equal(p.kind, 'schtasks');
    assert.equal(p.files.length, 1);
    assert.match(p.files[0].content, /<RestartOnFailure>/);
    assert.match(p.files[0].content, /serviced --root/);
    assert.doesNotMatch(p.files[0].content, /\$\{[A-Z_]+\}/);
  });
});

describe('plist validity (darwin only — plutil -lint)', { skip: process.platform !== 'darwin' }, () => {
  it('rendered plist passes plutil -lint', () => {
    const p = buildPlan('darwin', CFG, '/units', 0);
    const dir = mkdtempSync(join(tmpdir(), 'sm-plist-'));
    const f = join(dir, 'x.plist');
    writeFileSync(f, p.files[0].content);
    const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('nohupFallback (linux headless path)', () => {
  it('names the manual loop with node/cli/root/interval and the systemctl enable command', () => {
    const s = nohupFallback({ ...CFG, label: 'samemind-project' });
    assert.match(s, /nohup/);
    assert.match(s, /project --root/);
    assert.match(s, /sleep 1800/);
    assert.match(s, /systemctl --user enable --now samemind-project\.timer/);
  });
});

describe('install / uninstall roundtrip (SAMEMIND_SERVICE_HOME sandbox — never touches real unit dirs)', () => {
  function sandbox(fn) {
    const units = mkdtempSync(join(tmpdir(), 'sm-svc-units-'));
    const root = mkdtempSync(join(tmpdir(), 'sm-svc-root-'));
    try { return fn({ units, root }); }
    finally { rmSync(units, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  }

  it('install writes unit files to the sandbox dir, skips activation; uninstall removes them; idempotent', () => {
    sandbox(({ units, root }) => {
      const env = { ...process.env, SAMEMIND_SERVICE_HOME: units, OKF_ROOT: root };
      const install = spawnSync(process.execPath, [BIN, 'service', 'install'], { env, encoding: 'utf8' });
      assert.equal(install.status, 0, install.stdout + install.stderr);
      assert.match(install.stdout, /activation skipped/);

      const cfg = resolveConfig({}, process.platform, env);
      const plan = buildPlan(process.platform, cfg, units, 0);
      for (const f of plan.files) assert.ok(existsSync(f.path), `unit written: ${f.path}`);

      const uninstall = spawnSync(process.execPath, [BIN, 'service', 'uninstall'], { env, encoding: 'utf8' });
      assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
      for (const f of plan.files) assert.ok(!existsSync(f.path), `unit removed: ${f.path}`);

      // idempotent: second uninstall is a no-op success, not a crash.
      const again = spawnSync(process.execPath, [BIN, 'service', 'uninstall'], { env, encoding: 'utf8' });
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /not installed/);
    });
  });

  it('status reports installed vs not-installed via file presence (sandbox: load-check skipped)', () => {
    sandbox(({ units, root }) => {
      const env = { ...process.env, SAMEMIND_SERVICE_HOME: units, OKF_ROOT: root };
      const before = spawnSync(process.execPath, [BIN, 'service', 'status'], { env, encoding: 'utf8' });
      assert.equal(before.status, 1, 'not installed → exit 1');
      spawnSync(process.execPath, [BIN, 'service', 'install'], { env, encoding: 'utf8' });
      const after = spawnSync(process.execPath, [BIN, 'service', 'status'], { env, encoding: 'utf8' });
      assert.equal(after.status, 0, after.stdout + after.stderr);
      assert.match(after.stdout, /sandbox/);
      assert.match(after.stdout, /samemind status/); // points at the separate health command
    });
  });

  it('--dry-run prints a unit and the activation plan, writes nothing', () => {
    sandbox(({ units, root }) => {
      const env = { ...process.env, SAMEMIND_SERVICE_HOME: units, OKF_ROOT: root };
      const r = spawnSync(process.execPath, [BIN, 'service', 'install', '--dry-run'], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /would activate/);
      const plan = buildPlan(process.platform, resolveConfig({}, process.platform, env), units, 0);
      for (const f of plan.files) assert.ok(!existsSync(f.path), 'dry-run writes no unit files');
    });
  });
});

describe('main() exit codes', () => {
  it('no subcommand → usage, exit 0', () => { assert.equal(main([]), 0); });
  it('--help → exit 0', () => { assert.equal(main(['--help']), 0); });
  it('unknown flag → caught, exit 1', () => { assert.equal(main(['install', '--nope']), 1); });
});

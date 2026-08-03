/**
 * settings + the one write route.
 *
 * The regressions guarded here are the ones that make a switchboard lie: a capability with no
 * runner rendering as "off" instead of "unavailable", a save that silently drops an unknown key,
 * a write that clobbers a neighbouring section, and a first-ever save that throws because the
 * config directory does not exist yet (found live — the lock dir cannot be created beside a file
 * whose parent is missing, and a fresh bundle is the ordinary case, not an edge one).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { buildSettingsModel, applySettingsPatch, validatePatch, resolveLayers, assessAvailability } from './lib/settings.mjs';
import { createUiServer } from './lib/ui-server.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `set-${p}-`));
const bundle = (dir) => {
  mkdirSync(join(dir, 'concepts'), { recursive: true });
  writeFileSync(join(dir, 'index.md'), '# bundle\n', 'utf8');
  return dir;
};
const cfg = (dir, obj) => {
  mkdirSync(join(dir, '.samemind'), { recursive: true });
  writeFileSync(join(dir, '.samemind', 'config.json'), JSON.stringify(obj, null, 2), 'utf8');
};
const readCfg = (dir) => JSON.parse(readFileSync(join(dir, '.samemind', 'config.json'), 'utf8'));

describe('settings — model', () => {
  it('a capability with no runner is unavailable, not off — even when the user enabled it', () => {
    const root = bundle(tmp('avail'));
    try {
      cfg(root, { voice: { enabled: true } });
      const m = buildSettingsModel(root, { globalHome: null });
      assert.equal(m.features.voice.values.enabled, true, 'the user did turn it on');
      assert.equal(m.features.voice.available, false, 'but nothing can run it');
      assert.match(m.features.voice.reason, /not installed/);
      assert.ok(m.features.voice.fix, 'unavailable must come with what to do about it');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports the layer each value came from', () => {
    const root = bundle(tmp('layer')); const home = tmp('layerhome');
    try {
      cfg(home, { voice: { enabled: true, confidenceThreshold: 0.9 } });
      cfg(root, { voice: { confidenceThreshold: 0.5 } });
      const l = resolveLayers(root, home);
      assert.equal(l.voice.confidenceThreshold, 'project', 'project wins where it sets a key');
      assert.equal(l.voice.enabled, 'global', 'global shows through where project is silent');
      assert.equal(l.voice.trigger, 'default', 'untouched keys report default');
    } finally { [root, home].forEach(d => rmSync(d, { recursive: true, force: true })); }
  });

  it('reading never creates or modifies the config file', () => {
    const root = bundle(tmp('noWrite'));
    try {
      buildSettingsModel(root, { globalHome: null });
      assert.equal(existsSync(join(root, '.samemind', 'config.json')), false);
      cfg(root, { embedUrl: 'http://x' });
      const before = readFileSync(join(root, '.samemind', 'config.json'), 'utf8');
      buildSettingsModel(root, { globalHome: null });
      assert.equal(readFileSync(join(root, '.samemind', 'config.json'), 'utf8'), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('settings — voice availability has three honest states', () => {
  it('no serviceUrl → unavailable (available:false, with reason+fix)', () => {
    const { voice } = assessAvailability({ voice: { serviceUrl: null } });
    assert.equal(voice.state, 'unavailable');
    assert.equal(voice.available, false);
    assert.ok(voice.reason && voice.fix);
  });

  it('serviceUrl set, no probe → configured (NOT available — a config entry is not a connection)', () => {
    const { voice } = assessAvailability({ voice: { serviceUrl: 'http://127.0.0.1:8000' } });
    assert.equal(voice.state, 'configured');
    assert.equal(voice.available, false, 'configured must not render green');
  });

  it('serviceUrl set + a probe result → reachable (available:true)', () => {
    const probe = { url: 'http://127.0.0.1:8000', engine: 'openai-compatible', model: 'whisper-1' };
    const { voice } = assessAvailability({ voice: { serviceUrl: 'http://127.0.0.1:8000' } }, { voiceProbe: probe });
    assert.equal(voice.state, 'reachable');
    assert.equal(voice.available, true);
  });

  it('buildSettingsModel makes no network calls — pure over disk (regression guard)', () => {
    const root = bundle(tmp('pure'));
    cfg(root, { voice: { serviceUrl: 'http://127.0.0.1:8000' } }); // configured — would tempt a render to probe
    const orig = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network must not happen in a render'); };
    try {
      const m = buildSettingsModel(root, { globalHome: null });
      assert.equal(m.features.voice.state, 'configured', 'a render reports configured, never reaches out');
      assert.equal(m.features.voice.available, false, 'configured is not green');
    } finally {
      globalThis.fetch = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A frozen shape must not make a consumer guess `undefined` vs `null`. Every branch of
  // assessAvailability — unavailable / configured / reachable, plus vision — returns the SAME
  // key set; absence is always `null`, never a missing key. (doctor.active / verified share this
  // rule but live in doctor.mjs — owned by the parallel наряд P, not asserted here.)
  it('every availability branch returns one constant key set — absence is null, never a missing key', () => {
    const AVAIL_KEYS = ['available', 'fix', 'note', 'reason', 'state'];
    const branches = [
      ['voice unavailable', assessAvailability({ voice: { serviceUrl: null } }).voice],
      ['voice configured', assessAvailability({ voice: { serviceUrl: 'http://127.0.0.1:8000' } }).voice],
      ['voice reachable', assessAvailability({ voice: { serviceUrl: 'http://127.0.0.1:8000' } }, { voiceProbe: { model: 'whisper-1' } }).voice],
      ['vision', assessAvailability({ voice: { serviceUrl: null } }).vision],
    ];
    for (const [label, b] of branches) {
      assert.deepEqual(Object.keys(b).sort(), AVAIL_KEYS, `${label}: key set must be exactly ${AVAIL_KEYS.join(',')}`);
    }
    // and the populated/absent values land in the right slots per state
    const unavail = assessAvailability({ voice: { serviceUrl: null } }).voice;
    assert.ok(unavail.reason && unavail.fix, 'unavailable carries reason + fix');
    assert.equal(unavail.note, null, 'unavailable has no note');
    const reachable = assessAvailability({ voice: { serviceUrl: 'http://x' } }, { voiceProbe: { model: 'm' } }).voice;
    assert.ok(reachable.note, 'reachable carries a note');
    assert.equal(reachable.reason, null, 'reachable has no reason');
    assert.equal(reachable.fix, null, 'reachable has no fix');
  });
});

describe('settings — validation', () => {
  it('rejects unknown keys and foreign sections instead of dropping them silently', () => {
    assert.equal(validatePatch({ voice: { hack: 1 } }).ok, false);
    assert.equal(validatePatch({ projection: { budgetTokens: 9 } }).ok, false);
    assert.equal(validatePatch({ voice: { trigger: 'telepathy' } }).ok, false);
    assert.equal(validatePatch({ voice: { enabled: 'yes' } }).ok, false);
  });

  it('bounds the numbers a person can actually get wrong', () => {
    assert.equal(validatePatch({ voice: { confidenceThreshold: 5 } }).ok, false);
    assert.equal(validatePatch({ voice: { confidenceThreshold: 0.7 } }).ok, true);
    assert.equal(validatePatch({ voice: { transcriptRetentionDays: -1 } }).ok, false);
  });

  it('reports every problem at once, not just the first', () => {
    const v = validatePatch({ voice: { hack: 1, enabled: 'yes' } });
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 2, `expected several errors, got ${JSON.stringify(v.errors)}`);
  });
});

describe('settings — writing', () => {
  it('first save on a bundle that was never configured succeeds', () => {
    const root = bundle(tmp('fresh'));   // deliberately no .samemind/
    try {
      const r = applySettingsPatch(root, { voice: { enabled: true } }, { globalHome: null });
      assert.equal(r.ok, true, `first save must not throw: ${JSON.stringify(r.errors || '')}`);
      assert.equal(readCfg(root).voice.enabled, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves foreign sections written by other tools', () => {
    const root = bundle(tmp('foreign'));
    try {
      cfg(root, { embedUrl: 'http://keep', embedModel: 'bge-m3', schema_version: 1, projection: { budgetTokens: 1500 } });
      applySettingsPatch(root, { voice: { enabled: true } }, { globalHome: null });
      const after = readCfg(root);
      assert.equal(after.embedUrl, 'http://keep');
      assert.equal(after.embedModel, 'bge-m3');
      assert.equal(after.schema_version, 1);
      assert.deepEqual(after.projection, { budgetTokens: 1500 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is idempotent — a second identical save reports no change', () => {
    const root = bundle(tmp('idem'));
    try {
      assert.equal(applySettingsPatch(root, { voice: { enabled: true } }, { globalHome: null }).changed, true);
      assert.equal(applySettingsPatch(root, { voice: { enabled: true } }, { globalHome: null }).changed, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a corrupt config rather than overwriting the user\'s data', () => {
    const root = bundle(tmp('corrupt'));
    try {
      mkdirSync(join(root, '.samemind'), { recursive: true });
      const file = join(root, '.samemind', 'config.json');
      writeFileSync(file, '{ this is not json', 'utf8');
      const before = readFileSync(file, 'utf8');
      const mtime = statSync(file).mtimeMs;
      const r = applySettingsPatch(root, { voice: { enabled: true } }, { globalHome: null });
      assert.equal(r.ok, false);
      assert.equal(r.status, 409);
      assert.equal(readFileSync(file, 'utf8'), before, 'a typo is still the user\'s data');
      assert.equal(statSync(file).mtimeMs, mtime);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------- the route

function rawPost(port, { host, origin, contentType = 'application/json', body = '{}', path = '/api/config' }) {
  return new Promise((resolve) => {
    const lines = [`POST ${path} HTTP/1.1`];
    if (host !== null) lines.push(`Host: ${host}`);
    if (origin !== null) lines.push(`Origin: ${origin}`);
    lines.push(`Content-Type: ${contentType}`, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body);
    const c = net.connect(port, '127.0.0.1', () => c.write(lines.join('\r\n')));
    let data = '';
    c.on('data', (d) => { data += d; });
    c.on('close', () => resolve(Number(data.split('\r\n')[0].split(' ')[1])));
  });
}

async function withServer(fn) {
  const root = bundle(tmp('srv'));
  const server = createUiServer({ root, distDir: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { return await fn({ port, root }); }
  finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

describe('POST /api/config — the only write', () => {
  // Raw sockets, not fetch(): undici refuses to set the Host header, so a fetch-based
  // "spoofed Host" test silently sends the real one and passes for the wrong reason.
  it('rejects a spoofed loopback-prefixed Host', async () => withServer(async ({ port }) => {
    const h = `127.0.0.1.evil.com:${port}`;
    assert.equal(await rawPost(port, { host: h, origin: `http://${h}` }), 403);
  }));

  it('rejects a missing Host', async () => withServer(async ({ port }) =>
    assert.equal(await rawPost(port, { host: null, origin: `http://127.0.0.1:${port}` }), 400)));

  it('rejects a foreign Origin and a different loopback port', async () => withServer(async ({ port }) => {
    assert.equal(await rawPost(port, { host: `127.0.0.1:${port}`, origin: 'http://evil.com' }), 403);
    assert.equal(await rawPost(port, { host: `127.0.0.1:${port}`, origin: 'http://localhost:3000' }), 403);
  }));

  it('rejects a non-JSON content type (a CORS-safelisted simple request)', async () => withServer(async ({ port }) =>
    assert.equal(await rawPost(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, contentType: 'text/plain' }), 415)));

  it('leaves every read route method-locked', async () => withServer(async ({ port }) => {
    for (const path of ['/api/board', '/api/settings', '/api/status', '/api/doctor', '/api/voice/probe']) {
      assert.equal(
        await rawPost(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, path }),
        405, `${path} must stay read-only`,
      );
    }
  }));

  it('accepts an honest write and echoes state re-read from disk', async () => withServer(async ({ port, root }) => {
    const status = await rawPost(port, {
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`,
      body: JSON.stringify({ voice: { enabled: true, confidenceThreshold: 0.7 } }),
    });
    assert.equal(status, 200);
    assert.equal(readCfg(root).voice.confidenceThreshold, 0.7, 'the write reached disk');
  }));
});

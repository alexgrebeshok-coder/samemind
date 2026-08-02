// probe-voice.test.mjs — unit tests for tools/lib/probe-voice.mjs (node --test, mocked fetch).
// No real network: the companion is stood in for by a fetchImpl stub, per the same guardrail as
// probe-embed (GET-only /v1/models, never admin/auth, never POST audio, never load a model).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { probeVoiceCompanion } from './lib/probe-voice.mjs';

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

describe('probeVoiceCompanion', () => {
  it('no url → null, and never calls fetch', async () => {
    const fetchImpl = async () => { throw new Error('must not be called'); };
    assert.equal(await probeVoiceCompanion({ url: null, fetchImpl }), null);
    assert.equal(await probeVoiceCompanion({ url: '', fetchImpl }), null);
  });

  it('live OpenAI-compatible /v1/models → {url, engine, model}', async () => {
    const fetchImpl = async (u) => {
      assert.equal(u, 'http://127.0.0.1:8000/v1/models');
      return jsonResponse({ data: [{ id: 'whisper-1' }] });
    };
    const res = await probeVoiceCompanion({ url: 'http://127.0.0.1:8000', fetchImpl });
    assert.deepEqual(res, { url: 'http://127.0.0.1:8000', engine: 'openai-compatible', model: 'whisper-1' });
  });

  it('strips a trailing slash before appending /v1/models', async () => {
    const seen = [];
    const fetchImpl = async (u) => { seen.push(u); return jsonResponse({ data: [{ id: 'm' }] }); };
    await probeVoiceCompanion({ url: 'http://x:8000/', fetchImpl });
    assert.equal(seen[0], 'http://x:8000/v1/models');
  });

  it('live but empty model list → reachable with model null', async () => {
    const fetchImpl = async () => jsonResponse({ data: [] });
    assert.deepEqual(
      await probeVoiceCompanion({ url: 'http://x', fetchImpl }),
      { url: 'http://x', engine: 'openai-compatible', model: null },
    );
  });

  it('dead port (fetch throws) → null, never throws', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await probeVoiceCompanion({ url: 'http://127.0.0.1:9', fetchImpl }), null);
  });

  it('timeout (fetch hangs past timeoutMs) → null', async () => {
    const fetchImpl = (_u, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    assert.equal(await probeVoiceCompanion({ url: 'http://x', fetchImpl, timeoutMs: 50 }), null);
  });

  it('non-ok HTTP 500 → null', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => { throw new Error('no read'); } });
    assert.equal(await probeVoiceCompanion({ url: 'http://x', fetchImpl }), null);
  });

  it('invalid JSON body → null', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
    assert.equal(await probeVoiceCompanion({ url: 'http://x', fetchImpl }), null);
  });

  it('a body without a /v1/models `data` array → null (not OpenAI-compatible)', async () => {
    const fetchImpl = async () => jsonResponse({ models: [{ name: 'x' }] });
    assert.equal(await probeVoiceCompanion({ url: 'http://x', fetchImpl }), null);
  });

  it('only ever issues GET (never POST/audio upload)', async () => {
    const methods = [];
    const fetchImpl = async (_u, opts) => { methods.push(opts.method); return { ok: false, json: async () => ({}) }; };
    await probeVoiceCompanion({ url: 'http://x', fetchImpl });
    assert.ok(methods.length > 0);
    for (const m of methods) assert.equal(m, 'GET');
  });
});

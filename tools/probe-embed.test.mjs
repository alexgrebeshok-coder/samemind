// probe-embed.test.mjs — unit tests for tools/lib/probe-embed.mjs (node --test, mocked fetch).
// No real network calls — omlx/Ollama are stood in for by a fetchImpl stub, per naryad guardrail
// (never poke the real omlx server: GET-only /v1/models, never admin/auth, never load a model).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { probeEmbedEndpoint } from './lib/probe-embed.mjs';

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

describe('probeEmbedEndpoint', () => {
  it('omlx alive with an embedding model in /v1/models → {url, model, provider}', async () => {
    const fetchImpl = async (url) => {
      assert.equal(url, 'http://127.0.0.1:8000/v1/models');
      return jsonResponse({ data: [{ id: 'llama-3' }, { id: 'bge-m3' }] });
    };
    const res = await probeEmbedEndpoint({ fetchImpl });
    assert.deepEqual(res, { url: 'http://127.0.0.1:8000/v1/embeddings', model: 'bge-m3', provider: 'omlx' });
  });

  it('both dead/timeout → null, never throws', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const res = await probeEmbedEndpoint({ fetchImpl });
    assert.equal(res, null);
  });

  it('omlx alive but no embedding-shaped model, ollama alive but no embedding-shaped model → null', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('8000')) return jsonResponse({ data: [{ id: 'llama-3' }] });
      if (url.includes('11434')) return jsonResponse({ models: [{ name: 'llama3:latest' }] });
      throw new Error('unexpected url ' + url);
    };
    const res = await probeEmbedEndpoint({ fetchImpl });
    assert.equal(res, null);
  });

  it('omlx dead, ollama alive with an embedding model in /api/tags → falls back to ollama', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('8000')) throw new Error('ECONNREFUSED');
      assert.equal(url, 'http://127.0.0.1:11434/api/tags');
      return jsonResponse({ models: [{ name: 'nomic-embed-text:latest' }] });
    };
    const res = await probeEmbedEndpoint({ fetchImpl });
    assert.deepEqual(res, { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'nomic-embed-text:latest', provider: 'ollama' });
  });

  it('non-ok HTTP response is treated as not-alive, not thrown', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => { throw new Error('should not be read'); } });
    const res = await probeEmbedEndpoint({ fetchImpl });
    assert.equal(res, null);
  });

  it('only ever issues GET requests (never POST/admin/model-load)', async () => {
    const methods = [];
    const fetchImpl = async (url, opts) => {
      methods.push(opts.method);
      return { ok: false, json: async () => ({}) };
    };
    await probeEmbedEndpoint({ fetchImpl });
    assert.ok(methods.length > 0);
    for (const m of methods) assert.equal(m, 'GET');
  });
});

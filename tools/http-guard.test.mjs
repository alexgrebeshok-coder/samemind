#!/usr/bin/env node
// http-guard.test.mjs — write-route header guard (tools/lib/http-guard.mjs).
//   node --test tools/*.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHostHeader, checkWriteRequest } from './lib/http-guard.mjs';

const PORT = 7787;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

function writeHeaders(overrides = {}) {
  return {
    host: HOST,
    origin: ORIGIN,
    'content-type': 'application/json',
    ...overrides,
  };
}

function check(method, headers, boundPort = PORT) {
  return checkWriteRequest({ method, headers, boundPort });
}

describe('isLoopbackHostHeader — anchor loopback, not prefix', () => {
  it('127.0.0.1 and with port', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.1'), true);
    assert.equal(isLoopbackHostHeader(`127.0.0.1:${PORT}`), true);
  });
  it('localhost and [::1]', () => {
    assert.equal(isLoopbackHostHeader('localhost'), true);
    assert.equal(isLoopbackHostHeader(`localhost:${PORT}`), true);
    assert.equal(isLoopbackHostHeader('[::1]'), true);
    assert.equal(isLoopbackHostHeader(`[::1]:${PORT}`), true);
  });
  it('attack: 127.0.0.1.evil.com (prefix, not loopback)', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.1.evil.com'), false);
  });
  it('attack: 127.evil.com', () => {
    assert.equal(isLoopbackHostHeader('127.evil.com'), false);
  });
  it('attack: 127.0.0.1.nip.io wildcard DNS', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.1.nip.io'), false);
  });
  it('attack: [::1]@evil.com', () => {
    assert.equal(isLoopbackHostHeader('[::1]@evil.com'), false);
  });
  it('attack: 127.0.0.1%2eevil.com', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.1%2eevil.com'), false);
  });
  it('attack: 127.0.0.1:evil.com (non-numeric port)', () => {
    assert.equal(isLoopbackHostHeader('127.0.0.1:evil.com'), false);
  });
});

describe('checkWriteRequest — GET not guarded', () => {
  it('GET without Host passes', () => {
    const r = check('GET', {});
    assert.equal(r.ok, true);
  });
});

describe('checkWriteRequest — missing Host on write', () => {
  it('POST with no Host → 400', () => {
    const r = check('POST', writeHeaders({ host: undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });
  it('POST with empty Host → 400', () => {
    const r = check('POST', writeHeaders({ host: '' }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });
});

describe('checkWriteRequest — full authority must match bound port', () => {
  it('attack: localhost:3000 while bound 7787 → 403', () => {
    const r = check('POST', writeHeaders({
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
  it('attack: 127.0.0.1.evil.com as Host → 403', () => {
    const r = check('POST', writeHeaders({
      host: '127.0.0.1.evil.com',
      origin: 'http://127.0.0.1.evil.com',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('checkWriteRequest — Origin required and must match Host authority', () => {
  it('POST without Origin → 403', () => {
    const r = check('POST', writeHeaders({ origin: undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
  it('POST with cross-origin Origin → 403', () => {
    const r = check('POST', writeHeaders({ origin: 'http://localhost:3000' }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('checkWriteRequest — Content-Type must be application/json', () => {
  it('text/plain simple request → 415', () => {
    const r = check('POST', writeHeaders({ 'content-type': 'text/plain' }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 415);
  });
  it('missing Content-Type → 415', () => {
    const r = check('POST', writeHeaders({ 'content-type': undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 415);
  });
  it('application/json; charset=utf-8 passes', () => {
    const r = check('POST', writeHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    assert.equal(r.ok, true);
  });
});

describe('checkWriteRequest — Sec-Fetch-Site cross-site', () => {
  it('cross-site → 403', () => {
    const r = check('POST', writeHeaders({ 'sec-fetch-site': 'cross-site' }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('checkWriteRequest — normalization attacks on write', () => {
  it('127.0.0.1%2eevil.com Host → 403', () => {
    const r = check('POST', writeHeaders({
      host: '127.0.0.1%2eevil.com',
      origin: 'http://127.0.0.1%2eevil.com',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
  it('127.0.0.1:evil.com Host → 403', () => {
    const r = check('POST', writeHeaders({
      host: '127.0.0.1:evil.com',
      origin: 'http://127.0.0.1:evil.com',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
  it('[::1]@evil.com Host → 403', () => {
    const r = check('POST', writeHeaders({
      host: '[::1]@evil.com',
      origin: 'http://[::1]@evil.com',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('checkWriteRequest — happy path', () => {
  it('POST 127.0.0.1:7787 with matching Origin and JSON passes', () => {
    const r = check('POST', writeHeaders());
    assert.equal(r.ok, true);
  });
});

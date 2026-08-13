#!/usr/bin/env node
// ui-server-projection.test.mjs — regression guard for Н5: HTTP board/handoff must ship the
// same thin wire projection as `board --json` / `handoff --json` (tools/board.mjs
// projectBoardJson, tools/handoff.mjs projectHandoffJson), not the raw model.
//
// Before the fix, apiBoard/apiHandoff in tools/lib/ui-server.mjs called wrap('board', model) /
// wrap('handoff', model) on the UNPROJECTED model — shipping every document's full markdown
// `body` and the owner's absolute `file` path over HTTP, while the CLI (which does apply
// thinDoc/projectBoardJson) never did. This test spawns the real CLI (`node tools/board.mjs
// --json`, `node tools/handoff.mjs --json`) against the demo bundle, boots the HTTP server
// against the same bundle, and asserts both produce the same document-card key set — and that
// neither `body` nor `file` nor the bundle's absolute root path ever reach the wire.
//   node --test tools/ui-server-projection.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUiServer } from './lib/ui-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, '..', 'demo');

function listen(opts) {
  return new Promise((resolvePromise, reject) => {
    const server = createUiServer(opts);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function request(port, path) {
  return new Promise((resolvePromise, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

/** Runs the actual CLI script (not an in-process function call) against the demo bundle,
 *  the same way a person would: `OKF_ROOT=<demo> node tools/<script>.mjs --json`. */
function runCliJson(script) {
  const out = execFileSync(process.execPath, [join(HERE, script), '--json'], {
    env: { ...process.env, OKF_ROOT: DEMO },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

/** Every doc-carrying array name each model exposes (docs/ui-spec.md / thinDoc call sites). */
const BOARD_ARRAYS = [
  'backlog', 'inprog', 'blocked', 'done', 'plans',
  'ideaIncubating', 'ideaSpark', 'ideaAdopted', 'ideasVisible', 'recent', 'sessions',
];
const HANDOFF_ARRAYS = ['active', 'plansInForce', 'blocked'];

describe('HTTP board/handoff carry the same wire projection as the CLI (Н5)', () => {
  let server, port, cliBoard, cliHandoff;

  before(async () => {
    server = await listen({ root: DEMO, distDir: null });
    port = server.address().port;
    cliBoard = runCliJson('board.mjs');
    cliHandoff = runCliJson('handoff.mjs');
  });
  after(() => server.close());

  it('CLI board --json actually has non-empty document cards to compare (fixture sanity)', () => {
    const nonEmpty = BOARD_ARRAYS.filter((k) => (cliBoard.data[k] || []).length > 0);
    assert.ok(nonEmpty.length > 0, 'demo bundle produced no board cards at all — fixture is not exercising the projection');
  });

  it('GET /api/board — same key set per document card as `board --json`, for every populated column', async () => {
    const r = await request(port, '/api/board');
    assert.equal(r.status, 200);
    const httpBoard = JSON.parse(r.body);
    for (const key of BOARD_ARRAYS) {
      const cliArr = cliBoard.data[key] || [];
      const httpArr = httpBoard.data[key] || [];
      assert.equal(httpArr.length, cliArr.length, `array length mismatch for board.${key}`);
      for (let i = 0; i < cliArr.length; i++) {
        assert.deepEqual(
          Object.keys(httpArr[i]).sort(), Object.keys(cliArr[i]).sort(),
          `board.${key}[${i}] key set differs between HTTP and CLI: ` +
          `http=${JSON.stringify(Object.keys(httpArr[i]))} cli=${JSON.stringify(Object.keys(cliArr[i]))}`,
        );
      }
    }
  });

  it('GET /api/handoff — same key set per document card as `handoff --json`, for every populated section', async () => {
    const r = await request(port, '/api/handoff');
    assert.equal(r.status, 200);
    const httpHandoff = JSON.parse(r.body);
    for (const key of HANDOFF_ARRAYS) {
      const cliArr = cliHandoff.data[key] || [];
      const httpArr = httpHandoff.data[key] || [];
      assert.equal(httpArr.length, cliArr.length, `array length mismatch for handoff.${key}`);
      for (let i = 0; i < cliArr.length; i++) {
        assert.deepEqual(
          Object.keys(httpArr[i]).sort(), Object.keys(cliArr[i]).sort(),
          `handoff.${key}[${i}] key set differs between HTTP and CLI`,
        );
      }
    }
    // lastSession is a single thinned doc (or null), not an array — same check, singular.
    if (cliHandoff.data.lastSession) {
      assert.ok(httpHandoff.data.lastSession, 'HTTP handoff dropped lastSession the CLI has');
      assert.deepEqual(
        Object.keys(httpHandoff.data.lastSession).sort(),
        Object.keys(cliHandoff.data.lastSession).sort(),
      );
    }
  });

  it('GET /api/board never ships a raw document: no "body"/"file" keys, no absolute bundle path', async () => {
    const r = await request(port, '/api/board');
    assert.ok(!/"body":/.test(r.body), 'HTTP board leaked a document body');
    assert.ok(!/"file":/.test(r.body), 'HTTP board leaked an absolute file path key');
    assert.ok(!r.body.includes(DEMO), 'HTTP board leaked the bundle\'s absolute host path');
  });

  it('GET /api/handoff never ships a raw document: no "body"/"file" keys, no absolute bundle path', async () => {
    const r = await request(port, '/api/handoff');
    assert.ok(!/"body":/.test(r.body), 'HTTP handoff leaked a document body');
    assert.ok(!/"file":/.test(r.body), 'HTTP handoff leaked an absolute file path key');
    assert.ok(!r.body.includes(DEMO), 'HTTP handoff leaked the bundle\'s absolute host path');
  });
});

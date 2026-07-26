#!/usr/bin/env node
// ui.mjs — samemind ui: local read-only HTTP dashboard over one bundle (docs/ui-spec.md).
//   node tools/ui.mjs [--port N] [--root <dir>] [--open]
//
// --port N     listen port (default 7787).
// --root <dir> bundle root; default OKF_ROOT (bin/samemind.mjs sets it to the caller's cwd)
//              falling back to process.cwd(). If the resolved root has neither concepts/ nor
//              projects/, but $HOME/.samemind/bundle exists, that global bundle is served
//              instead (with a console.error saying so).
// --open       open the URL in the default browser (macOS `open`; no-op elsewhere).
//
// root is threaded explicitly into every lib.mjs/board.mjs/handoff.mjs call via
// tools/lib/ui-server.mjs's createUiServer({ root }) — never read back from process.env after
// import — so --root works even though tools/lib/okf.mjs computes a module-level ROOT at
// import time from OKF_ROOT.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUiServer } from './lib/ui-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const DEFAULT_PORT = 7787;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, root: null, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (a === '--root') out.root = argv[++i] || null;
    else if (a === '--open') out.open = true;
  }
  return out;
}

/** Resolves the bundle root to serve: --root > $OKF_ROOT > cwd, falling back to the global
 *  bundle ($HOME/.samemind/bundle) if the resolved candidate has no concepts/ or projects/. */
export function resolveRoot(explicitRoot) {
  const candidate = resolve(explicitRoot || process.env.OKF_ROOT || process.cwd());
  const looksLikeBundle = existsSync(join(candidate, 'concepts')) || existsSync(join(candidate, 'projects'));
  if (looksLikeBundle) return candidate;
  const globalBundle = join(homedir(), '.samemind', 'bundle');
  if (existsSync(globalBundle)) {
    console.error(`no bundle here, serving global bundle ${globalBundle}`);
    return globalBundle;
  }
  return candidate;
}

export function main(argv = process.argv.slice(2)) {
  const { port, root: rootArg, open } = parseArgs(argv);
  const root = resolveRoot(rootArg);
  const distDir = join(PACKAGE_ROOT, 'dist');
  const server = createUiServer({ root, distDir });
  server.listen(port, '127.0.0.1', () => {
    console.log(`samemind ui → http://127.0.0.1:${port} (root: ${root})`);
    if (open && process.platform === 'darwin') {
      spawn('open', [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true }).unref();
    }
  });
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) { main(); }

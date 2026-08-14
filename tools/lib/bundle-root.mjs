// bundle-root.mjs — shared `--root` resolution for CLI tools that read one physical OKF-bundle.
//
// Extracted (F1, 1.1.1) from board.mjs/handoff.mjs, where it lived as two byte-identical copies
// of `resolveBundleRoot` (1.0.1) — okf-query.mjs and okf-recall.mjs needed the exact same
// semantics and copying it a third/fourth time was exactly the class of defect 1.0.1 already
// fixed once: "--root silently ignored, tool reports on the wrong bundle without saying so."
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { ROOT } from './okf.mjs';

/**
 * Physical bundle root for one run: --root wins over OKF_ROOT (the module-level ROOT from
 * okf.mjs, bound at import time).
 *
 * A path that exists is not enough — it has to be a directory. `walk()` (./okf.mjs) swallows
 * the ENOTDIR from `readdirSync` on a regular file and returns [], so `--root ./notes.md` used
 * to print a cheerful empty result instead of saying the root was not a bundle. `statSync`
 * follows symlinks on purpose: a symlink to a directory is a perfectly good bundle root
 * (bundles get symlinked into place), while a symlink to a file or a dangling one is not.
 */
export function resolveBundleRoot(rootArg) {
  if (!rootArg) return ROOT;
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`root not found: ${root} (pass --root <dir> or set OKF_ROOT)`);
  }
  if (!st.isDirectory()) {
    throw new Error(`root is not a directory: ${root} (--root takes an OKF-bundle directory)`);
  }
  return root;
}

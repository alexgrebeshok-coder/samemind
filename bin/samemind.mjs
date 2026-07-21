#!/usr/bin/env node
// samemind.mjs — CLI router for the samemind package.
//   npx samemind init [dir] [--demo]     scaffold a fresh OKF bundle
//   npx samemind setup [...]             → tools/setup.mjs      (one-shot onboarding: detect engine, bundle, install+MCP, embeddings probe)
//   npx samemind query <cmd> ...         → tools/okf-query.mjs   (list|type|tag|get|links|validate)
//   npx samemind recall <cmd> ...        → tools/okf-recall.mjs  (index | "<query>" [--mode bm25|semantic|auto])
//   npx samemind gde "<query>" ...       → tools/gde.mjs         (semantic + BM25 fallback)
//   npx samemind brief [...]             → tools/brief.mjs       (identity/user/engine-rule digest, --inject)
//   npx samemind board [...]             → tools/board.mjs       (kanban dashboard over the work-discipline layer)
//   npx samemind handoff [...]           → tools/handoff.mjs     (work-state: tasks/plans/decisions/session)
//   npx samemind forget <id>             → tools/forget.mjs      (soft-deprecate; never deletes — see docs/memory-hygiene.md)
//   npx samemind install --agent <id>    → tools/install.mjs     (wire brief+protocol into an engine's instruction file)
//   npx samemind export <dir> [...]      → tools/export.mjs      (shareable OKF-bundle / --to-gbrain; no secrets)
//   npx samemind import <dir> [...]      → tools/import.mjs      (accept foreign OKF; default → inbox)
//   npx samemind capture --engine <id>   → tools/capture.mjs     (read-only capture of a live engine session store → inbox)
//   npx samemind ledger <cmd> ...        → tools/ledger.mjs      (append-only event ledger: append|status|read)
//   npx samemind serve                   → tools/mcp-server.mjs  (MCP stdio server: memory_* tools)
//
// query/recall/gde are routed with OKF_ROOT defaulted to the caller's cwd, so the tools
// operate on the user's own bundle rather than on samemind's own repo checkout.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

const ROUTES = {
  init: 'tools/init.mjs',
  setup: 'tools/setup.mjs',
  query: 'tools/okf-query.mjs',
  recall: 'tools/okf-recall.mjs',
  gde: 'tools/gde.mjs',
  brief: 'tools/brief.mjs',
  board: 'tools/board.mjs',
  handoff: 'tools/handoff.mjs',
  forget: 'tools/forget.mjs',
  install: 'tools/install.mjs',
  export: 'tools/export.mjs',
  import: 'tools/import.mjs',
  capture: 'tools/capture.mjs',
  ledger: 'tools/ledger.mjs',
  serve: 'tools/mcp-server.mjs',
};

function usage() {
  console.log('samemind — universal git-native memory for AI agents');
  console.log('');
  console.log('Commands:');
  console.log('  init [dir] [--demo]   create a bundle from scratch (empty folder only; --demo — with demo content)');
  console.log('  setup [...]           one-shot onboarding: detect engine, scaffold bundle, wire install+MCP, probe local embeddings (default: interactive; --yes — no prompts; --dry-run — plan only; --target <dir>)');
  console.log('  query <cmd> ...       structural queries: list | type <T> | tag <t> | get <id> | links | validate');
  console.log('  recall <cmd> ...      search: index | "<query>" [-k N] [--mode bm25|semantic|auto] (default auto: BM25 without an endpoint)');
  console.log('  gde "<query>" ...     human-readable search (semantic + BM25 fallback)');
  console.log('  brief [...]           personality-layer brief: identity+owner+engine role (--engine <id> --budget <n> --inject <file>)');
  console.log('  board [...]           memory kanban in markdown: Backlog/In progress/Done/Blocked+aging, Plans, Recent (--write → DASHBOARD.md, --project <path>)');
  console.log('  handoff [...]         work-state brief: active/decisions/plans/session (--project <path> --days N)');
  console.log('  forget <id>           mark a concept deprecated (deprecated: true) — never deletes the file, see docs/memory-hygiene.md');
  console.log('  install --agent <id>  wire brief+protocol into an engine\'s instruction file (--list — list them; --agent all — into all existing ones)');
  console.log('  export <dir> [...]    shareable OKF-bundle (no secret/mirror/inbox); --visibility public|internal --dry-run --to-gbrain');
  console.log('  import <dir> [...]    accept a foreign OKF-bundle; --into inbox|concepts (default inbox) — see docs/interop.md');
  console.log('  capture --engine <id> [--source <path>] [--since <ts>] [--dry-run]   read-only capture of a live engine session store → inbox/<engine>.md — see docs/session-capture.md');
  console.log('  ledger <cmd> ...      append-only event ledger: append --actor .. --topic .. --phase .. [--status ..] --action ".." | status | read --topic <t> — see docs/event-ledger.md');
  console.log('  serve                 MCP stdio server (memory_search/get/list/write_inbox/handoff/health/ledger_append/ledger_status) — connect it as an MCP tool');
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const script = ROUTES[cmd];

  if (!script) {
    usage();
    const isHelp = !cmd || cmd === '--help' || cmd === '-h' || cmd === 'help';
    return isHelp ? 0 : 1;
  }

  const env = { ...process.env };
  if (!env.OKF_ROOT) env.OKF_ROOT = process.cwd();

  const res = spawnSync(process.execPath, [join(PACKAGE_ROOT, script), ...rest], {
    stdio: 'inherit',
    env,
  });
  if (res.error) {
    console.error('Error:', res.error.message);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

// npm/npx run this file through a .bin symlink, so argv[1] must be realpath'd
// before comparing with import.meta.url — otherwise main() silently never runs.
const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) {
  process.exit(main());
}

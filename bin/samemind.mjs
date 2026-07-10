#!/usr/bin/env node
// samemind.mjs — CLI router for the samemind package.
//   npx samemind init [dir] [--demo]     scaffold a fresh OKF bundle
//   npx samemind query <cmd> ...         → tools/okf-query.mjs   (list|type|tag|get|links|validate)
//   npx samemind recall <cmd> ...        → tools/okf-recall.mjs  (index | "<query>" [--mode bm25|semantic|auto])
//   npx samemind gde "<query>" ...       → tools/gde.mjs         (semantic + BM25 fallback)
//
// query/recall/gde are routed with OKF_ROOT defaulted to the caller's cwd, so the tools
// operate on the user's own bundle rather than on samemind's own repo checkout.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

const ROUTES = {
  init: 'tools/init.mjs',
  query: 'tools/okf-query.mjs',
  recall: 'tools/okf-recall.mjs',
  gde: 'tools/gde.mjs',
};

function usage() {
  console.log('samemind — universal git-native memory for AI agents');
  console.log('');
  console.log('Команды:');
  console.log('  init [dir] [--demo]   создать bundle с нуля (только в пустой папке; --demo — с демо-контентом)');
  console.log('  query <cmd> ...       структурные запросы: list | type <T> | tag <t> | get <id> | links | validate');
  console.log('  recall <cmd> ...      поиск: index | "<запрос>" [-k N] [--mode bm25|semantic|auto] (дефолт auto: BM25 без эндпоинта)');
  console.log('  gde "<запрос>" ...    человекочитаемый поиск (semantic + BM25 fallback)');
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const script = ROUTES[cmd];

  if (!script) {
    usage();
    return cmd ? 1 : 0;
  }

  const env = { ...process.env };
  if (!env.OKF_ROOT) env.OKF_ROOT = process.cwd();

  const res = spawnSync(process.execPath, [join(PACKAGE_ROOT, script), ...rest], {
    stdio: 'inherit',
    env,
  });
  if (res.error) {
    console.error('Ошибка:', res.error.message);
    return 1;
  }
  return res.status === null ? 1 : res.status;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}

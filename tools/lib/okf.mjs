// okf.mjs — общая логика чтения OKF-bundle (используют okf-query и okf-recall).
import { readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень bundle: по умолчанию — родитель каталога tools/ (текущий чекаут).
// Переопределяется через OKF_ROOT, чтобы гонять инструменты на произвольном bundle (напр. demo/).
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(process.env.OKF_ROOT || join(HERE, '../..'));
// Bundle map + docs that live at the root but are not graph concepts.
export const RESERVED = new Set(['index.md', 'log.md', 'README.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md']);

export function walk(dir = ROOT, { includeSecret = false, includeMirror = false } = {}, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  const rootPrefix = resolve(ROOT) + sep;
  for (const name of entries) {
    // `.`/`_`-префикс = служебное (генераты, sync-блоки, отчёты); tools/demo/node_modules — не концепты графа
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules' || name === 'tools' || name === 'demo') continue;
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      try {
        const target = resolve(full);
        if (!target.startsWith(rootPrefix)) continue;
      } catch { continue; }
    }
    const top = relative(ROOT, full).split('/')[0];
    if (!includeSecret && top === 'secret') continue;   // секретный слой — только по флагу
    if (!includeMirror && top === 'mirror') continue;    // зеркало живой памяти — только по флагу
    try {
      if (statSync(full).isDirectory()) walk(full, { includeSecret, includeMirror }, acc);
      else if (name.endsWith('.md')) acc.push(full);
    } catch { continue; }
  }
  return acc;
}

// мини-парсер frontmatter (key: value; tags: [a, b]) — без YAML-зависимости
export function parse(file) {
  const raw = readFileSync(file, 'utf8');
  const id = relative(ROOT, file).replace(/\.md$/, '');
  const base = file.split('/').pop();
  const fm = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!mm) continue;
      let [, k, v] = mm; v = v.trim();
      if (v.startsWith('[') && v.endsWith(']'))
        fm[k] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else fm[k] = v.replace(/^["']|["']$/g, '');
    }
    if (!fm.visibility) fm.visibility = 'internal';
  }
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const links = [...prose.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)].map(x => x[1]);
  return { file, id, base, reserved: RESERVED.has(base), fm, hasFM: !!m, body, links };
}

export function load(opts = {}) { return walk(ROOT, opts).map(parse); }

// mirror-узлы используют [[wiki-links]] (формат памяти Claude Code), не OKF-ссылки —
// validate/links над ними не имеют смысла, поэтому okf-query ходит без mirror по умолчанию.

export function resolveLink(fromFile, target) {
  const resolved = target.startsWith('/')
    ? resolve(ROOT, '.' + target)
    : resolve(dirname(fromFile), target);
  const root = resolve(ROOT) + sep;
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

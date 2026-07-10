// okf.mjs — общая логика чтения OKF-bundle (используют okf-query и okf-recall).
import { readdirSync, readFileSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень bundle: по умолчанию — родитель каталога tools/ (текущий чекаут).
// Переопределяется через OKF_ROOT, чтобы гонять инструменты на произвольном bundle (напр. demo/).
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(process.env.OKF_ROOT || join(HERE, '../..'));
// Bundle map + docs that live at the root but are not graph concepts.
export const RESERVED = new Set(['index.md', 'log.md', 'README.md', 'DASHBOARD.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md']);

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

/** Scalar or list → string[]. Empty / missing → []. */
export function asPathList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(s => String(s).trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return [String(v).trim().replace(/^["']|["']$/g, '')].filter(Boolean);
}

/**
 * Normalize SameMind `relations` extension to { type: string[] }.
 * Edge types are open (no dictionary). Values are bundle-absolute paths or lists of them.
 */
export function normalizeRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue;
    out[k] = asPathList(v);
  }
  return out;
}

/** /entities/acme-labs.md → entities/acme-labs */
export function pathToId(p) {
  return String(p || '').replace(/^\//, '').replace(/\.md$/, '');
}

/**
 * Parse YAML-ish frontmatter lines (mini parser, no dependency).
 * Supports plain keys, inline lists, and indented `relations:` block.
 */
export function parseFrontmatter(yaml) {
  const fm = {};
  const lines = yaml.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // relations:  (block with indented edge types)
    if (/^relations:\s*$/.test(line) || /^relations:\s*\{\s*\}\s*$/.test(line)) {
      const rel = {};
      i++;
      while (i < lines.length) {
        const rl = lines[i];
        // stop on non-indented content (next top-level key or blank that breaks indent)
        if (rl.trim() === '') { i++; continue; }
        if (!/^\s/.test(rl)) break;
        const rm = rl.match(/^  ([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!rm) break;
        let [, rk, rv] = rm;
        rv = rv.trim();
        if (rv === '' || rv === '[]') {
          // multi-line YAML list under the key
          const items = [];
          i++;
          while (i < lines.length) {
            const lm = lines[i].match(/^    -\s*(.+)$/);
            if (!lm) break;
            items.push(lm[1].trim().replace(/^["']|["']$/g, ''));
            i++;
          }
          rel[rk] = items;
          continue;
        }
        if (rv.startsWith('[') && rv.endsWith(']')) {
          rel[rk] = rv.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
          rel[rk] = rv.replace(/^["']|["']$/g, '');
        }
        i++;
      }
      fm.relations = rel;
      continue;
    }

    const mm = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (mm) {
      let [, k, v] = mm;
      v = v.trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        fm[k] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        fm[k] = v.replace(/^["']|["']$/g, '');
      }
    }
    i++;
  }
  return fm;
}

// мини-парсер frontmatter (key: value; tags: [a, b]; relations: {…}) — без YAML-зависимости
export function parse(file) {
  const raw = readFileSync(file, 'utf8');
  const id = relative(ROOT, file).replace(/\.md$/, '');
  const base = file.split('/').pop();
  let fm = {};
  let body = raw;
  let hasFM = false;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    hasFM = true;
    body = m[2];
    fm = parseFrontmatter(m[1]);
    if (!fm.visibility) fm.visibility = 'internal';
  }
  const prose = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const links = [...prose.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)].map(x => x[1]);
  const relations = normalizeRelations(fm.relations);
  // keep fm.relations as the normalized map for consumers that read fm
  if (Object.keys(relations).length) fm.relations = relations;
  else delete fm.relations;
  // supersedes: /path.md | [/a.md, /b.md] — normalized the same way as a relations value
  // (see docs/memory-hygiene.md). Not nested under relations: it's a hygiene signal, not a graph edge.
  const supersedes = asPathList(fm.supersedes);
  if (supersedes.length) fm.supersedes = supersedes;
  else delete fm.supersedes;
  return { file, id, base, reserved: RESERVED.has(base), fm, hasFM, body, links, relations, supersedes };
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

/** Resolve a relation target path (bundle-absolute preferred; relative to ROOT also ok). */
export function resolveRelationPath(target) {
  if (!target) return null;
  const t = String(target).trim();
  const resolved = t.startsWith('/')
    ? resolve(ROOT, '.' + t)
    : resolve(ROOT, t);
  const root = resolve(ROOT) + sep;
  if (!resolved.startsWith(root) && resolved !== resolve(ROOT)) return null;
  return resolved;
}

/**
 * Collect all typed relation edges from a document list.
 * Returns { fromId, type, toPath, toId, resolved, exists }[].
 */
export function collectRelationEdges(docs) {
  const edges = [];
  for (const d of docs) {
    const rel = d.relations || normalizeRelations(d.fm?.relations);
    for (const [type, paths] of Object.entries(rel)) {
      for (const toPath of paths) {
        const resolved = resolveRelationPath(toPath);
        const toId = pathToId(toPath);
        edges.push({
          fromId: d.id,
          type,
          toPath,
          toId,
          resolved,
          exists: resolved ? existsSync(resolved) : false,
        });
      }
    }
  }
  return edges;
}

/** Find a concept by id (exact) or basename suffix — same rules as okf-query get. */
export function findById(docs, q) {
  const needle = String(q || '').replace(/\.md$/, '');
  const exact = docs.filter(d => d.id === needle);
  if (exact.length) return exact;
  return docs.filter(d => d.id.endsWith('/' + needle) || d.id === needle);
}

/**
 * Work-discipline status dictionaries (see docs/work-discipline.md).
 * Only Plan and Task carry a `status` field; Decision and Session are append-only
 * / point-in-time and have no status lifecycle, so they are intentionally absent.
 * Values are matched case-insensitively against the lowercase dictionary.
 */
export const STATUS_DICTIONARIES = Object.freeze({
  Plan: ['draft', 'agreed', 'in-progress', 'done', 'superseded'],
  Task: ['backlog', 'in-progress', 'done', 'blocked'],
});

/**
 * Discipline checks → warning strings (never errors; we don't fail foreign bundles).
 * Fires for Plan/Task only:
 *   - missing `status`
 *   - `status` value outside the type's dictionary
 *   - Task `status: blocked` without a non-empty `blocked_reason`
 */
export function disciplineChecks(docs) {
  const warns = [];
  const byLowerType = new Map(
    Object.entries(STATUS_DICTIONARIES).map(([t, v]) => [t.toLowerCase(), v])
  );
  for (const d of docs) {
    if (d.reserved) continue;
    const typeRaw = String(d.fm?.type || '').trim();
    const dict = byLowerType.get(typeRaw.toLowerCase());
    if (!dict) continue;                       // type carries no status lifecycle
    const status = String(d.fm?.status || '').trim();
    if (!status) {
      warns.push(`${d.id}: ${typeRaw} без 'status'`);
      continue;                                // missing ≠ outside dictionary
    }
    if (!dict.includes(status.toLowerCase())) {
      warns.push(`${d.id}: ${typeRaw} 'status' вне словаря (${dict.join('|')}): «${status}»`);
    }
    if (typeRaw.toLowerCase() === 'task' && status.toLowerCase() === 'blocked') {
      const reason = String(d.fm?.blocked_reason || '').trim();
      if (!reason) warns.push(`${d.id}: Task 'blocked' без 'blocked_reason'`);
    }
  }
  return warns;
}

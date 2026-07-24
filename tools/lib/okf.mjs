// okf.mjs — общая логика чтения OKF-bundle (используют okf-query и okf-recall).
import { readdirSync, readFileSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень bundle: по умолчанию — родитель каталога tools/ (текущий чекаут).
// Переопределяется через OKF_ROOT, чтобы гонять инструменты на произвольном bundle (напр. demo/).
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(process.env.OKF_ROOT || join(HERE, '../..'));
// Bundle map + docs that live at the root but are not graph concepts.
export const RESERVED = new Set([
  'index.md', 'log.md', 'README.md', 'DASHBOARD.md', 'LICENSE.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'INSTALL_FOR_AGENTS.md',
  // engine instruction files written by `samemind install` — not graph concepts
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
]);

// `root` (4th param) is the bundle root secret/mirror/inbox-tier and symlink-containment checks
// are relative to — separate from `dir` (which one recursion currently scans). Defaults to `dir`
// so a top-level call `walk(someRoot, opts)` needs no extra argument; recursive calls below thread
// it through explicitly so it stays pinned to the original root as `dir` descends into subdirs.
// Multi-root recall (U5/G-B, tools/lib/compose-roots.mjs) calls `walk(globalRoot, opts)` — before
// this, `top`/`rootPrefix` were computed against the module-level ROOT regardless of `dir`, which
// only ever matched `dir` by coincidence (default `dir = ROOT`); passing a genuinely different root
// would have miscomputed both. Byte-identical behavior when root === ROOT (the untouched default).
export function walk(dir = ROOT, { includeSecret = false, includeMirror = false, includeInbox = false } = {}, acc = [], root = dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  const rootPrefix = resolve(root) + sep;
  for (const name of entries) {
    // `.`/`_`-префикс = служебное (генераты, sync-блоки, отчёты); tools/demo/node_modules — не концепты
    // графа; docs — package prose (adapters/benchmark/…), not OKF nodes (no frontmatter by design).
    // ledger/ (see docs/event-ledger.md, issue #3) is an append-only *event log* — JSONL, not
    // OKF concepts — excluded unconditionally like tools/demo/docs, not opt-in like inbox/
    // (no consumer ever needs to walk it as graph concepts; consolidate.mjs has no ledger
    // equivalent, there is nothing here to promote into the canon).
    // bench/ (see bench/longmemeval/README.md) holds third-party benchmark harness adapters —
    // package prose + result JSON, same category as docs/, not OKF nodes.
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules' || name === 'tools'
      || name === 'demo' || name === 'docs' || name === 'ledger' || name === 'bench') continue;
    const full = join(dir, name);
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      try {
        const target = resolve(full);
        if (!target.startsWith(rootPrefix)) continue;
      } catch { continue; }
    }
    const top = relative(root, full).split('/')[0];
    if (!includeSecret && top === 'secret') continue;   // секретный слой — только по флагу
    if (!includeMirror && top === 'mirror') continue;    // зеркало живой памяти — только по флагу
    // inbox — сырьё, ждущее курации (см. issue #4): не концепты графа, поэтому — reserved-тир,
    // как secret/mirror, только по флагу includeInbox. Иначе первая же memory_write_inbox запись
    // (frontmatter без `type`) валит `validate` для всего bundle.
    if (!includeInbox && top === 'inbox') continue;
    try {
      if (statSync(full).isDirectory()) walk(full, { includeSecret, includeMirror, includeInbox }, acc, root);
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

/** Display title, OKF-native `title:` preferred; falls back onto samemind's own memory schema
 *  (`description:`/`name:`) for frontmatter that never had `title` to begin with — never
 *  overrides an existing OKF-native value. */
export function displayTitle(fm) {
  return (fm && (fm.title || fm.description || fm.name)) || '';
}

/** Display type, OKF-native `type:` preferred; falls back onto samemind's own memory schema
 *  (`metadata.type`/`metadata.node_type`) — see the `metadata:` block parsed in parseFrontmatter
 *  above. Never overrides an existing OKF-native value. */
export function displayType(fm) {
  return (fm && (fm.type || fm.metadata?.type || fm.metadata?.node_type)) || '';
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

    // metadata:  (block with indented flat key/value pairs — samemind's own memory schema
    // (name/description/metadata.type), distinct from OKF-native title/type; see displayTitle/
    // displayType below for how consumers fall back onto it)
    if (/^metadata:\s*$/.test(line) || /^metadata:\s*\{\s*\}\s*$/.test(line)) {
      const meta = {};
      i++;
      while (i < lines.length) {
        const ml = lines[i];
        if (ml.trim() === '') { i++; continue; }
        if (!/^\s/.test(ml)) break;
        const mm2 = ml.match(/^  ([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!mm2) break;
        let [, mk, mv] = mm2;
        mv = mv.trim();
        if (mv.startsWith('[') && mv.endsWith(']')) {
          meta[mk] = mv.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
          meta[mk] = mv.replace(/^["']|["']$/g, '');
        }
        i++;
      }
      fm.metadata = meta;
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
// `root` (2nd param, default ROOT): which bundle root `id` is computed relative to — see load()
// below (multi-root recall, U5/G-B). Byte-identical when root === ROOT (the untouched default).
export function parse(file, root = ROOT) {
  parseCount++; // test hook only — see _debugParseCount()
  const raw = readFileSync(file, 'utf8');
  const id = relative(root, file).replace(/\.md$/, '');
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
  // superseded_by: reverse pointer — set BY HAND (or via a human applying a tools/reconcile.mjs
  // proposal) on the OLD fact, naming the fact that replaces it. Same normalization as
  // supersedes, just the other direction (see docs/memory-hygiene.md, bi-temporal section).
  const supersededBy = asPathList(fm.superseded_by);
  if (supersededBy.length) fm.superseded_by = supersededBy;
  else delete fm.superseded_by;
  // valid_from / invalid_at: ISO-date bi-temporal bounds. No special normalization needed —
  // the generic key:value branch above already parses them as plain strings; absent = always
  // valid (backward compatible with every existing concept that predates Ф2).
  // authority: optional number (higher = more trusted) or enum canon|derived|observed —
  // also left as the raw string/number from parseFrontmatter; consumers use
  // hygiene.mjs `authorityValue()` (absent = neutral). Backward compatible: cards without
  // the field behave exactly as before (Э6/6.1).
  return {
    file, id, base, reserved: RESERVED.has(base), fm, hasFM, body, links, relations,
    supersedes, supersededBy,
  };
}

// --- per-file parse cache ---------------------------------------------------------------
// load() used to readFileSync+parse every .md file on every call. Fine for one-shot CLIs
// (okf-query, okf-recall) but wasteful for long-running callers — mcp-server.mjs re-runs
// readableDocs() → load() on every single tool invocation, re-reading the whole bundle each
// time even though most files never changed between calls. Cache parsed docs per file, keyed
// by mtimeMs+size (cheap: one extra statSync, no content hashing) — same idea already used for
// the embeddings index (lib/recall.mjs `syncIndex`'s content-hash reuse), just mtime+size
// instead of a hash since we don't need cross-process/on-disk persistence here, only
// within-process reuse.
// Freshness contract is unchanged from the uncached version: a write that lands between two
// load() calls (whether or not it went through lib/file-lock.mjs) changes the file's mtime
// and/or size, so the very next load() re-stats, notices, and reparses — no lock-awareness
// needed, we just never trust a cache entry without re-checking disk first. A file walk() no
// longer returns (deleted/renamed) simply never gets re-fetched from the cache and drops out
// of the result, exactly like the uncached version.
// ponytail: cache entries for deleted/renamed files are never pruned (walk() just stops asking
// for them), so memory is bounded by total distinct file paths ever seen in this process's
// lifetime, not current bundle size. Fine for a personal memory bundle (hundreds–low
// thousands of concepts, an mcp-server process that gets restarted regularly); add an
// LRU/periodic prune if a long-lived server ever churns through many thousands of renames.
const parseCache = new Map(); // file path -> { mtimeMs, size, doc }
let parseCount = 0; // real (uncached) parses since last reset — test hook, see _debugParseCount()

/** Test-only: how many times parse() actually ran a fresh readFileSync (cache misses). */
export function _debugParseCount() { return parseCount; }
/** Test-only: reset the counter and drop the whole cache (clean slate between test cases). */
export function _debugResetParseCache() { parseCount = 0; parseCache.clear(); }

function cachedParse(file, root) {
  let st;
  try {
    st = statSync(file);
  } catch {
    parseCache.delete(file); // gone — let parse() throw its normal ENOENT, don't cache a miss
    return parse(file, root);
  }
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.doc;
  const doc = parse(file, root);
  parseCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, doc });
  return doc;
}

// `root` (2nd param, default ROOT): walk + parse a bundle at an arbitrary root, not just the
// package's own ROOT — the one hook multi-root recall (U5/G-B, compose-roots.mjs) needs to load
// the optional global personal bundle ($HOME/.samemind/bundle) the same way. A file path is only
// ever under ONE root in practice (project files under the project root, global files under the
// global root), so keying the parse cache by absolute file path alone (unchanged) stays correct.
// Byte-identical when root === ROOT (the untouched default every existing caller uses).
export function load(opts = {}, root = ROOT) { return walk(root, opts).map(f => cachedParse(f, root)); }

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
      warns.push(`${d.id}: ${typeRaw} missing 'status'`);
      continue;                                // missing ≠ outside dictionary
    }
    if (!dict.includes(status.toLowerCase())) {
      warns.push(`${d.id}: ${typeRaw} 'status' outside dictionary (${dict.join('|')}): "${status}"`);
    }
    if (typeRaw.toLowerCase() === 'task' && status.toLowerCase() === 'blocked') {
      const reason = String(d.fm?.blocked_reason || '').trim();
      if (!reason) warns.push(`${d.id}: Task 'blocked' missing 'blocked_reason'`);
    }
  }
  return warns;
}

/**
 * Knowledge-cycle status dictionary (see docs/knowledge-cycle.md).
 * Only `Idea` carries a status lifecycle; `Analysis` and `Research` are
 * point-in-time write-ups (like `Decision`/`Session` in the work-discipline
 * layer) and intentionally have none. Kept as its own frozen map — separate
 * from STATUS_DICTIONARIES above — so that map's shape stays exactly
 * `{Plan, Task}` for existing consumers/tests.
 */
export const KNOWLEDGE_STATUS_DICTIONARIES = Object.freeze({
  Idea: ['spark', 'incubating', 'adopted', 'rejected'],
});

/**
 * Knowledge-cycle checks → warning strings (never errors; same severity as
 * disciplineChecks). Fires for `Idea` only:
 *   - missing `status`
 *   - `status` value outside the dictionary
 *   - `status: rejected` without a non-empty `rejected_reason`
 */
export function knowledgeChecks(docs) {
  const warns = [];
  const byLowerType = new Map(
    Object.entries(KNOWLEDGE_STATUS_DICTIONARIES).map(([t, v]) => [t.toLowerCase(), v])
  );
  for (const d of docs) {
    if (d.reserved) continue;
    const typeRaw = String(d.fm?.type || '').trim();
    const dict = byLowerType.get(typeRaw.toLowerCase());
    if (!dict) continue;                       // type carries no status lifecycle (Analysis/Research)
    const status = String(d.fm?.status || '').trim();
    if (!status) {
      warns.push(`${d.id}: ${typeRaw} missing 'status'`);
      continue;                                // missing ≠ outside dictionary
    }
    if (!dict.includes(status.toLowerCase())) {
      warns.push(`${d.id}: ${typeRaw} 'status' outside dictionary (${dict.join('|')}): "${status}"`);
    }
    if (typeRaw.toLowerCase() === 'idea' && status.toLowerCase() === 'rejected') {
      const reason = String(d.fm?.rejected_reason || '').trim();
      if (!reason) warns.push(`${d.id}: Idea 'rejected' missing 'rejected_reason'`);
    }
  }
  return warns;
}

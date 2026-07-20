// sqlite-index.mjs — Ф4: sqlite-vec-backed embeddings index (schema, incremental sync, KNN
// search) as an OPTIONAL alternative to the flat-JSON linear-cosine index (lib/recall.mjs
// rankByQuery). Binary Float32 vectors in ONE file (tools/.index/index.db) instead of ~10x
// heavier JSON-number arrays; KNN done in C (vec0 virtual table) instead of a JS linear scan —
// see docs/benchmark.md "Ф4 sqlite-vec" for the measured latency win at scale.
//
// Everything that can fail (no `node:sqlite` on this Node build, `sqlite-vec` optionalDependency
// not installed / no prebuilt binary for this platform, extension load error) is caught here and
// turned into `{ ok: false, reason }` — NEVER thrown. Callers (okf-recall.mjs) fall back to the
// existing JSON index unconditionally on `ok: false`. `node:sqlite` and `sqlite-vec` are imported
// dynamically, inside openVecStore(), never at module top level — importing *this file* never
// touches either, so it stays safe to import unconditionally (zero-runtime-deps-by-default is
// unaffected: nothing here runs unless a caller actually opens a store).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentHash, embedText, finalizeRanked } from './recall.mjs';
import { displayTitle, displayType } from './okf.mjs';

const KNN_OVERFETCH_MIN = 200; // floor candidate pool so tier/hygiene filtering has room to work
const KNN_OVERFETCH_FACTOR = 20; // candidates fetched = min(totalRows, max(k*FACTOR, MIN))

function f32(vector) {
  const arr = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Open (creating if needed) a sqlite-vec-backed store at `dbPath`. Never throws — returns
 * `{ ok: false, reason }` for any failure (missing node:sqlite, missing/incompatible sqlite-vec,
 * extension load error, unwritable path). The `vec_items` virtual table's dimension is fixed at
 * creation time, but we don't know the embedding dimension until the first vector arrives, so its
 * creation is deferred to the first `syncVecStore`/`migrateJsonIndex` call (see ensureVecTable).
 */
export async function openVecStore({ dbPath, model = null } = {}) {
  if (!dbPath) return { ok: false, reason: 'dbPath required' };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    return { ok: false, reason: `node:sqlite unavailable (${e.message})` };
  }
  let sqliteVec;
  try {
    sqliteVec = await import('sqlite-vec');
  } catch (e) {
    return { ok: false, reason: `sqlite-vec unavailable (${e.message})` };
  }
  let db;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(db);
  } catch (e) {
    try { db?.close(); } catch { /* already broken, nothing to salvage */ }
    return { ok: false, reason: `sqlite-vec load failed (${e.message})` };
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      rowid INTEGER PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      type TEXT,
      title TEXT,
      visibility TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
  const storedDim = metaGet.get('dim')?.value;
  const storedModel = metaGet.get('model')?.value;
  const store = {
    ok: true, db, dbPath,
    dim: storedDim ? Number(storedDim) : null,
    model: storedModel || null,
    vecTableReady: false,
  };
  // model changed since last run (e.g. switched embedding endpoint) → old vectors are for a
  // different embedding space, not just a different dimension; wipe and start clean, same rule
  // okf-recall.mjs already applies to the JSON index via indexKey().
  if (model && store.model && store.model !== model) {
    db.exec('DELETE FROM items; DROP TABLE IF EXISTS vec_items;');
    store.dim = null;
    store.model = model;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('model', model);
  } else if (model && !store.model) {
    store.model = model;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('model', model);
  }
  if (store.dim) ensureVecTable(store, store.dim); // reopen of an existing populated store
  return store;
}

/** Create vec_items (idempotent) once the embedding dimension is known; wipes on dimension change. */
function ensureVecTable(store, dim) {
  if (store.vecTableReady && store.dim === dim) return;
  if (store.dim !== null && store.dim !== dim) {
    // dimension changed (different model/endpoint) — old vectors are meaningless, start clean
    store.db.exec('DELETE FROM items; DROP TABLE IF EXISTS vec_items;');
  }
  store.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[${dim}] distance_metric=cosine)`);
  store.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('dim', String(dim));
  store.dim = dim;
  store.vecTableReady = true;
}

export function closeVecStore(store) {
  try { store?.db?.close(); } catch { /* best-effort */ }
}

/** Row count — the sqlite-side equivalent of `Object.keys(idx.items).length` (hasIndex checks). */
export function vecStoreCount(store) {
  if (!store?.ok) return 0;
  return store.db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
}

/**
 * Dump every indexed item as { id, title, type, visibility, vector } — the sqlite-side equivalent
 * of `Object.entries(idx.items)` on the flat-JSON index. For callers (tools/consolidate.mjs) that
 * need the raw vectors themselves (all-pairs cosine) rather than a single KNN query, so they can
 * stay backend-agnostic without going through searchVecStore(). `vector` is a plain Number[]
 * (decoded from the vec0 float32 blob) — same shape `cosine()`/consolidate's own cos() expect.
 */
export function readAllItems(store) {
  if (!store?.ok || !store.vecTableReady) return [];
  const rows = store.db.prepare(`
    SELECT i.id AS id, i.title AS title, i.type AS type, i.visibility AS visibility, v.embedding AS embedding
    FROM items i JOIN vec_items v ON i.rowid = v.rowid
  `).all();
  return rows.map(r => ({
    id: r.id, title: r.title, type: r.type, visibility: r.visibility,
    vector: Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
  }));
}

/**
 * Incremental sync by content-hash — same contract as lib/recall.mjs syncIndex(), just against
 * sqlite rows instead of a JS object: unchanged docs are reused (no re-embed), changed/new docs
 * are (re-)embedded, docs no longer in the bundle are pruned (mirror/secret preserved unless the
 * matching includeMirror/includeSecret flag is set — same rule as syncIndex).
 */
export async function syncVecStore(store, docs, embed, { includeSecret = false, includeMirror = false } = {}) {
  const seen = new Set();
  let built = 0, reused = 0;
  const getHash = store.db.prepare('SELECT rowid, hash FROM items WHERE id = ?');
  const insItem = store.db.prepare('INSERT INTO items (id, hash, type, title, visibility) VALUES (?, ?, ?, ?, ?)');
  const updItem = store.db.prepare('UPDATE items SET hash = ?, type = ?, title = ?, visibility = ? WHERE rowid = ?');
  // vec_items may not exist yet on a brand-new store (dim unknown until the first vector arrives)
  // — sqlite validates a prepared statement's tables at PREPARE time, so any `DELETE FROM
  // vec_items` must only ever be prepared AFTER ensureVecTable() has run at least once.
  const delVec = rowid => store.db.prepare('DELETE FROM vec_items WHERE rowid = ?').run(rowid);

  for (const d of docs) {
    const h = contentHash(d);
    seen.add(d.id);
    const existing = getHash.get(d.id);
    if (existing?.hash === h) { reused++; continue; }
    const visibility = d.fm.visibility || 'internal';
    const vector = await embed(embedText(d));
    ensureVecTable(store, vector.length);
    let rowid;
    if (existing) {
      rowid = existing.rowid;
      updItem.run(h, displayType(d.fm), displayTitle(d.fm), visibility, rowid);
      delVec(rowid);
    } else {
      rowid = insItem.run(d.id, h, displayType(d.fm), displayTitle(d.fm), visibility).lastInsertRowid;
    }
    store.db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), f32(vector));
    built++;
  }

  const allIds = store.db.prepare('SELECT rowid, id, visibility FROM items').all();
  const delItem = store.db.prepare('DELETE FROM items WHERE rowid = ?');
  for (const row of allIds) {
    if (seen.has(row.id)) continue;
    const vis = row.visibility || 'internal';
    if (vis === 'mirror' && !includeMirror) continue;
    if (vis === 'secret' && !includeSecret) continue;
    if (store.vecTableReady) delVec(row.rowid);
    delItem.run(row.rowid);
  }
  return { built, reused, total: vecStoreCount(store) };
}

/**
 * Copy an existing flat-JSON index (`{ items: { id: {hash, type, title, visibility, vector} } }`)
 * into the sqlite store WITHOUT re-embedding — the migration path (Ф4 DoD: "embeddings.json → sqlite
 * без потерь"). Dimension is inferred from the first vector.
 */
export function migrateJsonIndex(store, jsonIdx) {
  const entries = Object.entries(jsonIdx?.items || {});
  if (!entries.length) return { migrated: 0 };
  ensureVecTable(store, entries[0][1].vector.length);
  const insItem = store.db.prepare('INSERT INTO items (id, hash, type, title, visibility) VALUES (?, ?, ?, ?, ?)');
  const insVec = store.db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)');
  for (const [id, v] of entries) {
    // v.type/v.title can be `undefined` on an older JSON index built before displayType/
    // displayTitle existed (frontmatter with no OKF-native title/type at all) — sqlite bind
    // params accept `null` but not `undefined`, so normalize here rather than at every caller.
    const rowid = insItem.run(id, v.hash, v.type ?? null, v.title ?? null, v.visibility || 'internal').lastInsertRowid;
    insVec.run(BigInt(rowid), f32(v.vector));
  }
  return { migrated: entries.length };
}

/**
 * KNN search — sqlite-vec side of finalizeRanked() (see lib/recall.mjs). Overfetches a candidate
 * pool (min(totalRows, max(k*20, 200))) so tier filter / excludeSource / hygiene can run on it
 * exactly like the JSON path's full scan, then finalizeRanked() does the same
 * filter+multiplier+sort+slice(k) for both backends.
 * ponytail: overfetch is a bounded window, not a true full-corpus scan — a query that needs more
 * than `poolK` candidates filtered out (e.g. huge secret/mirror tiers on a modest k) could in
 * theory miss a result a JSON full scan would find. Raise KNN_OVERFETCH_FACTOR if that ever bites;
 * not worth a two-phase query for a personal-memory-bundle corpus.
 */
export function searchVecStore(store, queryVector, {
  k = 5, includeSecret = false, includeMirror = false, docs = [], excludeSource = null, events = [],
} = {}) {
  if (!store?.ok || !store.vecTableReady) return [];
  const total = vecStoreCount(store);
  if (total === 0) return [];
  const poolK = Math.min(total, Math.max(k * KNN_OVERFETCH_FACTOR, KNN_OVERFETCH_MIN));
  const rows = store.db.prepare(`
    SELECT i.id AS id, i.title AS title, i.type AS type, i.visibility AS visibility, v.distance AS distance
    FROM vec_items v JOIN items i ON i.rowid = v.rowid
    WHERE v.embedding MATCH ? AND v.k = ?
    ORDER BY v.distance
  `).all(f32(queryVector), BigInt(poolK));
  const candidates = rows.map(r => ({
    id: r.id, title: r.title, type: r.type, visibility: r.visibility,
    rawScore: 1 - r.distance, // vec0 distance_metric=cosine: distance = 1 - cosine similarity
  }));
  return finalizeRanked(candidates, { k, includeSecret, includeMirror, docs, excludeSource, events });
}

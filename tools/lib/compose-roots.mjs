// compose-roots.mjs — U5/G-B: multi-root recall ("Same mind" — every project sees its own memory
// AND the global personal bundle). Merges an optional global root ($HOME/.samemind/bundle by
// default, see resolveGlobalRoot) into a project-root search, WITHOUT mixing hygiene across
// bundles: each root keeps its own index (embeddings.json/index.db under <root>/tools/.index/ —
// same on-disk convention okf-recall.mjs/gde.mjs already use; walk() already excludes any
// top-level `tools/` folder from bundle content — see lib/okf.mjs — so this is safe to reuse
// verbatim even on a bare OKF bundle root that has no actual tools/ directory) and its own
// ledger-derived heat index (tools/lib/hygiene.mjs buildHeatIndex via lib/ledger.mjs readEvents).
//
// Building the global root's index is NOT this module's job — point okf-recall.mjs's own `index`
// subcommand at it (`OKF_ROOT=$HOME/.samemind/bundle node tools/okf-recall.mjs index`), same
// convention as any project bundle. Without one, the global root just searches via BM25 (same
// as a project bundle with no index yet — never a hard failure).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { load } from './okf.mjs';
import { recallSearch } from './recall.mjs';
import { readEvents } from './ledger.mjs';
import {
  openVecStore, closeVecStore, searchVecStore, vecStoreCount,
} from './sqlite-index.mjs';

/** Per-root index directory — same `<root>/tools/.index/` convention okf-recall.mjs/gde.mjs use
 *  for the project root. */
export function idxDirFor(root) {
  return join(root, 'tools', '.index');
}

function loadJsonIdxAt(root, model) {
  const p = join(idxDirFor(root), 'embeddings.json');
  if (!existsSync(p)) return { model, items: {} };
  try {
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    return idx && typeof idx.items === 'object' ? idx : { model, items: {} };
  } catch {
    return { model, items: {} };
  }
}

/** Read-only sqlite-vec open for `root` — null (never throws) on any unavailability, same
 *  DI-fallback contract as okf-recall.mjs/gde.mjs's own openBackend(). No JSON→sqlite migration
 *  here (that already happens on the project root path via those tools' own `index`/`--reindex`;
 *  a fresh global root with no index.db yet just searches BM25 until one is built the same way).
 *  ponytail: skips gde-style auto-migrate-on-read for the global root; add it here too if that
 *  gap bites in practice. */
async function openVecStoreAt(root, model, indexBackend) {
  if (indexBackend === 'json') return null;
  const store = await openVecStore({ dbPath: join(idxDirFor(root), 'index.db'), model });
  return store.ok ? store : null;
}

/** Runs recallSearch scoped to ONE root's own index + own ledger-derived heat — hygiene must
 *  never cross bundles (a hot doc in the global bundle says nothing about heat in the project). */
export async function searchRoot(root, docs, {
  query, mode = 'auto', embed = null, k = 5, includeSecret = false, includeMirror = false,
  excludeSource = null, model = null, indexBackend = process.env.OKF_INDEX_BACKEND || 'auto',
} = {}) {
  const store = await openVecStoreAt(root, model, indexBackend);
  const idx = store ? { items: {} } : loadJsonIdxAt(root, model);
  const result = await recallSearch({
    docs, query, mode, embed, idx, k, includeSecret, includeMirror, excludeSource,
    vecStore: store, vecSearch: store ? searchVecStore : null, vecCount: store ? vecStoreCount : null,
    events: readEvents(root),
  });
  if (store) closeVecStore(store);
  return result;
}

/** Global root resolution: `--no-global`/`no_global` always wins (disabled); else OKF_GLOBAL_ROOT
 *  env overrides (empty string = explicitly disabled — test isolation escape hatch); else the
 *  default `$HOME/.samemind/bundle` (samemind setup --global's target, U5/G-A). */
export function resolveGlobalRoot({ noGlobal = false } = {}) {
  if (noGlobal) return null;
  if (process.env.OKF_GLOBAL_ROOT !== undefined) return process.env.OKF_GLOBAL_ROOT || null;
  return join(homedir(), '.samemind', 'bundle');
}

/**
 * The "global half" of multi-root recall: load + dedup-against-project + search the optional
 * global root. Returns null when there is nothing to do (no globalRoot, or it doesn't exist on
 * disk, or every global doc got deduped away) — callers then behave exactly as they did before
 * G-B (pure single-root search), which is how the byte-identical no-global regression guarantee
 * is met (see mergeWithGlobal below).
 *
 * Dedup: a global doc whose `id` collides with a project doc's `id` is DROPPED — project wins,
 * same relative path in both bundles is assumed to mean the project's copy is the intended/fresher
 * one. Collisions are reported in the returned `dedupWarnings` (never thrown).
 */
export async function searchGlobalHalf(globalRoot, projectDocs, {
  loadOpts = {}, query, mode = 'auto', embed = null, k = 5, includeSecret = false,
  includeMirror = false, excludeSource = null, model = null, indexBackend,
} = {}) {
  if (!globalRoot || !existsSync(globalRoot)) return null;
  const projectIds = new Set(projectDocs.map(d => d.id));
  const dedupWarnings = [];
  const globalDocs = load(loadOpts, globalRoot)
    .filter(d => !d.reserved)
    .filter(d => {
      if (!projectIds.has(d.id)) return true;
      dedupWarnings.push(`global doc "${d.id}" shadowed by project doc with the same id — dropped`);
      return false;
    });
  if (!globalDocs.length) return { hits: [], mode: null, warning: null, dedupWarnings, docs: [] };
  const result = await searchRoot(globalRoot, globalDocs, {
    query, mode, embed, k, includeSecret, includeMirror, excludeSource, model, indexBackend,
  });
  return { ...result, dedupWarnings, docs: globalDocs };
}

/** Divide a corpus's own ranked hits by their own max score (min-max floor of 0 → plain /max)
 *  so relative strength survives the cross-corpus merge below: BM25's IDF is corpus-size/length
 *  dependent, so a small corpus's exact unique hit and a big corpus's incidental hit are not on
 *  the same raw scale. All-zero (or empty) hits pass through unchanged — nothing to normalize,
 *  and dividing by zero would just make NaNs. Only ever called from the two-corpora branch of
 *  mergeWithGlobal, so the single-root passthrough path (see below) is never touched by this. */
function normalizeHits(hits) {
  const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
  return max ? hits.map(h => ({ ...h, score: h.score / max })) : hits;
}

/**
 * Merges a project-root recallSearch result with the optional global half, tagging each hit's
 * provenance (`source: 'project'|'global'`) and sorting the union by score.
 * `globalResult` null or hit-less → returns `projectResult` UNCHANGED (same object, no `source`
 * field added anywhere) — this is what makes "no global bundle on disk / --no-global" byte-for-byte
 * identical to pre-G-B output: nothing about the project-only path is touched.
 * Each side is normalized to its own [0,1] scale (normalizeHits) BEFORE merging — a small corpus's
 * exact unique hit no longer sinks under a bigger corpus's incidental hit purely on raw BM25
 * magnitude (see normalizeHits). Order within a corpus is preserved (dividing by a positive
 * constant doesn't reorder), only the cross-corpus comparison changes.
 */
export function mergeWithGlobal(projectResult, globalResult, k) {
  if (!globalResult || !globalResult.hits.length) return projectResult;
  const merged = [
    ...normalizeHits(projectResult.hits).map(h => ({ ...h, source: 'project' })),
    ...normalizeHits(globalResult.hits).map(h => ({ ...h, source: 'global' })),
  ].sort((a, b) => b.score - a.score).slice(0, k);
  return {
    hits: merged,
    mode: projectResult.mode === globalResult.mode ? projectResult.mode : 'mixed',
    warning: projectResult.warning || globalResult.warning || null,
    dedupWarnings: globalResult.dedupWarnings,
  };
}

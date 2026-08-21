#!/usr/bin/env node
// okf-recall.mjs — search over an OKF bundle: semantic (any OpenAI-compatible embeddings endpoint)
//   or a local BM25 fallback with no network and no dependencies. The embeddings index is local.
//   node tools/okf-recall.mjs index [--root <dir>] [--include-mirror] [--include-secret] [--include-inbox]   # build the semantic index (needs OKF_EMBED_URL)
//   node tools/okf-recall.mjs "<query>" [-k N] [--mode bm25|semantic|hybrid|auto] [--root <dir>] [--include-mirror] [--include-secret] [--include-inbox] [--no-global]
// --root <dir>  which bundle to read: the physical OKF-bundle root, same meaning the flag carries
//               in board/handoff/status/nudge/service/query. Overrides OKF_ROOT for this run.
//               Known gap (F1b, 1.1.1): the *embeddings* index cache (tools/.index/) stays pinned
//               to the module-level ROOT regardless of --root — BM25 is fully correct against the
//               selected bundle either way, so plain --root or --root with --mode bm25 both just
//               work. `--mode semantic`/`--mode hybrid` together with a --root that differs from
//               the default bundle is refused (nonzero exit, explicit error) instead of silently
//               ranking with the WRONG bundle's vectors; `--mode auto` (the default) degrades to
//               bm25 with a stderr note instead of refusing, since auto never explicitly asked for
//               semantics. See the `query()` comment below for the real fix this stands in for.
// Modes: auto (default) — semantic if an index exists and the endpoint answers, otherwise BM25;
//        bm25 — always local keyword/BM25; semantic — strictly semantic (no silent fallback);
//        hybrid (Ф3) — BM25 ⊕ semantic fused via Reciprocal Rank Fusion (k=60, see lib/recall.mjs
//        rrfFuse); falls back to BM25 (never throws) if the index/endpoint is unavailable.
// Tiers: curated (default) · mirror (live-memory mirror) · secret (/secret) · inbox (raw notes
//   awaiting curation, opt-in — mainly for tools/consolidate.mjs, see issue #4).
// Multi-root (U5/G-B, "Same mind"): query results also fold in the global personal bundle
// ($HOME/.samemind/bundle by default, override via OKF_GLOBAL_ROOT — empty value disables it) —
// its hits print with a `global:` id prefix. `--no-global` skips the second load entirely. No
// global bundle on disk and no OKF_GLOBAL_ROOT set → output is byte-identical to project-only
// search (see tools/lib/compose-roots.mjs).
// Endpoint/model/key: OKF_EMBED_URL / OKF_EMBED_MODEL / OKF_EMBED_KEY (Bearer).
// G2 — 1-hop graph expand: `--expand` (or `--expand-hops 1`) pulls in docs connected to a top-k
// hit via a `relations` edge or a REVERSE wikilink (who cites the hit), budget-capped
// (`--expand-budget N`, default 5), printed after the primary hits as `+hop  ... (+1 hop from
// <id>)`. Off by default — with no flag, output is byte-identical to before G2. See
// lib/recall.mjs `expandHits`.
//
// Ф4 — index backend: sqlite-vec (tools/.index/index.db, binary Float32 vectors, KNN in C) is
// tried first; a clean fallback to the flat-JSON index (tools/.index/embeddings.json, linear
// cosine scan) kicks in whenever sqlite-vec isn't available (optionalDependency not installed, no
// prebuilt native binary for this platform, or any load error) — never a crash, just a one-line
// stderr note. An existing embeddings.json is migrated into index.db on first sqlite-backed run,
// with no re-embedding (see lib/sqlite-index.mjs migrateJsonIndex). Force a backend for testing/
// troubleshooting via OKF_INDEX_BACKEND=sqlite|json (default: auto).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, load } from './lib/okf.mjs';
import {
  DEFAULT_EMBED_URL, DEFAULT_MODEL, fetchEmbedding, syncIndex, indexKey, recallSearch,
  expandHits, DEFAULT_EXPAND_BUDGET,
} from './lib/recall.mjs';
import {
  openVecStore, closeVecStore, syncVecStore, searchVecStore, vecStoreCount, migrateJsonIndex,
} from './lib/sqlite-index.mjs';
import { readEvents } from './lib/ledger.mjs';
import { resolveGlobalRoot, searchGlobalHalf, mergeWithGlobal } from './lib/compose-roots.mjs';
import { atomicWriteJsonSync } from '../lib/atomic-write.mjs';
import { resolveBundleRoot } from './lib/bundle-root.mjs';

const EMBED_URL = process.env.OKF_EMBED_URL || DEFAULT_EMBED_URL;
const MODEL = process.env.OKF_EMBED_MODEL || DEFAULT_MODEL;
// F1b (1.1.1 follow-up): pinned to the module-level ROOT, NOT to any `--root` a caller passes —
// this is THE place a real fix would parameterize by root (mirror tools/lib/compose-roots.mjs
// `idxDirFor`, which already keys the *global* bundle's index dir this same way). Two
// consequences today: `query()` below refuses/degrades `--mode semantic|hybrid` against a
// foreign --root instead of silently reading this dir's vectors (see its comment); `buildIndex()`
// below writes a foreign --root's docs into THIS dir too (`index --root <other-bundle>` pollutes
// the default bundle's index with another bundle's ids) — not guarded, out of scope for this
// patch (nobody reported it silently returning wrong results the way search does).
const IDX_DIR = join(ROOT, 'tools', '.index');
const IDX = join(IDX_DIR, 'embeddings.json');
const IDX_DB = join(IDX_DIR, 'index.db');
const INDEX_BACKEND = process.env.OKF_INDEX_BACKEND || 'auto'; // auto | sqlite | json

const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: MODEL });

/** Opens the sqlite-vec store unless OKF_INDEX_BACKEND=json, migrating an existing embeddings.json
 *  in on first use. Returns null (with an honest one-line stderr note) on ANY unavailability —
 *  callers then use the unchanged JSON loadIdx()/saveIdx() path below. Never throws.
 *  Exported (1.2.1, Д1 fix) so lib/mcp.mjs can open the SAME backend query() does instead of
 *  only ever seeing the flat-JSON index — see its own openSemanticBackend() helper. */
export async function openBackend() {
  if (INDEX_BACKEND === 'json') return null;
  const store = await openVecStore({ dbPath: IDX_DB, model: MODEL });
  if (!store.ok) {
    console.error(`sqlite-vec unavailable, JSON fallback (${store.reason})`);
    return null;
  }
  if (vecStoreCount(store) === 0 && existsSync(IDX)) {
    const jsonIdx = loadIdx();
    const n = Object.keys(jsonIdx.items).length;
    if (n) {
      migrateJsonIndex(store, jsonIdx);
      console.error(`migrated ${n} item(s) from embeddings.json → index.db`);
    }
  }
  return store;
}

export function loadIdx() {
  if (!existsSync(IDX)) return { model: MODEL, items: {} };
  try {
    const idx = JSON.parse(readFileSync(IDX, 'utf8'));
    if (!idx || typeof idx.items !== 'object') throw new Error('invalid index schema');
    return idx;
  } catch (e) {
    console.warn(`corrupt index ${IDX} — rebuild it: node tools/okf-recall.mjs index (${e.message})`);
    return { model: MODEL, items: {} };
  }
}

export function saveIdx(idx) {
  mkdirSync(IDX_DIR, { recursive: true });
  atomicWriteJsonSync(IDX, idx);
}

const MODES = ['bm25', 'semantic', 'hybrid', 'auto'];

// Every flag this CLI recognizes today — kept as one list so the unknown-flag pass below (added
// for --root, F1/1.1.1) has a single source of truth instead of drifting from the indexOf checks
// above it. `-k`/`--root`/... are BOTH the flag token AND (for value flags) consume the next argv
// slot — that slot is tracked separately via each `*i` index below, same as this file always did.
const BOOL_FLAGS = ['--include-secret', '--include-mirror', '--include-inbox', '--include-superseded', '--no-global', '--expand'];
const VALUE_FLAGS = ['--root', '-k', '--mode', '--exclude-source', '--as-of', '--expand-hops', '--expand-budget'];

export function parseArgs(argv = process.argv.slice(2)) {
  // --root <dir>: same meaning/semantics the flag carries in board/handoff/status/nudge/
  // service/query — picks WHICH bundle this run reads, overriding OKF_ROOT. Resolved to a real,
  // existing directory later by resolveBundleRoot(); here we only pull the raw value and reject
  // a missing one, same "needs a value" contract board.mjs/handoff.mjs use for their own --root.
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? argv[ri + 1] : null;
  if (ri >= 0 && (root === undefined || root.startsWith('-'))) throw new Error('--root needs a value');
  const includeSecret = argv.includes('--include-secret');
  const includeMirror = argv.includes('--include-mirror');
  const includeInbox = argv.includes('--include-inbox');
  const includeSuperseded = argv.includes('--include-superseded');
  const noGlobal = argv.includes('--no-global');
  const ki = argv.indexOf('-k');
  const k = ki >= 0 ? parseInt(argv[ki + 1], 10) || 5 : 5;
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : 'auto';
  if (!MODES.includes(mode)) {
    throw new Error(`unknown --mode: ${mode} (allowed: ${MODES.join('|')})`);
  }
  const ei = argv.indexOf('--exclude-source');
  const excludeSource = ei >= 0 ? argv[ei + 1] : null;
  const ai = argv.indexOf('--as-of');
  const asOf = ai >= 0 ? argv[ai + 1] : null;
  if (ai >= 0 && !asOf) throw new Error('--as-of requires an ISO date (e.g. 2025-06-01)');
  // G2 — 1-hop graph expand: `--expand` turns it on; `--expand-hops N` is the same switch spelled
  // with a hop count (N=0 is off, N>=1 is on) — only 1 hop is implemented today, so any N>1 is
  // capped to 1 with a one-line stderr note (ponytail: see expandHits() for the ceiling).
  const ehi = argv.indexOf('--expand-hops');
  const expandHopsArg = ehi >= 0 ? parseInt(argv[ehi + 1], 10) : null;
  if (ehi >= 0 && !Number.isFinite(expandHopsArg)) {
    throw new Error('--expand-hops requires a number (e.g. --expand-hops 1)');
  }
  const expand = argv.includes('--expand') || (expandHopsArg != null && expandHopsArg > 0);
  if (expand && expandHopsArg > 1) {
    console.error(`--expand-hops ${expandHopsArg} > 1 not supported yet — using 1 hop`);
  }
  const ebi = argv.indexOf('--expand-budget');
  const expandBudget = ebi >= 0 ? (parseInt(argv[ebi + 1], 10) || DEFAULT_EXPAND_BUDGET) : DEFAULT_EXPAND_BUDGET;
  const valueSlot = new Set([ri, ki, mi, ei, ai, ehi, ebi].filter(idx => idx >= 0).map(idx => idx + 1));
  // Unknown flag (starts with '-') is a loud error + non-zero exit, not a silent no-op — same
  // family as the nudge --help bug (samemind fixed 09.08) and the 1.0.1 --root fix for
  // board/handoff: `recall --root ./other-bundle` silently doing nothing with an unrecognized
  // flag lets the run "succeed" while quietly searching the wrong bundle.
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueSlot.has(i)) continue; // consumed as some flag's value above
    if (BOOL_FLAGS.includes(a) || VALUE_FLAGS.includes(a)) continue; // the flag token itself
    if (a.startsWith('-')) throw new Error(`unknown flag "${a}"`);
    positional.push(a);
  }
  return {
    positional, k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal,
    includeSuperseded, asOf, expand, expandBudget, root,
  };
}

async function buildIndex(includeSecret, includeMirror, includeInbox, root = ROOT) {
  const docs = load({ includeSecret, includeMirror, includeInbox }, root).filter(d => !d.reserved);
  const store = await openBackend();
  if (store) {
    const { built, reused, total } = await syncVecStore(store, docs, embed, { includeSecret, includeMirror });
    closeVecStore(store);
    console.log(`index (sqlite-vec): ${built} new/changed, ${reused} unchanged, ${total} total (model ${MODEL})`);
    return;
  }
  const idx = loadIdx();
  const key = indexKey(MODEL, EMBED_URL);
  if (idx.indexKey && idx.indexKey !== key) idx.items = {};
  else if (!idx.indexKey && idx.model && idx.model !== MODEL) idx.items = {};
  idx.indexKey = key;
  idx.model = MODEL;
  const { built, reused, total } = await syncIndex(idx, docs, embed, { includeSecret, includeMirror });
  saveIdx(idx);
  console.log(`index (json): ${built} new/changed, ${reused} unchanged, ${total} total (model ${MODEL})`);
}

async function query(q, k, includeSecret, includeMirror, includeInbox, mode, excludeSource, noGlobal, {
  includeSuperseded = false, asOf = null, expand = false, expandBudget = DEFAULT_EXPAND_BUDGET, root = ROOT,
} = {}) {
  // BM25 ranks over concept bodies, so we load the bundle in every mode. `root` (--root, default
  // module ROOT) picks WHICH bundle's docs/ledger this run reads — same one root.mjs semantics
  // board.mjs/handoff.mjs use. Known gap (not fixed here, see F1/1.1.1 report): the *embeddings*
  // index (IDX/IDX_DB below) stays pinned to the module-level ROOT regardless of `root` — a
  // `--root`-selected bundle other than ROOT gets correct BM25 results (recallSearch computes
  // BM25 straight from `docs`) but semantic/hybrid mode would still consult ROOT's own index.
  // tools/lib/compose-roots.mjs `searchRoot`/`idxDirFor` already solve this per-root indexing
  // problem for the *global* half of multi-root recall — reusing it for the project half too is
  // the real fix, left for a follow-up naряд rather than folded into this one.
  const docs = load({ includeSecret, includeMirror, includeInbox }, root).filter(d => !d.reserved);

  // F1b (1.1.1 follow-up) — close the silence above instead of building the real fix.
  // `mode` here is the raw user request (bm25 stays bm25, semantic/hybrid stay themselves, auto
  // resolves later inside recallSearch); `projectMode` is what actually reaches the PROJECT-half
  // recallSearch call below. `--mode semantic`/`--mode hybrid` is an explicit ask for the
  // embeddings index — against a foreign `root` this code cannot honor it (it would silently rank
  // with ROOT's own vectors while printing `root`'s docs/ids — a foreign hit even keeps its
  // stale cached title via finalizeRanked's `c.title` fallback, since its id isn't in `docs`),
  // so it refuses outright rather than return a plausible-looking wrong list. `auto` never
  // explicitly asked for semantics — it's "best effort, degrade quietly" by contract (see its own
  // fallback warnings below) — so it degrades to bm25 with a loud stderr note instead of failing
  // a call nobody meant as a semantic request. `root === ROOT` (no --root, or --root pointing at
  // the same bundle the index was built for) is the untouched default path — byte-identical.
  let projectMode = mode;
  if (root !== ROOT) {
    if (mode === 'semantic' || mode === 'hybrid') {
      throw new Error(
        `--mode ${mode} does not support --root yet (the semantic index is pinned to the default `
        + `bundle, not ${root}) — use --mode bm25, or drop --root and run from inside that bundle`,
      );
    }
    if (mode === 'auto') {
      console.error(
        `note: --root given — auto uses bm25 only here (semantic index is pinned to the default `
        + `bundle, not ${root})`,
      );
      projectMode = 'bm25';
    }
  }
  const store = await openBackend();
  const idx = store ? null : loadIdx();
  const projectResult = await recallSearch({
    docs, query: q, mode: projectMode, embed, idx: idx || { items: {} }, k, includeSecret, includeMirror, excludeSource,
    vecStore: store, vecSearch: store ? searchVecStore : null, vecCount: store ? vecStoreCount : null,
    events: readEvents(root), // Ф5: tiered heat, same hygiene pass
    includeSuperseded, asOf,
  });
  if (store) closeVecStore(store);

  // U5/G-B: "Same mind" — merge in the optional global personal bundle. resolveGlobalRoot()
  // returns null on --no-global / OKF_GLOBAL_ROOT='' / unset+missing-on-disk, in which case
  // searchGlobalHalf short-circuits and mergeWithGlobal passes projectResult through UNCHANGED —
  // byte-identical to pre-G-B output.
  const globalRoot = resolveGlobalRoot({ noGlobal });
  const globalHalf = await searchGlobalHalf(globalRoot, docs, {
    loadOpts: { includeSecret, includeMirror, includeInbox },
    query: q, mode, embed, k, includeSecret, includeMirror, excludeSource, model: MODEL,
    includeSuperseded, asOf,
  });
  const { hits, mode: used, warning, dedupWarnings } = mergeWithGlobal(projectResult, globalHalf, k);

  if (warning) console.error(`⚠ ${warning}`);
  if (dedupWarnings) for (const w of dedupWarnings) console.error(`⚠ ${w}`);
  // Score scale differs by mode — bm25 is unbounded BM25, semantic is cosine (-1..1), hybrid is
  // an RRF-fused rank score (Σ 1/(k+rank+1), k=60) that is SMALL BY DESIGN (~0.01-0.03 for a
  // top hit) and must never be read as a cosine value — label it so nobody mistakes a healthy
  // hybrid result for a broken/near-zero embedding.
  const scoreKind = { bm25: 'bm25', semantic: 'cos', hybrid: 'rrf' }[used] || used;
  console.log(`# "${q}" → top-${k} [${used}, score=${scoreKind}]`);
  for (const r of hits) {
    const idOut = r.source === 'global' ? `global:${r.id}` : r.id;
    console.log(`${r.score.toFixed(3)}  ${(r.type || '').padEnd(10)} ${idOut} — ${r.title || ''}${r.label ? '  ' + r.label : ''}`);
  }
  if (!hits.length) console.log('(nothing found)');

  // G2 — 1-hop graph expand (opt-in via --expand/--expand-hops): walked over the project docs ∪
  // the (already project-deduped) global docs, so a global-root neighbor never shadows a
  // same-id project doc — see expandHits() doc comment. Printed after the primary hits, never
  // folded into their sort/score.
  if (expand) {
    const pool = globalHalf?.docs?.length ? [...docs, ...globalHalf.docs] : docs;
    const extra = expandHits(hits, pool, { budget: expandBudget, asOf, includeSuperseded });
    for (const e of extra) {
      console.log(`  +hop  ${(e.type || '').padEnd(10)} ${(e.kind || '').padEnd(11)} ${e.id} — ${e.title || ''}  ${e.label}`);
    }
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // `mode` is read again in the catch below for the semantic-search hint — kept outside the try
  // (default 'auto') so a parseArgs()/resolveBundleRoot() throw (bad --mode, bad --root, unknown
  // flag) still gets that hint instead of crashing on a read of an unset variable.
  let mode = 'auto';
  try {
    const opts = parseArgs();
    mode = opts.mode;
    // One root for the whole run: docs and the ledger (Ф5 heat) both resolve against it — same
    // "--root wins over OKF_ROOT" contract board.mjs/handoff.mjs/okf-query.mjs use.
    const bundleRoot = resolveBundleRoot(opts.root);
    if (opts.positional[0] === 'index') {
      await buildIndex(opts.includeSecret, opts.includeMirror, opts.includeInbox, bundleRoot);
    } else if (opts.positional.length) {
      await query(
        opts.positional.join(' '), opts.k, opts.includeSecret, opts.includeMirror, opts.includeInbox,
        opts.mode, opts.excludeSource, opts.noGlobal,
        { includeSuperseded: opts.includeSuperseded, asOf: opts.asOf, expand: opts.expand, expandBudget: opts.expandBudget, root: bundleRoot },
      );
    } else {
      console.log('Usage: okf-recall.mjs index | "<query>" [-k N] [--mode bm25|semantic|hybrid|auto] [--root <dir>] [--include-mirror] [--include-secret] [--include-inbox] [--include-superseded] [--as-of <ISO>] [--exclude-source <id>] [--no-global] [--expand] [--expand-hops 1] [--expand-budget N]');
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (mode !== 'bm25') console.error('Hint: --mode bm25 searches without an endpoint; --mode auto (default) enables semantic search when OKF_EMBED_URL is set.');
    process.exit(1);
  }
}

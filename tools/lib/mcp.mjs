// mcp.mjs — логика MCP-инструментов samemind (транспорт-агностичная; см. ../mcp-server.mjs).
// 10 инструментов: memory_search | memory_get | memory_list | memory_write_inbox | memory_handoff
// | memory_health | memory_ledger_append | memory_ledger_status | memory_fleet_status
// | memory_fleet_assign.
//
// Безопасность (см. наряд N3):
//  - visibility: secret НИКОГДА не попадает в docs, которые видят инструменты (load({includeSecret:false}))
//    — ни search, ни get, ни list; без флагов и без исключений.
//  - memory_get принимает id снаружи → assertSafeConceptId (lib/safe-path.mjs) отклоняет любой
//    path traversal (.., абсолютные пути вне bundle) до похода в файловую систему.
//  - memory_write_inbox пишет ТОЛЬКО в inbox/<agent>.md (имя агента санитизируется);
//    атомарная запись (lib/atomic-write.mjs), append-only; контент с признаками prompt-injection
//    не отклоняется, а оборачивается в quarantine fence (tools/lib/injection.mjs).
//  - memory_ledger_append: тот же контракт, что write_inbox — actor из env SAMEMIND_AGENT
//    (санитизируется), пишет ТОЛЬКО в ledger/events.jsonl, `action` сканируется на
//    prompt-injection (issue #3, docs/event-ledger.md); события никогда не удаляются.
//  - memory_fleet_status / memory_fleet_assign: тонкая MCP-обёртка над готовой чистой
//    логикой tools/lib/fleet.mjs (heartbeat/buildAssignment) — никакой логики не дублируется.
//    status read-only (никогда не мутирует); assign переиспользует appendEvent, поэтому
//    получает тот же injection-скан над `action`, что и memory_ledger_append, бесплатно.
//    Невалидный движок/статус/отсутствующий verify — hard error, не тихий фолбэк
//    (см. docs/fleet.md "Security"). Имена *_fleet_* — не *_status/_assign* без префикса —
//    ради единого memory_-неймспейса инструментов (см. docs/fleet.md "Future", предвиденное).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, load, findById } from './okf.mjs';
import {
  fetchEmbedding, recallSearch, extractSnippet, resolveEmbedConfig, expandHits, DEFAULT_EXPAND_BUDGET,
} from './recall.mjs';
import { scanForInjection } from './injection.mjs';
import { buildHeatIndex, heatScore, heatTier } from './hygiene.mjs';
import { loadIdx } from '../okf-recall.mjs';
import { resolveGlobalRoot, searchGlobalHalf, mergeWithGlobal } from './compose-roots.mjs';
import { buildHandoff, DEFAULT_DAYS as HANDOFF_DEFAULT_DAYS } from '../handoff.mjs';
import { appendEvent, readEvents, summarizeLedger, PHASES, STATUSES } from './ledger.mjs';
import { readRegistry, heartbeat, findEngine, buildAssignment } from './fleet.mjs';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { withFileLock } from '../../lib/file-lock.mjs';
import { safeMdPath, assertSafeConceptId, sanitizeAgentName } from '../../lib/safe-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

export const SERVER_NAME = 'samemind';
export const SERVER_VERSION = PKG.version;
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

// env > <ROOT>/.samemind/config.json > hardcoded default (resolveEmbedConfig — same precedence
// okf-recall's index build already uses; setup.mjs, U-B, writes that config.json from a live
// probe, so a bundle set up that way gets semantic `samemind serve` search with zero env vars).
const { url: EMBED_URL, model: EMBED_MODEL } = resolveEmbedConfig(ROOT);
const embed = text => fetchEmbedding(text, { url: EMBED_URL, model: EMBED_MODEL });

// Документы, которые вообще видны MCP-инструментам: НИКОГДА secret, mirror включён (единая
// база памяти агента может законно содержать зеркало живой памяти — не блокируем).
// inbox тоже НИКОГДА (default includeInbox: false, не передаём) — это сырьё, ждущее курации
// (см. issue #4): memory_search/get/list не должны его отдавать. memory_write_inbox — единственный
// путь, который его касается, и это чистая запись в файл, в load() не ходит.
function readableDocs() {
  return load({ includeSecret: false, includeMirror: true }).filter(d => !d.reserved);
}

export const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search the memory bundle (semantic if an index exists and answers, BM25 fallback otherwise). Never returns secret-visibility concepts. Pass exclude_source (an engine id like "claude-code") to filter out concepts authored by that source — anti-echo, so an engine does not get back what it just wrote. Results also fold in the global personal bundle ($HOME/.samemind/bundle by default, U5 "Same mind") — those hits carry source: "global"; pass no_global: true to search the project bundle only. Pass expand: true to also pull in 1-hop graph neighbors (typed `relations` edges + reverse wikilinks) of the top hits, returned in a separate `expanded` block — same graph-expand CLI users get via `okf-recall.mjs --expand` (G2); budget-capped via expand_budget (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        k: { type: 'integer', minimum: 1, description: 'Max results (default 5)' },
        mode: { type: 'string', enum: ['bm25', 'semantic', 'hybrid', 'auto'], description: 'Search mode (default auto). hybrid (Ф3) fuses BM25+semantic via RRF, falls back to BM25 if the embeddings endpoint is unavailable.' },
        exclude_source: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'Drop concepts whose frontmatter `source` is this id (anti-echo). Lowercase letters, digits, hyphens only.' },
        no_global: { type: 'boolean', description: 'Skip the global personal bundle — search only this project\'s memory (default false).' },
        expand: { type: 'boolean', description: '1-hop graph expand: also return neighbors of the top hits (relations + reverse wikilinks), in a separate `expanded` block, never mixed into `results` ranking (default false).' },
        expand_budget: { type: 'integer', minimum: 1, description: `Max expanded neighbors, shared across all seed hits (default ${DEFAULT_EXPAND_BUDGET}). Only used when expand is true.` },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one concept (full frontmatter + body) by id. Refuses secret-visibility concepts and any id outside the bundle (path traversal).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Concept id, e.g. "projects/lumen"' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description: 'List concepts in the bundle, optionally filtered by type or tag. Never lists secret-visibility concepts.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by frontmatter type (e.g. Project, Concept)' },
        tag: { type: 'string', description: 'Filter by tag' },
      },
    },
  },
  {
    name: 'memory_write_inbox',
    description: 'Append a note to inbox/<agent>.md — the only writable path. Agent name comes from env SAMEMIND_AGENT (default "mcp"), sanitized to [a-z0-9-]. Content resembling prompt injection is never dropped, only wrapped and flagged quarantine:true.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note body to append' },
        title: { type: 'string', description: 'Optional short heading for the entry' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_handoff',
    description: 'Work-state handoff brief: active tasks, recent decisions, plans in force, last session, open questions. Call at session start after /compact or engine switch. Never includes secret-visibility concepts. Not the identity brief (use samemind brief / identity layer for that).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project filter (e.g. "lumen" or "/projects/lumen.md")' },
        days: { type: 'integer', minimum: 1, description: 'Decision lookback window in days (default 14)' },
      },
    },
  },
  {
    name: 'memory_health',
    description: 'Bundle root, concept count, active search mode, tiered-heat counts (hot/warm/cold — Ф5, from the event ledger), samemind version.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_ledger_append',
    description: 'Append one event to the append-only event ledger (ledger/events.jsonl) — fine-grained "who did what step, when", complementing (not replacing) the coarser Task.status. Actor comes from env SAMEMIND_AGENT (default "mcp"), same as memory_write_inbox. `action` is scanned for prompt-injection heuristics; flagged text is still recorded (quarantine:true), never dropped. See docs/event-ledger.md.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Naryad/work-item id this event belongs to' },
        phase: { type: 'string', enum: [...PHASES], description: 'Lifecycle phase of this event' },
        status: { type: 'string', enum: [...STATUSES], description: 'Outcome of this event (default "ok")' },
        action: { type: 'string', description: 'What happened, one line' },
        artifact: { type: 'string', description: 'Optional artifact reference (branch, commit, file, URL)' },
        ref: { type: 'string', description: 'Optional external reference (issue id, PR, ticket)' },
      },
      required: ['topic', 'phase', 'action'],
    },
  },
  {
    name: 'memory_ledger_status',
    description: 'Read-only summary of the event ledger: current stage per topic (last event) and open failures — fail/block-phase events not yet closed by a later done-phase or ok-status event of the same topic — freshest first. See docs/event-ledger.md.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_fleet_status',
    description: 'Read-only fleet registry summary (fleet/registry.json): every declared engine with its role/status and a heartbeat — last seen (from the event ledger), seconds silent, and whether that exceeds its declared heartbeatSec (overdue). No registry yet → { registry: false }. Never mutates anything. See docs/fleet.md.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_fleet_assign',
    description: 'Declare an assignment to one engine already in the fleet registry (fleet/registry.json) and log it as a `start` event in the event ledger (ledger/events.jsonl) — same storage memory_ledger_append uses, no second format. `verify` is required: an assignment without a verification step is a wish, not a task. Fails hard — does not silently fall back — when the registry is missing, the engine is unknown, or the engine is not `active`. The combined action text runs through the same prompt-injection scan every write path in this project uses (never dropped, only flagged quarantine:true). Pass `ref` (a client-side idempotency key, e.g. the voice utterance id) to dedup: a second assign with a `ref` already in the ledger is a no-op that returns {deduped:true} instead of writing a duplicate assignment. See docs/fleet.md.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: { type: 'string', description: 'Engine id already declared in fleet/registry.json (see memory_fleet_status)' },
        topic: { type: 'string', description: 'Naryad/work-item id' },
        goal: { type: 'string', description: 'What the engine should accomplish' },
        verify: { type: 'string', description: 'How the result will be verified — required' },
        boundaries: { type: 'array', items: { type: 'string' }, description: 'Optional path/scope boundaries' },
        stopPoints: { type: 'array', items: { type: 'string' }, description: "Optional override of stop-points (default: the registry's own stopPoints)" },
        ref: { type: 'string', description: 'Optional idempotency key / external reference (e.g. voice utterance id, issue id). A second assign with the same ref is deduped — no duplicate assignment event is written. The actor stays the target engine (so heartbeat still counts it alive); the issuer (SAMEMIND_AGENT env, sanitized) is recorded in the event action so the ledger is attributable.' },
      },
      required: ['engine', 'topic', 'goal', 'verify'],
    },
  },
];

async function memorySearch({
  query, k = 5, mode = 'auto', exclude_source, no_global, expand, expand_budget,
} = {}) {
  if (!query || !String(query).trim()) throw new Error('memory_search: "query" is required');
  const kk = Number.isFinite(Number(k)) && Number(k) > 0 ? Math.floor(Number(k)) : 5;
  const doExpand = !!expand;
  const budget = Number.isFinite(Number(expand_budget)) && Number(expand_budget) > 0
    ? Math.floor(Number(expand_budget))
    : DEFAULT_EXPAND_BUDGET;
  let excludeSource = null;
  if (exclude_source !== undefined && exclude_source !== null && String(exclude_source).trim()) {
    excludeSource = String(exclude_source);
    if (!/^[a-z0-9-]+$/.test(excludeSource)) {
      throw new Error(`memory_search: "exclude_source" must match [a-z0-9-] (got "${excludeSource}")`);
    }
  }
  const docs = readableDocs();
  const docById = new Map(docs.map(d => [d.id, d]));
  const idx = loadIdx();
  const events = readEvents(ROOT); // Ф5: ledger-derived heat, folded into the same hygiene pass
  const projectResult = await recallSearch({
    docs, query, mode, embed, idx, k: kk, includeSecret: false, includeMirror: true, excludeSource, events,
  });

  // U5/G-B: "Same mind" — fold in the optional global personal bundle. no_global truthy, or no
  // bundle at $HOME/.samemind/bundle (or OKF_GLOBAL_ROOT) on disk → mergeWithGlobal passes
  // projectResult through UNCHANGED (byte-identical JSON payload to before G-B).
  const globalRoot = resolveGlobalRoot({ noGlobal: !!no_global });
  const globalHalf = await searchGlobalHalf(globalRoot, docs, {
    loadOpts: { includeSecret: false, includeMirror: true }, query, mode, embed, k: kk,
    includeSecret: false, includeMirror: true, excludeSource,
  });
  const { hits, mode: used, warning, dedupWarnings } = mergeWithGlobal(projectResult, globalHalf, kk);
  const globalDocById = globalHalf ? new Map(globalHalf.docs.map(d => [d.id, d])) : new Map();

  const results = hits.map(h => {
    const doc = docById.get(h.id) || globalDocById.get(h.id);
    return {
      id: h.id,
      type: h.type || doc?.fm.type || null,
      title: h.title || doc?.fm.title || null,
      score: Number.isFinite(h.score) ? Number(h.score.toFixed(4)) : 0,
      snippet: extractSnippet(doc?.body || '', query, { contextLines: 1 }),
      hygiene: h.label || null, // e.g. "[superseded by /concepts/new.md]" — see docs/memory-hygiene.md
      ...(h.source ? { source: h.source } : {}), // only present once a global hit is in the mix
    };
  });
  const warnings = [warning, ...(dedupWarnings || [])].filter(Boolean);
  const out = {
    query, mode: used, warning: warnings.length ? warnings.join('; ') : null, count: results.length, results,
  };

  // G2 — 1-hop graph expand (opt-in, MCP parity with `okf-recall.mjs --expand`): walked over the
  // project docs ∪ the (already project-deduped) global docs — same pool okf-recall.mjs's own
  // `query()` builds — so a global-root neighbor never shadows a same-id project doc. `docs` here
  // is readableDocs() (secret always excluded, see module header); globalHalf.docs is loaded with
  // the same includeSecret:false above — so the expand pool can never contain a secret concept,
  // and expandHits' own hygiene gate (isDeprecated/isStaleForRecall) drops superseded/deprecated
  // neighbors on top of that. Kept as its own `expanded` block, never merged into `results`.
  if (doExpand) {
    const pool = globalHalf?.docs?.length ? [...docs, ...globalHalf.docs] : docs;
    const extra = expandHits(hits, pool, { budget });
    out.expanded = extra.map(e => {
      const doc = docById.get(e.id) || globalDocById.get(e.id);
      return {
        id: e.id,
        type: e.type || null,
        title: e.title || null,
        hop: 1,
        expandedFrom: e.expandedFrom,
        snippet: extractSnippet(doc?.body || '', query, { contextLines: 1 }),
      };
    });
  }
  return out;
}

async function memoryGet({ id } = {}) {
  const rel = assertSafeConceptId(id, ROOT); // throws on traversal/empty id — before touching docs
  const docs = readableDocs(); // secret already excluded at the load() level
  const hits = findById(docs, rel);
  if (!hits.length) return { found: false, id: rel };
  if (hits.length > 1) {
    throw new Error(`memory_get: ambiguous — ${hits.length} matches for "${rel}": ${hits.map(d => d.id).join(', ')}`);
  }
  const doc = hits[0];
  if ((doc.fm.visibility || 'internal') === 'secret') return { found: false, id: rel }; // defense-in-depth
  const raw = readFileSync(doc.file, 'utf8');
  return {
    found: true,
    id: doc.id,
    type: doc.fm.type || null,
    title: doc.fm.title || null,
    visibility: doc.fm.visibility || 'internal',
    tags: doc.fm.tags || [],
    content: raw,
  };
}

async function memoryList({ type, tag } = {}) {
  let docs = readableDocs();
  if (type) docs = docs.filter(d => (d.fm.type || '').toLowerCase() === String(type).toLowerCase());
  if (tag) docs = docs.filter(d => (d.fm.tags || []).map(t => String(t).toLowerCase()).includes(String(tag).toLowerCase()));
  return {
    count: docs.length,
    items: docs
      .map(d => ({ id: d.id, type: d.fm.type || null, title: d.fm.title || null, visibility: d.fm.visibility || 'internal' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function memoryWriteInbox({ content, title } = {}) {
  if (content === undefined || content === null || !String(content).trim()) {
    throw new Error('memory_write_inbox: "content" is required and cannot be empty');
  }
  const agent = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const inboxDir = join(ROOT, 'inbox');
  mkdirSync(inboxDir, { recursive: true }); // must exist before acquireLock's mkdir(`${target}.lock`)
  const target = safeMdPath(inboxDir, agent);

  const text = String(content);
  const scan = scanForInjection(text);
  const timestamp = new Date().toISOString();
  const heading = title && String(title).trim() ? String(title).trim() : '(untitled)';

  const block = scan.flagged
    ? [
      `## ${timestamp} — ${heading}`,
      `quarantine: true  <!-- patterns: ${scan.matches.join(', ')} -->`,
      '',
      '```quarantine',
      text,
      '```',
      '',
    ].join('\n')
    : [
      `## ${timestamp} — ${heading}`,
      '',
      text.trim(),
      '',
    ].join('\n');

  // withFileLock: read-modify-write guarded against concurrent writers of the SAME inbox file
  // (the fleet all writing as one agent name, or `capture.mjs`'s appendInbox racing this same
  // path — both key the lock off `target`, so they mutually exclude each other too).
  const next = withFileLock(target, () => {
    const existing = existsSync(target)
      ? readFileSync(target, 'utf8')
      : `---\nokf_version: "0.1"\n---\n\n# Inbox — ${agent}\n\nAppend-only notes written via samemind MCP (memory_write_inbox).\n\n`;

    const body = `${existing.replace(/\n*$/, '\n\n')}${block}\n`;
    atomicWriteFileSync(target, body);
    return body;
  });

  return {
    ok: true,
    agent,
    file: relative(ROOT, target),
    quarantined: scan.flagged,
    matches: scan.matches,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
  };
}

async function memoryHandoff({ project, days } = {}) {
  const docs = readableDocs(); // secret already excluded
  const dayWindow = Number.isFinite(Number(days)) && Number(days) > 0
    ? Math.floor(Number(days))
    : HANDOFF_DEFAULT_DAYS;
  const { markdown, sections, warnings, project: projectKey } = buildHandoff(docs, {
    project: project || null,
    days: dayWindow,
  });
  return {
    markdown,
    project: projectKey,
    days: dayWindow,
    sections,
    warnings,
  };
}

async function memoryHealth() {
  const docs = readableDocs();
  const idx = loadIdx();
  const hasIndex = !!(idx && idx.items && Object.keys(idx.items).length > 0);
  // Ф5: tiered heat — hot/warm/cold counts over the same ledger-derived heatIndex recall uses
  // (see tools/lib/hygiene.mjs), so `memory_health` gives a bundle-wide read of what's actively
  // being touched vs. sitting cold, without a second ranking pass.
  const heatIndex = buildHeatIndex(readEvents(ROOT));
  const heatTiers = { hot: 0, warm: 0, cold: 0 };
  for (const d of docs) heatTiers[heatTier(heatScore(d, heatIndex))]++;
  return {
    root: ROOT,
    concepts: docs.length,
    searchMode: hasIndex ? 'semantic (index present; BM25 fallback if endpoint unavailable)' : 'bm25 (no semantic index — set OKF_EMBED_URL + run recall index)',
    embedUrl: EMBED_URL,
    heatTiers,
    version: SERVER_VERSION,
  };
}

async function memoryLedgerAppend({ topic, phase, status, action, artifact, ref } = {}) {
  const actor = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const rec = appendEvent(ROOT, { actor, topic, phase, status, action, artifact, ref });
  if (rec.deduped) {
    return {
      ok: true,
      deduped: true,
      actor: rec.event.actor,
      topic: rec.event.topic,
      phase: rec.event.phase,
      status: rec.event.status,
      quarantine: rec.event.quarantine,
      matches: rec.event.matches,
    };
  }
  return {
    ok: true,
    actor: rec.actor,
    topic: rec.topic,
    phase: rec.phase,
    status: rec.status,
    quarantine: rec.quarantine,
    matches: rec.matches,
  };
}

async function memoryLedgerStatus() {
  const { topics, openFailures } = summarizeLedger(readEvents(ROOT));
  return {
    topics: topics.map(t => ({ topic: t.topic, count: t.count, open: !!t.openFail, last: t.last })),
    openFailures,
  };
}

async function memoryFleetStatus() {
  const registry = readRegistry(ROOT);
  if (!registry) {
    return {
      registry: false, message: 'no fleet registry yet — run `samemind fleet init`', engines: [], overdue: [],
    };
  }
  const engines = heartbeat(registry.engines, readEvents(ROOT), Date.now());
  return {
    registry: true,
    stopPoints: registry.stopPoints,
    engines,
    overdue: engines.filter(e => e.overdue).map(e => e.id),
  };
}

async function memoryFleetAssign({
  engine, topic, goal, verify, boundaries, stopPoints, ref,
} = {}) {
  const registry = readRegistry(ROOT);
  if (!registry) {
    const err = new Error('memory_fleet_assign: no fleet registry — run `samemind fleet init` first');
    err.code = 'NO_REGISTRY';
    throw err;
  }
  const eng = findEngine(registry, engine);
  if (!eng) {
    const err = new Error(`memory_fleet_assign: engine "${engine}" is not in the registry`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (eng.status !== 'active') {
    const err = new Error(`memory_fleet_assign: engine "${engine}" is "${eng.status}", not active — not assignable`);
    err.code = 'ENGINE_NOT_ACTIVE';
    throw err;
  }
  const effectiveStopPoints = Array.isArray(stopPoints) && stopPoints.length ? stopPoints : registry.stopPoints;
  const assignment = buildAssignment({
    engine, topic, goal, verify, boundaries, stopPoints: effectiveStopPoints,
  });
  // Атрибуция выдавшего: SAMEMIND_AGENT окружения, через тот же sanitizeAgentName, что write_inbox
  // и ledger_append. Актор остаётся целевым движком (heartbeat считает «последний раз видели» по
  // актору — не ломаем); выдавший попадает в текст action через парсимый маркер `[by <issuer>]`,
  // чтобы летопись была атрибутируемой без нового поля и без изменений существующих читателей
  // (доска парсит action как свободный текст; artifact остаётся чистым носителем boundaries).
  const issuer = sanitizeAgentName(process.env.SAMEMIND_AGENT);
  const baseAction = `assigned: ${assignment.goal} — verify: ${assignment.verify}`;
  const action = issuer && issuer !== assignment.engine
    ? `${baseAction} [by ${issuer}]`
    : baseAction;
  const rec = appendEvent(ROOT, {
    actor: assignment.engine,
    topic: assignment.topic,
    phase: 'start',
    status: 'ok',
    action,
    artifact: assignment.boundaries.join('; ') || null,
    ref,
  });
  if (rec.deduped) {
    return {
      ok: true,
      deduped: true,
      engine: assignment.engine,
      topic: assignment.topic,
      ref: rec.event.ref || null,
      quarantine: rec.event.quarantine,
      matches: rec.event.matches,
    };
  }
  return {
    ok: true,
    engine: assignment.engine,
    topic: assignment.topic,
    goal: assignment.goal,
    verify: assignment.verify,
    stopPoints: assignment.stopPoints,
    quarantine: rec.quarantine,
    matches: rec.matches,
  };
}

const HANDLERS = {
  memory_search: memorySearch,
  memory_get: memoryGet,
  memory_list: memoryList,
  memory_write_inbox: memoryWriteInbox,
  memory_handoff: memoryHandoff,
  memory_health: memoryHealth,
  memory_ledger_append: memoryLedgerAppend,
  memory_ledger_status: memoryLedgerStatus,
  memory_fleet_status: memoryFleetStatus,
  memory_fleet_assign: memoryFleetAssign,
};

// Machine-readable error codes for `isError: true` responses — an agent consuming the MCP
// result shouldn't have to string-match `message` to branch on failure kind. Preference order:
// the code already set on the Error where it was thrown (see assertSafeConceptId in
// lib/safe-path.mjs, memoryFleetAssign above) — text matching below is only a fallback for
// throws that don't (yet) set one.
const ERROR_TEXT_CODES = [
  [/no fleet registry/i, 'NO_REGISTRY'],
  [/not active/i, 'ENGINE_NOT_ACTIVE'],
  [/not found/i, 'NOT_FOUND'],
  [/traversal|invalid id/i, 'INVALID_ID'],
  [/injection/i, 'REJECTED_INJECTION'],
];

function classifyError(e) {
  if (e && e.code) return e.code;
  const msg = String(e?.message || '');
  for (const [re, code] of ERROR_TEXT_CODES) {
    if (re.test(msg)) return code;
  }
  return 'INTERNAL';
}

/** Выполняет вызов инструмента, никогда не бросает — ошибки → { isError: true }. */
export async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const code = classifyError(e);
    return { content: [{ type: 'text', text: `Error [${code}]: ${e.message}` }], isError: true };
  }
}

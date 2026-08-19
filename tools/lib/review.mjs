// review.mjs — weekly memory review candidate collection (Э7.4a / Ф7.4 MVP).
// Pure graph/hygiene logic over loaded docs — no filesystem writes. See tools/review.mjs CLI.
import { statSync } from 'node:fs';
import {
  buildSupersededMap, buildHeatIndex, decayMultiplier, heatScore, isDeprecated,
  isSuperseded, isTemporallySuperseded, findContradictions, TIMELESS_TYPES,
} from './hygiene.mjs';
import { buildLinksModel } from '../okf-query.mjs';

export const DEFAULT_STALE_DAYS = 60;
const DAY_MS = 86_400_000;

/** Epoch ms of last touch — max(parseable timestamp, file mtime). Missing both → null. */
export function docTouchMs(doc) {
  let touch = null;
  const ts = doc?.fm?.timestamp;
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isFinite(t)) touch = t;
  }
  if (doc?.file) {
    try {
      const m = statSync(doc.file).mtimeMs;
      if (Number.isFinite(m)) touch = touch == null ? m : Math.max(touch, m);
    } catch { /* synthetic doc in tests */ }
  }
  return touch;
}

export function docAgeDays(doc, now = Date.now()) {
  const touch = docTouchMs(doc);
  if (touch == null) return null;
  return (now - touch) / DAY_MS;
}

function inboundCount(id, linksModel) {
  return linksModel.edges.filter(e => e.to === id).length;
}

function outboundCount(id, linksModel) {
  return linksModel.edges.filter(e => e.from === id).length;
}

function connectionsFor(id, linksModel, { conflictWith = null } = {}) {
  const inbound = inboundCount(id, linksModel);
  const outbound = outboundCount(id, linksModel);
  const peers = conflictWith ? [conflictWith] : [];
  return { inbound, outbound, peers };
}

function isArchivedPath(id) {
  return String(id).startsWith('archive/');
}

/**
 * Stale: untouched > staleDays AND low hygiene decay signal (decay penalty active OR no heat).
 * Skips timeless types, deprecated/superseded (separate categories).
 */
export function collectStaleCandidates(docs, {
  now = Date.now(), staleDays = DEFAULT_STALE_DAYS, heatIndex = null,
} = {}) {
  const supersededMap = buildSupersededMap(docs);
  const out = [];
  for (const d of docs) {
    if (d.reserved || isArchivedPath(d.id)) continue;
    if (TIMELESS_TYPES.has(d.fm?.type)) continue;
    if (isDeprecated(d) || isSuperseded(d, supersededMap) || isTemporallySuperseded(d, now)) continue;
    const ageDays = docAgeDays(d, now);
    if (ageDays == null || ageDays <= staleDays) continue;
    const decay = decayMultiplier(d, now);
    const heat = heatIndex ? heatScore(d, heatIndex, now) : 0;
    if (decay >= 1.0 && heat > 0) continue;
    out.push({
      id: d.id,
      reasons: ['stale'],
      ageDays: Math.floor(ageDays),
      connections: null,
      suggested: 'forget',
    });
  }
  return out;
}

/** Unresolved contradiction pairs (Э6) — reuse findContradictions. */
export function collectConflictCandidates(docs, { threshold } = {}) {
  const pairs = findContradictions(docs, threshold != null ? { threshold } : {});
  const byId = new Map();
  for (const { a, b, score } of pairs) {
    for (const [id, peer] of [[a, b], [b, a]]) {
      const prev = byId.get(id);
      if (prev && prev.conflictWith !== peer) continue;
      byId.set(id, {
        id,
        reasons: ['conflict'],
        ageDays: null,
        connections: { inbound: null, outbound: null, peers: [peer] },
        suggested: 'merge',
        conflictWith: peer,
        conflictScore: score,
      });
    }
  }
  return [...byId.values()];
}

/** Superseded or deprecated concepts still in the live tree (not under archive/). */
export function collectUnarchivedStale(docs, { now = Date.now() } = {}) {
  const supersededMap = buildSupersededMap(docs);
  const out = [];
  for (const d of docs) {
    if (d.reserved || isArchivedPath(d.id)) continue;
    const superseded = isSuperseded(d, supersededMap) || isTemporallySuperseded(d, now);
    const deprecated = isDeprecated(d);
    if (!superseded && !deprecated) continue;
    const ageDays = docAgeDays(d, now);
    out.push({
      id: d.id,
      reasons: [deprecated ? 'deprecated' : 'superseded'],
      ageDays: ageDays == null ? null : Math.floor(ageDays),
      connections: null,
      suggested: 'archive',
    });
  }
  return out;
}

/** Orphans: no inbound graph edge (md-link, relation, or supersedes). */
export function collectOrphanCandidates(docs, linksModel) {
  const orphanSet = new Set(linksModel.orphans);
  return docs
    .filter(d => !d.reserved && orphanSet.has(d.id) && !isArchivedPath(d.id))
    .map(d => {
      const ageDays = docAgeDays(d);
      return {
        id: d.id,
        reasons: ['orphan'],
        ageDays: ageDays == null ? null : Math.floor(ageDays),
        connections: connectionsFor(d.id, linksModel),
        suggested: 'archive',
      };
    });
}

/** Merge candidate lists; one row per id with combined reasons (first suggested wins by priority). */
const SUGGEST_PRIORITY = Object.freeze({ merge: 0, archive: 1, forget: 2, keep: 3 });

export function mergeReviewCandidates(lists, linksModel) {
  const map = new Map();
  for (const list of lists) {
    for (const c of list) {
      const prev = map.get(c.id);
      if (!prev) {
        const connections = c.connections
          || connectionsFor(c.id, linksModel, { conflictWith: c.conflictWith });
        map.set(c.id, { ...c, connections, reasons: [...c.reasons] });
        continue;
      }
      for (const r of c.reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r);
      if (c.conflictWith && !prev.conflictWith) prev.conflictWith = c.conflictWith;
      if (c.conflictScore != null) prev.conflictScore = c.conflictScore;
      if ((SUGGEST_PRIORITY[c.suggested] ?? 9) < (SUGGEST_PRIORITY[prev.suggested] ?? 9)) {
        prev.suggested = c.suggested;
      }
      if (prev.ageDays == null && c.ageDays != null) prev.ageDays = c.ageDays;
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildReviewCandidates(docs, {
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
  heatIndex = null,
  root,
} = {}) {
  const cs = (docs || []).filter(d => !d.reserved);
  const linksModel = buildLinksModel(docs, { root });
  const heat = heatIndex ?? buildHeatIndex([]);
  return mergeReviewCandidates([
    collectStaleCandidates(cs, { now, staleDays, heatIndex: heat }),
    collectConflictCandidates(cs),
    collectUnarchivedStale(cs, { now }),
    collectOrphanCandidates(cs, linksModel),
  ], linksModel);
}

export function reasonLine(c) {
  const parts = [];
  if (c.reasons.includes('stale')) parts.push(`не трогали ${c.ageDays ?? '?'}d, низкий decay/heat`);
  if (c.reasons.includes('conflict')) {
    parts.push(`конфликт с ${c.conflictWith}${c.conflictScore != null ? ` (sim ${c.conflictScore.toFixed(2)})` : ''}`);
  }
  if (c.reasons.includes('superseded')) parts.push('superseded, не в archive/');
  if (c.reasons.includes('deprecated')) parts.push('deprecated, не в archive/');
  if (c.reasons.includes('orphan')) parts.push('нет входящих связей');
  return parts.join('; ') || c.reasons.join(', ');
}

export function connectionsLine(c) {
  const conn = c.connections;
  if (!conn) return '—';
  const bits = [];
  if (conn.inbound != null) bits.push(`in ${conn.inbound}`);
  if (conn.outbound != null) bits.push(`out ${conn.outbound}`);
  if (conn.peers?.length) bits.push(`peers: ${conn.peers.join(', ')}`);
  return bits.length ? bits.join(', ') : '—';
}

export function renderReviewText(candidates, { staleDays = DEFAULT_STALE_DAYS } = {}) {
  const L = [];
  L.push(`# Memory review — ${candidates.length} candidate(s) (~10 min)`);
  L.push(`_Generated by \`samemind review\`. Human-gate: nothing changes until you run \`review apply --plan <file>\` or choose in interactive mode. No auto-deletes — \`forget\` is soft-deprecate only._`);
  L.push(`_Stale threshold: ${staleDays}d (decay penalty or zero heat)._`);
  L.push('');
  if (!candidates.length) {
    L.push('_No candidates — bundle looks tidy for this pass._');
    return L.join('\n');
  }
  for (const c of candidates) {
    const age = c.ageDays == null ? '—' : `${c.ageDays}d`;
    L.push(`- **${c.id}** — ${reasonLine(c)} | age ${age} | ${connectionsLine(c)} → \`${c.suggested}\`${c.conflictWith ? ` (${c.conflictWith})` : ''}`);
  }
  L.push('');
  L.push('_Actions: `keep` · `merge <target>` · `archive` · `forget` — explicit only, see docs/memory-hygiene.md § Weekly review._');
  return L.join('\n');
}

export function renderReviewJson(candidates, meta = {}) {
  return {
    kind: 'review',
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    ...meta,
    candidates: candidates.map(c => ({
      id: c.id,
      reasons: c.reasons,
      reason: reasonLine(c),
      ageDays: c.ageDays,
      connections: c.connections,
      suggested: c.suggested,
      conflictWith: c.conflictWith ?? null,
      type: null,
    })),
  };
}

/** Parse a plan file: lines `id <tab|space> action [target]`. # comments and blank lines skipped. */
export function parseReviewPlan(raw) {
  const decisions = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/[\t ]+/).filter(Boolean);
    if (parts.length < 2) throw new Error(`invalid plan line: ${line}`);
    const [id, action, target] = parts;
    const a = action.toLowerCase();
    if (!['keep', 'merge', 'archive', 'forget'].includes(a)) {
      throw new Error(`unknown action "${action}" for ${id}`);
    }
    if (a === 'merge' && !target) throw new Error(`merge requires a target for ${id}`);
    decisions.push({ id, action: a, target: target || null });
  }
  return decisions;
}

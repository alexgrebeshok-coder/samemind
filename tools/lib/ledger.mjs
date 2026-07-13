// ledger.mjs — append-only event ledger: fine-grained "who did what step, when" events,
// complementing (not replacing) the coarse-grained work-discipline layer where `Task.status`
// is edited in place (see docs/work-discipline.md, docs/event-ledger.md). Closes
// alexgrebeshok-coder/samemind#3.
//
// Storage: <root>/ledger/events.jsonl — one JSON object per line, append-only, a single
// flat file (no monthly rotation; see docs/event-ledger.md for why). `ledger/` is a reserved
// tier like inbox/secret/mirror: never walked as a graph concept (tools/lib/okf.mjs `walk()`).
//
// Zero dependencies; reuses this package's own primitives: `lib/atomic-write.mjs` for the
// write (temp file + rename — same contract `memory_write_inbox` already uses for its
// read-modify-write append) and `tools/lib/injection.mjs` for the same prompt-injection
// heuristic scan every writable tier in this package runs over free-form text.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { withFileLock } from '../../lib/file-lock.mjs';
import { scanForInjection } from './injection.mjs';

export const LEDGER_DIR_NAME = 'ledger';
export const LEDGER_FILE_NAME = 'events.jsonl';

// Lifecycle phase and outcome status dictionaries. Unlike ~/.claude/memory-bridge/journal.mjs
// (the prior art this issue names), invalid values are REJECTED, not silently coerced to a
// fallback — samemind's own validate-not-coerce convention (see disciplineChecks/knowledgeChecks
// in tools/lib/okf.mjs).
export const PHASES = new Set(['start', 'step', 'done', 'fail', 'block', 'note']);
export const STATUSES = new Set(['ok', 'wip', 'partial', 'fail']);

export function ledgerDir(root) { return join(root, LEDGER_DIR_NAME); }
export function ledgerFile(root) { return join(ledgerDir(root), LEDGER_FILE_NAME); }

function nowISO() { return new Date().toISOString(); }

/**
 * Builds and validates one event record (pure, no I/O). Throws on invalid/missing required
 * fields — callers (CLI, MCP tool) let the error surface rather than papering over bad input.
 * `action` is scanned for prompt-injection heuristics (same patterns `memory_write_inbox`
 * uses); flagged text is never dropped, only marked `quarantine: true` with the matched labels.
 */
export function buildEvent({ actor, topic, phase, status = 'ok', action, artifact, ref, ts } = {}) {
  const a = String(actor ?? '').trim();
  if (!a) throw new Error('ledger: "actor" is required');
  const t = String(topic ?? '').trim();
  if (!t) throw new Error('ledger: "topic" is required');
  const p = String(phase ?? '').trim();
  if (!PHASES.has(p)) {
    throw new Error(`ledger: "phase" must be one of ${[...PHASES].join('|')} (got "${phase ?? ''}")`);
  }
  const s = String(status ?? 'ok').trim() || 'ok';
  if (!STATUSES.has(s)) {
    throw new Error(`ledger: "status" must be one of ${[...STATUSES].join('|')} (got "${status}")`);
  }
  const act = String(action ?? '').trim();
  if (!act) throw new Error('ledger: "action" is required');

  const scan = scanForInjection(act);
  const artifactStr = artifact !== undefined && artifact !== null ? String(artifact).trim() : '';
  const refStr = ref !== undefined && ref !== null ? String(ref).trim() : '';

  return {
    ts: ts || nowISO(),
    actor: a,
    topic: t,
    phase: p,
    status: s,
    action: act,
    artifact: artifactStr || null,
    ref: refStr || null,
    quarantine: scan.flagged,
    matches: scan.matches,
  };
}

/**
 * Appends one validated event to <root>/ledger/events.jsonl. Read-modify-write, guarded by
 * `withFileLock` (lib/file-lock.mjs — mkdir-based mutual exclusion + stale-lock takeover) so
 * two agents appending at the same instant can't clobber each other's line, then written
 * through `atomicWriteFileSync` (temp file + rename) so a crash mid-write never corrupts the
 * file. Together: safe against both a concurrent fleet of writers AND partial writes (closes
 * alexgrebeshok-coder/samemind concurrent-write hardening; see docs/event-ledger.md).
 */
export function appendEvent(root, fields) {
  const rec = buildEvent(fields);
  const dir = ledgerDir(root);
  mkdirSync(dir, { recursive: true });
  const file = ledgerFile(root);
  withFileLock(file, () => {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = existing + JSON.stringify(rec) + '\n';
    atomicWriteFileSync(file, next);
  });
  return rec;
}

/** Reads every event from <root>/ledger/events.jsonl. Missing file → []. Corrupt lines skipped, never throw. */
export function readEvents(root) {
  const file = ledgerFile(root);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line, never throw */ }
  }
  return out;
}

/**
 * Groups events by topic → { topics, openFailures }.
 *   - `topics`: one entry per topic, newest-last-event first: { topic, last, count, openFail, evs }.
 *   - `openFailures`: the last fail/block-phase event of each topic that has NOT since been
 *     closed by a later closing event of the same topic, newest first.
 *
 * A "closing" event is `phase === 'done'` OR `status === 'ok'` (any phase) — wider than
 * journal.mjs's `phase === 'done'`-only rule: a plain "step, status ok" after a failure means
 * the topic is moving again, and that resolves the open-failure flag too (see
 * docs/event-ledger.md for the reasoning).
 */
export function summarizeLedger(events) {
  const byTopic = new Map();
  for (const e of events) {
    if (!byTopic.has(e.topic)) byTopic.set(e.topic, []);
    byTopic.get(e.topic).push(e);
  }
  const topics = [];
  const openFailures = [];
  for (const [topic, evsRaw] of byTopic) {
    const evs = [...evsRaw].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    const last = evs[evs.length - 1];
    const closingEvs = evs.filter(e => e.phase === 'done' || e.status === 'ok');
    const lastClosingTs = closingEvs.length ? closingEvs[closingEvs.length - 1].ts : '';
    const failEvs = evs.filter(e => e.phase === 'fail' || e.phase === 'block');
    const lastFail = failEvs.length ? failEvs[failEvs.length - 1] : null;
    const openFail = (lastFail && String(lastFail.ts) >= String(lastClosingTs)) ? lastFail : null;
    if (openFail) openFailures.push({ ...openFail, topic });
    topics.push({ topic, last, count: evs.length, openFail, evs });
  }
  topics.sort((x, y) => String(y.last.ts).localeCompare(String(x.last.ts)));
  openFailures.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
  return { topics, openFailures };
}

/** All events for one topic, chronological (oldest first). */
export function readTopic(root, topic) {
  return readEvents(root)
    .filter(e => e.topic === topic)
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
}

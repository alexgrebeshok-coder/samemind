// api.ts — same-origin `/api/*` access. Types mirror the actual payloads served by
// tools/lib/ui-server.mjs (fetched and read off the wire, not copied from the spec table).
import { useEffect, useState, useSyncExternalStore } from 'react';

export type Envelope<T> = { contract: number; kind: string; generatedAt: string; data: T };

export type Health = { root: string; concepts: number; version: string; searchMode: string };

export type Frontmatter = {
  type?: string;
  title?: string;
  description?: string;
  visibility?: string;
  status?: string;
  blocked_reason?: string;
  tags?: string[];
  timestamp?: string;
  date?: string;
  agreed_on?: string;
  engine?: string;
  source?: string;
  relations?: Record<string, string[]>;
  [k: string]: unknown;
};

/** A bundle doc as the board/handoff endpoints emit it (fm + resolved links). */
export type Doc = {
  id: string;
  base: string;
  reserved: boolean;
  fm: Frontmatter;
  body: string;
  links: string[];
  relations: Record<string, string[]>;
  supersedes: string[];
  supersededBy: string[];
};

/**
 * A kanban card the board synthesized from a ledger topic because no Task doc matched it.
 * Deliberately flat — it has no `fm`, no `links`, no `relations` — so every card reader must go
 * through `cardView()` in lib.ts rather than touching `.fm` directly.
 */
export type LedgerCard = {
  id: string; // "ledger:<topic>"
  title: string; // the topic
  type: string;
  source: 'ledger';
  ts: string;
  actor: string;
  action: string;
};

/** What a board column actually holds: real Task docs and ledger-derived cards, mixed. */
export type BoardCard = Doc | LedgerCard;

export type LedgerEvent = {
  ts: string;
  actor: string;
  topic: string;
  phase: string; // start | step | done | fail | block | note
  status: string; // ok | partial | wip | fail
  action: string;
  artifact: string | null;
  ref: string | null;
  quarantine: boolean;
};

export type Engine = {
  id: string;
  role: string; // director | executor | reserve
  status: string;
  lastSeen: string | null;
  silentSec: number | null;
  heartbeatSec: number;
  overdue: boolean;
};

export type Board = {
  nowMs: number;
  doneLimit: number;
  recentDays: number;
  project: string | null;
  backlog: BoardCard[];
  inprog: BoardCard[];
  blocked: BoardCard[];
  done: BoardCard[];
  plans: Doc[];
  ideaSpark: Doc[];
  ideaIncubating: Doc[];
  ideaAdopted: Doc[];
  ideasVisible: Doc[];
  recent: Doc[];
  sessions: Doc[];
  openFailuresShown: LedgerEvent[];
  openFailuresTotal: number;
  overdueEnginesShown: Engine[];
  overdueEnginesTotal: number;
  /** Per-column count of ledger topics beyond the ones synthesized into cards. */
  ledgerOverflow?: Partial<Record<'backlog' | 'inprog' | 'blocked' | 'done', number>>;
  /**
   * True per-column size before the display caps — what a heading or KPI must quote.
   * Optional: contract-1 servers predate it, so every reader falls back to the array length.
   */
  columnTotals?: Partial<Record<'backlog' | 'inprog' | 'blocked' | 'done', number>>;
};

export type Fleet = { engines: Engine[]; stopPoints: string[] };

export type LedgerTopic = {
  topic: string;
  last: LedgerEvent;
  count: number;
  openFail: LedgerEvent | null;
  evs: LedgerEvent[];
};

export type Ledger = { topics: LedgerTopic[]; openFailures: LedgerEvent[] };

export type ConceptRow = {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  date: string;
};

export type Concept = { id: string; frontmatter: Frontmatter; body: string };

export type GraphNode = { id: string; title: string; type: string };
export type GraphEdge = { from: string; to: string; kind: 'link' | 'relation'; rel?: string };
export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
  broken: string[];
  mdEdges: number;
  relCount: number;
  supersedeCount: number;
  totalEdges: number;
};

// --- shared refresh clock + reachability, so every screen agrees on "fresh" and "offline" ----

const REFRESH_MS = 30_000;

type Store = { tick: number; generatedAt: string | null; offline: boolean; now: number };
let store: Store = { tick: 0, generatedAt: null, offline: false, now: Date.now() };
const subs = new Set<() => void>();

function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}

export function useApiStatus(): Store {
  return useSyncExternalStore(subscribe, () => store);
}

/** Manual refresh button + the 30s auto-refresh both go through here. */
export function refreshAll() {
  set({ tick: store.tick + 1 });
}

let clockStarted = false;
export function startClock() {
  if (clockStarted) return;
  clockStarted = true;
  setInterval(refreshAll, REFRESH_MS);
  setInterval(() => set({ now: Date.now() }), 1000); // keeps "updated 12s ago" ticking
}

export class ApiError extends Error {}

async function getJson<T>(path: string): Promise<Envelope<T>> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(`${path} → HTTP ${res.status}`);
  const json = (await res.json()) as Envelope<T>;
  if (!json || typeof json !== 'object' || !('data' in json)) throw new ApiError(`${path} → bad payload`);
  return json;
}

export type Result<T> = { data: T | null; error: string | null; loading: boolean; stale: boolean };

/**
 * Fetches one endpoint, re-fetching on every refresh tick. On failure the last good `data` is
 * kept and flagged `stale` — spec §5 wants stale data visible-but-dimmed under the banner.
 */
export function useApi<T>(path: string | null): Result<T> {
  const { tick } = useApiStatus();
  const [state, setState] = useState<Result<T>>({ data: null, error: null, loading: !!path, stale: false });

  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false, stale: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    getJson<T>(path).then(
      (env) => {
        if (!alive) return;
        set({ generatedAt: env.generatedAt, offline: false });
        setState({ data: env.data, error: null, loading: false, stale: false });
      },
      (err: unknown) => {
        if (!alive) return;
        set({ offline: true });
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ data: s.data, error: msg, loading: false, stale: s.data !== null }));
      },
    );
    return () => {
      alive = false;
    };
  }, [path, tick]);

  return state;
}

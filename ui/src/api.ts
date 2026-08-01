// api.ts — same-origin `/api/*` access. Types mirror the actual payloads served by
// tools/lib/ui-server.mjs (fetched and read off the wire, not copied from the spec table).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { mergeEvents, nextRefreshDelay } from './lib';

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

export type ConfigLayer = 'default' | 'global' | 'project';

export type VoiceConfig = {
  enabled: boolean;
  trigger: 'hotkey' | 'wake-word';
  wakeWord: boolean;
  storeTranscripts: boolean;
  transcriptRetentionDays: number;
  sendTextToLlm: boolean;
  confidenceThreshold: number;
  serviceUrl: string | null;
};

export type VisionConfig = {
  enabled: boolean;
  mode: 'off' | 'manual' | 'presence' | 'proactive';
  camera: boolean;
  microphone: boolean;
  retentionDays: number;
  proactivePrompts: boolean;
};

type FeatureAvailability =
  | { available: true; note?: string }
  | { available: false; reason: string; fix: string | null };

export type SettingsFeature<T extends Record<string, unknown>> = {
  values: T;
  layers: { [K in keyof T]: ConfigLayer };
} & FeatureAvailability;

export type Settings = {
  root: string;
  configPath: string;
  globalConfigPath: string | null;
  features: {
    voice: SettingsFeature<VoiceConfig>;
    vision: SettingsFeature<VisionConfig>;
  };
};

export type ConfigPatch = { voice?: Partial<VoiceConfig>; vision?: Partial<VisionConfig> };

export type PostConfigResult =
  | { ok: true; data: Settings; generatedAt: string }
  | { ok: false; status: number; errors?: string[]; message: string };

/** POST /api/config — returns the settings envelope re-read from disk (no optimistic merge). */
export async function postConfig(patch: ConfigPatch): Promise<PostConfigResult> {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, message: `POST /api/config → unreadable body` };
  }
  if (res.ok) {
    const env = json as Envelope<Settings>;
    if (!env?.data?.features) return { ok: false, status: res.status, message: 'POST /api/config → bad payload' };
    set({ generatedAt: env.generatedAt, offline: false });
    return { ok: true, data: env.data, generatedAt: env.generatedAt };
  }
  const body = json as { error?: string; errors?: string[]; message?: string };
  if (res.status === 400 && body.error === 'rejected' && Array.isArray(body.errors)) {
    return { ok: false, status: 400, errors: body.errors, message: 'rejected' };
  }
  const message = body.message || body.error || `POST /api/config → HTTP ${res.status}`;
  return { ok: false, status: res.status, errors: body.errors, message };
}

// --- shared refresh clock + reachability, so every screen agrees on "fresh" and "offline" ----

const REFRESH_MS = 30_000;

type Store = {
  tick: number;
  generatedAt: string | null;
  offline: boolean;
  now: number;
  /** SSE connected: the header dot goes green and data refreshes on events, not just on the clock. */
  live: boolean;
  /** Newest-first live feed (spec §3.3 Fleet), capped by FEED_LIMIT. */
  events: LedgerEvent[];
};
let store: Store = { tick: 0, generatedAt: null, offline: false, now: Date.now(), live: false, events: [] };
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
  setInterval(refreshAll, REFRESH_MS); // stays on as the fallback when the stream is down
  setInterval(() => set({ now: Date.now() }), 1000); // keeps "updated 12s ago" ticking
  connectLive();
}

// --- live ledger stream (GET /api/events/stream) ----------------------------------------------
// One connection per app, opened once by startClock() and held for the page's lifetime — screens
// mount and unmount, the stream doesn't. Reconnection is ours rather than the browser's: an
// EventSource only auto-retries a clean close, so a server that dies mid-stream leaves the object
// in CLOSED and silently never comes back.

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

let es: EventSource | null = null;
let retry = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;

/**
 * A ledger event invalidates board/fleet/ledger — served by re-fetching, never by patching the
 * models client-side. Throttled with a trailing edge: the first event of a burst queues one
 * refresh and every event behind it rides along, so a noisy ledger can't starve the queue the way
 * a reset-on-every-event debounce would.
 */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefreshAt = Date.now();
    refreshAll();
  }, nextRefreshDelay(Date.now(), lastRefreshAt));
}

function onPayload(e: Event, snapshot: boolean) {
  let env: Envelope<unknown> | null = null;
  try {
    env = JSON.parse((e as MessageEvent).data) as Envelope<unknown>;
  } catch {
    return; // a mangled frame is not worth tearing the stream down for
  }
  const incoming = snapshot
    ? (env?.data as { events?: LedgerEvent[] })?.events || []
    : [env?.data as LedgerEvent];
  const events = incoming.filter((ev): ev is LedgerEvent => !!ev && typeof ev.ts === 'string');
  if (events.length) set({ live: true, events: mergeEvents(store.events, events) });
  if (!snapshot) scheduleRefresh(); // the snapshot only mirrors what the initial GETs already have
}

function connectLive() {
  es = new EventSource('/api/events/stream');
  es.addEventListener('open', () => {
    retry = 0;
    set({ live: true });
  });
  es.addEventListener('snapshot', (e) => onPayload(e, true));
  es.addEventListener('event', (e) => onPayload(e, false));
  es.addEventListener('error', () => {
    es?.close();
    es = null;
    set({ live: false });
    setTimeout(connectLive, BACKOFF_MS[Math.min(retry++, BACKOFF_MS.length - 1)]);
  });
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

/**
 * Frontmatter for a set of concepts, one GET per doc, keyed on the id set rather than on the
 * refresh tick. `/api/concepts` returns a deliberately slim row (no `description`), so a screen
 * that wants the blurb has to ask per doc — and a project's frontmatter changes far slower than
 * the board, so re-fetching 34 docs every 30s would buy nothing.
 */
export function useConceptMap(ids: string[]): Map<string, Frontmatter> {
  const key = ids.join('\n');
  const [map, setMap] = useState<Map<string, Frontmatter>>(new Map());

  useEffect(() => {
    const list = key ? key.split('\n') : [];
    if (!list.length) {
      setMap(new Map());
      return;
    }
    let alive = true;
    Promise.all(
      list.map((id) =>
        getJson<Concept>(`/api/concept/${id}`).then(
          (env) => [id, env.data.frontmatter || {}] as [string, Frontmatter],
          () => null, // one unreadable doc must not blank the whole grid
        ),
      ),
    ).then((pairs) => {
      if (alive) setMap(new Map(pairs.filter((p): p is [string, Frontmatter] => p !== null)));
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return map;
}

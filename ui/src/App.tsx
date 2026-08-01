// App.tsx — layout shell (spec §2): sidebar/top-bar nav, theme toggle, health footer chip,
// slim header with freshness stamp + manual refresh, and the offline banner from §5.
//
// Routing is hash-based (`#/memory/concepts/nova`) — deliberately, not a cosmetic choice: the
// server (tools/lib/ui-server.mjs) has no SPA history fallback, so a deep path like /memory
// would be answered with its API placeholder page instead of index.html. Hash routes keep every
// screen deep-linkable and reload-safe without touching tools/.
import { useEffect, useState } from 'react';
import { refreshAll, startClock, useApi, useApiStatus, type Health } from './api';
import { ago } from './lib';
import { Overview } from './screens/Overview';
import { Today } from './screens/Today';
import { Memory } from './screens/Memory';
import { Fleet } from './screens/Fleet';
import { Projects } from './screens/Projects';
import { Settings } from './screens/Settings';

type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'samemind.theme';

function readTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'dark' || v === 'light' ? v : 'system';
}

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => theme === 'system' && applyTheme(theme);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return { theme, setTheme };
}

export type Route = {
  screen: 'today' | 'overview' | 'memory' | 'fleet' | 'projects' | 'settings';
  id: string | null;
};

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  const id = rest.join('/') || null;
  if (head === '' || head === 'today') return { screen: 'today', id: null };
  if (head === 'overview') return { screen: 'overview', id: null };
  if (head === 'memory') return { screen: 'memory', id };
  if (head === 'fleet') return { screen: 'fleet', id: null };
  if (head === 'projects') return { screen: 'projects', id };
  if (head === 'settings') return { screen: 'settings', id: null };
  return { screen: 'today', id: null };
}

export function navigate(to: string) {
  location.hash = to.startsWith('#') ? to : `#${to}`;
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

const NAV = [
  { screen: 'today', label: 'Today', href: '#/today' },
  { screen: 'overview', label: 'Overview', href: '#/overview' },
  { screen: 'memory', label: 'Memory', href: '#/memory' },
  { screen: 'fleet', label: 'Fleet', href: '#/fleet' },
  { screen: 'projects', label: 'Projects', href: '#/projects' },
  { screen: 'settings', label: 'Settings', href: '#/settings' },
] as const;

const TITLES: Record<Route['screen'], string> = {
  today: 'Today',
  overview: 'Overview',
  memory: 'Memory',
  fleet: 'Fleet',
  projects: 'Projects',
  settings: 'Settings',
};

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const order: Theme[] = ['light', 'dark', 'system'];
  const icon = { light: '☀', dark: '☾', system: '◐' }[theme];
  const next = order[(order.indexOf(theme) + 1) % order.length];
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="flex w-full items-center justify-between gap-2 rounded-[12px] border border-line bg-surface px-3 py-2 text-sm hover:border-accent/60"
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme} → click for ${next}`}
    >
      <span className="text-muted">Theme</span>
      <span className="font-medium">
        <span aria-hidden="true">{icon}</span> {theme}
      </span>
    </button>
  );
}

function Sidebar({ route }: { route: Route }) {
  const { theme, setTheme } = useTheme();
  const health = useApi<Health>('/api/health');
  return (
    <header className="flex shrink-0 flex-col gap-4 border-b border-line bg-surface px-4 py-3 min-[900px]:h-screen min-[900px]:w-60 min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:px-4 min-[900px]:py-5">
      <div className="flex items-center justify-between gap-3 min-[900px]:block">
        <a href="#/today" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden="true" className="inline-block size-3 rounded-full bg-accent" />
          samemind
        </a>
        <nav aria-label="Screens" className="min-[900px]:mt-5">
          <ul className="flex gap-1 min-[900px]:flex-col">
            {NAV.map((n) => {
              const active = n.screen === route.screen;
              return (
                <li key={n.screen}>
                  <a
                    href={n.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-[12px] px-3 py-2 text-sm ${
                      active
                        ? 'bg-accent-soft font-semibold text-accent'
                        : 'text-ink hover:bg-surface-2'
                    }`}
                  >
                    {n.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className="mt-auto hidden flex-col gap-3 min-[900px]:flex">
        <ThemeToggle theme={theme} setTheme={setTheme} />
        <div className="rounded-[12px] border border-line bg-surface-2 px-3 py-2">
          <div className="text-[11px] tracking-wide text-muted uppercase">bundle</div>
          <div className="mt-0.5 truncate font-mono text-[11px]" title={health.data?.root || ''}>
            {health.data?.root || '—'}
          </div>
          <div className="tnum mt-1 text-[11px] text-muted">
            v{health.data?.version || '—'} · {health.data?.concepts ?? '—'} concepts ·{' '}
            {health.data?.searchMode || '—'}
          </div>
        </div>
      </div>
      {/* narrow layout: toggle + bundle chip collapse into the top bar */}
      <div className="flex items-center gap-2 min-[900px]:hidden">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={health.data?.root || ''}>
          {health.data?.root || '—'} · v{health.data?.version || '—'}
        </div>
        <div className="w-36">
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>
    </header>
  );
}

function OfflineBanner() {
  const { offline } = useApiStatus();
  if (!offline) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-danger/40 bg-danger-soft px-4 py-2 text-sm text-danger"
    >
      <strong>server stopped</strong>
      <span>— restart</span>
      <code className="rounded bg-surface/60 px-1.5 py-0.5 font-mono text-xs">samemind ui</code>
      <span className="text-xs">· showing the last data received</span>
    </div>
  );
}

/** Live-stream state next to the freshness stamp: green pulse = SSE attached, grey = 30s poll. */
function LiveDot() {
  const { live } = useApiStatus();
  return (
    <span
      className="flex items-center gap-1.5 text-xs"
      title={
        live
          ? 'live — streaming ledger events over /api/events/stream'
          : 'stream down — falling back to the 30s poll, reconnecting'
      }
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 rounded-full ${
          live ? 'animate-pulse bg-ok motion-reduce:animate-none' : 'bg-muted'
        }`}
      />
      <span className={live ? 'text-ok' : 'text-muted'}>{live ? 'live' : 'polling'}</span>
    </span>
  );
}

function ScreenHeader({ title }: { title: string }) {
  const { generatedAt, now, offline } = useApiStatus();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 min-[900px]:px-6">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <div className="flex items-center gap-3">
        <span className={`tnum text-xs ${offline ? 'text-danger' : 'text-muted'}`}>
          updated {ago(generatedAt, now)}
        </span>
        <LiveDot />
        <button
          type="button"
          onClick={refreshAll}
          className="rounded-[12px] border border-line px-3 py-1.5 text-xs hover:border-accent/60"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const { offline } = useApiStatus();
  useEffect(startClock, []);
  useEffect(() => {
    document.title = `samemind — ${TITLES[route.screen]}`;
  }, [route.screen]);

  return (
    <div className="min-h-screen min-[900px]:flex">
      <Sidebar route={route} />
      <div className="flex min-w-0 flex-1 flex-col min-[900px]:h-screen min-[900px]:overflow-y-auto">
        <OfflineBanner />
        <ScreenHeader title={TITLES[route.screen]} />
        <main className={`flex-1 px-4 py-5 min-[900px]:px-6 ${offline ? 'opacity-60' : ''}`}>
          {route.screen === 'today' && <Today />}
          {route.screen === 'overview' && <Overview />}
          {route.screen === 'memory' && <Memory id={route.id} />}
          {route.screen === 'fleet' && <Fleet />}
          {route.screen === 'projects' && <Projects id={route.id} />}
          {route.screen === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  );
}

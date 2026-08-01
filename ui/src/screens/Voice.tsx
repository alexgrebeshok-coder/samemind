// Voice — state + confirmation panel (sm016). No getUserMedia: shows companion truth and intent gate output.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  fetchVoiceProbe,
  postConfig,
  useApi,
  type Settings,
  type VoiceCompanionState,
  type VoiceProbe,
} from '../api';
import { plannedActionLabel, type VoiceDecision, type Quarantine } from '../voice-types.ts';
import { routeVoice } from '../api.ts';
import { Card, Chip, Panel, Spinner } from '../ui';

type AttentionId = 'idle' | 'listening' | 'thinking' | 'responding' | 'mic-off';

const ATTENTION: { id: AttentionId; label: string }[] = [
  { id: 'idle', label: 'покой' },
  { id: 'listening', label: 'слушаю' },
  { id: 'thinking', label: 'думаю' },
  { id: 'responding', label: 'отвечаю' },
  { id: 'mic-off', label: 'микрофон выключен' },
];

type Session = {
  transcript: string;
  confidence: number;
  decision: VoiceDecision | null;
  quarantine: Quarantine | null;
  phase: 'idle' | 'listening' | 'thinking' | 'responding';
  confirmDismissed: boolean;
  verifyDraft: string;
};

const EMPTY_SESSION: Session = {
  transcript: '',
  confidence: 0.85,
  decision: null,
  quarantine: null,
  phase: 'idle',
  confirmDismissed: false,
  verifyDraft: '',
};

function intentLabel(intent: VoiceDecision['intent']): string {
  if (!intent) return 'не распознано';
  const map: Record<Exclude<VoiceDecision['intent'], null>, string> = {
    context: 'контекст / handoff',
    blockers: 'блокеры',
    fleet: 'флот',
    assign: 'наряд (fleet assign)',
    capture: 'захват решения (inbox)',
  };
  return map[intent];
}

function companionChipTone(state: VoiceCompanionState): 'danger' | 'ok' | 'neutral' {
  if (state === 'reachable') return 'ok';
  if (state === 'configured') return 'neutral';
  return 'danger';
}

function companionStateLabel(state: VoiceCompanionState): string {
  if (state === 'reachable') return 'reachable — связь проверена';
  if (state === 'configured') return 'configured — адрес задан, связь не доказана';
  return 'unavailable — спутник не настроен';
}

function AttentionStrip({ active }: { active: AttentionId }) {
  return (
    <section aria-label="Состояние внимания" className="grid gap-2 sm:grid-cols-5">
      {ATTENTION.map((a) => {
        const on = a.id === active;
        const micOff = a.id === 'mic-off';
        const base =
          'rounded-[12px] border px-3 py-2 text-center text-sm font-medium transition-colors';
        let cls = `${base} border-line bg-surface-2 text-muted`;
        if (on && micOff) cls = `${base} border-danger bg-danger-soft text-danger ring-2 ring-danger/50`;
        else if (on) cls = `${base} border-accent bg-accent-soft text-accent ring-2 ring-accent/40`;
        else if (micOff) cls = `${base} border-danger/50 bg-danger-soft/30 text-danger`;
        return (
          <div key={a.id} className={cls} aria-current={on ? 'step' : undefined}>
            {a.label}
          </div>
        );
      })}
    </section>
  );
}

function CompanionStatus({
  voice,
  probe,
  probing,
  probeError,
  onProbe,
}: {
  voice: Settings['features']['voice'];
  probe: VoiceProbe | null;
  probing: boolean;
  probeError: string | null;
  onProbe: () => void;
}) {
  const state: VoiceCompanionState = probe?.state ?? voice.state;
  const tone = companionChipTone(state);
  return (
    <Panel title="Спутник (voice companion)" hint="Состояние из GET /api/settings; reachable — только после ручной пробы.">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={tone}>{companionStateLabel(state)}</Chip>
        {voice.values.serviceUrl ? (
          <span className="truncate font-mono text-xs text-muted" title={voice.values.serviceUrl}>
            {voice.values.serviceUrl}
          </span>
        ) : null}
      </div>
      {state === 'unavailable' ? (
        <Card tone="danger" className="mt-3 space-y-2 p-3">
          <p className="text-sm">{voice.reason}</p>
          {voice.fix ? <p className="text-xs text-muted">Подсказка: {voice.fix}</p> : null}
        </Card>
      ) : null}
      {state === 'configured' ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted">
            {probe?.note ?? voice.note ?? 'Адрес задан — это ещё не означает работающую связь.'}
          </p>
          <button
            type="button"
            disabled={probing}
            onClick={onProbe}
            className="rounded-[12px] border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-accent/60 disabled:opacity-50"
          >
            {probing ? 'Проверяю…' : 'Проверить связь'}
          </button>
          {probeError ? <p className="text-xs text-danger">{probeError}</p> : null}
        </div>
      ) : null}
      {state === 'reachable' ? (
        <p className="mt-3 text-sm text-ok">
          {probe?.note ?? voice.note ?? 'Спутник отвечает.'}
          {probe?.probe?.model ? (
            <span className="text-muted">
              {' '}
              · модель <span className="font-mono">{probe.probe.model}</span>
            </span>
          ) : null}
        </p>
      ) : null}
    </Panel>
  );
}

function ConfirmCard({
  transcript,
  decision,
  quarantine,
  verifyDraft,
  onVerifyChange,
  onConfirm,
  onReject,
}: {
  transcript: string;
  decision: VoiceDecision;
  quarantine: { flagged: boolean; matches: string[] };
  verifyDraft: string;
  onVerifyChange: (v: string) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const needVerify = decision.missing.includes('verify');
  const verifyOk = !needVerify || verifyDraft.trim().length > 0;
  const verifyId = useId();
  return (
    <Card className="mt-4 space-y-4 p-4" tone="muted">
      <h3 className="text-sm font-semibold">Подтверждение</h3>
      {quarantine.flagged ? (
        <div role="alert" className="rounded-[12px] border border-danger/60 bg-danger-soft/60 p-3 text-sm text-danger">
          <strong>Карантин.</strong> Сканер инъекций сработал на этой фразе ({quarantine.matches.join(', ')}). Запись
          всё равно может попасть в память с пометкой quarantine — не удивляйся, если увидишь её в карантинном блоке.
        </div>
      ) : null}
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Услышали</dt>
          <dd className="mt-0.5 font-medium">{transcript || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Намерение</dt>
          <dd className="mt-0.5 font-medium">{intentLabel(decision.intent)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">Что произойдёт</dt>
          <dd className="mt-0.5">{plannedActionLabel(decision)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted">Ответ ядра</dt>
          <dd className="mt-0.5 text-muted">{decision.say}</dd>
        </div>
      </dl>
      {needVerify ? (
        <div>
          <label htmlFor={verifyId} className="text-sm font-medium">
            Критерий проверки (verify) <span className="text-danger">*</span>
          </label>
          <p className="mt-0.5 text-xs text-muted">Без verify наряд в ядре не отдаётся — поле обязательно.</p>
          <input
            id={verifyId}
            type="text"
            value={verifyDraft}
            onChange={(e) => onVerifyChange(e.target.value)}
            className="mt-2 w-full rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
            placeholder="например: npm test зелёный"
          />
        </div>
      ) : null}
      <p className="text-[11px] text-muted">
        Голосовые «ага» и «угу» не считаются подтверждением — только эти кнопки (правило ядра §5).
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!verifyOk}
          onClick={onConfirm}
          className="rounded-[12px] border border-ok/50 bg-ok-soft px-4 py-2 text-sm font-semibold text-ok hover:border-ok disabled:cursor-not-allowed disabled:opacity-40"
        >
          Подтвердить
        </button>
        <button
          type="button"
          onClick={onReject}
          className="rounded-[12px] border border-danger/50 bg-danger-soft/40 px-4 py-2 text-sm font-semibold text-danger hover:border-danger"
        >
          Отклонить
        </button>
      </div>
    </Card>
  );
}

export function Voice() {
  const settings = useApi<Settings>('/api/settings');
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [probe, setProbe] = useState<VoiceProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [muting, setMuting] = useState(false);
  const [muteError, setMuteError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const voice = settings.data?.features.voice;
  const micEnabled = voice?.values.enabled ?? false;
  const threshold = voice?.values.confidenceThreshold ?? 0.6;

  const attention: AttentionId = useMemo(() => {
    if (!micEnabled) return 'mic-off';
    if (session.phase === 'listening') return 'listening';
    if (session.phase === 'thinking') return 'thinking';
    if (session.phase === 'responding') return 'responding';
    return 'idle';
  }, [micEnabled, session.phase]);

  // Quarantine is the server's verdict, carried on the route response — never recomputed here.
  const quarantine: Quarantine = session.quarantine ?? { flagged: false, matches: [] };

  const applyTranscript = useCallback(
    (text: string, confidence: number) => {
      setOutcome(null);
      setSession((s) => ({ ...s, transcript: text, confidence, phase: 'thinking', confirmDismissed: false }));
      // The gate lives in the core (tools/lib/voice-intent.mjs) and is reached over
      // GET /api/voice/route. The panel renders the verdict; it never forms its own.
      routeVoice(text, confidence).then((route) => {
        if (!route) {
          setSession((s) => ({ ...s, phase: 'idle' }));
          return;
        }
        const nextPhase =
          route.action === 'read' ? 'responding' : route.action === 'reask' ? 'idle' : 'thinking';
        setSession((s) => ({
          ...s,
          decision: route,
          quarantine: route.quarantine,
          phase: nextPhase,
          verifyDraft: route.slots?.verify ?? s.verifyDraft,
        }));
      });
    },
    [],
  );

  useEffect(() => {
    if (!micEnabled) {
      setSession((s) => ({ ...s, phase: 'idle' }));
      return;
    }
    if (!session.transcript && session.phase === 'idle') {
      setSession((s) => ({ ...s, phase: 'listening' }));
    }
  }, [micEnabled, session.transcript, session.phase]);

  const muteMic = async () => {
    setMuteError(null);
    setMuting(true);
    const res = await postConfig({ voice: { enabled: false } });
    setMuting(false);
    if (!res.ok) {
      setMuteError(res.message);
      return;
    }
    setSession(EMPTY_SESSION);
    setOutcome(null);
  };

  const runProbe = async () => {
    setProbeError(null);
    setProbing(true);
    const res = await fetchVoiceProbe();
    setProbing(false);
    if (!res.ok) {
      setProbeError(res.message);
      return;
    }
    setProbe(res.data);
  };

  if (settings.loading && !settings.data) return <Spinner label="voice settings" />;
  if (!voice) return <p className="text-sm text-danger">Не удалось прочитать /api/settings</p>;

  const showConfirm =
    session.decision?.action === 'confirm' && !session.confirmDismissed && session.transcript;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Панель состояния и подтверждения. Захват с микрофона здесь не включён — только видимость того, что услышал
          спутник.
        </p>
        <button
          type="button"
          onClick={muteMic}
          disabled={muting}
          className="shrink-0 rounded-[12px] border border-danger/60 bg-danger-soft px-4 py-2 text-sm font-semibold text-danger hover:border-danger disabled:opacity-40"
          title="Один щелчок — voice.enabled=false через POST /api/config"
        >
          {muting ? 'Выключаю…' : micEnabled ? 'Выключить микрофон' : 'Микрофон уже выключен'}
        </button>
      </div>
      {muteError ? <p className="text-xs text-danger">{muteError}</p> : null}

      <AttentionStrip active={attention} />

      <CompanionStatus voice={voice} probe={probe} probing={probing} probeError={probeError} onProbe={runProbe} />

      <Panel
        title="Расшифровка"
        hint="Текст и уверенность приходят от спутника (контракт). Для проверки панели можно подставить фразу вручную — без getUserMedia."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <label className="text-xs text-muted" htmlFor="voice-transcript">
                Распознанный текст
              </label>
              <textarea
                id="voice-transcript"
                rows={3}
                value={session.transcript}
                onChange={(e) => setSession((s) => ({ ...s, transcript: e.target.value }))}
                className="mt-1 w-full rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
                placeholder="Пусто — спутник молчит"
              />
            </div>
            <div className="w-36">
              <label className="text-xs text-muted" htmlFor="voice-confidence">
                Уверенность
              </label>
              <input
                id="voice-confidence"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={session.confidence}
                onChange={(e) =>
                  setSession((s) => ({ ...s, confidence: Number.parseFloat(e.target.value) || 0 }))
                }
                className="tnum mt-1 w-full rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
              />
              <p className="tnum mt-0.5 text-[11px] text-muted">порог {threshold}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => applyTranscript(session.transcript, session.confidence)}
            disabled={!session.transcript.trim()}
            className="rounded-[12px] border border-line bg-surface-2 px-4 py-2 text-sm hover:border-accent/60 disabled:opacity-40"
          >
            Разобрать фразу
          </button>

          {session.transcript ? (
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span>
                ref <span className="font-mono">{session.decision?.ref ?? '—'}</span>
              </span>
              {session.decision ? (
                <span>
                  action <strong>{session.decision.action}</strong>
                </span>
              ) : null}
            </div>
          ) : null}

          {session.decision?.action === 'reask' ? (
            <Card tone="muted" className="p-3">
              <p className="text-sm font-medium">Переспрос</p>
              <p className="mt-1 text-sm text-muted">{session.decision.say}</p>
              <p className="mt-2 text-xs text-muted">Наряд и запись в память не запускаются.</p>
            </Card>
          ) : null}

          {session.decision?.action === 'read' ? (
            <Card className="p-3">
              <p className="text-sm font-medium text-ok">Чтение — без подтверждения</p>
              <p className="mt-1 text-sm">{session.decision.say}</p>
              <p className="mt-2 text-xs text-muted">{plannedActionLabel(session.decision)}</p>
            </Card>
          ) : null}

          {showConfirm && session.decision ? (
            <ConfirmCard
              transcript={session.transcript}
              decision={session.decision}
              quarantine={quarantine}
              verifyDraft={session.verifyDraft}
              onVerifyChange={(verifyDraft) => setSession((s) => ({ ...s, verifyDraft }))}
              onConfirm={() => {
                setOutcome('Принято на экране. Исполнение — отдельный контур спутника; голосовое «ага» не использовалось.');
                setSession((s) => ({ ...s, confirmDismissed: true, phase: 'responding' }));
              }}
              onReject={() => {
                setOutcome('Отклонено — действие не отправлено.');
                setSession((s) => ({ ...s, confirmDismissed: true, decision: null, phase: 'idle' }));
              }}
            />
          ) : null}

          {outcome ? (
            <p className="text-sm text-muted" role="status">
              {outcome}
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

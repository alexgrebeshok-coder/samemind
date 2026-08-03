// NudgeCard — dashboard replica: reads GET /api/nudge, answers via POST /api/nudge/respond.
import { useCallback, useRef, useState } from 'react';
import { navigate } from './App';
import {
  postNudgeRespond,
  refreshAll,
  useApi,
  type NudgeData,
  type NudgeRespondOutcome,
} from './api';
import { nudgeSilenceLine } from './lib';
import { Card } from './ui';

const OUTCOMES: { outcome: NudgeRespondOutcome; label: string }[] = [
  { outcome: 'accepted', label: 'Понял' },
  { outcome: 'deferred', label: 'Не сейчас' },
  { outcome: 'dismissed', label: 'Не надо' },
  { outcome: 'muted', label: 'Хватит на сегодня' },
];

export function NudgeCard() {
  const nudge = useApi<NudgeData>('/api/nudge');
  const [busy, setBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const respond = useCallback(async (outcome: NudgeRespondOutcome, ref: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAnswerError(null);
    const result = await postNudgeRespond({ outcome, ref });
    if (!result.ok) {
      setAnswerError(result.message);
      inFlight.current = false;
      setBusy(false);
      return;
    }
    refreshAll();
    inFlight.current = false;
    setBusy(false);
  }, []);

  const data = nudge.data;
  if (!data && nudge.loading) {
    return (
      <section aria-label="Подсказка" className="text-sm text-muted">
        читаю подсказку…
      </section>
    );
  }
  if (!data) return null;

  if (data.spoken && data.candidate) {
    const ref = data.candidate.id;
    return (
      <section aria-label="Подсказка">
        <Card className="p-4">
          <p className="text-base font-medium leading-snug">{data.candidate.text}</p>
          <p className="mt-2 text-sm text-muted">{data.candidate.why}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {OUTCOMES.map(({ outcome, label }) => (
              <button
                key={outcome}
                type="button"
                disabled={busy}
                onClick={() => respond(outcome, ref)}
                className="rounded-[12px] border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent/60 disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
          {answerError ? (
            <p className="mt-2 text-xs text-danger" role="alert">
              {answerError}
            </p>
          ) : null}
        </Card>
      </section>
    );
  }

  const line = nudgeSilenceLine(data.reasonCode, data.nextAllowedAt);
  if (data.reasonCode === 'disabled') {
    return (
      <section aria-label="Подсказка">
        <Card tone="muted" className="p-4">
          <p className="text-sm text-muted">
            {line}{' '}
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="text-accent underline-offset-2 hover:underline"
            >
              Настройки зрения
            </button>
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Подсказка">
      <Card tone="muted" className="p-4">
        <p className="text-sm text-muted">{line}</p>
      </Card>
    </section>
  );
}

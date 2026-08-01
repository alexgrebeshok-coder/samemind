// Voice panel types and presentation helpers. Deliberately contains NO routing logic.
//
// An earlier draft mirrored tools/lib/voice-intent.mjs into the browser (plus a hand-rolled
// sha256 and a copy of the injection scanner) so the panel could decide client-side. That is
// the wrong shape: two implementations of a gate drift, and the browser copy is the one a
// person actually sees — a weakened client-side injection scan would show "no quarantine" on a
// phrase the core quarantines, and a stale threshold would show a decision the core would not
// take. Decisions now come from GET /api/voice/route, which runs the core function.
//
// What is left here is display only: the shape of the answer, and how to word it.

export type Intent = 'context' | 'blockers' | 'fleet' | 'assign' | 'capture' | null;
export type VoiceAction = 'read' | 'confirm' | 'reask';

export type VoiceDecision = {
  intent: Intent;
  action: VoiceAction;
  confidence: number;
  ref: string;
  slots: Record<string, string | undefined>;
  missing: string[];
  say: string;
};

/** Server-computed quarantine verdict — mirrors scanForInjection's return, never recomputed here. */
export type Quarantine = { flagged: boolean; matches: string[] };

export type VoiceRoute = VoiceDecision & { threshold: number; quarantine: Quarantine };

const ACTION_WORDS: Record<Exclude<Intent, null>, string> = {
  context: 'покажет, на чём вы остановились',
  blockers: 'покажет открытые блокеры',
  fleet: 'покажет состояние флота',
  assign: 'выдаст наряд движку',
  capture: 'запишет заметку в inbox',
};

/** One plain sentence: what will happen if this is confirmed. Presentation, not policy. */
export function plannedActionLabel(decision: VoiceDecision): string {
  if (decision.action === 'reask') return 'ничего — уверенность ниже порога, нужен переспрос';
  if (!decision.intent) return 'ничего — намерение не распознано';
  return ACTION_WORDS[decision.intent];
}

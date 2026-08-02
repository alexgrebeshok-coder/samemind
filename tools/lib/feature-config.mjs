// feature-config.mjs — read/normalize the `voice` and `vision` feature-toggle sections of
// samemind's config.json (the same shared file setup.mjs writes embedUrl/embedModel into and
// projection-config.mjs reads the `projection` section from). Pure fs read — no write, no network
// — applying defaults and a two-tier (global-under-project) merge in memory only.
//
// Everything defaults to OFF. That is a privacy stance, not caution: a brand-new install must not
// be silently listening through a microphone or pointing a camera until the user has explicitly
// turned each capability on. Voice keeps THREE SEPARATE consents on purpose — access to the
// microphone (enabled) is not the same decision as storing transcripts (storeTranscripts), which
// is again not the same as piping the recognized text to an LLM (sendTextToLlm). Do not collapse
// them into one flag: they are three different human decisions.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_TRIGGERS = new Set(['hotkey', 'wake-word']);
const VALID_VISION_MODES = new Set(['off', 'manual', 'presence', 'proactive']);

export const VOICE_DEFAULTS = Object.freeze({
  enabled: false,
  trigger: 'hotkey',          // 'hotkey' | 'wake-word'
  wakeWord: false,
  storeTranscripts: false,
  transcriptRetentionDays: 7,
  sendTextToLlm: false,
  confidenceThreshold: 0.6,
  serviceUrl: null,
});

export const VISION_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'off',                // 'off' | 'manual' | 'presence' | 'proactive'
  camera: false,
  microphone: false,
  rooms: [],
  hours: null,
  retentionDays: 7,
  proactivePrompts: false,
});

const configPath = dir => join(dir, '.samemind', 'config.json');

/** Missing/malformed file → null (never throws) — same shape as projection-config's readJson. */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Mirrors normalizeFactSource: a known value (or absence) passes through; an unknown one falls
 *  back to the default and says why on stderr instead of crashing a read of a hand-edited file. */
function normalizeEnum(value, valid, fallback, label, root) {
  if (value === undefined || valid.has(value)) return value ?? fallback;
  console.warn(`feature-config: invalid ${label} "${value}" in ${root}/.samemind/config.json — falling back to "${fallback}"`);
  return fallback;
}

/** Number.isFinite guard with a warning on a present-but-garbage value (e.g. a threshold typed as
 *  a string). Absence is already covered — DEFAULTS are spread into the merge first, so a missing
 *  key keeps its default; only an explicitly-bad value reaches the warn branch. */
function finiteOrWarn(value, fallback, label, root) {
  if (Number.isFinite(value)) return value;
  console.warn(`feature-config: invalid ${label} ${JSON.stringify(value)} in ${root}/.samemind/config.json — falling back to ${JSON.stringify(fallback)}`);
  return fallback;
}

function normalizeVoice(merged, root) {
  return {
    enabled: !!merged.enabled,
    trigger: normalizeEnum(merged.trigger, VALID_TRIGGERS, VOICE_DEFAULTS.trigger, 'voice.trigger', root),
    wakeWord: !!merged.wakeWord,
    storeTranscripts: !!merged.storeTranscripts,
    transcriptRetentionDays: finiteOrWarn(merged.transcriptRetentionDays, VOICE_DEFAULTS.transcriptRetentionDays, 'voice.transcriptRetentionDays', root),
    sendTextToLlm: !!merged.sendTextToLlm,
    confidenceThreshold: finiteOrWarn(merged.confidenceThreshold, VOICE_DEFAULTS.confidenceThreshold, 'voice.confidenceThreshold', root),
    serviceUrl: merged.serviceUrl ?? VOICE_DEFAULTS.serviceUrl,
  };
}

function normalizeVision(merged, root) {
  return {
    enabled: !!merged.enabled,
    mode: normalizeEnum(merged.mode, VALID_VISION_MODES, VISION_DEFAULTS.mode, 'vision.mode', root),
    camera: !!merged.camera,
    microphone: !!merged.microphone,
    // fresh copy so a caller can't mutate the frozen VISION_DEFAULTS.rooms constant through the
    // returned object (absent rooms resolves to that frozen [] via the spread above).
    rooms: Array.isArray(merged.rooms) ? [...merged.rooms] : [],
    hours: merged.hours ?? VISION_DEFAULTS.hours,
    retentionDays: finiteOrWarn(merged.retentionDays, VISION_DEFAULTS.retentionDays, 'vision.retentionDays', root),
    proactivePrompts: !!merged.proactivePrompts,
  };
}

/**
 * Reads and normalizes the `voice` and `vision` feature sections, merging `<globalHome>/.samemind/
 * config.json` (base) under `<root>/.samemind/config.json` (override) — same precedence as
 * readProjectionConfig/resolveEmbedConfig. Pure read: applies defaults/merge in memory, never
 * writes. A read must never mutate `~/.samemind/config.json` — it's a shared machine-wide file;
 * some other caller's plain read silently rewriting it would be a nasty surprise (a `project
 * --dry-run`, an unrelated module's test). Foreign keys living in the same file (embedUrl,
 * embedModel, schema_version, projection, …) are simply never plucked — only `.voice`/`.vision`
 * are read — so they survive untouched by construction, and there is no write here to endanger
 * them regardless.
 *
 * Returns `{ voice, vision }`, each fully normalized against its DEFAULTS. Missing section/file at
 * either tier → everything OFF (see VOICE_DEFAULTS / VISION_DEFAULTS). `globalHome` defaults to
 * $HOME — pass a tmp dir (or a falsy value to skip the global tier entirely) from tests so the real
 * ~/.samemind is never touched.
 */
export function readFeatureConfig(root, globalHome = process.env.HOME) {
  const globalCfg = (globalHome && readJson(configPath(globalHome))) || {};
  const projectCfg = readJson(configPath(root)) || {};

  const voice = normalizeVoice({ ...VOICE_DEFAULTS, ...globalCfg.voice, ...projectCfg.voice }, root);
  const vision = normalizeVision({ ...VISION_DEFAULTS, ...globalCfg.vision, ...projectCfg.vision }, root);

  return { voice, vision };
}

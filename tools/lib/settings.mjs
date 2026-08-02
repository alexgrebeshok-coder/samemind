/**
 * settings.mjs — the switchboard: what the dashboard shows, and the one write it may perform.
 *
 * Two honesty rules drive the whole module, both learned the hard way in 0.15:
 *
 * 1. **A capability with no runner is "unavailable", never "off".** Rendering a missing companion
 *    as an unchecked box tells the user "you chose this", when the truth is "nothing here can do
 *    it". That is the same lie as a config entry counting as a working connection.
 * 2. **Every value reports the layer it came from** (default / global / project). A settings screen
 *    that shows an effective value without its origin cannot answer "why is this on?", and the user
 *    edits the wrong file.
 *
 * Reads never write — same contract as projection-config/feature-config: `~/.samemind/config.json`
 * is machine-wide, and a read that rewrites it would surprise every other caller.
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { withFileLock } from '../../lib/file-lock.mjs';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';
import { VOICE_DEFAULTS, VISION_DEFAULTS, readFeatureConfig } from './feature-config.mjs';

const configPath = (dir) => join(dir, '.samemind', 'config.json');

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Per-field provenance. Walks the same two tiers feature-config merges, in the same order, and
 * reports the *last* tier that set each key — which is exactly the one that won.
 */
export function resolveLayers(root, globalHome = process.env.HOME) {
  const global = (globalHome && readJson(configPath(globalHome))) || {};
  const project = readJson(configPath(root)) || {};
  const out = {};
  for (const [section, defaults] of [['voice', VOICE_DEFAULTS], ['vision', VISION_DEFAULTS]]) {
    out[section] = {};
    for (const key of Object.keys(defaults)) {
      out[section][key] =
        project[section] && key in project[section] ? 'project'
          : global[section] && key in global[section] ? 'global'
            : 'default';
    }
  }
  return out;
}

/**
 * Is there anything that could actually perform this capability?
 *
 * Deliberately *pure and synchronous* — no network, no spawn. A GET that probes a companion turns
 * every dashboard poll into a connection attempt, and a slow companion into a slow dashboard. So
 * reachability is never *computed* here; it is *passed in* via `voiceProbe` — the result of
 * probeVoiceCompanion, run only on demand by GET /api/voice/probe. The polling buildSettingsModel
 * never passes one, which is exactly why a render can never claim "reachable". Three honest states:
 *
 *   unavailable — no serviceUrl; nothing to enable (reason + fix populated, note null).
 *   configured  — serviceUrl set but unproven. NOT available: a config entry is not a working
 *                 connection (the same lie 0.15 cleaned up elsewhere), so the screen must not draw
 *                 it green until a probe says so.
 *   reachable   — proven live by a probe (available:true).
 *
 * Every branch returns the SAME key set — { state, available, reason, note, fix } — with absence
 * expressed as `null`, never a missing key. A consumer must not have to guess whether to check
 * `undefined` or `null`; that ambiguity is exactly what froze badly elsewhere.
 */
export function assessAvailability(cfg, { voiceProbe } = {}) {
  const url = cfg.voice.serviceUrl;
  let voice;
  if (!url) {
    voice = {
      state: 'unavailable',
      available: false,
      reason: 'voice companion is not installed',
      note: null,
      fix: 'install the companion, then set voice.serviceUrl',
    };
  } else if (voiceProbe) {
    voice = {
      state: 'reachable',
      available: true,
      reason: null,
      note: `companion reachable${voiceProbe.model ? ` (${voiceProbe.model})` : ''}`,
      fix: null,
    };
  } else {
    voice = {
      state: 'configured',
      available: false,
      reason: null,
      note: 'companion configured (reachability not probed — use "check connection")',
      fix: null,
    };
  }
  // Vision ships no runner at all yet; saying "off" would imply the user turned it off.
  const vision = {
    state: 'unavailable',
    available: false,
    reason: 'ambient vision is not implemented yet (planned for 0.17)',
    note: null,
    fix: null,
  };
  return { voice, vision };
}

/** The full model the Settings screen renders. Pure over disk state. */
export function buildSettingsModel(root, { globalHome = process.env.HOME } = {}) {
  const values = readFeatureConfig(root, globalHome);
  const layers = resolveLayers(root, globalHome);
  const availability = assessAvailability(values);
  return {
    root,
    configPath: configPath(root),
    globalConfigPath: globalHome ? configPath(globalHome) : null,
    features: {
      voice: { values: values.voice, layers: layers.voice, ...availability.voice },
      vision: { values: values.vision, layers: layers.vision, ...availability.vision },
    },
  };
}

// ---------------------------------------------------------------- writing

/** Only these keys may be written, and only with these types. An unknown key is a rejection,
 *  not a silent drop: a UI that thinks it saved something it did not is the failure mode. */
const WRITABLE = {
  voice: {
    enabled: 'boolean', trigger: ['hotkey', 'wake-word'], wakeWord: 'boolean',
    storeTranscripts: 'boolean', transcriptRetentionDays: 'number',
    sendTextToLlm: 'boolean', confidenceThreshold: 'number', serviceUrl: 'string|null',
  },
  vision: {
    enabled: 'boolean', mode: ['off', 'manual', 'presence', 'proactive'],
    camera: 'boolean', microphone: 'boolean', retentionDays: 'number',
    proactivePrompts: 'boolean',
  },
};

function typeOk(spec, v) {
  if (Array.isArray(spec)) return spec.includes(v);
  if (spec === 'string|null') return v === null || typeof v === 'string';
  if (spec === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === spec;
}

/** Validates a patch without touching disk. Returns every problem, not just the first — a form
 *  that reports one error per round-trip is a form people give up on. */
export function validatePatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['patch must be an object'] };
  }
  for (const [section, fields] of Object.entries(patch)) {
    if (!WRITABLE[section]) { errors.push(`unknown section "${section}"`); continue; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      errors.push(`section "${section}" must be an object`); continue;
    }
    for (const [key, value] of Object.entries(fields)) {
      const spec = WRITABLE[section][key];
      if (!spec) { errors.push(`unknown or read-only key "${section}.${key}"`); continue; }
      if (!typeOk(spec, value)) {
        errors.push(`"${section}.${key}" expects ${Array.isArray(spec) ? spec.join('|') : spec}`);
      }
    }
  }
  if (patch.voice && patch.voice.confidenceThreshold !== undefined) {
    const t = patch.voice.confidenceThreshold;
    if (!(t >= 0 && t <= 1)) errors.push('"voice.confidenceThreshold" must be between 0 and 1');
  }
  for (const s of ['voice', 'vision']) {
    const d = patch[s]?.[s === 'voice' ? 'transcriptRetentionDays' : 'retentionDays'];
    if (d !== undefined && !(d >= 0 && d <= 365)) errors.push(`"${s}" retention must be 0..365 days`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Applies a validated patch to `<root>/.samemind/config.json`.
 *
 * `withFileLock` is not decoration: this file is machine-wide and `setup.mjs` writes it too
 * (applyEmbedProbe). Atomic write protects a reader from a torn file; it does **not** protect
 * either writer from a lost update. Only the lock does.
 *
 * Foreign keys (embedUrl, projection, schema_version, …) survive because we mutate one section
 * of the parsed object and write the whole thing back — never reconstruct it from our own schema.
 */
export function applySettingsPatch(root, patch, { globalHome = process.env.HOME } = {}) {
  const v = validatePatch(patch);
  if (!v.ok) return { ok: false, status: 400, errors: v.errors };

  const file = configPath(root);
  // The lock is a directory created *beside* the target, so `.samemind/` must exist before we
  // take it. On a bundle that has never been configured it does not — and that is the ordinary
  // first-save, not an edge case. Without this the very first toggle a user flips throws ENOENT.
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(file, () => {
    let cfg = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      try {
        cfg = JSON.parse(raw);
      } catch {
        // Refuse rather than overwrite: a hand-edited file with a typo is still the user's data,
        // and clobbering it to "fix" a save is how people lose configuration.
        return { ok: false, status: 409, errors: [`${file} is not valid JSON — left untouched; fix it by hand`] };
      }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return { ok: false, status: 409, errors: [`${file} is not a JSON object — left untouched`] };
      }
    }

    let changed = false;
    for (const [section, fields] of Object.entries(patch)) {
      cfg[section] = { ...(cfg[section] || {}) };
      for (const [key, value] of Object.entries(fields)) {
        if (cfg[section][key] !== value) { cfg[section][key] = value; changed = true; }
      }
    }
    if (changed) atomicWriteFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);

    return { ok: true, status: 200, changed, settings: buildSettingsModel(root, { globalHome }) };
  });
}

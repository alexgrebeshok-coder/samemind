// Settings — voice/vision switchboard. Renders server truth only; unavailable ≠ off; layers visible.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import {
  postConfig,
  useApi,
  type ConfigLayer,
  type ConfigPatch,
  type Settings,
  type VisionConfig,
  type VoiceConfig,
} from '../api';
import { Card, Chip, Panel, Spinner } from '../ui';

const LAYER_HINT: Record<ConfigLayer, string> = {
  default: 'built-in default',
  global: 'from global config',
  project: 'from project config',
};

function fieldKey(section: 'voice' | 'vision', key: string) {
  return `${section}.${key}`;
}

function parseFieldErrors(errors: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const err of errors) {
    const quoted = err.match(/^"([^"]+)"/);
    const key = quoted?.[1] || '_general';
    const list = map.get(key) || [];
    list.push(err);
    map.set(key, list);
  }
  return map;
}

function FieldErrors({ messages }: { messages: string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <ul className="mt-1 list-inside list-disc text-xs text-danger" role="alert">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

function LayerNote({ layer }: { layer: ConfigLayer }) {
  return <span className="text-[11px] text-muted">({LAYER_HINT[layer]})</span>;
}

function AvailabilityNotice({
  feature,
}: {
  feature: Settings['features']['voice'] | Settings['features']['vision'];
}) {
  if (feature.available) {
    return feature.note ? <p className="text-xs text-muted">{feature.note}</p> : null;
  }
  return (
    <Card tone="danger" className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="danger">Unavailable</Chip>
        <span className="text-sm font-medium">No runner on this machine — not the same as “off”</span>
      </div>
      <p className="text-sm">{feature.reason}</p>
      {feature.fix ? <p className="text-xs text-muted">What to do: {feature.fix}</p> : null}
    </Card>
  );
}

function BoolSwitch({
  label,
  description,
  checked,
  layer,
  disabled,
  busy,
  errors,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  layer: ConfigLayer;
  disabled?: boolean;
  busy?: boolean;
  errors?: string[];
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const stateId = `${id}-state`;
  return (
    <div className="border-b border-line/70 py-4 last:border-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span id={labelId} className="text-sm font-medium">
              {label}
            </span>
            <LayerNote layer={layer} />
          </div>
          <p className="mt-0.5 text-xs text-muted">{description}</p>
          <p id={stateId} className="mt-1.5 text-xs">
            <span className="text-muted">Saved value: </span>
            <strong>{checked ? 'On' : 'Off'}</strong>
            {disabled ? <span className="text-muted"> · controls locked while unavailable</span> : null}
          </p>
          <FieldErrors messages={errors} />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={`${labelId} ${stateId}`}
          disabled={disabled || busy}
          onClick={() => onChange(!checked)}
          className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full border transition-colors ${
            checked ? 'border-accent bg-accent' : 'border-line bg-surface-2'
          } ${disabled || busy ? 'cursor-not-allowed opacity-50' : 'hover:border-accent/60'}`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-surface shadow transition-transform ${
              checked ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
          <span className="absolute size-px overflow-hidden whitespace-nowrap border-0 p-0 [clip:rect(0,0,0,0)]">
            {label}: {checked ? 'on' : 'off'}
          </span>
        </button>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  layer,
  errors,
  children,
}: {
  label: string;
  description: string;
  layer: ConfigLayer;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line/70 py-4 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        <LayerNote layer={layer} />
      </div>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      <div className="mt-2">{children}</div>
      <FieldErrors messages={errors} />
    </div>
  );
}

export function Settings() {
  const api = useApi<Settings>('/api/settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Map<string, string[]>>(new Map());
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    if (api.data) setSettings(api.data);
  }, [api.data]);

  const errFor = useCallback(
    (section: 'voice' | 'vision', key: string) => fieldErrors.get(fieldKey(section, key)),
    [fieldErrors],
  );

  const applyPatch = useCallback(async (patch: ConfigPatch) => {
    setBusy(true);
    setGlobalError(null);
    setFieldErrors(new Map());
    const result = await postConfig(patch);
    setBusy(false);
    if (result.ok) {
      setSettings(result.data);
      return;
    }
    if (result.status === 400 && result.errors) {
      setFieldErrors(parseFieldErrors(result.errors));
      return;
    }
    setGlobalError(result.message);
    if (result.errors?.length) setFieldErrors(parseFieldErrors(result.errors));
  }, []);

  const patchVoice = (fields: Partial<VoiceConfig>) => applyPatch({ voice: fields });
  const patchVision = (fields: Partial<VisionConfig>) => applyPatch({ vision: fields });

  if (api.loading && !settings) return <Spinner label="Loading settings" />;
  if (api.error && !settings) {
    return (
      <Card tone="danger" className="p-4 text-sm text-danger">
        Could not load settings — {api.error}
      </Card>
    );
  }
  if (!settings) return null;

  const { voice, vision } = settings.features;
  const visionLocked = !vision.available;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {globalError ? (
        <div role="alert" className="rounded-[12px] border border-danger/70 bg-danger-soft px-4 py-3 text-sm text-danger">
          {globalError}
        </div>
      ) : null}
      {busy ? (
        <p className="text-xs text-muted" role="status" aria-live="polite">
          Saving…
        </p>
      ) : null}

      <Panel
        title="Voice"
        hint="Microphone access, local storage, and LLM forwarding are three separate choices."
        right={
          voice.available ? (
            <Chip tone="ok" title={voice.note}>
              Available
            </Chip>
          ) : (
            <Chip tone="danger">Unavailable</Chip>
          )
        }
      >
        <div className="space-y-4">
          <AvailabilityNotice feature={voice} />
          <BoolSwitch
            label="Voice input"
            description="Allow samemind to listen for a hotkey or wake word and turn speech into text on this machine."
            checked={voice.values.enabled}
            layer={voice.layers.enabled}
            busy={busy}
            errors={errFor('voice', 'enabled')}
            onChange={(enabled) => patchVoice({ enabled })}
          />
          <BoolSwitch
            label="Wake word"
            description="Listen continuously for a spoken wake phrase (only applies when trigger is wake-word)."
            checked={voice.values.wakeWord}
            layer={voice.layers.wakeWord}
            busy={busy}
            errors={errFor('voice', 'wakeWord')}
            onChange={(wakeWord) => patchVoice({ wakeWord })}
          />
          <BoolSwitch
            label="Store transcripts locally"
            description="Keep recognized text on this machine for later review (not the same as turning the microphone on)."
            checked={voice.values.storeTranscripts}
            layer={voice.layers.storeTranscripts}
            busy={busy}
            errors={errFor('voice', 'storeTranscripts')}
            onChange={(storeTranscripts) => patchVoice({ storeTranscripts })}
          />
          <BoolSwitch
            label="Send recognized text to the LLM"
            description="Pipe transcribed speech into the model — separate from merely listening or saving locally."
            checked={voice.values.sendTextToLlm}
            layer={voice.layers.sendTextToLlm}
            busy={busy}
            errors={errFor('voice', 'sendTextToLlm')}
            onChange={(sendTextToLlm) => patchVoice({ sendTextToLlm })}
          />
          <SettingRow
            label="Activation trigger"
            description="How voice capture starts: keyboard shortcut or spoken wake word."
            layer={voice.layers.trigger}
            errors={errFor('voice', 'trigger')}
          >
            <select
              className="w-full max-w-xs rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
              value={voice.values.trigger}
              disabled={busy}
              onChange={(e) => patchVoice({ trigger: e.target.value as VoiceConfig['trigger'] })}
              aria-describedby="voice-trigger-state"
            >
              <option value="hotkey">Hotkey</option>
              <option value="wake-word">Wake word</option>
            </select>
            <p id="voice-trigger-state" className="mt-1.5 text-xs">
              <span className="text-muted">Saved value: </span>
              <strong>{voice.values.trigger === 'hotkey' ? 'Hotkey' : 'Wake word'}</strong>
            </p>
          </SettingRow>
          <SettingRow
            label="Transcript retention (days)"
            description="How long locally stored transcripts are kept before automatic deletion."
            layer={voice.layers.transcriptRetentionDays}
            errors={errFor('voice', 'transcriptRetentionDays')}
          >
            <input
              type="number"
              min={0}
              max={365}
              className="tnum w-full max-w-[8rem] rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
              defaultValue={voice.values.transcriptRetentionDays}
              key={`voice-retention-${voice.values.transcriptRetentionDays}`}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n !== voice.values.transcriptRetentionDays) {
                  patchVoice({ transcriptRetentionDays: n });
                }
              }}
            />
            <p className="mt-1.5 text-xs">
              <span className="text-muted">Saved value: </span>
              <strong className="tnum">{voice.values.transcriptRetentionDays} days</strong>
            </p>
          </SettingRow>
          <SettingRow
            label="Recognition confidence threshold"
            description="Minimum score (0–1) required before a phrase is accepted as recognized speech."
            layer={voice.layers.confidenceThreshold}
            errors={errFor('voice', 'confidenceThreshold')}
          >
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="tnum w-full max-w-[8rem] rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
              defaultValue={voice.values.confidenceThreshold}
              key={`voice-threshold-${voice.values.confidenceThreshold}`}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n !== voice.values.confidenceThreshold) {
                  patchVoice({ confidenceThreshold: n });
                }
              }}
            />
            <p className="mt-1.5 text-xs">
              <span className="text-muted">Saved value: </span>
              <strong className="tnum">{voice.values.confidenceThreshold}</strong>
            </p>
          </SettingRow>
          <SettingRow
            label="Companion service URL"
            description="HTTP endpoint of the voice companion that performs capture and recognition."
            layer={voice.layers.serviceUrl}
            errors={errFor('voice', 'serviceUrl')}
          >
            {/* Placeholder is a loopback example, not a remote-looking one: the companion is
                local by design — raw audio never leaves the device — so hinting at a remote
                host would contradict the promise. It also keeps the source free of external
                hosts, which ui/src/lib.test.mjs enforces as a spec §0 invariant (that check
                reads source text, so even a URL inside a comment trips it). */}
            <input
              type="url"
              className="w-full rounded-[12px] border border-line bg-surface px-3 py-2 font-mono text-sm"
              defaultValue={voice.values.serviceUrl ?? ''}
              key={`voice-url-${voice.values.serviceUrl ?? 'null'}`}
              placeholder="http://127.0.0.1:11434"
              disabled={busy}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next = raw === '' ? null : raw;
                if (next !== voice.values.serviceUrl) patchVoice({ serviceUrl: next });
              }}
            />
            <p className="mt-1.5 text-xs">
              <span className="text-muted">Saved value: </span>
              <strong className="font-mono">{voice.values.serviceUrl ?? 'not set'}</strong>
            </p>
          </SettingRow>
        </div>
      </Panel>

      <Panel
        title="Vision"
        hint="Ambient camera/microphone context (planned for 0.17)."
        right={vision.available ? <Chip tone="ok">Available</Chip> : <Chip tone="danger">Unavailable</Chip>}
      >
        <div className="space-y-4">
          <AvailabilityNotice feature={vision} />
          {visionLocked ? (
            <p className="text-sm text-muted">
              Values below reflect what is saved; controls stay disabled until a vision runner ships.
            </p>
          ) : null}
          <fieldset disabled={visionLocked || busy} className={visionLocked ? 'opacity-70' : undefined}>
            <BoolSwitch
              label="Vision features"
              description="Master switch for ambient vision on this bundle."
              checked={vision.values.enabled}
              layer={vision.layers.enabled}
              disabled={visionLocked}
              busy={busy}
              errors={errFor('vision', 'enabled')}
              onChange={(enabled) => patchVision({ enabled })}
            />
            <BoolSwitch
              label="Use camera"
              description="Allow periodic or on-demand frames from the system camera."
              checked={vision.values.camera}
              layer={vision.layers.camera}
              disabled={visionLocked}
              busy={busy}
              errors={errFor('vision', 'camera')}
              onChange={(camera) => patchVision({ camera })}
            />
            <BoolSwitch
              label="Use microphone (vision)"
              description="Allow ambient audio capture for vision context — separate from voice input above."
              checked={vision.values.microphone}
              layer={vision.layers.microphone}
              disabled={visionLocked}
              busy={busy}
              errors={errFor('vision', 'microphone')}
              onChange={(microphone) => patchVision({ microphone })}
            />
            <BoolSwitch
              label="Proactive prompts"
              description="Let vision suggest actions without you asking first (only in proactive mode)."
              checked={vision.values.proactivePrompts}
              layer={vision.layers.proactivePrompts}
              disabled={visionLocked}
              busy={busy}
              errors={errFor('vision', 'proactivePrompts')}
              onChange={(proactivePrompts) => patchVision({ proactivePrompts })}
            />
            <SettingRow
              label="Operating mode"
              description="How often vision runs: off, manual capture, presence-based, or fully proactive."
              layer={vision.layers.mode}
              errors={errFor('vision', 'mode')}
            >
              <select
                className="w-full max-w-xs rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
                value={vision.values.mode}
                disabled={visionLocked || busy}
                onChange={(e) => patchVision({ mode: e.target.value as VisionConfig['mode'] })}
              >
                <option value="off">Off</option>
                <option value="manual">Manual</option>
                <option value="presence">Presence</option>
                <option value="proactive">Proactive</option>
              </select>
              <p className="mt-1.5 text-xs">
                <span className="text-muted">Saved value: </span>
                <strong>{vision.values.mode}</strong>
              </p>
            </SettingRow>
            <SettingRow
              label="Retention (days)"
              description="How long vision captures are kept on disk."
              layer={vision.layers.retentionDays}
              errors={errFor('vision', 'retentionDays')}
            >
              <input
                type="number"
                min={0}
                max={365}
                className="tnum w-full max-w-[8rem] rounded-[12px] border border-line bg-surface px-3 py-2 text-sm"
                defaultValue={vision.values.retentionDays}
                key={`vision-retention-${vision.values.retentionDays}`}
                disabled={visionLocked || busy}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n !== vision.values.retentionDays) {
                    patchVision({ retentionDays: n });
                  }
                }}
              />
              <p className="mt-1.5 text-xs">
                <span className="text-muted">Saved value: </span>
                <strong className="tnum">{vision.values.retentionDays} days</strong>
              </p>
            </SettingRow>
          </fieldset>
        </div>
      </Panel>

      <p className="text-xs text-muted">
        Project file: <code className="font-mono">{settings.configPath}</code>
        {settings.globalConfigPath ? (
          <>
            {' '}
            · Global: <code className="font-mono">{settings.globalConfigPath}</code>
          </>
        ) : null}
      </p>
      <FieldErrors messages={fieldErrors.get('_general')} />
    </div>
  );
}

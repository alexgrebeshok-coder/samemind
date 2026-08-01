// probe-voice.mjs — best-effort reachability probe of a voice companion: a local, OpenAI-compatible
// transcription service the user points voice.serviceUrl at. Used by the dashboard's "check
// connection" button (GET /api/voice/probe) — never by the polling GET /api/settings, which stays
// pure and network-free (a slow companion must not make a slow dashboard; see settings.mjs).
//
// CAUTION (same scar as probe-embed.mjs): GET-only. Never touches any admin/auth endpoint, never
// POSTs audio to /v1/audio/transcriptions, never loads or warms a model. We only read what the
// server already reports at GET /v1/models to answer "does something OpenAI-compatible answer
// here?". Never throws — a dead, refused, slow, or malformed server is the expected "companion not
// reachable" case, not an error.
const TIMEOUT_MS = 2000;

async function getJson(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'GET', signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // dead, refused, timed out, malformed JSON — all equally "not reachable"
  } finally {
    clearTimeout(timer);
  }
}

// serviceUrl is the companion base (e.g. http://127.0.0.1:8000); the OpenAI-compatible model list
// lives at <base>/v1/models regardless of a trailing slash.
function modelsEndpoint(base) {
  return String(base).replace(/\/+$/, '') + '/v1/models';
}

/**
 * Probes the voice companion at `url` (voice.serviceUrl) with GET /v1/models. Returns
 * { url, engine, model } — engine labels the OpenAI-compatible contract we confirmed, model is the
 * first id the service lists (or null if it lists none) — or null if nothing answers or it does not
 * speak the /v1/models contract. `fetchImpl` is injectable so every test runs without a network;
 * never throws.
 */
export async function probeVoiceCompanion({ url, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) return null;
  const body = await getJson(fetchImpl, modelsEndpoint(url), timeoutMs);
  if (!body || !Array.isArray(body.data)) return null;
  const first = body.data[0];
  const model = first == null ? null : (typeof first === 'string' ? first : (first.id || first.name || null));
  return { url, engine: 'openai-compatible', model };
}

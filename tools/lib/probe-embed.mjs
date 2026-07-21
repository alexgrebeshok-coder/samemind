// probe-embed.mjs — best-effort discovery of a locally-running embeddings-capable server
// (omlx on :8000, Ollama on :11434), for a future `setup` command (U-B) to auto-suggest
// OKF_EMBED_URL instead of asking the user to find it by hand.
//
// CAUTION (omlx incident — see memory): GET-only, never touches ~/.omlx/settings.json or any
// admin/auth endpoint, never loads/warms a model. This only reads what the server already
// reports it has loaded/available. Never throws — a dead/unreachable/slow server is exactly
// the expected "no local embeddings" case, not an error.
const TIMEOUT_MS = 2000;
const EMBED_NAME_RE = /bge|embed|nomic/i;

async function getJson(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'GET', signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // dead, refused, timed out, malformed JSON — all equally "not usable"
  } finally {
    clearTimeout(timer);
  }
}

/** First model name matching the embedding-model heuristic in a models list (string ids or
 *  {id|name} objects — covers both OpenAI-style `data[]` and Ollama-style `models[]`). */
function findEmbedModel(list) {
  for (const m of list || []) {
    const name = typeof m === 'string' ? m : (m?.id || m?.name || '');
    if (EMBED_NAME_RE.test(name)) return name;
  }
  return null;
}

/**
 * Probes omlx (GET :8000/v1/models) then Ollama (GET :11434/api/tags) for a live server that
 * lists an embedding-shaped model (name matching bge/embed/nomic). Returns
 * {url, model, provider} pointing at that server's OpenAI-compatible /v1/embeddings endpoint —
 * the same shape `fetchEmbedding` (lib/recall.mjs) already POSTs to — or null if neither
 * responds or neither lists one. `fetchImpl` is injectable for tests; never throws.
 */
export async function probeEmbedEndpoint({ fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const omlx = await getJson(fetchImpl, 'http://127.0.0.1:8000/v1/models', timeoutMs);
  if (omlx) {
    const model = findEmbedModel(omlx.data);
    if (model) return { url: 'http://127.0.0.1:8000/v1/embeddings', model, provider: 'omlx' };
  }

  const ollama = await getJson(fetchImpl, 'http://127.0.0.1:11434/api/tags', timeoutMs);
  if (ollama) {
    const model = findEmbedModel(ollama.models);
    if (model) return { url: 'http://127.0.0.1:11434/v1/embeddings', model, provider: 'ollama' };
  }

  return null;
}

// http-guard.mjs — pure header checks for the one local write route on the ui server.
// No I/O: callers pass method, headers, and the bound TCP port.

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fail(status, error) {
  return { ok: false, status, error };
}

function pass() {
  return { ok: true };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function normalizeLoopbackHostname(hostname) {
  if (hostname === '[::1]') return '[::1]';
  if (hostname.toLowerCase() === 'localhost') return 'localhost';
  return hostname;
}

function isLoopbackIpv4(hostname) {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  return m.slice(1).every((oct) => Number(oct) <= 255);
}

/** Hostname only (no port): exact localhost, [::1], or full 127.x.x.x IPv4 loopback. */
function isLoopbackHostname(hostname) {
  const h = String(hostname);
  if (h === '[::1]') return true;
  if (h.toLowerCase() === 'localhost') return true;
  return isLoopbackIpv4(h);
}

/**
 * Parse a Host header value into { hostname, port } or { invalid: true }.
 * Port, if present, must be digits only. Rejects percent-encoding and malformed authorities.
 */
function parseHostAuthority(host) {
  if (host == null || host === '') return { invalid: true };
  const h = String(host);
  if (h.includes('%') || h.includes('@')) return { invalid: true };

  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close === -1) return { invalid: true };
    const hostname = h.slice(0, close + 1);
    if (h.length === close + 1) return { hostname, port: undefined };
    if (h[close + 1] !== ':') return { invalid: true };
    const port = h.slice(close + 2);
    if (!/^\d+$/.test(port)) return { invalid: true };
    return { hostname, port };
  }

  const colon = h.indexOf(':');
  if (colon === -1) return { hostname: h, port: undefined };
  const hostname = h.slice(0, colon);
  const port = h.slice(colon + 1);
  if (hostname.includes(':')) return { invalid: true };
  if (!/^\d+$/.test(port)) return { invalid: true };
  return { hostname, port };
}

/** True when the Host header names a loopback authority (hostname rules + numeric port only). */
export function isLoopbackHostHeader(host) {
  const parsed = parseHostAuthority(host);
  if (!parsed || parsed.invalid) return false;
  return isLoopbackHostname(parsed.hostname);
}

function hostAuthorityMatchesBound(host, boundPort) {
  const parsed = parseHostAuthority(host);
  if (!parsed || parsed.invalid) return false;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  if (parsed.port === undefined) return false;
  if (parsed.port !== String(boundPort)) return false;
  const norm = normalizeLoopbackHostname(parsed.hostname);
  return norm === '127.0.0.1' || norm === 'localhost' || norm === '[::1]';
}

function originMatchesHostAuthority(origin, host) {
  if (!origin) return false;
  let u;
  try {
    u = new URL(String(origin));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  return u.host === String(host);
}

function isJsonContentType(contentType) {
  if (contentType == null || contentType === '') return false;
  const main = String(contentType).split(';')[0].trim().toLowerCase();
  return main === 'application/json';
}

/**
 * @param {{ method: string, headers: Record<string, string|undefined>, boundPort: number }}
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkWriteRequest({ method, headers, boundPort }) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return pass();
  if (!WRITE_METHODS.has(m)) return pass();

  const host = headerValue(headers, 'host');
  if (host == null || host === '') return fail(400, 'missing host');

  if (!hostAuthorityMatchesBound(host, boundPort)) {
    return fail(403, 'forbidden host');
  }

  const origin = headerValue(headers, 'origin');
  if (!origin || !originMatchesHostAuthority(origin, host)) {
    return fail(403, 'forbidden origin');
  }

  const contentType = headerValue(headers, 'content-type');
  if (!isJsonContentType(contentType)) {
    return fail(415, 'unsupported media type');
  }

  const secFetchSite = headerValue(headers, 'sec-fetch-site');
  if (secFetchSite != null && String(secFetchSite).toLowerCase() === 'cross-site') {
    return fail(403, 'cross-site fetch');
  }

  return pass();
}

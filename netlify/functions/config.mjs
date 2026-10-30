// Serves ICE (STUN/TURN) settings to the app. Secrets live in Netlify environment variables,
// never in the repo. Order of preference:
//   1. Cloudflare TURN: CF_TURN_KEY_ID + CF_TURN_API_TOKEN → fresh short-lived credentials per join
//   2. Any static TURN server: TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
//   3. Nothing → the app falls back to PeerJS's free shared relays
const GOOGLE_STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const CREDENTIAL_TTL = 24 * 60 * 60; // comfortably longer than any match day

async function cloudflareIce(keyId, token) {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
  const { iceServers } = await res.json();
  // Browsers block port 53, so those URLs would only ever time out.
  return iceServers
    .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
    .filter(s => s.urls.length);
}

// Netlify's own accessor first (recommended for functions), then process.env (local dev).
// Trimmed, because a stray space pasted along with a value would break the request.
const envVar = name => (globalThis.Netlify?.env?.get(name) ?? process.env[name] ?? '').trim();

export default async () => {
  const env = Object.fromEntries(['CF_TURN_KEY_ID', 'CF_TURN_API_TOKEN', 'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'].map(k => [k, envVar(k)]));
  let iceServers = null, provider = null, error = null;
  // Which settings this deploy can see — names only, never values — for troubleshooting setup.
  const configured = { CF_TURN_KEY_ID: !!env.CF_TURN_KEY_ID, CF_TURN_API_TOKEN: !!env.CF_TURN_API_TOKEN, TURN_URLS: !!env.TURN_URLS };

  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try {
      iceServers = [...await cloudflareIce(env.CF_TURN_KEY_ID, env.CF_TURN_API_TOKEN), GOOGLE_STUN];
      provider = 'cloudflare';
    } catch (err) {
      error = err.message; // fall through to the next option rather than failing the join
    }
  }
  if (!iceServers && env.TURN_URLS) {
    iceServers = [GOOGLE_STUN, {
      urls: env.TURN_URLS.split(',').map(s => s.trim()),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL,
    }];
    provider = 'static';
  }

  return Response.json(
    { iceServers: iceServers || [GOOGLE_STUN], hasTurn: !!iceServers, provider, error, configured },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};

export const config = { path: '/config.json' };

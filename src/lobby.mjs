// Game lobby: a public list of games so officials can see their match is set up, while the audio
// itself still needs the match code. The code is never stored or returned — only a salted hash,
// checked here — and the public list shows roles that are connected, never names.
//
// A game can also be "open to listeners": anyone may listen without the code. That's controlled by
// whoever listed the game, and listeners connect through a separate listen-only route on each
// official's phone (see the app), so the code is still the only way to be heard.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HOUR = 3600e3;
const LIVE_MS = 150e3;          // a phone counts as "in the match" if it checked in this recently
const SHOW_AHEAD_MS = 7 * 24 * HOUR;
const SHOW_AFTER_MS = 6 * HOUR; // kicked-off games stay listed this long (longer while anyone's live)
const PURGE_AFTER_MS = 24 * HOUR;
const MAX_GAMES = 60;
const FAIL_WINDOW_MS = 15 * 60e3;
const MAX_FAILS = 12;           // wrong codes per game per window before it's locked for a while
const ROLE_ORDER = ['Referee', 'AR 1', 'AR 2', 'TMO', '4th Official', 'Assessor'];

const json = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const sha = s => createHash('sha256').update(s).digest('hex');
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const normCode = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function codeMatches(game, code) {
  const a = Buffer.from(sha(game.salt + normCode(code)));
  const b = Buffer.from(game.codeHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleLobby(req, kv, now = Date.now()) {
  const parts = new URL(req.url).pathname.replace(/^\/api\/lobby\/?/, '').split('/').filter(Boolean);
  const body = () => req.json().catch(() => ({}));
  try {
    if (!parts.length && req.method === 'GET') return json(200, { games: await listGames(kv, now) });
    if (!parts.length && req.method === 'POST') return await createGame(kv, await body(), now);

    const [id, action] = parts;
    if (!/^[a-f0-9]{16}$/.test(id)) return json(404, { error: 'No such game.' });
    const game = await kv.get(`game/${id}`);
    if (!game || game.ended) return json(404, { error: 'This game is no longer listed.' });
    if (req.method === 'POST' && action === 'verify') return await verify(kv, game, await body(), now);
    if (req.method === 'POST' && action === 'presence') return await presence(kv, game, await body(), now);
    if (req.method === 'POST' && action === 'end') return await endGame(kv, game, await body());
    if (req.method === 'POST' && action === 'settings') return await settings(kv, game, await body());
    return json(405, { error: 'Not supported.' });
  } catch (err) {
    console.error('lobby error', err);
    return json(500, { error: 'The game list is unavailable right now.' });
  }
}

async function listGames(kv, now) {
  const games = (await Promise.all((await kv.list('game/')).map(k => kv.get(k)))).filter(Boolean);
  const out = [];
  for (const g of games) {
    const kickoff = Date.parse(g.kickoff);
    if (g.ended || now - kickoff > PURGE_AFTER_MS) { await purge(kv, g.id); continue; }
    if (kickoff - now > SHOW_AHEAD_MS) continue;
    const seats = await liveSeats(kv, g.id, now);
    if (now - kickoff > SHOW_AFTER_MS && !seats.length) continue;
    const entry = { id: g.id, home: g.home, away: g.away, venue: g.venue, kickoff: g.kickoff, live: seats.map(s => s.role), openListen: !!g.openListen };
    // Listeners need to know which seats to tune in to (seat numbers and roles only).
    if (g.openListen) entry.seats = seats.filter(s => s.talks).map(({ seat, role }) => ({ seat, role }));
    out.push(entry);
  }
  // Games with officials connected first, then by kickoff.
  return out.sort((a, b) => (b.live.length > 0) - (a.live.length > 0) || Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

async function liveSeats(kv, id, now) {
  const keys = await kv.list(`presence/${id}/`);
  const seats = await Promise.all(keys.map(async k => ({ seat: Number(k.split('/').pop()), ...(await kv.get(k)) })));
  const rank = role => (ROLE_ORDER.indexOf(role) + 99) % 99; // unknown roles last
  return seats
    .filter(s => s.at && now - s.at < LIVE_MS)
    .map(s => ({ seat: s.seat, role: s.role, talks: s.talks !== false }))
    .sort((a, b) => rank(a.role) - rank(b.role));
}

async function purge(kv, id) {
  for (const k of await kv.list(`presence/${id}/`)) await kv.del(k);
  await kv.del(`game/${id}`);
}

async function createGame(kv, b, now) {
  const home = clean(b.home, 40), away = clean(b.away, 40), venue = clean(b.venue, 60);
  const code = normCode(b.code);
  const kickoff = Date.parse(b.kickoff);
  if (!home || !away) return json(400, { error: 'Enter both teams.' });
  if (!/^[A-Z0-9]{6,8}$/.test(code)) return json(400, { error: 'The match code must be 6–8 letters or numbers.' });
  if (!kickoff || kickoff < now - 12 * HOUR || kickoff > now + 60 * 24 * HOUR) return json(400, { error: 'Pick a kickoff time within the next 60 days.' });
  if ((await kv.list('game/')).length >= MAX_GAMES) return json(429, { error: 'The game list is full. Try again later.' });

  const id = randomBytes(8).toString('hex');
  const salt = randomBytes(8).toString('hex');
  const manageToken = randomBytes(18).toString('base64url'); // lets whoever listed it remove it
  await kv.set(`game/${id}`, {
    id, home, away, venue, kickoff: new Date(kickoff).toISOString(),
    salt, codeHash: sha(salt + code), manageHash: sha(manageToken),
    createdAt: new Date(now).toISOString(), fails: [], openListen: !!b.openListen,
  });
  return json(201, { id, manageToken });
}

async function verify(kv, game, b, now) {
  const fails = (game.fails || []).filter(t => now - t < FAIL_WINDOW_MS);
  if (fails.length >= MAX_FAILS) return json(429, { error: 'Too many wrong codes for this game. Wait a few minutes and try again.' });
  if (codeMatches(game, b.code)) return json(200, { ok: true });
  await kv.set(`game/${game.id}`, { ...game, fails: [...fails, now] });
  return json(403, { error: 'That code doesn\'t match this game. Check it with your referee.' });
}

async function presence(kv, game, b, now) {
  if (!codeMatches(game, b.code)) return json(403, { error: 'Wrong code.' });
  const seat = Number(b.seat);
  if (!Number.isInteger(seat) || seat < 1 || seat > 8) return json(400, { error: 'Bad seat.' });
  const key = `presence/${game.id}/${seat}`;
  if (b.gone) await kv.del(key);
  else await kv.set(key, { role: clean(b.role, 20) || 'Official', talks: b.talks !== false, at: now });
  // Check-ins double as the way officials' phones learn if listening was switched on or off.
  return json(200, { ok: true, openListen: !!game.openListen });
}

async function settings(kv, game, b) {
  if (!b.manageToken || sha(String(b.manageToken)) !== game.manageHash) return json(403, { error: 'Only the phone that listed this game can change it.' });
  const updated = { ...game, openListen: !!b.openListen };
  await kv.set(`game/${game.id}`, updated);
  return json(200, { ok: true, openListen: updated.openListen });
}

async function endGame(kv, game, b) {
  if (!b.manageToken || sha(String(b.manageToken)) !== game.manageHash) return json(403, { error: 'Only the phone that listed this game can remove it.' });
  await purge(kv, game.id);
  return json(200, { ok: true });
}

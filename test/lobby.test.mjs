import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLobby } from '../src/lobby.mjs';
import { fileStore } from '../src/lobby-store.mjs';

const NOW = Date.parse('2026-11-21T18:00:00Z');
const KICKOFF = '2026-11-21T19:30:00Z';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lobby-'));
  const kv = fileStore(dir);
  const call = async (method, path, body, now = NOW) => {
    const res = await handleLobby(new Request(`http://x/api/lobby${path}`, {
      method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' },
    }), kv, now);
    return { status: res.status, body: await res.json() };
  };
  return { kv, call, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const newGame = { home: 'Ashland', away: 'Wooster', venue: 'Riverside Park', kickoff: KICKOFF, code: 'K7M2QX' };

test('a listed game appears without its code, salt or tokens', async () => {
  const { call, cleanup } = await setup();
  const created = await call('POST', '', newGame);
  assert.equal(created.status, 201);
  const { body } = await call('GET', '');
  assert.equal(body.games.length, 1);
  assert.deepEqual(Object.keys(body.games[0]).sort(), ['away', 'home', 'id', 'kickoff', 'live', 'openListen', 'venue']);
  assert.equal(body.games[0].openListen, false);
  assert.ok(!JSON.stringify(body).includes('K7M2QX'));
  await cleanup();
});

test('verify accepts the right code (any case) and rejects a wrong one', async () => {
  const { call, cleanup } = await setup();
  const { body: { id } } = await call('POST', '', newGame);
  assert.equal((await call('POST', `/${id}/verify`, { code: 'k7m2qx' })).status, 200);
  assert.equal((await call('POST', `/${id}/verify`, { code: 'AAAAAA' })).status, 403);
  await cleanup();
});

test('too many wrong codes locks the game for a while', async () => {
  const { call, cleanup } = await setup();
  const { body: { id } } = await call('POST', '', newGame);
  for (let i = 0; i < 12; i++) await call('POST', `/${id}/verify`, { code: 'WRONG1' });
  assert.equal((await call('POST', `/${id}/verify`, { code: 'K7M2QX' })).status, 429);
  // ...and unlocks once the window has passed
  assert.equal((await call('POST', `/${id}/verify`, { code: 'K7M2QX' }, NOW + 16 * 60e3)).status, 200);
  await cleanup();
});

test('presence needs the code and shows roles only, expiring when phones stop checking in', async () => {
  const { call, cleanup } = await setup();
  const { body: { id } } = await call('POST', '', newGame);
  assert.equal((await call('POST', `/${id}/presence`, { code: 'NOPE00', seat: 1, role: 'Referee' })).status, 403);
  await call('POST', `/${id}/presence`, { code: 'K7M2QX', seat: 1, role: 'Referee', name: 'Jay' });
  await call('POST', `/${id}/presence`, { code: 'K7M2QX', seat: 2, role: 'AR 1' });
  let games = (await call('GET', '')).body.games;
  assert.deepEqual(games[0].live, ['Referee', 'AR 1']);
  assert.ok(!JSON.stringify(games).includes('Jay'));
  games = (await call('GET', '', null, NOW + 5 * 60e3)).body.games;
  assert.deepEqual(games[0].live, []);
  await cleanup();
});

test('only the listing phone can remove a game', async () => {
  const { call, cleanup } = await setup();
  const { body: { id, manageToken } } = await call('POST', '', newGame);
  assert.equal((await call('POST', `/${id}/end`, { manageToken: 'guess' })).status, 403);
  assert.equal((await call('POST', `/${id}/end`, { manageToken })).status, 200);
  assert.equal((await call('GET', '')).body.games.length, 0);
  await cleanup();
});

test('old games drop off the list', async () => {
  const { call, cleanup } = await setup();
  await call('POST', '', newGame);
  assert.equal((await call('GET', '', null, NOW + 8 * 3600e3)).body.games.length, 0);
  await cleanup();
});

test('bad input is rejected', async () => {
  const { call, cleanup } = await setup();
  assert.equal((await call('POST', '', { ...newGame, away: '' })).status, 400);
  assert.equal((await call('POST', '', { ...newGame, code: 'ABCD' })).status, 400);
  assert.equal((await call('POST', '', { ...newGame, kickoff: 'soon' })).status, 400);
  await cleanup();
});

test('listening without a code is off by default and only the lister can switch it', async () => {
  const { call, cleanup } = await setup();
  const { body: { id, manageToken } } = await call('POST', '', newGame);
  let g = (await call('GET', '')).body.games[0];
  assert.equal(g.openListen, false);
  assert.equal(g.seats, undefined); // no seat map unless listening is open
  assert.equal((await call('POST', `/${id}/settings`, { manageToken: 'guess', openListen: true })).status, 403);
  assert.equal((await call('POST', `/${id}/settings`, { manageToken, openListen: true })).status, 200);
  const checkIn = await call('POST', `/${id}/presence`, { code: 'K7M2QX', seat: 3, role: 'AR 1', name: 'Sam' });
  assert.equal(checkIn.body.openListen, true); // officials' phones learn the setting from check-ins
  await call('POST', `/${id}/presence`, { code: 'K7M2QX', seat: 1, role: 'Referee' });
  await call('POST', `/${id}/presence`, { code: 'K7M2QX', seat: 5, role: 'Assessor', talks: false });
  g = (await call('GET', '')).body.games[0];
  assert.equal(g.openListen, true);
  assert.deepEqual(g.seats, [{ seat: 1, role: 'Referee' }, { seat: 3, role: 'AR 1' }]); // talkers only, roles not names
  assert.deepEqual(g.live, ['Referee', 'AR 1', 'Assessor']);
  assert.ok(!JSON.stringify(g).includes('Sam') && !JSON.stringify(g).includes('K7M2QX'));
  await cleanup();
});

test('a game can be listed open to listeners from the start', async () => {
  const { call, cleanup } = await setup();
  await call('POST', '', { ...newGame, openListen: true });
  assert.equal((await call('GET', '')).body.games[0].openListen, true);
  await cleanup();
});

// Serves ICE (STUN/TURN) settings to the app. TURN credentials live in Netlify environment
// variables, never in the repo. Without them the app falls back to PeerJS's free relays.
export default async () => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turn = process.env.TURN_URLS;
  if (turn) {
    iceServers.push({
      urls: turn.split(',').map(s => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return Response.json({ iceServers, hasTurn: !!turn }, { headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/config.json' };

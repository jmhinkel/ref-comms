// Public game list (see src/lobby.mjs). Stored in Netlify Blobs.
import { lobbyStore } from '../../src/lobby-store.mjs';
import { handleLobby } from '../../src/lobby.mjs';

export default async req => handleLobby(req, await lobbyStore());

export const config = { path: ['/api/lobby', '/api/lobby/*'] };

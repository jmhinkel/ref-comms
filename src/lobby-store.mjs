// Key-value storage for the game lobby. On Netlify it's Netlify Blobs; locally it's a folder of
// JSON files, so `npm start` works with no account or setup.
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function lobbyStore() {
  if (globalThis.Netlify) {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore({ name: 'ref-comms-lobby', consistency: 'strong' });
    return {
      get: key => store.get(key, { type: 'json' }),
      set: (key, value) => store.setJSON(key, value),
      del: key => store.delete(key),
      list: async prefix => (await store.list({ prefix })).blobs.map(b => b.key),
    };
  }
  return fileStore(process.env.LOBBY_DIR || fileURLToPath(new URL('../.data/lobby/', import.meta.url)));
}

export function fileStore(dir) {
  const file = key => join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key) {
      try { return JSON.parse(await readFile(file(key), 'utf8')); } catch { return null; }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(key), JSON.stringify(value));
    },
    async del(key) {
      await unlink(file(key)).catch(() => {});
    },
    async list(prefix) {
      const names = await readdir(dir).catch(() => []);
      return names
        .filter(n => n.endsWith('.json'))
        .map(n => decodeURIComponent(n.slice(0, -5)))
        .filter(k => k.startsWith(prefix));
    },
  };
}

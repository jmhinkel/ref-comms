// Local dev server: serves public/ and mimics the Netlify /config.json function.
// Not needed in production — Netlify hosts the static files and the function.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// Run the real Netlify functions so local testing exercises the same code as production.
// The lobby stores its data in .data/lobby/ locally instead of Netlify Blobs.
const configFunction = import('./netlify/functions/config.mjs').then(m => m.default);
const lobbyFunction = import('./netlify/functions/lobby.mjs').then(m => m.default);

async function sendResponse(res, response) {
  res.writeHead(response.status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(await response.text());
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') return sendResponse(res, await (await configFunction)());
  if (url.pathname === '/api/lobby' || url.pathname.startsWith('/api/lobby/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    return sendResponse(res, await (await lobbyFunction)(request));
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Ref Comms dev server on http://localhost:${PORT}`));

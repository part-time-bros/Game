/**
 * serve.js — zero-dependency static server for local development.
 * Usage: node tools/serve.js [port]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err && err.message));
  }
});

server.listen(PORT, () => {
  console.log(`NOVA LANCE dev server → http://localhost:${PORT}/`);
});

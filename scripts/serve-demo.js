#!/usr/bin/env node
/** Minimal static server for the demo. No dependencies, binds to 127.0.0.1 only. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/demo/index.html';
    const full = resolve(join(root, path));
    if (!full.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(full);
    const file = info.isDirectory() ? join(full, 'index.html') : full;
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(String(e.message));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`demo: http://127.0.0.1:${port}/demo/`);
  console.log('press Ctrl+C to stop');
});

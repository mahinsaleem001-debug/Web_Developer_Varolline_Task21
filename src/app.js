'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { LinkStore, HttpError } = require('./store');
const { TokenBucketLimiter } = require('./limiter');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function createApp({ store = new LinkStore(), writeLimiter, readLimiter } = {}) {
  writeLimiter = writeLimiter || new TokenBucketLimiter({ capacity: 10, refillPerSec: 0.5 }); // 30 creates/min sustained
  readLimiter = readLimiter || new TokenBucketLimiter({ capacity: 100, refillPerSec: 50 });

  const send = (res, status, body, headers = {}) => {
    const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10_000) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new HttpError(400, 'invalid JSON')); } });
  });
  const limit = (limiter, req, res) => {
    const r = limiter.take(req.socket.remoteAddress || 'unknown');
    const h = { 'X-RateLimit-Limit': r.limit, 'X-RateLimit-Remaining': r.remaining };
    if (!r.allowed) { send(res, 429, { error: 'Too many requests. Try again shortly.', retryAfter: r.retryAfter }, { ...h, 'Retry-After': r.retryAfter }); return null; }
    return h;
  };

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      store.baseUrl = `http://${req.headers.host}`;

      if (req.method === 'GET' && parts.length === 0) {
        return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (parts[0] === 'api') {
        if (parts[1] === 'health' && req.method === 'GET') return send(res, 200, { status: 'ok', ...store.stats() });
        if (parts[1] === 'links') {
          if (req.method === 'POST' && parts.length === 2) {
            const h = limit(writeLimiter, req, res); if (!h) return;
            const body = await readJson(req);
            return send(res, 201, store.create(body), h);
          }
          if (req.method === 'GET' && parts.length === 2) return send(res, 200, { links: store.list(), stats: store.stats() });
          if (req.method === 'GET' && parts.length === 3) {
            const l = store.get(parts[2]); return l ? send(res, 200, l) : send(res, 404, { error: 'link not found' });
          }
          if (req.method === 'DELETE' && parts.length === 3) {
            return store.remove(parts[2]) ? send(res, 204, '') : send(res, 404, { error: 'link not found' });
          }
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && parts.length === 1) {
        const h = limit(readLimiter, req, res); if (!h) return;
        const target = store.resolve(parts[0]);
        // 302 (not 301): browsers must keep hitting us so clicks are counted and deletes/expiry take effect.
        return target ? send(res, 302, '', { ...h, Location: target, 'Cache-Control': 'private, max-age=0' }) : send(res, 404, { error: 'link not found or expired' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e); send(res, 500, { error: 'internal error' }); // never leak internals
    }
  };
  const server = http.createServer(handler);
  server.store = store;
  return server;
}
module.exports = { createApp };

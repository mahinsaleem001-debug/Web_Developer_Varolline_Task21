'use strict';
const { encode, ALIAS_RE } = require('./codec');
const { LRU } = require('./lru');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const RESERVED = new Set(['api', 'health', 'favicon.ico', 'index.html']);
const MAX_URL = 2048;

function validateUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'url is required');
  if (raw.length > MAX_URL) throw new HttpError(400, `url exceeds ${MAX_URL} characters`);
  let u; try { u = new URL(raw.trim()); } catch { throw new HttpError(400, 'url is not valid'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'only http and https links are allowed');
  return u.toString();
}

// Source of truth is a Map here; the interface (create/resolve/get/remove/list) is what a
// Postgres/Redis-backed store would implement. The LRU sits in front of the read path.
class LinkStore {
  constructor({ now = Date.now, cacheSize = 1000, baseUrl = '' } = {}) {
    this.now = now; this.baseUrl = baseUrl;
    this.links = new Map(); this.counter = 0;
    this.cache = new LRU(cacheSize);
  }
  create({ url, alias, ttlSeconds }) {
    const target = validateUrl(url);
    let code;
    if (alias != null && alias !== '') {
      if (!ALIAS_RE.test(alias)) throw new HttpError(400, 'alias must be 3-32 chars: letters, numbers, - or _');
      if (RESERVED.has(alias.toLowerCase())) throw new HttpError(400, 'alias is reserved');
      if (this.links.has(alias)) throw new HttpError(409, 'alias is already taken');
      code = alias;
    } else {
      do { code = encode(++this.counter); } while (this.links.has(code)); // skip codes taken as aliases
    }
    let expiresAt = null;
    if (ttlSeconds != null) {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 31536000) throw new HttpError(400, 'ttlSeconds must be between 1 and 31536000');
      expiresAt = this.now() + ttlSeconds * 1000;
    }
    const link = { code, url: target, createdAt: this.now(), expiresAt, clicks: 0, buckets: new Map() };
    this.links.set(code, link);
    return this.view(link);
  }
  _live(code) {
    const l = this.links.get(code);
    if (!l) return null;
    if (l.expiresAt && l.expiresAt <= this.now()) { this.links.delete(code); this.cache.delete(code); return null; } // lazy expiry
    return l;
  }
  // Hot path: cache first, store on miss. Click counting is O(1) and never blocks the redirect.
  resolve(code) {
    let entry = this.cache.get(code);
    if (!entry || (entry.expiresAt && entry.expiresAt <= this.now())) {
      const l = this._live(code);
      if (!l) { this.cache.delete(code); return null; }
      entry = { url: l.url, expiresAt: l.expiresAt };
      this.cache.set(code, entry);
    }
    const l = this.links.get(code);
    if (l) { l.clicks++; const m = Math.floor(this.now() / 60000); l.buckets.set(m, (l.buckets.get(m) || 0) + 1); this._trim(l, m); }
    return entry.url;
  }
  _trim(l, m) { for (const k of l.buckets.keys()) if (k < m - 59) l.buckets.delete(k); } // keep last 60 minutes
  get(code) { const l = this._live(code); return l ? this.view(l) : null; }
  remove(code) { this.cache.delete(code); return this.links.delete(code); }
  list(limit = 50) {
    return [...this.links.values()].filter(l => this._live(l.code)).reverse().slice(0, limit).map(l => this.view(l));
  }
  view(l) {
    const m = Math.floor(this.now() / 60000);
    const series = Array.from({ length: 30 }, (_, i) => l.buckets.get(m - 29 + i) || 0); // clicks per minute, last 30 min
    return { code: l.code, shortUrl: `${this.baseUrl}/${l.code}`, url: l.url, createdAt: l.createdAt, expiresAt: l.expiresAt, clicks: l.clicks, series };
  }
  stats() { return { links: this.links.size, cacheSize: this.cache.size, cacheHits: this.cache.hits, cacheMisses: this.cache.misses }; }
}
module.exports = { LinkStore, HttpError };

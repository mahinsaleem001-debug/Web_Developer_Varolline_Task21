'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encode } = require('../src/codec');
const { LRU } = require('../src/lru');
const { TokenBucketLimiter } = require('../src/limiter');
const { LinkStore } = require('../src/store');

test('codec: 7 chars and unique across 200k ids', () => {
  const seen = new Set();
  for (let i = 1; i <= 200000; i++) { const c = encode(i); assert.strictEqual(c.length, 7); seen.add(c); }
  assert.strictEqual(seen.size, 200000);
});

test('lru: evicts least recently used', () => {
  const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.strictEqual(c.get('b'), undefined); assert.strictEqual(c.get('a'), 1);
});

test('limiter: burst, deny, then refill over time', () => {
  let t = 0; const l = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
  for (let i = 0; i < 3; i++) assert.ok(l.take('ip').allowed);
  const denied = l.take('ip'); assert.ok(!denied.allowed); assert.strictEqual(denied.retryAfter, 1);
  t += 2000; assert.ok(l.take('ip').allowed);
  assert.ok(l.take('other').allowed, 'keys are independent');
});

test('store: create, resolve, count clicks, cache hit', () => {
  const s = new LinkStore(); const l = s.create({ url: 'https://example.com/a' });
  assert.strictEqual(s.resolve(l.code), 'https://example.com/a'); s.resolve(l.code);
  assert.strictEqual(s.get(l.code).clicks, 2); assert.strictEqual(s.stats().cacheHits, 1);
});

test('store: validation rejects bad input', () => {
  const s = new LinkStore();
  for (const url of ['', 'nope', 'javascript:alert(1)', 'ftp://x.com', 'https://x.com/' + 'a'.repeat(2100)]) assert.throws(() => s.create({ url }), { status: 400 });
  assert.throws(() => s.create({ url: 'https://x.com', alias: 'a!' }), { status: 400 });
  assert.throws(() => s.create({ url: 'https://x.com', alias: 'api' }), { status: 400 });
});

test('store: alias conflict -> 409; generated codes skip taken aliases', () => {
  const s = new LinkStore(); s.create({ url: 'https://x.com', alias: 'promo' });
  assert.throws(() => s.create({ url: 'https://y.com', alias: 'promo' }), { status: 409 });
  const s2 = new LinkStore(); s2.links.set(encode(1), { code: encode(1), url: 'https://z.com', buckets: new Map() });
  assert.notStrictEqual(s2.create({ url: 'https://x.com' }).code, encode(1));
});

test('store: expiry is enforced even when the link is cached', () => {
  let t = 1000; const s = new LinkStore({ now: () => t });
  const l = s.create({ url: 'https://x.com', ttlSeconds: 10 });
  assert.ok(s.resolve(l.code)); t += 11000;
  assert.strictEqual(s.resolve(l.code), null); assert.strictEqual(s.get(l.code), null);
});

test('store: delete invalidates the cache', () => {
  const s = new LinkStore(); const l = s.create({ url: 'https://x.com' });
  s.resolve(l.code); s.remove(l.code); assert.strictEqual(s.resolve(l.code), null);
});

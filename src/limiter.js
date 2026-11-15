'use strict';
// Token bucket per key. Lazy refill (no timers): tokens are recomputed on each request.
// Allows short bursts up to `capacity` while enforcing `refillPerSec` on average.
class TokenBucketLimiter {
  constructor({ capacity, refillPerSec, now = Date.now, maxKeys = 50000 }) {
    Object.assign(this, { capacity, refillPerSec, now, maxKeys });
    this.buckets = new Map();
  }
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, ts: t }; if (this.buckets.size >= this.maxKeys) this._evict(); }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.ts) / 1000) * this.refillPerSec);
    b.ts = t;
    this.buckets.delete(key); this.buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { allowed: true, remaining: Math.floor(b.tokens), limit: this.capacity, retryAfter: 0 }; }
    return { allowed: false, remaining: 0, limit: this.capacity, retryAfter: Math.ceil((1 - b.tokens) / this.refillPerSec) };
  }
  _evict() { this.buckets.delete(this.buckets.keys().next().value); } // drop least recently used
}
module.exports = { TokenBucketLimiter };

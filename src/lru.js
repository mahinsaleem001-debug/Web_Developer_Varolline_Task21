'use strict';
// Tiny LRU using Map insertion order. get() refreshes recency; set() evicts the oldest.
class LRU {
  constructor(max = 1000) { this.max = max; this.map = new Map(); this.hits = 0; this.misses = 0; }
  get(k) {
    if (!this.map.has(k)) { this.misses++; return undefined; }
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); this.hits++; return v;
  }
  set(k, v) {
    this.map.delete(k); this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(k) { this.map.delete(k); }
  get size() { return this.map.size; }
}
module.exports = { LRU };

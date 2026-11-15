# Design Document: Shortlink (URL Shortener)

## 1. Goals and scope
Turn a long URL into a short one, redirect fast, and show click activity. I chose a URL shortener because its core problem (read-heavy traffic, unique ID generation, abuse control) lets me justify real trade-offs without a large codebase.

**Functional requirements**
- Create a short link from an http/https URL, with an optional custom alias and optional expiry.
- Redirect `GET /{code}` to the destination.
- List links, view per-link stats (total clicks, clicks per minute for the last 30 minutes), delete a link.

**Non-functional requirements**
- Redirect latency: p99 under 10 ms in-process; the redirect must not depend on analytics succeeding.
- Reads dominate writes (assume 100:1). Availability matters more than strict consistency of click counts.
- Codes must be unique, short (7 chars) and not trivially enumerable.
- Abuse resistance: rate limiting, input validation, no `javascript:` or other schemes.

**Out of scope (deliberately):** user accounts, link editing, malware scanning, custom domains.

## 2. Capacity estimate
Assume 10 M new links per month (~4 per second) and 1 B redirects per month (~400/s average, ~2,000/s peak).
Storage: ~500 bytes per link x 120 M links per year is about 60 GB per year, which fits on one database node for years.
A 7-character base62 code gives 62^7, about 3.5 trillion codes, enough for centuries at this rate.

## 3. Data model
`Link { code (PK), url, createdAt, expiresAt|null, clicks, buckets }`

- `code` is the primary key, so redirect lookup is a single key read.
- `buckets` is a map of minute -> click count, trimmed to the last 60 minutes. In production this becomes a separate time-series or counter table so redirects never write to the link row.

In this implementation the store is an in-memory `Map` behind a small interface (`create / resolve / get / remove / list`). The interface is the contract; the backing store is replaceable.

## 4. API
| Method | Path | Result |
|---|---|---|
| POST | `/api/links` body `{url, alias?, ttlSeconds?}` | 201 link; 400 invalid; 409 alias taken; 429 rate limited |
| GET | `/api/links` | 200 `{links, stats}` |
| GET | `/api/links/{code}` | 200 link; 404 |
| DELETE | `/api/links/{code}` | 204; 404 |
| GET | `/{code}` | 302 `Location`; 404 if missing or expired; 429 |
| GET | `/api/health` | 200 status and cache stats |

Rate limit headers `X-RateLimit-Limit` and `X-RateLimit-Remaining` are returned; 429 adds `Retry-After`.

## 5. Code generation
**Decision:** a global counter, mapped through a bijective scramble (`(n * M + offset) mod 62^7`) and encoded in base62.

| Option | Collisions | Guessable | Coordination cost |
|---|---|---|---|
| Random 7 chars + retry | Possible, needs a check per write | No | Extra read per write |
| Hash of URL (truncate) | Likely at scale | No | Same URL always collides |
| Plain counter in base62 | Never | Yes (code N+1 is predictable) | Needs a central counter |
| **Counter + scramble (chosen)** | **Never** (multiplier is coprime to 62^7, so the mapping is a bijection) | **Hard to guess in order** | Central counter |

The scramble is obfuscation, not security: someone who learns the constants can enumerate. Links are public by design, so this is acceptable; private links would need random 128-bit tokens.
Multi-node scaling: each app node leases a block of 10,000 counter values from the database (or Redis `INCRBY`), so nodes generate codes locally with no per-request coordination. A crash wastes at most one block, which is harmless given the code space.
Custom aliases live in the same namespace; generated codes skip any value already taken as an alias.

## 6. Caching
Redirects are read-heavy and the data is almost immutable, so an LRU cache (1,000 entries here, sized by memory in production) sits in front of the store.
- Cache holds `url` and `expiresAt`. Expiry is re-checked on every hit, so a cached link cannot outlive its TTL.
- Delete invalidates the entry immediately.
- Production: a per-node LRU plus a shared Redis tier. A 302 response (below) means CDN caching of redirects stays off, so the application cache does the work.

## 7. Rate limiting
Token bucket per client IP, lazily refilled (no timers).
- Create: burst 10, then 0.5 per second (30 per minute). Redirect: burst 100, then 50 per second.
- **Why token bucket over fixed window:** fixed windows allow double-rate bursts at window edges; sliding-window logs cost memory per request. A bucket is O(1) memory per client and permits harmless bursts.
- Bucket map is capped (50,000 keys, LRU eviction) so an attacker cannot exhaust memory with spoofed IPs.
- Limitation: in-process state is per node. At multiple nodes, move buckets to Redis with an atomic Lua script. Behind a proxy, key on the trusted `X-Forwarded-For` hop, not the socket address.

## 8. Scaling approach
1. **Now:** one stateless Node process.
2. **Horizontal:** N identical app nodes behind a load balancer; state moves to Postgres (links) and Redis (cache, rate limits, counter blocks).
3. **Database:** shard by `code` hash only when a single primary stops fitting (not before roughly 1 TB). Read replicas serve cache misses.
4. **Analytics:** stop incrementing counters inline; publish click events to a queue and aggregate in batches, so the redirect path has no write.
5. **Expiry:** lazy deletion on read (implemented) plus a periodic sweep job to reclaim space.

## 9. Failure handling
| Failure | Behaviour |
|---|---|
| Invalid input | 400 with a specific message; nothing is stored |
| Alias collision | 409; the client picks another |
| Unknown or expired code | 404, and the cache entry is dropped |
| Malformed or oversized body | 400 / 413 (10 KB cap), connection closed on overflow |
| Unexpected exception | Logged server-side, generic 500 returned (no stack traces leaked) |
| Cache down (production) | Fall through to the database; slower but correct |
| Analytics failure (production) | Never blocks the redirect; events are dropped or retried |
| Node crash | Stateless nodes restart freely; with Postgres no links are lost, and at most one counter block is skipped |
| Overload | 429 sheds load per client before it reaches the store |

**Known limitation of this build:** data lives in memory and is lost on restart. This is the first thing to replace (Postgres), and the `LinkStore` interface is shaped for that swap.

## 10. Security
- Only `http:` and `https:` schemes; URLs capped at 2,048 characters and normalised with the `URL` parser.
- Reserved aliases (`api`, `health`, ...) cannot shadow routes.
- The frontend inserts all user data with `textContent` (never `innerHTML`), preventing stored XSS from hostile URLs or aliases.
- Open-redirect abuse (phishing via short links) is the inherent risk of this product; mitigations are rate limits now, and URL reputation checks plus a report-abuse flow later.

## 11. Trade-offs and decisions
| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Redirect status | 302 | 301 | A 301 is cached by browsers forever, which would hide clicks and make delete or expiry ineffective. Cost: more traffic to us. |
| Storage in this build | In-memory Map behind an interface | SQLite or Postgres | Keeps the project dependency-free and runnable anywhere; interface limits the rewrite. |
| Click counting | Inline O(1) increment | Async queue | Simplest correct thing at this scale; documented upgrade path. |
| Same URL submitted twice | Two separate codes | Deduplicate | Per-link stats and expiry would be shared and confusing. |
| Dependencies | None (Node core only) | Express | Fewer moving parts, and every line is explainable. |
| Rate limiter | Token bucket | Fixed or sliding window | See section 7. |
| Time | Injected `now()` | `Date.now()` directly | Makes expiry and rate-limit tests deterministic, with no sleeps. |

## 12. Testing strategy
Unit tests cover the code generator (200,000 unique codes), LRU eviction, limiter burst and refill using a fake clock, validation, alias conflicts, expiry of cached links, and cache invalidation. API tests start a real server on a random port and cover create, redirect, stats, delete, error codes, and 429 with `Retry-After`.

## 13. Future work
Postgres store, Redis shared cache and limiter, event-queue analytics, API keys per user, QR codes, and abuse reporting.

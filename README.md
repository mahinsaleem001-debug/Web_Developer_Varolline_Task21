# Shortlink

A URL shortener with a design document, a working core flow (create, redirect, track, delete), automated tests and an interactive dashboard. No dependencies; Node.js 18+.

## Run
```bash
npm start            # http://localhost:3000
PORT=8080 npm start  # custom port
npm test             # 12 tests, node:test
```

## What to try
1. Open http://localhost:3000 and shorten a link (add a custom name or an expiry if you like).
2. Press **Test click** a few times and watch the click counter and sparkline update.
3. Press **Shorten link** more than 10 times quickly. The creation allowance drains and the server answers 429.

## API
```bash
curl -X POST localhost:3000/api/links -d '{"url":"https://example.com","alias":"demo","ttlSeconds":3600}'
curl -i localhost:3000/demo          # 302 Location: https://example.com/
curl localhost:3000/api/links/demo   # stats
curl -X DELETE localhost:3000/api/links/demo
```
Full table of routes and status codes: see `DESIGN.md` section 4.

## Layout
```
DESIGN.md        design document: requirements, data model, API, scaling, caching, failures, trade-offs
src/codec.js     counter -> unique, non-sequential base62 code
src/lru.js       LRU cache
src/limiter.js   token-bucket rate limiter
src/store.js     links, validation, expiry, click stats
src/app.js       HTTP routes (Node core http)
public/index.html  dashboard
test/            unit and API tests
```

## Known limitations
Data is in memory and resets on restart; the rate limiter and cache are per process. `DESIGN.md` explains how each moves to Postgres/Redis when scaling out.

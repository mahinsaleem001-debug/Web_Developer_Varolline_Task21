'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { TokenBucketLimiter } = require('../src/limiter');

async function boot(opts) {
  const server = createApp(opts); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}
const post = (base, body) => fetch(base + '/api/links', { method: 'POST', body: JSON.stringify(body) });

test('end to end: create -> redirect -> stats -> delete -> 404', async () => {
  const { base, close } = await boot();
  const created = await post(base, { url: 'https://example.com/docs' });
  assert.strictEqual(created.status, 201);
  const link = await created.json();
  const r = await fetch(`${base}/${link.code}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), 'https://example.com/docs');
  await fetch(`${base}/${link.code}`, { redirect: 'manual' });
  assert.strictEqual((await (await fetch(`${base}/api/links/${link.code}`)).json()).clicks, 2);
  assert.strictEqual((await fetch(`${base}/api/links/${link.code}`, { method: 'DELETE' })).status, 204);
  assert.strictEqual((await fetch(`${base}/${link.code}`, { redirect: 'manual' })).status, 404);
  await close();
});

test('api: error codes for bad JSON, bad url, duplicate alias', async () => {
  const { base, close } = await boot();
  assert.strictEqual((await fetch(base + '/api/links', { method: 'POST', body: '{oops' })).status, 400);
  assert.strictEqual((await post(base, { url: 'javascript:1' })).status, 400);
  await post(base, { url: 'https://a.com', alias: 'mine' });
  assert.strictEqual((await post(base, { url: 'https://b.com', alias: 'mine' })).status, 409);
  await close();
});

test('rate limiting: 429 with Retry-After once the bucket is empty', async () => {
  const writeLimiter = new TokenBucketLimiter({ capacity: 2, refillPerSec: 0.01 });
  const { base, close } = await boot({ writeLimiter });
  assert.strictEqual((await post(base, { url: 'https://a.com' })).status, 201);
  const second = await post(base, { url: 'https://a.com' });
  assert.strictEqual(second.headers.get('x-ratelimit-remaining'), '0');
  const third = await post(base, { url: 'https://a.com' });
  assert.strictEqual(third.status, 429); assert.ok(Number(third.headers.get('retry-after')) > 0);
  await close();
});

test('serves the dashboard and health endpoint', async () => {
  const { base, close } = await boot();
  assert.match(await (await fetch(base + '/')).text(), /<title>/);
  assert.strictEqual((await (await fetch(base + '/api/health')).json()).status, 'ok');
  await close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// Minimal ExecutionContext stub. The validation paths we exercise return
// before any background work, so waitUntil is a no-op here.
const ctx = { waitUntil() {} };
const env = {};

function get(path) {
  return worker.fetch(new Request('https://example.com' + path), env, ctx);
}
function post(path, body, { raw = false } = {}) {
  return worker.fetch(new Request('https://example.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body)
  }), env, ctx);
}

test('GET / serves the SPA HTML', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /FamilyTripAI/);
});

test('served HTML wires sanitization and PWA (regression guards)', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /dompurify/i, 'DOMPurify must be loaded');
  assert.match(html, /rel="manifest"/, 'manifest must be linked');
  assert.match(html, /serviceWorker\.register/, 'service worker must register');
});

test('GET /manifest.webmanifest returns a valid manifest', async () => {
  const res = await get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.name, 'FamilyTripAI');
  assert.ok(Array.isArray(m.icons) && m.icons.length > 0);
});

test('GET /sw.js returns the service worker script', async () => {
  const res = await get('/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  assert.match(await res.text(), /addEventListener\('fetch'/);
});

test('GET /icon.svg returns SVG', async () => {
  const res = await get('/icon.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /svg/);
});

test('OPTIONS preflight returns 204 with CORS', async () => {
  const res = await worker.fetch(new Request('https://example.com/chat', { method: 'OPTIONS' }), env, ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('POST /chat rejects a missing/invalid Groq key', async () => {
  const res = await post('/chat', { message: 'hi' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Groq API key/);
});

test('POST /chat rejects invalid JSON', async () => {
  const res = await post('/chat', '{not json', { raw: true });
  assert.equal(res.status, 400);
});

test('POST /chat rejects an empty message even with a key', async () => {
  const res = await post('/chat', { message: '   ', api_key: 'gsk_test' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Message is required/);
});

test('POST /search rejects an invalid category', async () => {
  const res = await post('/search', { category: 'bogus', api_key: 'gsk_test' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invalid category/);
});

test('unknown route returns 404', async () => {
  const res = await get('/does-not-exist');
  assert.equal(res.status, 404);
});

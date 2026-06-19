import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSSEData,
  toolStatusText,
  memoJson,
  buildFlightLinks,
  buildHotelLinks,
  toolDestinationImage
} from '../worker.js';

test('extractSSEData parses a content delta line', () => {
  const obj = extractSSEData('data: {"choices":[{"delta":{"content":"Hello"}}]}');
  assert.equal(obj.choices[0].delta.content, 'Hello');
});

test('extractSSEData recognises the [DONE] sentinel', () => {
  assert.equal(extractSSEData('data: [DONE]'), '[DONE]');
});

test('extractSSEData ignores keep-alives and non-data lines', () => {
  assert.equal(extractSSEData(''), null);
  assert.equal(extractSSEData(':\n'), null);
  assert.equal(extractSSEData('event: ping'), null);
  assert.equal(extractSSEData('data: {not json}'), null);
});

test('toolStatusText uses the correct currency arg keys', () => {
  // Regression: previously read args.from_currency / args.to_currency, which
  // never matched the real `from` / `to` args, so it always rendered "? → ?".
  const text = toolStatusText('currency_info', { from: 'USD', to: 'EUR' });
  assert.match(text, /USD/);
  assert.match(text, /EUR/);
  assert.doesNotMatch(text, /\?/);
});

test('toolStatusText falls back gracefully for unknown tools', () => {
  assert.equal(toolStatusText('mystery_tool', {}), 'Working on it…');
});

test('buildFlightLinks produces the three expected providers', () => {
  const links = buildFlightLinks('London', 'Tokyo', '2026-07-01', '2026-07-14', 4);
  assert.deepEqual(Object.keys(links), ['Google Flights', 'Skyscanner', 'Kayak']);
  assert.match(links['Skyscanner'], /london\/tokyo\/20260701/);
  assert.match(links['Kayak'], /4adults$/);
});

test('buildHotelLinks encodes the location and dates', () => {
  const links = buildHotelLinks('New York', '2026-07-01', '2026-07-05', 3, 2);
  assert.deepEqual(Object.keys(links), ['Booking.com', 'Airbnb', 'Hotels.com']);
  assert.match(links['Booking.com'], /ss=New%20York/);
  assert.match(links['Booking.com'], /no_rooms=2/);
});

test('toolDestinationImage returns a usable pollinations URL', async () => {
  const parsed = JSON.parse(await toolDestinationImage('Kyoto'));
  assert.equal(parsed.type, 'destination_image');
  assert.match(parsed.image_url, /^https:\/\/image\.pollinations\.ai\/prompt\//);
});

test('memoJson caches within the TTL and refetches after it expires', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { n: calls }; };

  const a = await memoJson('k1', 50, fetcher);
  const b = await memoJson('k1', 50, fetcher);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1, 'second call within TTL should be served from cache');
  assert.equal(calls, 1);

  await new Promise(r => setTimeout(r, 60));
  const c = await memoJson('k1', 50, fetcher);
  assert.equal(c.n, 2, 'after TTL expiry the fetcher runs again');
  assert.equal(calls, 2);
});

test('memoJson keys are independent', async () => {
  const x = await memoJson('alpha', 1000, async () => 'A');
  const y = await memoJson('beta', 1000, async () => 'B');
  assert.equal(x, 'A');
  assert.equal(y, 'B');
});

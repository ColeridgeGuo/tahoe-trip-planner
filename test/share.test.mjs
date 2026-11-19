// Share links: what goes into the address, what is read back, and what happens to a departure that has gone by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareQuery, parseShare, sharedDepart } from '../js/share.js';
import { index } from '../js/logic.js';
import { makeData, T0, H, NOW } from './helpers.mjs';

const IDS = ['heavenly', 'kirkwood', 'northstar'];

test('a picked departure goes into the address and comes back the same', () => {
  const view = { destId: 'kirkwood', direction: 'back', depart: { day: '2026-11-22', h: 7 } };
  const q = shareQuery(view);
  assert.equal(q, 'resort=kirkwood&dir=back&date=2026-11-22&time=7:00');
  assert.deepEqual(parseShare('?' + q, IDS), view);
});

test('"leave now" carries no date or time', () => {
  const q = shareQuery({ destId: 'heavenly', direction: 'out', depart: 'now' });
  assert.equal(q, 'resort=heavenly&dir=out');
  assert.deepEqual(parseShare('?' + q, IDS), { destId: 'heavenly', direction: 'out' });
});

test('an address without share parameters is not a share link', () => {
  assert.equal(parseShare('', IDS), null);
  assert.equal(parseShare('?ts=123', IDS), null);
});

test('unknown or malformed parts are dropped, the rest is kept', () => {
  assert.deepEqual(parseShare('?resort=aspen&dir=back', IDS), { direction: 'back' });
  assert.deepEqual(parseShare('?resort=kirkwood&dir=sideways', IDS), { destId: 'kirkwood' });
  assert.deepEqual(parseShare('?resort=kirkwood&date=11-22&time=7:00', IDS), { destId: 'kirkwood' });
  assert.deepEqual(parseShare('?resort=kirkwood&date=2026-11-22&time=25:00', IDS), { destId: 'kirkwood' });
  assert.deepEqual(parseShare('?resort=kirkwood&date=2026-13-45&time=7:00', IDS), { destId: 'kirkwood' });
  assert.equal(parseShare('?resort=<script>', IDS), null);
});

test('the time may be written as a bare hour, and a date alone starts at 8', () => {
  assert.deepEqual(parseShare('?date=2026-11-22&time=7', IDS), { depart: { day: '2026-11-22', h: 7 } });
  assert.deepEqual(parseShare('?date=2026-11-22', IDS), { depart: { day: '2026-11-22', h: 8 } });
});

test('a departure still ahead is kept; one gone by or beyond the forecast becomes "now"', () => {
  const { hours } = index(makeData()); // 168 hours from Tue 13 Jan 2026 00:00 Pacific; NOW is 06:00
  const at = (day, h) => ({ day, h });
  assert.deepEqual(sharedDepart(at('2026-01-15', 7), hours, NOW), at('2026-01-15', 7));
  assert.deepEqual(sharedDepart(at('2026-01-13', 6), hours, NOW + H / 2), at('2026-01-13', 6)); // the hour in progress
  assert.equal(sharedDepart(at('2026-01-13', 5), hours, NOW), 'now');
  assert.equal(sharedDepart(at('2026-02-01', 7), hours, NOW), 'now');
  assert.equal(sharedDepart('now', hours, NOW), 'now');
  assert.equal(T0 + 6 * H, NOW);
});

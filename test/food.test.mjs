// Food along the way: arrival times and opening hours (js/logic.js). Run: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';
import { FOOD } from '../js/food.js';
import { dest, route, H, MIN, T0, NOW, makeData, stopIdx, timed } from './helpers.mjs';

// T0 is Tue 13 Jan 2026, 00:00 Pacific.
const at = (h, m = 0, day = 0) => T0 + day * 24 * H + h * H + m * MIN;
const pt = (id) => route.points.find((p) => p.id === id);

describe('opening hours', () => {
  const hours = { daily: '07:00-15:00', tue: '07:00-11:00,17:00-21:00', wed: null, fri: '17:00-01:00' };
  test('no hours entered: unknown', () => assert.equal(L.openAt(undefined, at(12)).state, 'unknown'));
  test('inside and outside a range', () => {
    assert.equal(L.openAt(hours, at(8)).state, 'open');
    assert.equal(L.openAt(hours, at(6, 59)).state, 'closed');
    assert.equal(L.openAt(hours, at(11)).state, 'closed');
  });
  test('closing within 45 minutes is flagged, with the minutes left', () => {
    assert.deepEqual(L.openAt(hours, at(10, 30)), { state: 'closing', closeMin: 30 });
    assert.equal(L.openAt(hours, at(10)).state, 'open');
  });
  test('closed between two ranges says when it reopens', () => assert.deepEqual(L.openAt(hours, at(15)), { state: 'closed', openMin: 120 }));
  test('a weekday override wins over daily, null is closed all day', () => {
    assert.equal(L.openAt(hours, at(12, 0, 1)).state, 'closed'); // Wednesday
    assert.equal(L.openAt(hours, at(12, 0, 2)).state, 'open'); // Thursday falls back to daily
  });
  test('a range past midnight carries into the next morning', () => {
    assert.equal(L.openAt(hours, at(23, 0, 3)).state, 'open'); // Friday 23:00
    assert.equal(L.openAt(hours, at(0, 30, 4)).state, 'closing'); // Saturday 00:30, shuts at 01:00
    assert.equal(L.openAt(hours, at(1, 0, 4)).state, 'closed');
  });
  test('a mistyped range is ignored rather than read as open', () => assert.equal(L.openAt({ daily: '7am-3pm' }, at(8)).state, 'closed'));
});

describe('where a place sits on the drive', () => {
  test('a place at a route point takes that point’s time', () => {
    for (const id of ['sac', 'placerville', 'kyburz']) assert.ok(Math.abs(L.placeOffsetH(route, pt(id)) - pt(id).offsetH) < 0.01, id);
  });
  test('a place between two points falls between their times', () => {
    const h = L.placeOffsetH(route, { lat: 38.75, lon: -120.55 }); // Pollock Pines area
    assert.ok(h > pt('placerville').offsetH && h < pt('kyburz').offsetH, String(h));
  });
  test('an explicit offsetH wins', () => assert.equal(L.placeOffsetH(route, { lat: 0, lon: 0, offsetH: 1.2 }), 1.2));
});

describe('stops for a departure', () => {
  const places = [
    { id: 'b', name: 'B', highway: 'US-50', ...pick('kyburz') },
    { id: 'a', name: 'A', highway: 'US-50', ...pick('placerville'), hours: { daily: '07:00-09:00' } },
    { id: 'x', name: 'Other road', highway: 'I-80', lat: 39.3, lon: -120.3 },
  ];
  function pick(id) { const p = pt(id); return { lat: p.lat, lon: p.lon }; }
  const run = (dir, hours, stops) => L.foodStops(makeData(), dest, places, NOW, dir, hours, stops);

  test('only this highway, in driving order, reversed on the way back', () => {
    assert.deepEqual(run('out').map((x) => x.place.id), ['a', 'b']);
    assert.deepEqual(run('back').map((x) => x.place.id), ['b', 'a']);
  });
  test('each stop names the leg it is on, in driving order', () => {
    const mid = { id: 'm', name: 'M', highway: 'US-50', lat: 38.75, lon: -120.55 };
    const leg = (dir) => L.foodStops(makeData(), dest, [mid], NOW, dir)[0].leg.map((p) => p.id);
    assert.deepEqual(leg('out'), ['placerville', 'kyburz']);
    assert.deepEqual(leg('back'), ['kyburz', 'placerville']);
  });
  test('arrival follows the fixed offsets when there is no drive time', () => {
    const [a] = run('out');
    assert.ok(Math.abs(a.ms - (NOW + pt('placerville').offsetH * H)) < MIN);
    assert.equal(a.open.state, 'closing'); // 06:00 + 2.4 h = 08:24, shuts 09:00
  });
  test('a slower drive pushes arrivals later in proportion', () => {
    const [a] = run('out', route.driveHours * 2);
    assert.ok(Math.abs(a.ms - (NOW + pt('placerville').offsetH * 2 * H)) < MIN);
    assert.equal(a.open.state, 'closed');
  });
  test('TomTom pass-through times are used where given', () => {
    const stops = timed.map(() => null);
    stops[stopIdx('kyburz')] = 4 * 3600;
    const b = run('out', 5, stops).find((x) => x.place.id === 'b');
    assert.ok(Math.abs(b.ms - (NOW + 4 * H)) < MIN);
  });
  test('return trip counts from the Tahoe end', () => {
    const b = run('back').find((x) => x.place.id === 'b');
    assert.ok(Math.abs(b.ms - (NOW + (route.driveHours - pt('kyburz').offsetH) * H)) < MIN);
  });
});

describe('the list itself', () => {
  test('every entry has what the page needs and hours that parse', () => {
    const ids = new Set();
    for (const p of FOOD) {
      assert.ok(p.id && !ids.has(p.id), `duplicate or missing id: ${p.id}`);
      ids.add(p.id);
      assert.ok(p.name && p.town && p.highway, p.id);
      assert.ok(p.lat > 36 && p.lat < 40 && p.lon < -119 && p.lon > -123, `${p.id} is off the map`);
      for (const [k, v] of Object.entries(p.hours || {})) {
        assert.ok(['daily', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(k), `${p.id}: ${k}`);
        if (v != null) for (const s of v.split(',')) assert.match(s.trim(), /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/, `${p.id}: ${k}`);
      }
    }
  });
});

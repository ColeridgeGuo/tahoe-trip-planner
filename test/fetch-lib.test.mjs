// What the fetch script does with a failed source, and how it reads the feeds (scripts/lib.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOURS, MAX_CARRY_MS, carried, source, shiftWeather, carriedWeather, hourly, ptToMs, stopTimes, PAST_H, pastSnow, HISTORY_MAX, addHistory, quotaUsed, dedupe } from '../scripts/lib.mjs';

const H = 36e5;
const MIN = 6e4;
const NOW = Date.UTC(2026, 0, 13, 14);
const boom = async () => { throw new Error('HTTP 503'); };

describe('a source fails: fall back to the last good data', () => {
  const quiet = (t) => t.mock.method(console, 'error', () => {});
  const prevOk = { status: { chain: { ok: true, at: NOW - 15 * MIN } }, chain: [{ level: 2 }] };

  test('success records ok and returns the new data', async () => {
    const status = {};
    assert.deepEqual(await source(status, 'chain', async () => [{ level: 1 }], [], prevOk, NOW), [{ level: 1 }]);
    assert.deepEqual(status.chain, { ok: true, at: NOW });
  });
  test('failure keeps the previous data and says when it was fetched', async (t) => {
    quiet(t);
    const status = {};
    assert.deepEqual(await source(status, 'chain', boom, [], prevOk, NOW), [{ level: 2 }]);
    assert.deepEqual(status.chain, { ok: false, error: 'HTTP 503', at: NOW, dataAt: NOW - 15 * MIN });
  });
  test('failing again and again keeps the time of the last real fetch, not of the last attempt', async (t) => {
    quiet(t);
    let prev = prevOk;
    for (let run = 1; run <= 3; run++) {
      const status = {};
      const chain = await source(status, 'chain', boom, [], prev, NOW + run * 15 * MIN);
      prev = { status, chain };
    }
    assert.equal(prev.status.chain.dataAt, NOW - 15 * MIN);
    assert.deepEqual(prev.chain, [{ level: 2 }]);
  });
  test('nothing to fall back on: the empty fallback and no data time', async (t) => {
    quiet(t);
    for (const prev of [null, {}, { status: { chain: { ok: false, at: NOW - 15 * MIN } }, chain: [] }]) {
      const status = {};
      assert.deepEqual(await source(status, 'chain', boom, [], prev, NOW), []);
      assert.equal(status.chain.ok, false);
      assert.equal('dataAt' in status.chain, false);
    }
  });
  test('data older than 24 hours is dropped rather than shown', async (t) => {
    quiet(t);
    const old = (age) => ({ status: { chain: { ok: false, at: NOW - 15 * MIN, dataAt: NOW - age } }, chain: [{ level: 2 }] });
    assert.deepEqual(carried(old(MAX_CARRY_MS - MIN), 'chain', NOW), { value: [{ level: 2 }], dataAt: NOW - MAX_CARRY_MS + MIN });
    assert.equal(carried(old(MAX_CARRY_MS), 'chain', NOW), null);
    const status = {};
    assert.deepEqual(await source(status, 'chain', boom, [], old(MAX_CARRY_MS), NOW), []);
    assert.equal('dataAt' in status.chain, false);
  });
  test('a long error message is cut short', async (t) => {
    quiet(t);
    const status = {};
    await source(status, 'chain', async () => { throw new Error('x'.repeat(500)); }, [], null, NOW);
    assert.equal(status.chain.error.length, 200);
  });
});

describe('a weather point fails: keep its last forecast', () => {
  const t0 = Date.UTC(2026, 0, 13, 8);
  const series = Array.from({ length: HOURS }, (_, i) => i);
  const prev = { t0, generatedAt: NOW - 30 * MIN, status: { weather: { ok: true } }, weather: { pass: { at: NOW - 30 * MIN, elevM: 2250, temp: series, snow: series } } };

  test('hourly values slide forward to the new start hour', () => {
    const w = shiftWeather({ elevM: 2250, temp: series }, 3);
    assert.equal(w.temp.length, HOURS);
    assert.deepEqual(w.temp.slice(0, 3), [3, 4, 5]);
    assert.deepEqual(w.temp.slice(-4), [HOURS - 1, null, null, null]);
    assert.equal(w.elevM, 2250);
  });
  test('the carried forecast is re-aligned, marked, and keeps its original fetch time', () => {
    const w = carriedWeather(prev, 'pass', t0 + 2 * H, NOW);
    assert.equal(w.carried, true);
    assert.equal(w.at, NOW - 30 * MIN);
    assert.equal(w.temp[0], 2);
    assert.equal(w.snow[10], 12);
  });
  test('carried a second time, the fetch time still does not move', () => {
    const once = carriedWeather(prev, 'pass', t0 + H, NOW);
    const again = carriedWeather({ ...prev, t0: t0 + H, weather: { pass: once } }, 'pass', t0 + 2 * H, NOW + H);
    assert.equal(again.at, NOW - 30 * MIN);
    assert.equal(again.temp[0], 2);
  });
  test('no previous forecast, or one older than 24 hours: nothing', () => {
    assert.equal(carriedWeather(prev, 'kyburz', t0, NOW), null);
    assert.equal(carriedWeather(null, 'pass', t0, NOW), null);
    assert.equal(carriedWeather(prev, 'pass', t0, NOW + MAX_CARRY_MS), null);
  });
});

describe('NWS forecast series to hourly values', () => {
  const t0 = Date.UTC(2026, 0, 13, 8);
  const at = (h) => new Date(t0 + h * H).toISOString().replace('.000Z', '+00:00');
  test('each interval fills its hours; gaps stay empty', () => {
    const out = hourly({ values: [{ validTime: `${at(0)}/PT2H`, value: 1.5 }, { validTime: `${at(3)}/PT1H`, value: -2 }] }, t0);
    assert.equal(out.length, HOURS);
    assert.deepEqual(out.slice(0, 5), [1.5, 1.5, null, -2, null]);
  });
  test('accumulated amounts (snow, rain) are spread evenly over the interval', () => {
    const out = hourly({ values: [{ validTime: `${at(0)}/PT6H`, value: 60 }, { validTime: `${at(6)}/P1D`, value: 24 }] }, t0, true);
    assert.deepEqual(out.slice(0, 7), [10, 10, 10, 10, 10, 10, 1]);
    assert.equal(out[29], 1);
    assert.equal(out[30], null);
  });
  test('an interval that began before the first hour is clipped, not shifted', () => {
    const out = hourly({ values: [{ validTime: `${at(-2)}/PT6H`, value: 60 }] }, t0, true);
    assert.deepEqual(out.slice(0, 5), [10, 10, 10, 10, null]);
  });
  test('missing values and a missing series', () => {
    assert.deepEqual(hourly({ values: [{ validTime: `${at(0)}/PT2H`, value: null }] }, t0).slice(0, 2), [null, null]);
    assert.ok(hourly(undefined, t0).every((v) => v === null));
  });
});

describe('CHP log times are Pacific wall-clock', () => {
  test('winter (PST) and summer (PDT)', () => {
    assert.equal(ptToMs('Jan 13 2026  6:05AM'), Date.UTC(2026, 0, 13, 14, 5));
    assert.equal(ptToMs('Jul  4 2026  6:05PM'), Date.UTC(2026, 6, 5, 1, 5));
  });
  test('noon and midnight', () => {
    assert.equal(ptToMs('Jan 13 2026 12:00PM'), Date.UTC(2026, 0, 13, 20));
    assert.equal(ptToMs('Jan 13 2026 12:30AM'), Date.UTC(2026, 0, 13, 8, 30));
  });
  test('unreadable: null', () => {
    assert.equal(ptToMs(''), null);
    assert.equal(ptToMs('yesterday'), null);
  });
});

describe('pass-through times read off a TomTom route', () => {
  // A straight road east along one parallel, a point every 0.01 degrees of longitude. Waypoints A (0), C (200)
  // and E (400); TomTom reports the travel time at every 50th point, 10 s per point up to C, 20 s after.
  const lat = 38.7;
  const pt = (i) => ({ latitude: lat, longitude: -121 + i * 0.01 });
  const secAt = (i) => (i <= 200 ? i * 10 : 2000 + (i - 200) * 20);
  const way = [{ id: 'a', lat, lon: -121 }, { id: 'c', lat, lon: -119 }, { id: 'e', lat, lon: -117 }];
  const route = {
    legs: [
      { summary: { travelTimeInSeconds: 2000 }, points: Array.from({ length: 201 }, (_, i) => pt(i)) },
      { summary: { travelTimeInSeconds: 4000 }, points: Array.from({ length: 200 }, (_, i) => pt(201 + i)) },
    ],
    progress: Array.from({ length: 9 }, (_, k) => ({ pointIndex: k * 50, travelTimeInSeconds: secAt(k * 50) })),
  };
  const near = (id, i, off = 0) => ({ id, lat: lat + off, lon: -121 + i * 0.01 });

  test('waypoints come from the leg times', () => {
    assert.deepEqual(stopTimes(route, way, way), [0, 2000, 6000]);
  });
  test('a place between waypoints is timed where the route passes it', () => {
    assert.deepEqual(stopTimes(route, way, [near('b', 100), near('d', 300)]), [1000, 4000]);
  });
  test('between two progress markers the time is interpolated by distance', () => {
    assert.deepEqual(stopTimes(route, way, [near('b', 120), near('d', 265)]), [1200, 3300]);
  });
  test('a place just off the road is timed at the nearest point of the route', () => {
    assert.deepEqual(stopTimes(route, way, [near('b', 120, 0.02)]), [1200]); // about 2 km north of it
  });
  test('a place the route does not go near is not timed', () => {
    assert.deepEqual(stopTimes(route, way, [near('far', 120, 0.5)]), [null]); // about 55 km away
  });
  test('the result lines up with the points asked for, whatever their order', () => {
    const timed = [way[2], near('d', 300), way[1], near('far', 120, 0.5), way[0]];
    assert.deepEqual(stopTimes(route, way, timed), [6000, 4000, 2000, null, 0]);
  });
  test('return direction: times count from the other end', () => {
    const back = {
      legs: [
        { summary: { travelTimeInSeconds: 4000 }, points: Array.from({ length: 200 }, (_, i) => pt(400 - i)) },
        { summary: { travelTimeInSeconds: 2000 }, points: Array.from({ length: 201 }, (_, i) => pt(200 - i)) },
      ],
      progress: Array.from({ length: 9 }, (_, k) => ({ pointIndex: k * 50, travelTimeInSeconds: 6000 - secAt(400 - k * 50) })),
    };
    assert.deepEqual(stopTimes(back, [...way].reverse(), [way[0], near('b', 100), way[1], near('d', 300), way[2]]), [6000, 5000, 4000, 2000, 0]);
  });
  test('a summary-only route still times the waypoints', () => {
    const summary = { legs: route.legs.map((l) => ({ summary: l.summary })) };
    assert.deepEqual(stopTimes(summary, way, [way[0], near('b', 100), way[1], way[2]]), [0, null, 2000, 6000]);
  });
  test('a leg without a time leaves the waypoints after it untimed', () => {
    const broken = { ...route, legs: [route.legs[0], { points: route.legs[1].points }] };
    assert.deepEqual(stopTimes(broken, way, way), [0, 2000, null]);
  });
});

describe('snowfall of the last day, kept for the page', () => {
  const T0 = Date.UTC(2026, 0, 13, 8);
  const file = (snow, snowPast) => ({ t0: T0, weather: { pass: { snow, ...(snowPast ? { snowPast } : {}) } } });
  test('no previous file: all unknown', () => {
    assert.deepEqual(pastSnow(null, 'pass', T0), new Array(PAST_H).fill(null));
    assert.deepEqual(pastSnow(file([1, 2]), 'kyburz', T0), new Array(PAST_H).fill(null));
  });
  test('the hour that just ended is the first hour of the previous file', () => {
    const past = pastSnow(file([7, 8, 9]), 'pass', T0 + H);
    assert.equal(past.length, PAST_H);
    assert.equal(past.at(-1), 7);
    assert.equal(past.at(-2), null);
  });
  test('same hour as the previous file: its past hours are kept as they are', () => {
    const before = Array.from({ length: PAST_H }, (_, i) => i);
    assert.deepEqual(pastSnow(file([7, 8, 9], before), 'pass', T0), before);
  });
  test('hours roll through: older ones come from the previous past, newer ones from its forecast', () => {
    const before = Array.from({ length: PAST_H }, (_, i) => 100 + i);
    const past = pastSnow(file([7, 8, 9], before), 'pass', T0 + 2 * H);
    assert.deepEqual(past.slice(-3), [100 + PAST_H - 1, 7, 8]);
    assert.equal(past[0], 102);
  });
  test('a gap longer than the previous file reaches: unknown, not zero', () => {
    assert.deepEqual(pastSnow(file([7, 8, 9]), 'pass', T0 + 400 * H), new Array(PAST_H).fill(null));
  });
});

describe('hourly record of real chain control', () => {
  const T = Date.UTC(2026, 0, 13, 8);
  const row = (over = {}) => ({ t: T, e: 0, w: 0, s: [0, 0, 0], c: [1, 0, -1], ...over });
  test('starts a record and names the points', () => {
    assert.deepEqual(addHistory(null, row(), ['kyburz', 'pass', 'town']), { v: 1, points: ['kyburz', 'pass', 'town'], rows: [row()] });
  });
  test('several runs in one hour make one row, keeping the strictest level each way', () => {
    let h = addHistory(null, row({ e: 2, w: 0 }), []);
    h = addHistory(h, row({ e: 1, w: 1, s: [3, 3, 3] }), []);
    assert.equal(h.rows.length, 1);
    assert.deepEqual([h.rows[0].e, h.rows[0].w], [2, 1]);
    assert.deepEqual(h.rows[0].s, [3, 3, 3]);
  });
  test('a run where the chain feed failed does not erase what the hour already showed', () => {
    const h = addHistory(addHistory(null, row({ e: 2 }), []), row({ e: null, w: null }), []);
    assert.deepEqual([h.rows[0].e, h.rows[0].w], [2, 0]);
  });
  test('rows stay in time order and the oldest drop off', () => {
    let h = null;
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = addHistory(h, row({ t: T + i * H }), []);
    assert.equal(h.rows.length, HISTORY_MAX);
    assert.equal(h.rows[0].t, T + 5 * H);
    assert.equal(h.rows.at(-1).t, T + (HISTORY_MAX + 4) * H);
  });
});

describe('TomTom requests used today', () => {
  const at = (h) => Date.UTC(2026, 0, 13, h);
  test('adds up over the runs of a UTC day', () => {
    const a = quotaUsed(null, 50, at(1));
    assert.deepEqual(a, { day: '2026-01-13', n: 50 });
    assert.deepEqual(quotaUsed(a, 2, at(2)), { day: '2026-01-13', n: 52 });
  });
  test('a new day starts from zero and keeps the total of the day before', () => {
    const b = quotaUsed({ day: '2026-01-13', n: 1640 }, 2, at(24));
    assert.deepEqual(b, { day: '2026-01-14', n: 2, prev: { day: '2026-01-13', n: 1640 } });
    assert.deepEqual(quotaUsed(b, 2, at(25)).prev, { day: '2026-01-13', n: 1640 });
  });
});

describe('closure feed', () => {
  test('a closure listed twice is kept once; different ones stay', () => {
    const a = { from: 'A', to: 'B', start: 1 };
    assert.deepEqual(dedupe([a, { ...a }, { ...a, start: 2 }]), [a, { ...a, start: 2 }]);
  });
});

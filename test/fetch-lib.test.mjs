// What the fetch script does with a failed source, and how it reads the feeds (scripts/lib.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOURS, MAX_CARRY_MS, carried, source, shiftWeather, carriedWeather, hourly, ptToMs, stopTimes, PAST_H, pastSnow, HISTORY_MAX, addHistory, quotaUsed, dedupe, dedupeIncidents, streamUrl, liveStreams, STREAM_TRIES, MONTHLY_QUOTA, LIVE_EVERY_MS, NEAR_H, MID_EVERY_MS, DETOUR_EVERY_MS, HOURLY_EVERY_MS, LONG_EVERY_MS, LONG_STEP_H, LONG_TO_H, keptLive, keptHours, snotelStations } from '../scripts/lib.mjs';

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

describe('snowfall of the last three days, kept for the page', () => {
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
  test('the live drive time is kept as the longest seen in the hour, and survives a run without one', () => {
    let h = addHistory(null, row({ d: [12900, 12000], m: [35, 38] }), []);
    h = addHistory(h, row({ d: [15000, 11900], m: [70, 37] }), []);
    assert.deepEqual([h.rows[0].d, h.rows[0].m], [[15000, 12000], [70, 38]]);
    h = addHistory(h, row(), []); // TomTom failed on this run
    assert.deepEqual([h.rows[0].d, h.rows[0].m], [[15000, 12000], [70, 38]]);
    assert.equal('d' in addHistory(null, row(), []).rows[0], false);
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
    assert.deepEqual(a, { day: '2026-01-13', n: 50, month: '2026-01', monthN: 50, from: '2026-01-13', quota: MONTHLY_QUOTA });
    assert.deepEqual(quotaUsed(a, 2, at(2)), { day: '2026-01-13', n: 52, month: '2026-01', monthN: 52, from: '2026-01-13', quota: MONTHLY_QUOTA });
  });
  test('a new day starts from zero and keeps the total of the day before', () => {
    const b = quotaUsed({ day: '2026-01-13', n: 1640 }, 2, at(24));
    assert.deepEqual(b, { day: '2026-01-14', n: 2, month: '2026-01', monthN: 2, from: '2026-01-14', quota: MONTHLY_QUOTA, prev: { day: '2026-01-13', n: 1640 } });
    assert.deepEqual(quotaUsed(b, 2, at(25)).prev, { day: '2026-01-13', n: 1640 });
  });
});

describe('TomTom quota: the month', () => {
  const at = (d, h = 0) => Date.UTC(2026, 0, d, h);
  test('the month keeps counting across days and starts again on the 1st (UTC)', () => {
    let q = quotaUsed(null, 500, at(30));
    q = quotaUsed(q, 500, at(31));
    assert.deepEqual([q.day, q.n, q.month, q.monthN], ['2026-01-31', 500, '2026-01', 1000]);
    q = quotaUsed(q, 7, Date.UTC(2026, 1, 1));
    assert.deepEqual([q.day, q.n, q.month, q.monthN], ['2026-02-01', 7, '2026-02', 7]);
    assert.equal(q.from, '2026-02-01'); // a month that turned over while counting is counted whole
  });
  test('a count saved before the month was tracked starts the month from this run', () => {
    assert.deepEqual(quotaUsed({ day: '2026-01-13', n: 900 }, 4, at(13, 5)), { day: '2026-01-13', n: 904, month: '2026-01', monthN: 4, from: '2026-01-13', quota: MONTHLY_QUOTA });
  });
  test('the day the count began is kept through the month; a count published before it was recorded began on 2026-11-18', () => {
    let q = quotaUsed(null, 5, at(13));
    q = quotaUsed(q, 5, at(20));
    assert.equal(q.from, '2026-01-13');
    assert.equal(quotaUsed({ day: '2026-11-19', n: 3, month: '2026-11', monthN: 180 }, 2, Date.UTC(2026, 10, 19, 3)).from, '2026-11-18');
  });
});

describe('TomTom quota: how often drive times are refreshed', () => {
  const h0 = Date.UTC(2026, 0, 13, 15);
  const now = h0 - 20 * MIN;
  const pt = (i, at) => ({ ms: h0 + i * H, sec: 13000, noTrafficSec: 12500, stops: [0, 1], ...(at != null ? { at } : {}) });
  const series = (from, to, at) => { const a = []; for (let i = from; i <= to; i++) a.push(pt(i, at)); return { out: a, back: a.map((x) => ({ ...x })) }; };
  const hours = (kept) => [...kept.keys()].map((ms) => (ms - h0) / H).sort((a, b) => a - b);

  test('a day costs about 506 requests, and a 31-day month stays under 80% of the free allowance', () => {
    const live = 2 * ((24 * H) / (Math.ceil(LIVE_EVERY_MS / (15 * MIN)) * 15 * MIN)); // a run every 15 minutes
    const perHour = NEAR_H + Math.ceil((24 - NEAR_H) / Math.round(MID_EVERY_MS / H)); // times one hour is fetched before it passes
    const hourly = 2 * perHour * Math.round((24 * H) / (HOURLY_EVERY_MS + 5 * MIN));
    const long = 2 * ((LONG_TO_H - 24) / LONG_STEP_H + 1) * Math.round((24 * H) / (LONG_EVERY_MS + 5 * MIN));
    assert.deepEqual({ live, hourly, long }, { live: 96, hourly: 240, long: 170 });
    assert.equal(MONTHLY_QUOTA, 20000);
    assert.ok((live + hourly + long) * 31 <= MONTHLY_QUOTA * 0.8);
  });
  test('live times are fetched on every other run', () => {
    const prev = { at: now - 15 * MIN, out: { sec: 1 }, back: { sec: 2 }, hourly: {} };
    assert.deepEqual(keptLive(prev, now), { at: prev.at, out: prev.out, back: prev.back });
    assert.equal(keptLive({ ...prev, at: now - 30 * MIN }, now), null);
    assert.equal(keptLive(null, now), null);
    assert.equal(keptLive({ at: now - 15 * MIN, out: { sec: 1 } }, now), null);
  });
  test('the 7-day grid reaches a day past the week, so a day-old one still covers it', () => {
    assert.ok(LONG_TO_H * H - LONG_EVERY_MS >= 167 * H);
  });
  test('no earlier forecast: every hour is fetched', () => {
    assert.equal(keptHours(null, null, h0, now).size, 0);
    assert.equal(keptHours({ out: [], back: [] }, 0, h0, now).size, 0);
  });
  test('an hour later: the next 3 hours and the new last hour are fetched, the rest kept', () => {
    const prev = series(-1, 22, now - 60 * MIN); // the last refresh covered what are now hours -1..22
    assert.deepEqual(hours(keptHours(prev, now - 60 * MIN, h0, now)), Array.from({ length: 20 }, (_, i) => i + 3));
  });
  test('a later hour is fetched again once it is 12 hours old', () => {
    const prev = series(0, 23, now - 11 * H);
    prev.out[10].at = prev.back[10].at = now - 12 * H;
    const kept = keptHours(prev, now - H, h0, now);
    assert.ok(!kept.has(h0 + 10 * H));
    assert.equal(kept.size, 20);
    assert.equal(keptHours(series(0, 23, now - 12 * H), now - H, h0, now).size, 0);
  });
  test('an hour TomTom routed round a closure is fetched again after 3 hours, not 12', () => {
    const detour = (x) => x.noTrafficSec > 20000;
    const prev = series(0, 23, now - 4 * H);
    prev.back[10].noTrafficSec = 42000; // either direction is enough
    prev.out[11].noTrafficSec = 42000;
    const kept = keptHours(prev, now - H, h0, now, detour);
    assert.ok(!kept.has(h0 + 10 * H) && !kept.has(h0 + 11 * H));
    assert.equal(kept.size, 19);
    const fresh = series(0, 23, now - 2 * H);
    fresh.out[11].noTrafficSec = 42000;
    assert.ok(keptHours(fresh, now - H, h0, now, detour).has(h0 + 11 * H)); // asked 2 hours ago: not yet
    assert.ok(DETOUR_EVERY_MS < MID_EVERY_MS && DETOUR_EVERY_MS > 2 * HOURLY_EVERY_MS);
  });
  test('the older of the two directions decides', () => {
    const prev = series(0, 23, now - H);
    prev.back[12].at = now - 13 * H;
    assert.ok(!keptHours(prev, now - H, h0, now).has(h0 + 12 * H));
  });
  test('points saved before each carried its own time are dated by the forecast as a whole', () => {
    assert.equal(keptHours(series(0, 23), now - H, h0, now).size, 21);
    assert.equal(keptHours(series(0, 23), now - 13 * H, h0, now).size, 0);
    assert.equal(keptHours(series(0, 23), undefined, h0, now).size, 0);
  });
  test('an hour missing one direction, or saved without pass-through times, is fetched', () => {
    const prev = series(0, 23, now - H);
    prev.back.splice(8, 1);
    delete prev.out[15].stops;
    const kept = keptHours(prev, now - H, h0, now);
    assert.ok(!kept.has(h0 + 8 * H) && !kept.has(h0 + 15 * H));
    assert.equal(kept.size, 19);
  });
});

describe('closure feed', () => {
  test('a closure listed twice is kept once; different ones stay', () => {
    const a = { from: 'A', to: 'B', start: 1 };
    assert.deepEqual(dedupe([a, { ...a }, { ...a, start: 2 }]), [a, { ...a, start: 2 }]);
  });
  test('a CHP incident logged by both the dispatch centre and its service patrol desk is listed once', () => {
    const at = Date.UTC(2026, 10, 20, 1);
    const sa = { id: '261119SA0865', time: at, type: 'Trfc Collision-Unkn Inj', loc: 'Us50 W / Jeo Sr99', hw: 'US-50', dir: 'West', area: 'South Sac' };
    const fsp = { ...sa, id: '261119SAFSP0081', time: at + 2 * 6e4, area: 'South Sac FSP' };
    assert.deepEqual(dedupeIncidents([fsp, sa]), [sa]);
    assert.deepEqual(dedupeIncidents([sa, fsp]), [sa]);
    const other = { ...sa, id: 'x', loc: 'Us50 W / Watt Ave' };
    const later = { ...sa, id: 'y', time: at + 2 * 36e5 };
    const east = { ...sa, id: 'z', dir: 'East' };
    assert.deepEqual(dedupeIncidents([sa, other, later, east]), [sa, other, later, east]);
  });
});

describe('camera live streams', () => {
  const B = 'https://wzmedia.dot.ca.gov/D3/';
  test('an address with ".stream" written twice is corrected, others are left alone', () => {
    assert.equal(streamUrl(B + '50_Forni_Rd_ED50_WB_1.stream.stream/playlist.m3u8'), B + '50_Forni_Rd_ED50_WB_1.stream/playlist.m3u8');
    assert.equal(streamUrl(B + '50_Echo_Summit_ED50_EB.stream/playlist.m3u8'), B + '50_Echo_Summit_ED50_EB.stream/playlist.m3u8');
    assert.equal(streamUrl(undefined), '');
  });
  const cams = [{ name: 'a', stream: B + 'a' }, { name: 'b', stream: B + 'b' }, { name: 'c', stream: '' }, { name: 'd', stream: B + 'd' }];
  test('a stream that does not exist (404) is dropped, even after a refusal; one that answers is kept', async () => {
    const seen = {};
    const probe = async (u) => { seen[u] = (seen[u] || 0) + 1; return u.endsWith('a') ? (seen[u] < 3 ? 403 : 200) : u.endsWith('b') ? (seen[u] < 2 ? 403 : 404) : 200; };
    const out = await liveStreams(cams, probe);
    assert.deepEqual(out.map((c) => c.stream), [B + 'a', '', '', B + 'd']);
    assert.deepEqual(seen, { [B + 'a']: 3, [B + 'b']: 2, [B + 'd']: 1 });
  });
  test('a stream that is only ever refused, or a host that does not answer, keeps its address', async () => {
    let n = 0;
    assert.deepEqual(await liveStreams(cams, async () => { n++; return 403; }), cams);
    assert.equal(n, 3 * STREAM_TRIES);
    assert.deepEqual(await liveStreams(cams, async () => 0), cams);
  });
});

describe('measured snow from SNOTEL', () => {
  const at = (h) => `2026-01-${String(10 + Math.floor(h / 24)).padStart(2, '0')} ${String(h % 24).padStart(2, '0')}:00`;
  const series = (code, f) => ({ stationElement: { elementCode: code }, values: Array.from({ length: 73 }, (_, h) => ({ date: at(h), value: f(h) })) });
  const json = [{ stationTriplet: '518:CA:SNTL', data: [series('SNWD', (h) => (h < 48 ? 10 : 10 + (h - 48) / 2)), series('WTEQ', (h) => 2 + (h > 60 ? 1.5 : 0)), series('TOBS', () => 23)] }];
  test('latest depth, its change over 24 and 48 hours, water in 24 hours and temperature, in metric', () => {
    const [s] = snotelStations(json, [{ id: '518:CA:SNTL' }]);
    assert.equal(s.at, Date.UTC(2026, 0, 13, 8)); // 00:00 PST on the 13th
    assert.deepEqual([s.depth, s.d24, s.d48, s.water24, s.temp], [559, 305, 305, 38, -5]);
  });
  test('gaps in the readings: the latest good one is used, and a change with nothing to compare to is null', () => {
    const holes = [{ stationTriplet: '518:CA:SNTL', data: [{ stationElement: { elementCode: 'SNWD' }, values: [{ date: at(70), value: 20 }, { date: at(71), value: null }, { date: at(72) }] }] }];
    const [s] = snotelStations(holes, [{ id: '518:CA:SNTL' }]);
    assert.deepEqual([s.depth, s.d24, s.d48, s.water24, s.temp], [508, null, null, null, null]);
  });
  test('a station missing from the answer keeps its place with no readings', () => {
    const list = snotelStations(json, [{ id: '463:CA:SNTL' }, { id: '518:CA:SNTL' }]);
    assert.deepEqual(list.map((s) => [s.id, s.at == null]), [['463:CA:SNTL', true], ['518:CA:SNTL', false]]);
    assert.equal(snotelStations(null, [{ id: 'x' }])[0].depth, null);
  });
});

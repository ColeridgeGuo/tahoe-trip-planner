// The trip verdict and everything it rests on (js/logic.js). Run: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';
import { dest, route, H, MIN, T0, NOW, AWD, timed, stopIdx, hourIdx, makeData, fail, factor, chainRow, closure, incident, liveDrive } from './helpers.mjs';

const ev = (data, over = {}) => L.evaluate(data, dest, { departMs: NOW, direction: 'out', vehicle: AWD, nowMs: NOW, ...over });
const LATER = NOW + 30 * H; // beyond the live horizon: live road status no longer decides

describe('verdict', () => {
  test('quiet roads and weather: go', () => {
    const r = ev(makeData());
    assert.equal(r.level, 'go');
    assert.equal(r.dir, 'East');
    assert.equal(r.live, true);
    assert.ok(r.factors.every((f) => L.LV[f.level] === 0));
  });
  test('return trip is judged westbound', () => {
    assert.equal(ev(makeData(), { direction: 'back' }).dir, 'West');
  });
  test('the verdict is the worst factor', () => {
    const data = makeData({ chain: [chainRow(1)], closures: [closure()] });
    const r = ev(data);
    assert.equal(factor(r, 'chain').level, 'caution');
    assert.equal(factor(r, 'closures').level, 'nogo');
    assert.equal(r.level, 'nogo');
  });
  test('a data file older than two hours is at best caution', () => {
    assert.equal(ev(makeData({ generatedAt: NOW - 119 * MIN })).level, 'go');
    const r = ev(makeData({ generatedAt: NOW - 121 * MIN }));
    assert.equal(r.level, 'caution');
    assert.equal(factor(r, 'fresh').msg, 'stale');
  });
});

describe('chain control', () => {
  const car = (o) => ({ drive: 'fwd', snowTires: false, chains: false, ...o });
  const cases = [
    // level, vehicle, expected level, expected message
    [-1, car(), 'ok', 'chainNone'],
    [0, car(), 'ok', 'chainNone'],
    [1, car(), 'nogo', 'chainNeedChains'],
    [1, car({ chains: true }), 'caution', 'chainInstall'],
    [1, car({ snowTires: true }), 'caution', 'chainR1PassNoChains'],
    [1, car({ snowTires: true, chains: true }), 'caution', 'chainR1Pass'],
    [1, car({ drive: 'awd', snowTires: true, chains: true }), 'caution', 'chainR1Pass'],
    [2, car({ snowTires: true }), 'nogo', 'chainNeedChains'], // snow tires alone do not pass R2
    [2, car({ snowTires: true, chains: true }), 'caution', 'chainInstall'],
    [2, car({ drive: 'awd', chains: true }), 'caution', 'chainInstall'], // AWD without snow tires is not exempt
    [2, car({ drive: 'awd', snowTires: true }), 'nogo', 'chainR2Carry'], // exempt, but must carry chains
    [2, car({ drive: 'awd', snowTires: true, chains: true }), 'caution', 'chainR2Pass'],
    [3, car({ drive: 'awd', snowTires: true, chains: true }), 'nogo', 'chainR3'],
    [4, car({ drive: 'awd', snowTires: true, chains: true }), 'nogo', 'chainClosed'],
  ];
  for (const [level, v, want, msg] of cases) {
    test(`R${level} ${v.drive}${v.snowTires ? '+snow tires' : ''}${v.chains ? '+chains' : ''}: ${want}`, () => {
      assert.deepEqual(L.chainVerdict(level, v), { level: want, msg });
    });
  }

  test('only this highway and this direction count; a control with no direction counts both ways', () => {
    const data = makeData({ chain: [chainRow(3, 'West'), chainRow(2, 'East'), chainRow(1, ''), chainRow(4, 'East', 'I-80')] });
    assert.equal(L.chainFor(data, 'US-50', 'East').max, 2);
    assert.equal(L.chainFor(data, 'US-50', 'West').max, 3);
    assert.equal(L.chainFor(makeData({ chain: [chainRow(1, '')] }), 'US-50', 'West').max, 1);
    assert.equal(L.chainFor(makeData(), 'US-50', 'East').max, -1);
  });
  test('westbound R3 does not stop an eastbound trip, and stops the return', () => {
    const data = makeData({ chain: [chainRow(3, 'West')] });
    assert.equal(ev(data).level, 'go');
    assert.equal(ev(data, { direction: 'back' }).level, 'nogo');
  });
  test("today's chain control does not decide a trip more than 6 hours away", () => {
    const data = makeData({ chain: [chainRow(3)] });
    assert.equal(ev(data, { departMs: NOW + 6 * H }).level, 'nogo');
    const far = ev(data, { departMs: NOW + 6 * H + MIN });
    assert.equal(far.live, false);
    assert.equal(factor(far, 'chain').level, 'info');
    assert.equal(factor(far, 'chain').msg, 'chainR3'); // still shown
    assert.equal(far.level, 'go');
  });
});

describe('closures', () => {
  test('direction of travel', () => {
    assert.equal(L.inDir('East', 'East'), true);
    assert.equal(L.inDir('West', 'East'), false);
    assert.equal(L.inDir('East / West', 'West'), true);
    assert.equal(L.inDir('N/A', 'East'), true);
    assert.equal(L.inDir('', 'East'), true);
    assert.equal(L.inDir(undefined, 'East'), true);
  });
  test('a full closure the other way does not block the trip', () => {
    const data = makeData({ closures: [closure({ dir: 'West' })] });
    assert.equal(ev(data).level, 'go');
    assert.equal(factor(ev(data), 'closures').msg, 'closedNone');
    assert.equal(ev(data, { direction: 'back' }).level, 'nogo');
  });
  test('a closure of both directions blocks both', () => {
    const data = makeData({ closures: [closure({ dir: 'East / West' })] });
    assert.equal(ev(data).level, 'nogo');
    assert.equal(ev(data, { direction: 'back' }).level, 'nogo');
  });
  test('only closures overlapping the drive count', () => {
    const end = NOW + route.driveHours * H;
    assert.equal(ev(makeData({ closures: [closure({ start: NOW - 5 * H, end: NOW - MIN })] })).level, 'go'); // over before leaving
    assert.equal(ev(makeData({ closures: [closure({ start: end + MIN, end: end + H })] })).level, 'go'); // starts after arriving
    assert.equal(ev(makeData({ closures: [closure({ start: end - MIN, end: end + H })] })).level, 'nogo'); // starts just before arriving
    assert.equal(ev(makeData({ closures: [closure({ start: NOW - 5 * H, end: null })] })).level, 'nogo'); // no end given
  });
  test('a scheduled closure decides a trip days away, unlike live road status', () => {
    const data = makeData({ closures: [closure({ start: LATER, end: LATER + 3 * H })] });
    assert.equal(ev(data, { departMs: LATER }).level, 'nogo');
    assert.equal(ev(data).level, 'go');
  });
  test('ramp closures are ignored', () => {
    const data = makeData({ closures: [closure({ facility: 'Off Ramp' }), closure({ facility: 'Connector' })] });
    assert.equal(ev(data).level, 'go');
    assert.equal(L.closuresDuring(data, NOW, NOW + H, 'East').length, 0);
  });
  test('lane closures: caution only from a 15-minute delay', () => {
    const lane = (delayMin) => makeData({ closures: [closure({ type: 'Lane', delayMin })] });
    assert.equal(ev(lane(14)).level, 'go');
    assert.equal(factor(ev(lane(14)), 'closures').msg, 'closedLanes');
    assert.equal(ev(lane(15)).level, 'caution');
  });
});

describe('incidents', () => {
  test('a collision in the direction of travel is caution', () => {
    const r = ev(makeData({ incidents: [incident()] }));
    assert.equal(r.level, 'caution');
    assert.equal(factor(r, 'incidents').v.serious.length, 1);
  });
  test('the other direction is left out; no direction counts both ways', () => {
    assert.equal(ev(makeData({ incidents: [incident({ dir: 'West' })] })).level, 'go');
    assert.equal(factor(ev(makeData({ incidents: [incident({ dir: 'West' })] })), 'incidents').msg, 'incNone');
    assert.equal(ev(makeData({ incidents: [incident({ dir: '' })] })).level, 'caution');
    assert.equal(ev(makeData({ incidents: [incident({ dir: '' })] }), { direction: 'back' }).level, 'caution');
  });
  test('minor incidents are listed without changing the verdict', () => {
    const r = ev(makeData({ incidents: [incident({ type: 'Traffic Hazard' })] }));
    assert.equal(r.level, 'go');
    assert.equal(factor(r, 'incidents').msg, 'incSome');
  });
  test('a collision in the valley, west of the mountain road, is listed but does not change the verdict', () => {
    const r = ev(makeData({ incidents: [incident({ lon: -121.46 })] })); // Sacramento
    assert.equal(r.level, 'go');
    assert.equal(factor(r, 'incidents').v.all.length, 1);
    assert.equal(factor(r, 'incidents').v.serious.length, 0);
    assert.equal(ev(makeData({ incidents: [incident({ lon: route.mountainLonMin })] })).level, 'caution');
    assert.equal(ev(makeData({ incidents: [incident({ lon: -120.03 })] })).level, 'caution'); // Echo Summit
  });
  test('incidents now do not decide a trip days away', () => {
    const r = ev(makeData({ incidents: [incident()] }), { departMs: LATER });
    assert.equal(factor(r, 'incidents').level, 'info');
    assert.equal(r.level, 'go');
  });
});

describe('weather on the mountain section', () => {
  // With no TomTom time the drive is the route's fixed estimate, so the pass is reached at its fixed offset.
  const passHour = hourIdx(NOW + route.points.find((p) => p.id === 'pass').offsetH * H);
  const snowAt = (rate, hour = passHour, id = 'pass') => {
    const data = makeData();
    data.weather[id].snow[hour] = rate;
    return data;
  };
  test('snowfall thresholds', () => {
    const at = (rate) => { const r = ev(snowAt(rate)); return [r.level, factor(r, 'snow').msg]; };
    assert.deepEqual(at(0), ['go', 'snowNone']);
    assert.deepEqual(at(1), ['go', 'snowTrace']);
    assert.deepEqual(at(L.TH.snowLight), ['caution', 'snowLight']);
    assert.deepEqual(at(L.TH.snowHeavy), ['caution', 'snowHeavy']);
    assert.deepEqual(at(L.TH.snowExtreme), ['nogo', 'snowExtreme']);
  });
  test('looks one hour either side of the pass-through time, no further', () => {
    assert.equal(ev(snowAt(60, passHour - 1)).level, 'nogo');
    assert.equal(ev(snowAt(60, passHour + 1)).level, 'nogo');
    assert.equal(ev(snowAt(60, passHour - 3)).level, 'go');
    assert.equal(ev(snowAt(60, passHour + 3)).level, 'go');
  });
  describe('snow that fell before the crossing', () => {
    // `mm` of snow an hour for the `hours` before the pass is reached, none while crossing.
    const storm = (mm, hours, temp, endsBefore = 2, cross = passHour) => {
      const data = makeData();
      for (let h = cross - endsBefore - hours + 1; h <= cross - endsBefore; h++) data.weather.pass.snow[h] = mm;
      data.weather.pass.temp.fill(temp);
      return data;
    };
    test('enough of it and still freezing: caution, chain control probably still up', () => {
      const r = ev(storm(10, 6, -5));
      assert.equal(factor(r, 'snow').msg, 'snowPack');
      assert.equal(factor(r, 'snow').level, 'caution');
      assert.equal(factor(r, 'snow').v.pack.mm, 60);
      assert.equal(factor(r, 'snow').v.pack.hours, 12);
      assert.equal(factor(r, 'snow').v.pack.stop.point.id, 'pass');
    });
    test('thresholds: the amount, the temperature, and how long ago', () => {
      const msg = (data) => factor(ev(data, { departMs: LATER }), 'snow').msg;
      const laterPass = hourIdx(LATER + route.points.find((p) => p.id === 'pass').offsetH * H);
      const later = (mm, hours, temp, endsBefore) => storm(mm, hours, temp, endsBefore, laterPass);
      const [short, long] = L.TH.pack;
      assert.equal(msg(later(short.mm / 5, 5, L.TH.packTemp)), 'snowPack');
      assert.equal(msg(later(short.mm / 5 - 1, 5, L.TH.packTemp)), 'snowNone'); // too little
      assert.equal(msg(later(20, 5, L.TH.packTemp + 1)), 'snowNone'); // thawing as you cross
      assert.equal(msg(later(15, 5, -5, short.hours + 1)), 'snowNone'); // a short storm that ended long enough ago
      // A long storm tapering off: too little in the last 12 hours, but a lot within the day.
      const taper = later(long.mm / 10, 10, -5, short.hours - 2);
      assert.equal(msg(taper), 'snowPack');
      assert.equal(factor(ev(taper, { departMs: LATER }), 'snow').v.pack.hours, long.hours);
      assert.equal(msg(later(long.mm / 10, 10, -5, long.hours + 1)), 'snowNone'); // more than a day ago
    });
    test('while it is still snowing the falling snow is what is reported', () => {
      const data = storm(10, 6, -5);
      data.weather.pass.snow[passHour] = L.TH.snowLight;
      assert.equal(factor(ev(data), 'snow').msg, 'snowLight');
    });
    test('snow from before the file starts is read from the hours the fetch script kept', () => {
      const data = makeData();
      data.weather.pass.temp.fill(-5);
      const trip = { departMs: T0, nowMs: T0 }; // crossing 3 to 4 hours into the file
      assert.equal(factor(ev(data, trip), 'snow').msg, 'snowNone');
      data.weather.pass.snowPast = [...new Array(18).fill(0), 20, 20, 20, 0, 0, 0]; // ended 3 hours before the file starts
      assert.equal(factor(ev(data, trip), 'snow').msg, 'snowPack');
      assert.equal(factor(ev(data, trip), 'snow').v.pack.mm, 60);
    });
    test('the hour-by-hour strip marks heavy snow apart from light snow', () => {
      const data = makeData();
      data.weather.pass.snow.fill(L.TH.snowLight, 24, 36);
      data.weather.pass.snow.fill(L.TH.snowHeavy, 36, 48);
      const strip = L.departureStrip(data, dest, L.index(data), L.dayKey(T0 + 24 * H), 'out', NOW);
      assert.ok(strip.some((s) => s.level === 'caution' && !s.heavy));
      assert.ok(strip.some((s) => s.level === 'caution' && s.heavy));
      assert.ok(strip.filter((s) => s.heavy).every((s) => s.h >= 7)); // only departures that cross during the heavy hours
    });
  });
  test('snow in the valley does not count', () => {
    assert.equal(ev(snowAt(60, hourIdx(NOW + 1.75 * H), 'sac')).level, 'go');
  });
  test('no forecast for the mountain: caution, not go', () => {
    const data = makeData();
    for (const id of route.mountainPoints) delete data.weather[id];
    const r = ev(data);
    assert.equal(r.level, 'caution');
    assert.equal(factor(r, 'snow').msg, 'snowUnknown');
  });
  test('a trip beyond the end of the forecast is caution', () => {
    assert.equal(factor(ev(makeData(), { departMs: T0 + 170 * H }), 'snow').msg, 'snowUnknown');
  });
  test('gusts on the pass', () => {
    const gust = (v) => { const d = makeData(); d.weather.pass.gust[passHour] = v; return ev(d); };
    assert.equal(gust(L.TH.gustRoad - 1).level, 'go');
    assert.equal(gust(L.TH.gustRoad).level, 'caution');
    assert.equal(factor(gust(L.TH.gustRoad), 'wind').msg, 'windHigh');
  });
  test('weather alerts overlapping the drive', () => {
    const alert = (event, onset = NOW - H, ends = NOW + 10 * H) => ev(makeData({ alerts: [{ id: 'a', event, onset, ends }] }));
    assert.equal(alert('Blizzard Warning').level, 'nogo');
    assert.equal(alert('Avalanche Warning').level, 'nogo');
    assert.equal(alert('Winter Storm Warning').level, 'caution');
    assert.equal(alert('Winter Weather Advisory').level, 'caution');
    assert.equal(alert('Winter Storm Watch').level, 'go'); // listed, does not change the verdict
    assert.equal(factor(alert('Winter Storm Watch'), 'alerts').msg, 'alertsActive');
    assert.equal(alert('Blizzard Warning', NOW + 5 * H).level, 'go'); // starts after arriving
    assert.equal(alert('Blizzard Warning', NOW - 9 * H, NOW - H).level, 'go'); // already over
  });
  test('lift wind hold on the ski day is a caution for the outbound trip only', () => {
    const data = makeData();
    data.weather[dest.resort.summitPoint].gust[hourIdx(T0 + 12 * H)] = L.TH.gustLiftHigh; // noon on the arrival day
    assert.equal(factor(ev(data), 'lift').msg, 'lift_high');
    assert.equal(ev(data).level, 'caution');
    assert.equal(ev(data, { direction: 'back' }).level, 'go');
    data.weather[dest.resort.summitPoint].gust[hourIdx(T0 + 12 * H)] = L.TH.gustLiftMod;
    assert.equal(factor(ev(data), 'lift').msg, 'lift_mod');
    assert.equal(ev(data).level, 'go');
  });
});

describe('when a data source failed', () => {
  for (const key of ['chain', 'closures', 'incidents', 'alerts']) {
    test(`${key} failed with nothing to fall back on: caution, "could not confirm"`, () => {
      const r = ev(fail(makeData(), key));
      assert.equal(r.level, 'caution');
      assert.deepEqual({ level: factor(r, key).level, msg: factor(r, key).msg }, { level: 'caution', msg: 'srcFailed' });
    });
  }
  test('carried-over data is judged as usual and tagged with its age', () => {
    const at = NOW - 40 * MIN;
    const quiet = ev(fail(makeData(), 'chain', at));
    assert.equal(quiet.level, 'go');
    assert.equal(factor(quiet, 'chain').staleAt, at);
    const closed = ev(fail(makeData({ closures: [closure()] }), 'closures', at));
    assert.equal(closed.level, 'nogo');
    assert.equal(factor(closed, 'closures').staleAt, at);
  });
  test('carried-over data older than two hours is at best caution, and never hides something worse', () => {
    const at = NOW - 121 * MIN;
    for (const key of ['chain', 'closures', 'incidents', 'alerts']) assert.equal(ev(fail(makeData(), key, at)).level, 'caution', key);
    assert.equal(ev(fail(makeData({ chain: [chainRow(3)] }), 'chain', at)).level, 'nogo');
  });
  test('fresh sources carry no age tag', () => {
    assert.ok(ev(makeData()).factors.every((f) => f.staleAt == null));
  });
  test('a mountain forecast carried over from an earlier run tags snow and wind, and is caution once old', () => {
    const carry = (ageMin) => {
      const data = makeData();
      Object.assign(data.weather.pass, { carried: true, at: NOW - ageMin * MIN });
      return ev(data);
    };
    assert.equal(carry(30).level, 'go');
    assert.equal(factor(carry(30), 'snow').staleAt, NOW - 30 * MIN);
    assert.equal(carry(121).level, 'caution');
    assert.equal(factor(carry(121), 'snow').level, 'caution');
  });
  test('TomTom failed: the fixed drive time is used and it is only a note', () => {
    const r = ev(fail(makeData(), 'drive'));
    assert.equal(r.drive.src, 'fixed');
    assert.equal(r.level, 'go');
    assert.deepEqual({ level: factor(r, 'drive').level, msg: factor(r, 'drive').msg }, { level: 'info', msg: 'driveFailed' });
  });
});

describe('drive time', () => {
  const fc = (ms, sec, stops) => ({ ms, sec, noTrafficSec: 12600, ...(stops ? { stops } : {}) });
  const S = (sac, plc, kyb, pass, total) => [0, sac, plc, kyb, pass, total];
  const dt = (drive, departMs, direction = 'out', nowMs = NOW) => L.driveTime(makeData({ drive }), dest, departMs, direction, nowMs);

  test('no TomTom data: the fixed estimate', () => {
    assert.deepEqual(dt(null, NOW), { hours: route.driveHours, src: 'fixed' });
  });
  test('leaving now uses the live reading, compared with the usual time', () => {
    const r = dt(liveDrive({ out: { sec: 16200, noTrafficSec: 12600, historicSec: 14400, stops: S(9000, 11000, 13000, 14500, 16200) } }), NOW + 10 * MIN);
    assert.equal(r.src, 'live');
    assert.equal(r.hours, 4.5);
    assert.equal(r.deltaMin, 30);
    assert.equal(r.vs, 'usual');
    assert.deepEqual(r.stops, S(9000, 11000, 13000, 14500, 16200));
  });
  test('a live reading older than 45 minutes is not used', () => {
    assert.equal(dt(liveDrive({ at: NOW - 46 * MIN }), NOW).src, 'fixed');
  });
  test('a later departure interpolates between forecast points, pass-through times included', () => {
    const t = NOW + 2 * H;
    const drive = liveDrive({ hourly: { out: [fc(t, 12600, S(6000, 8000, 10000, 11400, 12600)), fc(t + H, 14400, S(7000, 9200, 11400, 13000, 14400))], back: [] } });
    const r = dt(drive, t + 30 * MIN);
    assert.equal(r.src, 'forecast');
    assert.equal(r.sec, 13500);
    assert.equal(r.deltaMin, 15);
    assert.deepEqual(r.stops, S(6500, 8600, 10700, 12200, 13500));
  });
  test('a place the route does not pass at one of the two times stays untimed', () => {
    const t = NOW + 2 * H;
    const drive = liveDrive({ hourly: { out: [fc(t, 12600, S(null, 8000, 10000, 11400, 12600)), fc(t + H, 14400, S(7000, 9200, 11400, 13000, 14400))], back: [] } });
    assert.deepEqual(dt(drive, t + 30 * MIN).stops, S(null, 8600, 10700, 12200, 13500));
  });
  test('forecast points saved before pass-through times existed still give the total', () => {
    const t = NOW + 2 * H;
    const r = dt(liveDrive({ hourly: { out: [fc(t, 12600), fc(t + H, 14400)], back: [] } }), t + 30 * MIN);
    assert.equal(r.sec, 13500);
    assert.equal(r.stops, null);
  });
  test('the 7-day grid continues where the hourly forecast ends', () => {
    const t = NOW + 2 * H;
    const drive = liveDrive({
      hourly: { out: [fc(t, 12600), fc(t + H, 12600)], back: [] },
      long: { out: [fc(t, 99999), fc(t + 2 * H, 14400), fc(t + 4 * H, 16200)], back: [] }, // the first overlaps the hourly series
    });
    assert.equal(dt(drive, t + 30 * MIN).sec, 12600);
    assert.equal(dt(drive, t + 3 * H).sec, 15300);
  });
  test('no forecast near the departure: the fixed estimate', () => {
    const t = NOW + 2 * H;
    const drive = liveDrive({ hourly: { out: [fc(t, 12600), fc(t + 4 * H, 14400)], back: [] } });
    assert.equal(dt(drive, t + 2 * H).src, 'fixed'); // a 4-hour hole is not bridged
    assert.equal(dt(drive, t + 4 * H + 30 * MIN).src, 'forecast'); // just past the end
    assert.equal(dt(drive, t + 5 * H + MIN).src, 'fixed'); // more than an hour past the end
  });
  test('only an hour or more of delay changes the verdict', () => {
    const slow = (sec) => ev(makeData({ drive: liveDrive({ out: { sec, noTrafficSec: 12600, historicSec: 12600 } }) }));
    assert.equal(slow(12600 + 59 * 60).level, 'go');
    assert.equal(slow(12600 + 60 * 60).level, 'caution');
    assert.equal(factor(slow(12600 + 60 * 60), 'drive').msg, 'driveLive');
  });
  test('the drive window for closures follows the real drive time', () => {
    // A closure starting 4 h 15 min after leaving: missed by the fixed 3 h 45 min, hit by a 4 h 30 min drive.
    const data = makeData({ closures: [closure({ start: NOW + 4.25 * H, end: NOW + 9 * H })] });
    assert.equal(ev(data).level, 'go');
    data.drive = liveDrive({ out: { sec: 16200, noTrafficSec: 16000, historicSec: 16000 } });
    assert.equal(ev(data).level, 'nogo');
  });
});

describe('when the drive reaches each point', () => {
  const mins = (stops, departMs = NOW) => Object.fromEntries(stops.map((s) => [s.point.id, Math.round((s.ms - departMs) / MIN)]));
  const order = (stops) => stops.map((s) => s.point.id);

  test('without TomTom times: the fixed offsets, stretched to the drive time', () => {
    const fixed = L.alongRoute(makeData(), dest, NOW, 'out');
    assert.deepEqual(order(fixed), timed.map((p) => p.id));
    for (const s of fixed) assert.equal(s.ms, NOW + s.point.offsetH * H);
    const slow = L.alongRoute(makeData(), dest, NOW, 'out', route.driveHours * 2);
    for (const s of slow) assert.equal(s.ms, NOW + s.point.offsetH * 2 * H);
  });
  test('return trip without TomTom times: the same offsets from the other end', () => {
    const back = L.alongRoute(makeData(), dest, NOW, 'back');
    assert.deepEqual(order(back), timed.map((p) => p.id).reverse());
    for (const s of back) assert.ok(Math.abs(s.ms - (NOW + (route.driveHours - s.point.offsetH) * H)) < 1);
  });
  test('with TomTom times every point is where TomTom puts it', () => {
    // Real figures from a weekday evening rush: Sacramento is reached 38 min later than the fixed split says.
    const stops = [0, 9834, 12114, 14022, 15217, 16166];
    const got = mins(L.alongRoute(makeData(), dest, NOW, 'out', 16166 / 3600, stops));
    assert.deepEqual(got, { origin: 0, sac: 164, placerville: 202, kyburz: 234, pass: 254, town: 269 });
    const fixed = mins(L.alongRoute(makeData(), dest, NOW, 'out', 16166 / 3600));
    assert.equal(fixed.sac, 126);
  });
  test('return trip: times count from the Tahoe end', () => {
    const stops = [12780, 6600, 4140, 2280, 1020, 0]; // still in route order, west to east
    const r = L.alongRoute(makeData(), dest, NOW, 'back', 12780 / 3600, stops);
    assert.deepEqual(order(r), ['town', 'pass', 'kyburz', 'placerville', 'sac', 'origin']);
    assert.deepEqual(mins(r), { town: 0, pass: 17, kyburz: 38, placerville: 69, sac: 110, origin: 213 });
  });
  test('a point the route does not pass is placed between its timed neighbours', () => {
    // In the evening TomTom goes via Stockton, not Sacramento: no time for it.
    const stops = [0, null, 9000, 10800, 12000, 12960];
    const got = mins(L.alongRoute(makeData(), dest, NOW, 'out', 3.6, stops));
    const [sac, plc] = [timed[stopIdx('sac')].offsetH, timed[stopIdx('placerville')].offsetH];
    assert.equal(got.sac, Math.round((sac / plc) * 150));
    assert.deepEqual({ ...got, sac: 0 }, { origin: 0, sac: 0, placerville: 150, kyburz: 180, pass: 200, town: 216 });
  });
  test('times that make no sense are ignored rather than shown', () => {
    const base = mins(L.alongRoute(makeData(), dest, NOW, 'out', 3.75));
    assert.deepEqual(mins(L.alongRoute(makeData(), dest, NOW, 'out', 3.75, [0, 99999, -5, NaN, undefined, 13500])), base); // beyond arrival, negative, missing
    const r = L.alongRoute(makeData(), dest, NOW, 'out', 3.75, [0, 9000, 7000, 10800, 12000, 13500]); // Placerville "before" Sacramento
    const t = r.map((s) => s.ms);
    assert.deepEqual(t, [...t].sort((a, b) => a - b));
    for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  });
  test('the forecast is read at the hour each point is reached', () => {
    const data = makeData();
    data.weather.pass.temp[hourIdx(NOW + 2 * H)] = -9;
    const stops = [0, 3000, 4500, 6000, 7200, 9000];
    const pass = L.alongRoute(data, dest, NOW, 'out', 2.5, stops).find((s) => s.point.id === 'pass');
    assert.equal(pass.temp, -9);
    assert.equal(pass.missing, false);
  });
  test('the verdict uses the real time over the pass', () => {
    // A 6-hour drive that is over the pass after 2 hours. One hour of extreme snow there at that moment is
    // seen with TomTom's times and missed by the fixed split, which has the car on the pass 3.5 hours later.
    const sec = 6 * 3600;
    const stops = [0, 3600, 4500, 5400, 7200, sec];
    const data = makeData({ drive: liveDrive({ out: { sec, noTrafficSec: sec, historicSec: sec, stops } }) });
    data.weather.pass.snow[hourIdx(NOW + 2 * H)] = 60;
    const withTimes = ev(data);
    assert.equal(withTimes.level, 'nogo');
    assert.equal(factor(withTimes, 'snow').v.stop.point.id, 'pass');
    delete data.drive.out.stops;
    assert.equal(ev(data).level, 'go'); // the fixed split has the pass at 5 h 26 min and never sees it
  });
  test('the hour-by-hour strip uses the forecast times for each departure hour', () => {
    const t = T0 + 30 * H; // 06:00 the next day
    const sec = 6 * 3600;
    const point = (ms) => ({ ms, sec, noTrafficSec: sec, stops: [0, 3600, 4500, 5400, 7200, sec] });
    const data = makeData({ drive: liveDrive({ hourly: { out: Array.from({ length: 24 }, (_, i) => point(T0 + (24 + i) * H)), back: [] } }) });
    data.weather.pass.snow[hourIdx(t + 2 * H)] = 60;
    const ix = L.index(data);
    const strip = L.departureStrip(data, dest, ix, L.dayKey(t), 'out', NOW);
    assert.equal(strip.length, 24);
    assert.deepEqual(strip.filter((s) => s.level === 'nogo').map((s) => s.h), [5, 6, 7]); // on the pass within an hour of the burst
  });
});

describe('best time to leave', () => {
  const strip = (levels, from = 0) => levels.map((level, k) => ({ h: from + k, level, past: false }));
  test('the longest clear run within the day', () => {
    assert.deepEqual(L.bestWindow(strip(['ok', 'ok', 'caution', 'ok', 'ok', 'ok', 'nogo', 'ok'], 5)), { from: 8, to: 10 });
  });
  test('night hours and hours already past are left out', () => {
    assert.deepEqual(L.bestWindow(strip(new Array(24).fill('ok'))), { from: 5, to: 21 });
    const s = strip(new Array(24).fill('ok'));
    for (const x of s) x.past = x.h < 9;
    assert.deepEqual(L.bestWindow(s), { from: 9, to: 21 });
  });
  test('no clear hour: none', () => {
    assert.equal(L.bestWindow(strip(new Array(24).fill('caution'))), null);
  });
});

describe('time zone', () => {
  test('days and hours are Pacific, across the clock change', () => {
    assert.equal(L.dayKey(T0), '2026-01-13');
    assert.equal(L.hourOf(T0), 0);
    assert.equal(L.dayKey(T0 - 1), '2026-01-12');
    assert.equal(L.hourOf(Date.UTC(2026, 6, 1, 7)), 0); // PDT
    const ix = L.index(makeData({ t0: Date.UTC(2026, 2, 8, 8), hours: 24 })); // spring forward: 02:00 does not exist
    assert.deepEqual(ix.hours.slice(0, 4).map((h) => h.h), [0, 1, 3, 4]);
  });
});

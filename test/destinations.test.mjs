// Every destination in js/config.js: that its configuration hangs together, that Heavenly is still exactly
// what it was, and that Kirkwood (CA-88) and Northstar (I-80 + CA-267) are judged on their own roads.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DESTINATIONS } from '../js/config.js';
import * as L from '../js/logic.js';
import { makeT } from '../js/i18n.js';
import { incidentDir } from '../js/normalize.js';
import { incidentRoad, keptHours, keptLive, cadenceOf, CADENCE, HOURLY_EVERY_MS, LONG_EVERY_MS, LONG_STEP_H, LONG_TO_H } from '../scripts/lib.mjs';
import { planState, decide } from '../scripts/notify.mjs';
import { makeData, factor, closure, incident, liveDrive, AWD, NOW, T0, H, MIN } from './helpers.mjs';

const by = (id) => DESTINATIONS.find((d) => d.id === id);
const heavenly = by('heavenly');
const kirkwood = by('kirkwood');
const northstar = by('northstar');
const cc = (hw, dir, level, lon) => ({ hw, name: `cc ${hw} ${dir} ${lon ?? ''}`, dir, level, lon, status: level > 0 ? `R-${level}` : '' });
const go = (dest, data, direction = 'out') => L.evaluate(data, dest, { departMs: NOW, direction, vehicle: AWD, nowMs: NOW });

describe('destinations', () => {
  test('Heavenly, Kirkwood and Northstar, in that order', () => {
    assert.deepEqual(DESTINATIONS.map((d) => d.id), ['heavenly', 'kirkwood', 'northstar']);
    assert.deepEqual(DESTINATIONS.map((d) => d.route.label), ['US-50', 'CA-88', 'I-80']);
  });
  test('Heavenly is unchanged: names, route points and drive-time waypoints', () => {
    const r = heavenly.route;
    assert.deepEqual(heavenly.name, { zh: 'Heavenly', en: 'Heavenly' });
    assert.deepEqual(r.points.map((p) => [p.id, p.name.zh, p.lat, p.lon, p.offsetH ?? null]), [
      ['origin', '圣马特奥', 37.563, -122.3255, 0],
      ['sac', '萨克拉门托', 38.5816, -121.4944, 1.75],
      ['placerville', 'Placerville', 38.7296, -120.7985, 2.4],
      ['kyburz', 'Kyburz', 38.7746, -120.2977, 3.0],
      ['pass', 'Echo Summit 垭口', 38.8121, -120.0303, 3.4],
      ['town', '南太浩湖', 38.9399, -119.9772, 3.75],
      ['base', 'Heavenly 山脚 (California Lodge)', 38.9353, -119.94, null],
      ['summit', 'Heavenly 山顶', 38.9195, -119.9005, null],
    ]);
    assert.deepEqual(r.drivePins, ['kyburz', 'pass']);
    assert.deepEqual(r.mountainPoints, ['kyburz', 'pass', 'town']);
    assert.deepEqual([r.highway, r.outboundDir, r.returnDir, r.driveHours, r.distanceKm], ['US-50', 'East', 'West', 3.75, 335]);
    assert.equal(r.also, undefined);
    assert.equal(r.lonMax, undefined);
  });
  test('Heavenly wording that now takes the destination from the config reads as before', () => {
    const zh = makeT('zh');
    const en = makeT('en');
    assert.equal(zh('m.evCool', { v: '−3°C', climb: heavenly.route.climb.zh }), '沿途最低 −3°C，爬升约 2,250 m，续航会比平时少一些。');
    assert.equal(en('m.evCool', { v: '27°F', climb: heavenly.route.climb.en }), 'Coldest point 27°F with about 7,400 ft of climbing. Expect somewhat less range.');
    assert.equal(zh('m.lift_high', { day: '明天', v: '90 km/h', lifts: heavenly.resort.windLifts.zh }), '明天 山顶最大阵风 90 km/h，Gondola 和山顶缆车很可能因风停运。');
    assert.equal(en('m.lift_high', { day: 'Tomorrow', v: '56 mph', lifts: heavenly.resort.windLifts.en }), 'Tomorrow: summit gusts to 56 mph. Gondola and summit lifts likely on wind hold.');
    assert.equal(zh('liftNote', { dest: heavenly.name.zh }), '缆车开放状态请看 Heavenly 官方页面，它不提供可抓取的数据。这里的停缆风险是按 NWS 山顶阵风预报估的。');
    assert.equal(en('liftNote', { dest: heavenly.name.en }), 'For lift status see the official Heavenly page; it offers no machine-readable feed. Wind-hold risk here is estimated from NWS summit gust forecasts.');
  });

  for (const d of DESTINATIONS) {
    describe(d.id, () => {
      const r = d.route;
      const pt = (id) => r.points.find((p) => p.id === id);
      test('every point the rest of the config names exists', () => {
        for (const id of [...r.mountainPoints, ...r.drivePins, r.townPoint, ...d.feeds.alertPoints, d.resort.basePoint, d.resort.summitPoint]) assert.ok(pt(id), id);
        assert.equal(new Set(r.points.map((p) => p.id)).size, r.points.length);
      });
      test('starts in San Mateo and the timed points run west to east with rising offsets', () => {
        assert.deepEqual(r.points[0].name, { zh: '圣马特奥', en: 'San Mateo' });
        const timed = r.points.filter((p) => p.offsetH != null);
        assert.equal(timed.at(-1).id, r.townPoint);
        assert.equal(timed.at(-1).offsetH, r.driveHours);
        for (let i = 1; i < timed.length; i++) {
          assert.ok(timed[i].offsetH > timed[i - 1].offsetH, timed[i].id);
          assert.ok(timed[i].lon > timed[i - 1].lon, timed[i].id);
        }
      });
      test('drive-time waypoints are mountain points only, never a town centre', () => {
        assert.ok(r.drivePins.length > 0);
        for (const id of r.drivePins) {
          assert.equal(pt(id).role, 'mountain', id);
          assert.ok(r.mountainPoints.includes(id), id);
          assert.notEqual(id, r.townPoint);
        }
      });
      test('coordinates are ones the NWS point lookup accepts (at most 4 decimals)', () => {
        for (const p of r.points) for (const v of [p.lat, p.lon]) assert.equal(+v.toFixed(4), v, `${p.id} ${v}`);
      });
      test('roads, feeds and resort are filled in', () => {
        for (const road of L.roadsOf(r)) {
          assert.ok(d.feeds.chainHighways.includes(road.highway), road.highway);
          assert.ok(road.label && road.outboundDir && road.returnDir && road.outboundDir !== road.returnDir);
        }
        for (const a of r.alternates) assert.ok(d.feeds.chainHighways.includes(a.highway), a.highway);
        assert.match(d.feeds.incidentMatch, new RegExp(r.highway.replace(/\D/g, '')));
        assert.ok(d.feeds.camRoads || d.feeds.camHighway);
        assert.ok(d.resort.cams.length > 0);
        for (const c of d.resort.cams) assert.match(c.embed, /^https:\/\//);
        for (const k of ['cams', 'lifts', 'snow']) assert.match(d.resort.links[k], /^https:\/\//);
        for (const o of [d.name, r.climb, d.resort.windLifts]) assert.ok(o.zh && o.en);
      });
      test('has a map line from San Mateo to the destination, saved for offline use', async () => {
        const line = (await import(`../js/routes/${d.id}.js`)).default;
        const near = (a, p) => Math.hypot(a[0] - p.lat, (a[1] - p.lon) * 0.78) < 0.02;
        assert.ok(line.length > 100);
        assert.ok(near(line[0], r.points[0]));
        assert.ok(near(line.at(-1), pt(r.townPoint)));
        assert.ok(readFileSync(new URL('../sw.js', import.meta.url), 'utf8').includes(`'js/routes/${d.id}.js'`));
      });
      test('quiet roads and weather: go, both ways', () => {
        const data = makeData({}, r);
        assert.equal(go(d, data).level, 'go');
        assert.equal(go(d, data, 'back').level, 'go');
      });
      test('heavy snow on any of its mountain points is caution; in the valley it is not', () => {
        for (const id of r.mountainPoints) {
          const data = makeData({}, r);
          data.weather[id].snow.fill(30);
          assert.equal(factor(go(d, data), 'snow').msg, 'snowHeavy', id);
        }
        const data = makeData({}, r);
        data.weather[r.points[1].id].snow.fill(30);
        assert.equal(factor(go(d, data), 'snow').level, 'ok');
      });
      test('week overview: seven days of departures with drive times, both ways', () => {
        const grid = (dir) => Array.from({ length: 97 }, (_, i) => ({ ms: T0 + i * 2 * H, sec: (r.driveHours + (i % 12 === 8 ? 1 : 0)) * 3600, noTrafficSec: r.driveHours * 3600, stops: null }));
        const data = makeData({ drive: liveDrive({ long: { out: grid(), back: grid() } }) }, r);
        for (const dir of ['out', 'back']) {
          const wk = L.weekOverview(data, d, L.index(data), dir, NOW);
          assert.equal(wk.rows.length, 7);
          assert.ok(wk.rows.every((row) => row.best?.drive), dir);
          assert.equal(wk.lo, r.driveHours * 3600);
          assert.equal(wk.hi, (r.driveHours + 1) * 3600);
        }
      });
      test('change alert: the notification names this destination and its highway', () => {
        const data = makeData({ chain: [cc(r.highway, r.outboundDir, 0)] }, r);
        const plan = { dest: d.id, direction: 'out', departMs: NOW + 3 * H, setAt: NOW };
        const cur = planState(data, d, plan, AWD, NOW);
        assert.deepEqual([cur.level, cur.chain], ['go', 0]);
        const first = decide(null, cur, plan, d, 'zh', NOW);
        assert.ok(first.title.startsWith(d.name.zh));
        assert.ok(first.body.includes(r.label));
        const worse = planState(makeData({ chain: [cc(r.highway, r.outboundDir, 2)] }, r), d, plan, { ...AWD, chains: false }, NOW);
        const msg = decide(first.told, worse, plan, d, 'zh', NOW);
        assert.ok(msg.body.includes('R2'));
        assert.equal(msg.told.level, 'nogo');
      });
    });
  }
});

describe('Kirkwood: CA-88', () => {
  const r = kirkwood.route;
  test('chain control on SR-88 eastbound decides the trip out, westbound the trip back', () => {
    const data = makeData({ chain: [cc('SR-88', 'East', 3, -120.37), cc('SR-88', 'West', 0, -120.08)] }, r);
    assert.equal(go(kirkwood, data).level, 'nogo');
    assert.equal(go(kirkwood, data, 'back').level, 'go');
  });
  test('US-50 and I-80 chain control do not touch it', () => {
    const data = makeData({ chain: [cc('US-50', 'East', 3, -120.1), cc('I-80', 'East', 3, -120.4)] }, r);
    assert.equal(go(kirkwood, data).level, 'go');
    assert.equal(L.chainOn(data, r, 'out').max, -1);
  });
  test('checkpoints past the resort turn-off (Caples Lake, Carson Pass) are not on the trip', () => {
    const data = makeData({ chain: [cc('SR-88', 'East', 4, -120.043), cc('SR-88', 'West', 4, -119.955), cc('SR-88', 'East', 1, -120.109)] }, r);
    assert.equal(L.chainOn(data, r, 'out').max, 1);
    assert.equal(L.chainOn(data, r, 'back').max, -1);
    assert.equal(factor(go(kirkwood, data), 'chain').msg, 'chainR1Pass');
  });
  test('Carson Spur closed for avalanche control: no-go', () => {
    const data = makeData({ closures: [closure({ hw: 'SR-88', dir: 'East / West', lon: -120.109 })] }, r);
    assert.equal(go(kirkwood, data).level, 'nogo');
    assert.equal(go(kirkwood, data, 'back').level, 'nogo');
  });
  test('the drive is pinned to two points on the mountain stretch of CA-88', () => {
    assert.deepEqual(r.drivePins, ['hams', 'spur']);
    assert.ok(r.points.filter((p) => r.drivePins.includes(p.id)).every((p) => !p.pin));
  });
});

describe('Northstar: I-80, then CA-267', () => {
  const r = northstar.route;
  test('its roads: I-80 east/west and CA-267 south/north', () => {
    assert.deepEqual(L.roadsOf(r).map((x) => [x.highway, x.label, x.outboundDir, x.returnDir]), [['I-80', 'I-80', 'East', 'West'], ['SR-267', 'CA-267', 'South', 'North']]);
    assert.deepEqual(L.roadsOf(heavenly.route).map((x) => x.highway), ['US-50']);
  });
  test('chain control on I-80 eastbound decides the trip out', () => {
    const data = makeData({ chain: [cc('I-80', 'East', 3, -120.45), cc('I-80', 'West', 0, -120.45)] }, r);
    assert.equal(go(northstar, data).level, 'nogo');
    assert.equal(go(northstar, data, 'back').level, 'go');
  });
  test('chain control on CA-267 counts too: southbound out, northbound back', () => {
    const south = makeData({ chain: [cc('I-80', 'East', 0, -120.45), cc('SR-267', 'South', 3, -120.148)] }, r);
    assert.equal(go(northstar, south).level, 'nogo');
    assert.equal(go(northstar, south, 'back').level, 'go');
    const north = makeData({ chain: [cc('SR-267', 'North', 3, -120.038)] }, r);
    assert.equal(go(northstar, north).level, 'go');
    assert.equal(go(northstar, north, 'back').level, 'nogo');
  });
  test('the stricter of the two roads is the one reported', () => {
    const data = makeData({ chain: [cc('I-80', 'East', 1, -120.45), cc('SR-267', 'South', 2, -120.148)] }, r);
    const c = L.chainOn(data, r, 'out');
    assert.equal(c.max, 2);
    assert.deepEqual(c.active.map((x) => x.hw), ['I-80', 'SR-267']);
    assert.equal(planState(data, northstar, { direction: 'out', departMs: NOW + H }, AWD, NOW).chain, 2);
  });
  test('I-80 east of the CA-267 junction (Boca, Floriston, the state line) is not on the trip', () => {
    const data = makeData({ chain: [cc('I-80', 'East', 4, -120.084), cc('I-80', 'West', 4, -119.998)], closures: [closure({ hw: 'I-80', dir: 'East', lon: -120.03 })], incidents: [incident({ hw: 'I-80', dir: 'East', lon: -120.03 })] }, r);
    assert.equal(go(northstar, data).level, 'go');
    assert.equal(go(northstar, data, 'back').level, 'go');
  });
  test('a closed rest area or side street is not a closed freeway', () => {
    const data = makeData({ closures: [closure({ hw: 'I-80', dir: 'East', facility: 'Rest Area', from: 'Route 80', to: 'Donner Summit Rest Area (EB)', end: null }), closure({ hw: 'I-80', dir: 'East', facility: 'Surface Street', delayMin: 30 })] }, r);
    assert.equal(go(northstar, data).level, 'go');
    assert.equal(factor(go(northstar, data), 'closures').msg, 'closedNone');
    assert.equal(go(northstar, makeData({ closures: [closure({ hw: 'I-80', dir: 'East', facility: 'Mainline' })] }, r)).level, 'nogo');
  });
  test('closures and incidents are matched to the direction on their own road', () => {
    const data = makeData({ closures: [closure({ hw: 'SR-267', dir: 'South', lon: -120.12 })], incidents: [incident({ hw: 'SR-267', dir: 'North', lon: -120.12 })] }, r);
    assert.equal(factor(go(northstar, data), 'closures').msg, 'closedFull');
    assert.equal(factor(go(northstar, data), 'incidents').v.all.length, 0);
    assert.equal(factor(go(northstar, data, 'back'), 'closures').msg, 'closedNone');
    assert.equal(factor(go(northstar, data, 'back'), 'incidents').v.serious.length, 1);
  });
  test('records saved before roads were told apart count for the main highway', () => {
    const data = makeData({ closures: [closure({ dir: 'East' })] }, r);
    assert.equal(go(northstar, data).level, 'nogo');
    assert.equal(go(northstar, data, 'back').level, 'go');
  });
  test('the waypoint on the divided freeway has a spot on each carriageway, a stone throw apart', () => {
    assert.deepEqual(r.drivePins, ['pass']);
    const p = r.points.find((x) => x.id === 'pass');
    for (const k of ['out', 'back']) assert.ok(Math.hypot(p.pin[k][0] - p.lat, p.pin[k][1] - p.lon) < 0.002, k);
    assert.notDeepEqual(p.pin.out, p.pin.back);
  });
});

describe('CHP incidents: which road, which way', () => {
  const road = (dest, loc, desc = '') => incidentRoad(loc, desc, L.roadsOf(dest.route), dest.feeds.incidentMatch, incidentDir);
  test('Heavenly: US-50 as before', () => {
    assert.deepEqual(road(heavenly, 'Us50 E / Sly Park Rd'), { hw: 'US-50', dir: 'East' });
    assert.deepEqual(road(heavenly, 'Kyburz', 'WB 50 JEO KYBURZ'), { hw: 'US-50', dir: 'West' });
    assert.equal(road(heavenly, 'I80 E / Sr267'), null);
    assert.equal(road(heavenly, '1500 Main St'), null);
  });
  test('Kirkwood: SR-88', () => {
    assert.deepEqual(road(kirkwood, 'Sr88 W / Mormon Emigrant Trl'), { hw: 'SR-88', dir: 'West' });
    assert.deepEqual(road(kirkwood, 'Kirkwood Meadows Dr', 'EB 88 AT CARSON SPUR'), { hw: 'SR-88', dir: 'East' });
    assert.equal(road(kirkwood, '1880 Ridge Rd'), null);
  });
  test('Northstar: I-80 first, then CA-267 in its own directions', () => {
    assert.deepEqual(road(northstar, 'I80 W / Donner Lake Rd'), { hw: 'I-80', dir: 'West' });
    assert.deepEqual(road(northstar, 'Sr267 S / Northstar Dr'), { hw: 'SR-267', dir: 'South' });
    assert.deepEqual(road(northstar, 'Brockway Rd', 'NB 267 JSO AIRPORT RD'), { hw: 'SR-267', dir: 'North' });
    assert.deepEqual(road(northstar, 'I80 E / Sr267'), { hw: 'I-80', dir: 'East' });
    assert.deepEqual(road(northstar, 'Sr267 / Airport Rd'), { hw: 'SR-267', dir: '' });
    assert.equal(road(northstar, 'Us50 E / Sly Park Rd'), null);
  });
});

describe('TomTom quota: how often forecasts are refreshed', () => {
  const h0 = Date.UTC(2026, 0, 13, 15);
  const now = h0 - 20 * MIN;
  const pt = (i, at) => ({ ms: h0 + i * H, sec: 13000, noTrafficSec: 12500, stops: [0, 1], ...(at != null ? { at } : {}) });
  const series = (from, to, at) => { const a = []; for (let i = from; i <= to; i++) a.push(pt(i, at)); return { out: a, back: a.map((x) => ({ ...x })) }; };
  const six = { nearH: 3, midEveryMs: 6 * H - 5 * MIN };
  const hours = (kept) => [...kept.keys()].map((ms) => (ms - h0) / H).sort((a, b) => a - b);

  const { full, light } = CADENCE;
  // Requests a day for one destination on the given cadence, with a run every 15 minutes.
  const perDay = (c) => {
    const live = 2 * (c.liveEveryMs ? (24 * H) / (Math.ceil(c.liveEveryMs / (15 * MIN)) * 15 * MIN) : 96);
    const perHour = c.nearH + Math.ceil((24 - c.nearH) / Math.round(c.midEveryMs / H)); // times one hour is fetched before it passes
    const hourly = 2 * perHour * Math.round((24 * H) / (HOURLY_EVERY_MS + 5 * MIN));
    const long = 2 * ((LONG_TO_H - 24) / LONG_STEP_H + 1) * Math.round((24 * H) / (LONG_EVERY_MS + 5 * MIN));
    return { live, hourly, long, total: live + hourly + long };
  };
  test('Heavenly is refreshed in full, the other two lightly: about 2:1:1', () => {
    assert.deepEqual(DESTINATIONS.map((d) => d.driveRefresh), ['full', 'light', 'light']);
    assert.deepEqual(perDay(full), { live: 192, hourly: 672, long: 170, total: 1034 });
    assert.deepEqual(perDay(light), { live: 96, hourly: 240, long: 170, total: 506 });
    const ratio = perDay(full).total / perDay(light).total;
    assert.ok(ratio > 1.8 && ratio < 2.2, String(ratio));
  });
  test('the three together fit the free daily quota with room to spare', () => {
    const total = DESTINATIONS.reduce((n, d) => n + perDay(cadenceOf(d)).total, 0);
    assert.equal(total, 2046);
    assert.ok(total <= 2500 * 0.85);
  });
  test('a destination with no cadence set gets the light one', () => {
    assert.equal(cadenceOf({}), light);
  });
  test('live times: every run for Heavenly, every other run for the light ones', () => {
    const prev = { at: now - 15 * MIN, out: { sec: 1 }, back: { sec: 2 } };
    assert.equal(keptLive(prev, full, now), null);
    assert.deepEqual(keptLive(prev, light, now), prev);
    assert.equal(keptLive({ ...prev, at: now - 30 * MIN }, light, now), null);
    assert.equal(keptLive(null, light, now), null);
    assert.equal(keptLive({ at: now - 15 * MIN, out: { sec: 1 } }, light, now), null);
  });
  test('the 7-day grid reaches a day past the week, so a day-old one still covers it', () => {
    assert.ok(LONG_TO_H * H - LONG_EVERY_MS >= 167 * H);
  });
  test('no earlier forecast: every hour is fetched', () => {
    assert.equal(keptHours(null, null, h0, now, full).size, 0);
    assert.equal(keptHours({ out: [], back: [] }, 0, h0, now, light).size, 0);
  });
  test('an hour later: the next 3 hours and the new last hour are fetched, the rest kept', () => {
    const prev = series(1 - 1, 22, now - 60 * MIN); // last refresh covered what are now hours -1..22
    assert.deepEqual(hours(keptHours(prev, now - 60 * MIN, h0, now, six)), Array.from({ length: 20 }, (_, i) => i + 3));
  });
  test('a kept hour is fetched again once it is 6 hours old', () => {
    const prev = series(0, 23, now - 5 * H);
    prev.out[10].at = prev.back[10].at = now - 6 * H;
    assert.ok(!keptHours(prev, now - H, h0, now, six).has(h0 + 10 * H));
    assert.equal(keptHours(prev, now - H, h0, now, six).size, 20);
    assert.equal(keptHours(series(0, 23, now - 7 * H), now - H, h0, now, six).size, 0);
  });
  test('Heavenly keeps a later hour for 2 hours, the light destinations for 12', () => {
    assert.equal(keptHours(series(0, 23, now - 90 * MIN), 0, h0, now, full).size, 21);
    assert.equal(keptHours(series(0, 23, now - 2 * H), 0, h0, now, full).size, 0);
    assert.equal(keptHours(series(0, 23, now - 11 * H), 0, h0, now, light).size, 21);
    assert.equal(keptHours(series(0, 23, now - 12 * H), 0, h0, now, light).size, 0);
  });
  test('the older of the two directions decides', () => {
    const prev = series(0, 23, now - H);
    prev.back[12].at = now - 7 * H;
    assert.ok(!keptHours(prev, now - H, h0, now, six).has(h0 + 12 * H));
  });
  test('points saved before each carried its own time are dated by the forecast as a whole', () => {
    assert.equal(keptHours(series(0, 23), now - H, h0, now, six).size, 21);
    assert.equal(keptHours(series(0, 23), now - 7 * H, h0, now, six).size, 0);
    assert.equal(keptHours(series(0, 23), undefined, h0, now, six).size, 0);
  });
  test('an hour missing one direction, or saved without pass-through times, is fetched', () => {
    const prev = series(0, 23, now - H);
    prev.back.splice(8, 1);
    delete prev.out[15].stops;
    const kept = keptHours(prev, now - H, h0, now, six);
    assert.ok(!kept.has(h0 + 8 * H) && !kept.has(h0 + 15 * H));
    assert.equal(kept.size, 19);
  });
});

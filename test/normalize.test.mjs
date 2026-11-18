// Reading the Caltrans chain-control feed and the direction of CHP incidents (js/normalize.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chainLevel, normalizeChain, incidentDir } from '../js/normalize.js';

describe('chain-control level', () => {
  test('R levels, however Caltrans writes them', () => {
    assert.equal(chainLevel('R-1'), 1);
    assert.equal(chainLevel('R2'), 2);
    assert.equal(chainLevel('r-3'), 3);
    assert.equal(chainLevel('R-0'), 0);
  });
  test('closed, from the status or its description', () => {
    assert.equal(chainLevel('Closed'), 4);
    assert.equal(chainLevel('', 'ROAD CLOSED DUE TO SNOW'), 4);
  });
  test('anything else is unknown, not "no chains needed"', () => {
    assert.equal(chainLevel(''), -1);
    assert.equal(chainLevel(undefined), -1);
    assert.equal(chainLevel('Not Reported'), -1);
  });
});

describe('chain-control feed', () => {
  const row = (o = {}) => ({
    cc: {
      inService: o.inService ?? 'true',
      location: { route: o.route ?? 'US-50', locationName: o.name ?? 'Twin Bridges', nearbyPlace: 'Twin Bridges', direction: o.dir ?? 'East', milepost: '57.3', latitude: '38.81', longitude: o.lon ?? '-120.12', elevation: '6100' },
      statusData: { status: o.status ?? 'R-2', statusDescription: o.desc ?? 'Chains required', statusTimestamp: { statusDate: '2026-01-13', statusTime: '05:42:00' } },
    },
  });
  test('keeps the wanted highways and reads each record', () => {
    const out = normalizeChain({ data: [row(), row({ route: 'SR-20' })] }, ['US-50', 'I-80']);
    assert.equal(out.length, 1);
    assert.deepEqual(
      { hw: out[0].hw, name: out[0].name, dir: out[0].dir, level: out[0].level, lat: out[0].lat, lon: out[0].lon, elevFt: out[0].elevFt, at: out[0].at },
      { hw: 'US-50', name: 'Twin Bridges', dir: 'East', level: 2, lat: 38.81, lon: -120.12, elevFt: 6100, at: '2026-01-13 05:42' },
    );
  });
  test('a station listed twice keeps its stricter reading; each direction is its own record', () => {
    const out = normalizeChain({ data: [row({ status: 'R-1' }), row({ status: 'R-3' }), row({ status: 'R-2' }), row({ dir: 'West', status: 'R-1' })] }, ['US-50']);
    assert.deepEqual(out.map((r) => [r.dir, r.level]).sort(), [['East', 3], ['West', 1]]);
  });
  test('stations out of service are dropped', () => {
    assert.equal(normalizeChain({ data: [row({ inService: 'false' })] }, ['US-50']).length, 0);
  });
  test('sorted by highway, then west to east', () => {
    const out = normalizeChain({ data: [row({ name: 'b', lon: '-120.0' }), row({ route: 'I-80', name: 'c' }), row({ name: 'a', lon: '-120.5' })] }, ['US-50', 'I-80']);
    assert.deepEqual(out.map((r) => r.name), ['c', 'a', 'b']);
  });
  test('an empty or broken feed gives no records rather than throwing', () => {
    assert.deepEqual(normalizeChain(null, ['US-50']), []);
    assert.deepEqual(normalizeChain({ data: [{}, { cc: {} }] }, ['US-50']), []);
  });
});

describe('direction of a CHP incident', () => {
  const dirs = ['East', 'West'];
  const dir = (loc, desc = '') => incidentDir(loc, desc, '50', dirs);
  test('from the location: "Us50 E / Sly Park Rd"', () => {
    assert.equal(dir('Us50 E / Sly Park Rd'), 'East');
    assert.equal(dir('Us50 W / Echo Summit'), 'West');
    assert.equal(dir('US50 W'), 'West');
  });
  test('from the description: "WB 50 JEO ...", "EB US-50", "50 WB"', () => {
    assert.equal(dir('Echo Summit', 'WB 50 JEO Echo Summit'), 'West');
    assert.equal(dir('Kyburz', 'EB US-50 at Kyburz'), 'East');
    assert.equal(dir('Kyburz', 'on 50 WB near Kyburz'), 'West');
  });
  test('on the highway with the description starting "EB ..."', () => {
    assert.equal(dir('Us50 / Ice House Rd', 'EB JWO Ice House'), 'East');
  });
  test('not stated: empty, which counts for both directions', () => {
    assert.equal(dir('Us50 / Ice House Rd', 'vehicle in the snow bank'), '');
    assert.equal(dir('', ''), '');
    assert.equal(dir(undefined, undefined), '');
  });
  test('another highway is not mistaken for this one', () => {
    assert.equal(dir('Sr150 E / Main St'), '');
    assert.equal(dir('Main St', 'WB 150 at Main'), '');
    assert.equal(dir('Sr89 N / Us50', 'NB 89'), '');
  });
  test('a direction the route does not have is not returned', () => {
    assert.equal(dir('Us50 N / Somewhere'), '');
  });
});

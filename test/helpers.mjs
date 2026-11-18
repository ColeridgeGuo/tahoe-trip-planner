// Shared fixtures: a quiet, fully-fetched data file in the shape scripts/fetch.mjs writes, to be bent per test.
import { DESTINATIONS, DEFAULT_VEHICLE } from '../js/config.js';

export const dest = DESTINATIONS[0];
export const route = dest.route;
export const H = 36e5;
export const MIN = 6e4;
export const T0 = Date.UTC(2026, 0, 13, 8); // Tue 13 Jan 2026, 00:00 Pacific
export const NOW = T0 + 6 * H; // 06:00 Pacific
export const AWD = { ...DEFAULT_VEHICLE, drive: 'awd', snowTires: true, chains: true, ev: false };
export const timed = route.points.filter((p) => p.offsetH != null); // the order of every `stops` array
export const stopIdx = (id) => timed.findIndex((p) => p.id === id);
export const hourIdx = (ms) => Math.round((ms - T0) / H);

const quiet = { temp: 5, feels: 3, wind: 8, gust: 15, pop: 0, sky: 20, qpf: 0, snow: 0, snowLevel: 2500 };
export function makeData(over = {}) {
  const weather = {};
  for (const p of route.points) {
    weather[p.id] = { at: NOW, elevM: 1000 };
    for (const [k, v] of Object.entries(quiet)) weather[p.id][k] = new Array(168).fill(v);
  }
  const status = {};
  for (const k of ['chain', 'cams', 'closures', 'incidents', 'alerts', 'weather']) status[k] = { ok: true, at: NOW };
  return { generatedAt: NOW, t0: T0, hours: 168, status, chain: [], closures: [], incidents: [], alerts: [], cams: [], weather, drive: null, ...over };
}
// Marks a source as failed on the last refresh; with `dataAt` it still carries data fetched at that time.
export function fail(data, key, dataAt) {
  data.status[key] = { ok: false, error: 'HTTP 503', at: NOW, ...(dataAt != null ? { dataAt } : {}) };
  return data;
}
export const factor = (ev, key) => ev.factors.find((f) => f.key === key);
export const chainRow = (level, dir = 'East', hw = route.highway) => ({ hw, name: `cc ${hw} ${dir}`, dir, level, status: level > 0 ? `R-${level}` : '' });
export const closure = (over = {}) => ({ from: 'Twin Bridges', to: 'Meyers', dir: 'East', type: 'Full', facility: 'Mainline', start: NOW - H, end: NOW + 8 * H, delayMin: 0, ...over });
export const incident = (over = {}) => ({ id: '1', time: NOW - 10 * MIN, type: 'Traffic Collision', loc: 'Us50 E / Sly Park Rd', desc: '', dir: 'East', ...over });
// A live TomTom reading taken just now. `stops` is in route order (west to east) for both directions.
export const liveDrive = (over = {}) => ({ at: NOW - 5 * MIN, out: { sec: 13500, noTrafficSec: 13000, historicSec: 13400 }, back: { sec: 13500, noTrafficSec: 13000, historicSec: 13400 }, hourly: { out: [], back: [] }, long: { out: [], back: [] }, ...over });

// Pure helpers for scripts/fetch.mjs: no network, no files, so they can be tested (test/fetch-lib.test.mjs).
export const HOURS = 168;
export const MAX_CARRY_MS = 24 * 36e5; // older than this, a carried-over source is dropped rather than shown

// ---------- carrying over the last good data ----------
// Last good data for a source and when it was fetched, if the previous file has any that is recent enough.
export function carried(prev, key, nowMs = Date.now()) {
  const s = prev?.status?.[key];
  const dataAt = s?.ok ? s.at : s?.dataAt;
  return dataAt && prev[key] != null && nowMs - dataAt < MAX_CARRY_MS ? { value: prev[key], dataAt } : null;
}

// Each source records ok/error. On failure the last good data is carried over and status.dataAt says how old
// it is, so the UI can show its age; with nothing to carry over the UI says "couldn't confirm".
export async function source(status, key, fn, fallback, prev, nowMs) {
  const now = () => nowMs ?? Date.now();
  try {
    const v = await fn();
    status[key] = { ok: true, at: now() };
    return v;
  } catch (e) {
    console.error(`[${key}] ${e.message}`);
    const c = carried(prev, key, now());
    status[key] = { ok: false, error: String(e.message).slice(0, 200), at: now(), ...(c ? { dataAt: c.dataAt } : {}) };
    if (c) console.error(`[${key}] carrying over data from ${Math.round((now() - c.dataAt) / 6e4)} min ago`);
    return c ? c.value : fallback;
  }
}

// Hourly arrays start at the file's t0, so a forecast carried over from an earlier file is slid forward.
export function shiftWeather(w, shift) {
  const out = { ...w };
  for (const [k, v] of Object.entries(w)) if (Array.isArray(v)) out[k] = Array.from({ length: HOURS }, (_, i) => v[i + shift] ?? null);
  return out;
}
// A forecast point whose fetch failed keeps its last good forecast from the previous file, re-aligned to the
// new t0 and marked `carried`. Null when there is none or it is too old.
export function carriedWeather(prev, id, t0, nowMs = Date.now()) {
  const old = prev?.weather?.[id];
  const oldAt = old?.at ?? (prev?.status?.weather?.ok ? prev.generatedAt : null);
  if (!old || !oldAt || nowMs - oldAt >= MAX_CARRY_MS) return null;
  return { ...shiftWeather(old, Math.round((t0 - prev.t0) / 36e5)), at: oldAt, carried: true };
}

// ---------- NWS ----------
function durH(iso) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(iso);
  return (+m[1] || 0) * 24 + (+m[2] || 0);
}
// Expand NWS interval series to one value per hour. Accumulated fields are spread evenly over the interval.
export function hourly(series, t0, accumulate) {
  const out = new Array(HOURS).fill(null);
  for (const v of series?.values || []) {
    const [start, d] = v.validTime.split('/');
    const h = Math.max(1, durH(d));
    const s = Math.round((Date.parse(start) - t0) / 36e5);
    const val = v.value == null ? null : accumulate ? v.value / h : v.value;
    for (let i = Math.max(0, s); i < Math.min(HOURS, s + h); i++) out[i] = val == null ? null : Math.round(val * 100) / 100;
  }
  return out;
}

// ---------- CHP ----------
// CHP times are Pacific wall-clock; resolve to an epoch without a tz library.
export function ptToMs(str) {
  const m = /(\w{3}) +(\d+) +(\d{4}) +(\d+):(\d+)(AM|PM)/.exec(str);
  if (!m) return null;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
  let h = +m[4] % 12;
  if (m[6] === 'PM') h += 12;
  const guess = Date.UTC(+m[3], mon, +m[2], h, +m[5]);
  for (const off of [8, 7]) {
    const ms = guess + off * 36e5;
    const hh = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(ms);
    if (hh === h) return ms;
  }
  return guess + 8 * 36e5;
}

// Which of the route's roads a CHP log is on, and which way it faces there. `roads` come from roadsOf() in
// js/logic.js; `mainMatch` is the pattern for the main highway (feeds.incidentMatch), the others are matched by
// their number. `dirOf` is incidentDir() from js/normalize.js. Null when the log names none of them.
export function incidentRoad(loc, desc, roads, mainMatch, dirOf) {
  for (const [i, road] of roads.entries()) {
    const num = road.highway.replace(/\D/g, '');
    const re = new RegExp(i === 0 && mainMatch ? mainMatch : `(^|[^0-9])${num}([^0-9]|$)`, 'i');
    if (!re.test(loc) && !re.test(desc)) continue;
    return { hw: road.highway, dir: dirOf(loc, desc, num, [road.outboundDir, road.returnDir]) };
  }
  return null;
}

// ---------- TomTom ----------
// How often drive times are refreshed. Three destinations share one free daily quota (2,500 requests), split
// about 2:1:1: the destination marked `driveRefresh: 'full'` in js/config.js is refreshed more often than
// the ones marked 'light'. Only what actually moves is fetched often. Per destination, per day:
//                                                                                   full   light
//   live     both ways, on every run (96 a day) / on every other run                 192      96
//   hourly   the next 24 h, one point an hour. The first `nearH` hours follow current
//            traffic and are fetched again every hour; later hours come from TomTom's
//            historic profiles and are fetched again only when `midEveryMs` old (2 h /
//            12 h). An hour is fetched 14 / 5 times before it passes, both ways       672     240
//   long     hours 24-192, every 2 h, once a day: 85 x 2                              170     170
//                                                                                   1,034     506
// One full and two light destinations: about 2,050 a day.
export const CADENCE = {
  full: { liveEveryMs: 0, nearH: 3, midEveryMs: 2 * 36e5 - 5 * 6e4 },
  light: { liveEveryMs: 25 * 6e4, nearH: 3, midEveryMs: 12 * 36e5 - 5 * 6e4 },
};
export const cadenceOf = (dest) => CADENCE[dest.driveRefresh] || CADENCE.light;
export const HOURLY_EVERY_MS = 55 * 6e4;
export const LONG_EVERY_MS = 24 * 36e5 - 5 * 6e4;
export const LONG_STEP_H = 2;
export const LONG_TO_H = 192; // a day past the 7 the page shows, so a day-old forecast still covers them
// The live reading of the last run, if this destination does not need a new one yet.
export function keptLive(prev, cadence, nowMs) {
  return cadence.liveEveryMs && prev?.out?.sec && prev?.back?.sec && nowMs - prev.at < cadence.liveEveryMs ? { at: prev.at, out: prev.out, back: prev.back } : null;
}
// For an hourly refresh starting at hour `h0`: the points of the last forecast that can be kept, by time.
// Every hour not in the result has to be fetched. `prevAt` dates points saved before each carried its own time.
export function keptHours(prev, prevAt, h0, nowMs, cadence) {
  const kept = new Map();
  const back = new Map((prev?.back || []).map((x) => [x.ms, x]));
  for (const out of prev?.out || []) {
    const b = back.get(out.ms);
    if (!b || !out.stops || !b.stops || out.ms < h0 + cadence.nearH * 36e5) continue;
    if (nowMs - Math.min(out.at ?? prevAt ?? 0, b.at ?? prevAt ?? 0) >= cadence.midEveryMs) continue;
    kept.set(out.ms, { out, back: b });
  }
  return kept;
}
const STOP_MAX_KM = 5; // a point further than this from the route TomTom chose is not timed
function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  return 6371 * Math.hypot((bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r), (bLat - aLat) * r);
}
// When the drive reaches each timed route point, in seconds after departure, read off the route TomTom
// returned. `way` are the waypoints the route was requested through, in travel order; `timed` are the points
// to time (any order). The result lines up with `timed`; null where it cannot be told.
//   - a waypoint: the sum of the legs before it (exact);
//   - any other point: the place where the route passes closest to it, timed from the route's progress
//     markers (TomTom's `progress`: travel time at some of the polyline points), interpolated by distance.
// This times places like Sacramento without making them waypoints, so the route itself is left to TomTom.
export function stopTimes(route, way, timed) {
  const legs = route.legs || [];
  const atWay = new Map();
  let sum = 0;
  way.forEach((p, i) => {
    if (i > 0) sum += legs[i - 1]?.summary?.travelTimeInSeconds ?? NaN;
    atWay.set(p.id, sum);
  });
  const line = legs.flatMap((l) => l.points || []);
  const prog = (route.progress || []).filter((x) => Number.isFinite(x.travelTimeInSeconds));
  const dist = [0]; // metres-ish along the polyline, only used for ratios
  for (let i = 1; i < line.length; i++) dist.push(dist[i - 1] + km(line[i - 1].latitude, line[i - 1].longitude, line[i].latitude, line[i].longitude));
  return timed.map((p) => {
    if (atWay.has(p.id)) return Number.isFinite(atWay.get(p.id)) ? Math.round(atWay.get(p.id)) : null;
    if (line.length < 2 || prog.length < 2) return null;
    let best = Infinity;
    let at = -1;
    line.forEach((q, i) => {
      const d = km(p.lat, p.lon, q.latitude, q.longitude);
      if (d < best) { best = d; at = i; }
    });
    if (best > STOP_MAX_KM) return null;
    const j = prog.findIndex((x) => x.pointIndex >= at);
    if (j < 0) return null;
    const b = prog[j];
    const a = j > 0 ? prog[j - 1] : b;
    const span = dist[b.pointIndex] - dist[a.pointIndex];
    const f = span > 0 ? (dist[at] - dist[a.pointIndex]) / span : 0;
    return Math.round(a.travelTimeInSeconds + (b.travelTimeInSeconds - a.travelTimeInSeconds) * f);
  });
}

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

// Snowfall for the hours just before the file's first hour, oldest first, taken from the previous file (its own
// past hours, then its forecast). The page uses it to tell that snow is still lying on the road after a storm
// has ended. Null where the previous file does not reach.
export const PAST_H = 24;
export function pastSnow(prev, id, t0) {
  const out = new Array(PAST_H).fill(null);
  const old = prev?.weather?.[id];
  if (!old?.snow || !Number.isFinite(prev.t0)) return out;
  const shift = Math.round((t0 - prev.t0) / 36e5);
  const before = old.snowPast || [];
  for (let j = 0; j < PAST_H; j++) {
    const k = shift - PAST_H + j; // this hour's index in the previous file; negative = before its first hour
    out[j] = (k >= 0 ? old.snow[k] : before[before.length + k]) ?? null;
  }
  return out;
}

// ---------- what actually happened ----------
// One row per hour: the strictest chain control seen on the route highway each way during that hour, next to
// the snowfall rate and temperature forecast for that hour at the mountain points. Published as
// data/history.json so the snow thresholds in js/logic.js can be checked against real storms.
//   t: start of the hour; e / w: highest level eastbound / westbound (0 none, 1-3 R level, 4 closed, null: feed failed)
//   s / c: mm of snow per hour and °C at `points`, in that order
//   d: the live TomTom drive time out / back in seconds, and m: of that, the minutes on the mountain section
//      (between the first route pin and the town), the longest seen in the hour. For working out how much
//      snow and chain control really add to the drive. Absent on rows from before these were kept.
export const HISTORY_MAX = 24 * 60; // about two months
export function addHistory(hist, row, points) {
  const rows = Array.isArray(hist?.rows) ? hist.rows : [];
  const same = rows.find((r) => r.t === row.t);
  const hi = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
  const his = (a, b) => (a || b ? [0, 1].map((i) => hi(a?.[i] ?? null, b?.[i] ?? null)) : undefined);
  const merged = same ? { ...row, e: hi(same.e, row.e), w: hi(same.w, row.w), ...(same.d || row.d ? { d: his(same.d, row.d), m: his(same.m, row.m) } : {}) } : row;
  return { v: 1, points, rows: [...rows.filter((r) => r.t !== row.t), merged].sort((a, b) => a.t - b.t).slice(-HISTORY_MAX) };
}

// ---------- TomTom quota ----------
// The free allowance for the Routing API is 20,000 requests a month (about 645 a day). Only what actually
// moves is fetched often. With a run every 15 minutes, a day costs:
//   live     both ways, on every other run                                             96
//   hourly   the next 24 h, one point an hour. The first NEAR_H hours follow current
//            traffic and are fetched again every hour; later hours come from TomTom's
//            historic profiles and are fetched again only when MID_EVERY_MS old. An
//            hour is fetched 5 times before it passes, both ways                      240
//   long     hours 24-192, every 2 h, once a day: 85 x 2                              170
//                                                                                     506
// About 15,700 in a 31-day month, which leaves a fifth of the allowance for retries and extra runs.
export const MONTHLY_QUOTA = 20000;
export const LIVE_EVERY_MS = 25 * 6e4;
export const NEAR_H = 3;
export const MID_EVERY_MS = 12 * 36e5 - 5 * 6e4;
export const HOURLY_EVERY_MS = 55 * 6e4;
export const LONG_EVERY_MS = 24 * 36e5 - 5 * 6e4;
export const LONG_STEP_H = 2;
export const LONG_TO_H = 192; // a day past the 7 the page shows, so a day-old forecast still covers them
// The live reading of the last run, if a new one is not due yet.
export function keptLive(prev, nowMs) {
  return prev?.out?.sec && prev?.back?.sec && nowMs - prev.at < LIVE_EVERY_MS ? { at: prev.at, out: prev.out, back: prev.back } : null;
}
// For an hourly refresh starting at hour `h0`: the points of the last forecast that can be kept, by time.
// Every hour not in the result has to be fetched. `prevAt` dates points saved before each carried its own time.
export function keptHours(prev, prevAt, h0, nowMs) {
  const kept = new Map();
  const back = new Map((prev?.back || []).map((x) => [x.ms, x]));
  for (const out of prev?.out || []) {
    const b = back.get(out.ms);
    if (!b || !out.stops || !b.stops || out.ms < h0 + NEAR_H * 36e5) continue;
    if (nowMs - Math.min(out.at ?? prevAt ?? 0, b.at ?? prevAt ?? 0) >= MID_EVERY_MS) continue;
    kept.set(out.ms, { out, back: b });
  }
  return kept;
}
// Requests sent so far today and this month, carried from run to run, and yesterday's total once the day
// turns. Days and months are UTC. The month's count starts when this was first deployed, so the first
// month reads low.
export function quotaUsed(prev, calls, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const monthN = (prev?.month === month ? prev.monthN : 0) + calls;
  if (prev?.day === day) return { ...prev, n: prev.n + calls, month, monthN };
  return { day, n: calls, month, monthN, ...(prev?.day ? { prev: { day: prev.day, n: prev.n } } : {}) };
}

// ---------- Caltrans ----------
// The camera feed's live-stream address, cleaned up. Caltrans writes a few of them with the ".stream" part
// twice (the Forni Rd cameras), and that address answers 404; the single form plays.
export const streamUrl = (raw) => String(raw || '').trim().replace(/(\.stream)+\/playlist\.m3u8$/, '.stream/playlist.m3u8');

// Drops the live-stream address of cameras that have no stream (the feed lists one anyway and it answers
// 404), so the page does not offer it. The stream host also refuses requests for streams that do exist with
// 403, about one in three and more when many arrive together, so a 403 says nothing and is asked again; a
// camera that is still refused after STREAM_TRIES keeps its address, and the page's player retries by itself.
// probe(url) resolves to the HTTP status (0 = no answer).
export const STREAM_TRIES = 4;
export async function liveStreams(cams, probe) {
  return Promise.all(cams.map(async (c) => {
    for (let i = 0; c.stream && i < STREAM_TRIES; i++) {
      const code = await probe(c.stream);
      if (code === 200) break;
      if (code === 404) return { ...c, stream: '' };
    }
    return c;
  }));
}

// The lane-closure feed lists some closures twice; keep one of each.
export function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    const k = JSON.stringify(c);
    return seen.has(k) ? false : (seen.add(k), true);
  });
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

// ---------- TomTom ----------
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

// Pulls official feeds (Caltrans, CHP, NWS) and writes one slim JSON per destination.
// Node 22+, no dependencies. Run: node scripts/fetch.mjs
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { DESTINATIONS } from '../js/config.js';
import { CC_URL, normalizeChain, incidentDir } from '../js/normalize.js';
import { HOURS, source, carriedWeather, hourly, ptToMs, stopTimes, pastSnow, addHistory, quotaUsed, dedupe } from './lib.mjs';
import { chainFor } from '../js/logic.js';

const UA = 'tahoe-trip-planner (personal trip dashboard, github pages)';
const pad = (d) => String(d).padStart(2, '0');

async function get(url, { json = true, tries = 3, accept } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) {
      err = e;
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${err.message}`);
}

// The file published by the previous run (or left by a local run). A source that fails this time keeps
// its last good data from here instead of going empty.
// (How it is carried over: source() and carriedWeather() in ./lib.mjs.)
async function previous(dest) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  try {
    if (owner) return await get(`https://${owner.toLowerCase()}.github.io/${repo}/data/${dest.id}.json`, { tries: 1 });
  } catch { /* first run or site unreachable */ }
  try {
    return JSON.parse(await readFile(new URL(`../data/${dest.id}.json`, import.meta.url), 'utf8'));
  } catch { return null; }
}
// The hourly record of real chain control published by the previous run (see addHistory in ./lib.mjs).
async function previousHistory() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (owner) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`https://${owner.toLowerCase()}.github.io/${repo}/data/history.json?ts=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
        if (r.ok) return await r.json();
        if (r.status === 404) return null;
      } catch { /* retry */ }
      await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
    }
    console.error('[history] previous record unreachable, starting a new one');
    return null;
  }
  try {
    return JSON.parse(await readFile(new URL('../data/history.json', import.meta.url), 'utf8'));
  } catch { return null; }
}
// ---------- Caltrans ----------
async function chain(feeds) {
  const all = [];
  for (const d of feeds.ccDistricts) all.push(...normalizeChain(await get(CC_URL(d)), feeds.chainHighways));
  return all;
}

async function cams(feeds) {
  const out = [];
  for (const d of feeds.cctvDistricts) {
    const j = await get(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${pad(d)}.json`);
    for (const { cctv: c } of j.data) {
      const l = c.location;
      if (l.route !== feeds.camHighway || c.inService !== 'true' || +l.longitude < feeds.camLonMin) continue;
      const img = c.imageData?.static?.currentImageURL;
      if (!img) continue;
      out.push({
        name: l.locationName.replace(/^Hwy \d+ at /i, '').replace(/_/g, ' '),
        place: l.nearbyPlace,
        lat: +l.latitude,
        lon: +l.longitude,
        elevFt: +l.elevation || null,
        img,
        stream: c.imageData.streamingVideoURL || '',
      });
    }
  }
  return out.sort((a, b) => a.lon - b.lon);
}

async function closures(feeds, hw) {
  const now = Date.now();
  const out = [];
  for (const d of feeds.lcsDistricts) {
    const j = await get(`https://cwwp2.dot.ca.gov/data/d${d}/lcs/lcsStatusD${pad(d)}.json`);
    for (const { lcs: c } of j.data) {
      const b = c.location.begin;
      const e = c.location.end;
      if (b.beginRoute !== hw) continue;
      const k = c.closure;
      const t = k.closureTimestamp;
      const start = +t.closureStartEpoch * 1000;
      const indefinite = t.isClosureEndIndefinite === 'true';
      const end = indefinite ? null : +t.closureEndEpoch * 1000;
      if (k.code1098?.isCode1098 === 'true') continue; // crew reported finished
      if ((end && end < now) || start > now + 8 * 864e5) continue;
      out.push({
        from: b.beginLocationName,
        to: e.endLocationName,
        place: b.beginNearbyPlace,
        lat: +b.beginLatitude,
        lon: +b.beginLongitude,
        endLat: +e.endLatitude,
        endLon: +e.endLongitude,
        dir: c.location.travelFlowDirection,
        type: k.typeOfClosure,
        work: k.typeOfWork,
        facility: k.facility,
        start,
        end,
        delayMin: +k.estimatedDelay || 0,
        lanes: +k.lanesClosed || 0,
        total: +k.totalExistingLanes || 0,
        onSite: k.code1097?.isCode1097 === 'true',
      });
    }
  }
  return dedupe(out).sort((a, b) => a.start - b.start || a.lon - b.lon);
}

// ---------- CHP ----------
const unq = (s) => (s || '').replace(/^"|"$/g, '').trim();
const tag = (x, t) => unq((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x) || [])[1]);
async function incidents(feeds, route) {
  const xml = await get('https://media.chp.ca.gov/sa_xml/sa.xml', { json: false });
  const re = new RegExp(feeds.incidentMatch, 'i');
  const box = feeds.incidentBox;
  const hwNum = route.highway.replace(/\D/g, '');
  const dirs = [route.outboundDir, route.returnDir];
  const out = [];
  for (const log of xml.split('<Log ').slice(1)) {
    const ll = /(\d+):(\d+)/.exec(tag(log, 'LATLON'));
    if (!ll) continue;
    const lat = +ll[1] / 1e6;
    const lon = -ll[2] / 1e6;
    if (lat < box.latMin || lat > box.latMax || lon < box.lonMin || lon > box.lonMax) continue;
    const loc = tag(log, 'Location');
    const desc = tag(log, 'LocationDesc');
    if (!re.test(loc) && !re.test(desc)) continue;
    const details = [...log.matchAll(/<IncidentDetail>([\s\S]*?)<\/IncidentDetail>/g)].map((m) => unq(m[1]).replace(/^\[\d+\]\s*/, ''));
    out.push({
      id: (/ID = "([^"]+)"/.exec(log) || [])[1],
      time: ptToMs(tag(log, 'LogTime')),
      type: tag(log, 'LogType').replace(/^\w+-/, ''),
      loc,
      desc,
      dir: incidentDir(loc, desc, hwNum, dirs),
      area: tag(log, 'Area'),
      lat,
      lon,
      details: details.slice(-3),
    });
  }
  return out.sort((a, b) => a.lon - b.lon);
}

// ---------- NWS ----------
async function nwsPoint(p, t0) {
  const meta = await get(`https://api.weather.gov/points/${p.lat},${p.lon}`, { accept: 'application/geo+json' });
  const g = (await get(meta.properties.forecastGridData, { accept: 'application/geo+json', tries: 4 })).properties;
  return {
    at: Date.now(),
    elevM: g.elevation?.value ?? null,
    office: meta.properties.gridId,
    updated: g.updateTime,
    temp: hourly(g.temperature, t0),
    feels: hourly(g.apparentTemperature, t0),
    wind: hourly(g.windSpeed, t0),
    gust: hourly(g.windGust, t0),
    pop: hourly(g.probabilityOfPrecipitation, t0),
    sky: hourly(g.skyCover, t0),
    qpf: hourly(g.quantitativePrecipitation, t0, true),
    snow: hourly(g.snowfallAmount, t0, true),
    snowLevel: hourly(g.snowLevel, t0),
  };
}
async function alerts(points) {
  const seen = new Map();
  for (const p of points) {
    const j = await get(`https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`, { accept: 'application/geo+json' });
    for (const f of j.features || []) {
      const a = f.properties;
      seen.set(a.id, {
        id: a.id,
        event: a.event,
        severity: a.severity,
        headline: a.headline,
        onset: Date.parse(a.onset || a.effective),
        ends: Date.parse(a.ends || a.expires),
        desc: (a.description || '').slice(0, 1200),
        url: `https://forecast.weather.gov/MapClick.php?lat=${p.lat}&lon=${p.lon}`,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.onset - b.onset);
}

// ---------- TomTom drive times ----------
// The key comes from the TOMTOM_KEY secret. Errors are built without the request URL so the key can never
// end up in the published JSON or the logs.
const TT_KEY = process.env.TOMTOM_KEY || '';
let ttCalls = 0; // requests sent on this run, retries included: each one counts against the daily quota
// `timed` are the route points whose pass-through time is read off the returned route (stopTimes in ./lib.mjs).
// That needs the route's polyline and progress markers, so the response is the full route, not just a summary.
async function ttRoute(points, departMs, timed = []) {
  const locs = points.map((p) => `${p.lat},${p.lon}`).join(':');
  const q = new URLSearchParams({ key: TT_KEY, traffic: 'true', travelMode: 'car', routeType: 'fastest', computeTravelTimeFor: 'all', routeRepresentation: 'polyline', extendedRouteRepresentation: 'travelTime' });
  if (departMs) q.set('departAt', new Date(departMs).toISOString().replace(/\.\d+Z$/, 'Z'));
  let last = 'no response';
  for (let i = 0; i < 3; i++) {
    try {
      ttCalls++;
      const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?${q}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const route = (await r.json()).routes?.[0];
        const m = route?.summary;
        if (!m?.travelTimeInSeconds) throw new Error('no route in response');
        const legs = (route.legs || []).map((l) => ({ km: Math.round(l.summary.lengthInMeters / 100) / 10, min: Math.round(l.summary.travelTimeInSeconds / 60) }));
        return { sec: m.travelTimeInSeconds, noTrafficSec: m.noTrafficTravelTimeInSeconds ?? null, historicSec: m.historicTrafficTravelTimeInSeconds ?? null, km: Math.round(m.lengthInMeters / 1000), legs, stops: stopTimes(route, points, timed) };
      }
      last = `HTTP ${r.status} ${(await r.text()).replaceAll(TT_KEY, '***').slice(0, 160)}`;
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = String(e.message).replaceAll(TT_KEY, '***');
    }
    await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
  }
  throw new Error(`TomTom routing: ${last}`);
}
// Live drive time both ways on every run. Forecasts are refreshed far less often and otherwise carried over from
// the previously published file, to stay well inside the free daily quota (2,500 requests):
//   live     2 requests x 96 runs a day                       = 192
//   hourly   next 24 h, every hour, refreshed hourly: 48 x 24 = 1,152
//   long     hours 24-168, every 2 h, refreshed every 12 h: 146 x 2 = 292
// About 1,640 a day for one destination. Beyond a day TomTom predicts from its historic weekly traffic
// profiles, which do not move between runs, so a coarse grid refreshed twice a day loses nothing.
const HOURLY_EVERY_MS = 55 * 6e4;
const LONG_EVERY_MS = 12 * 36e5 - 5 * 6e4;
const LONG_RETRY_MS = 60 * 6e4; // after a failed long refresh, wait this long rather than retrying every run
const LONG_STEP_H = 2;
const LONG_TO_H = 168;
async function drive(dest, prevFile) {
  const pt = (id) => dest.route.points.find((p) => p.id === id);
  const way = [dest.route.points[0], ...dest.route.drivePins.map(pt), pt(dest.route.townPoint)];
  const dirs = { out: way, back: [...way].reverse() };
  // The points the page shows conditions for, in route order (west to east). Every drive time carries
  // `stops`: seconds from departure to each of them, in this order whichever way the trip goes.
  const timed = dest.route.points.filter((p) => p.offsetH != null);
  const res = { at: Date.now() };
  for (const [k, pts] of Object.entries(dirs)) {
    res[k] = await ttRoute(pts, null, timed);
    console.log(`drive ${k}: ${res[k].km} km, legs ${pts.map((p) => p.id).join(' > ')}: ${res[k].legs.map((l) => `${l.km}km/${l.min}min`).join(', ')}; reaches ${timed.map((p, i) => `${p.id} ${res[k].stops[i] == null ? '?' : Math.round(res[k].stops[i] / 60)}min`).join(', ')}`);
  }
  const prev = prevFile?.drive;
  const h0 = Math.ceil(Date.now() / 36e5) * 36e5;
  // Fills `into` for the given hour offsets; a failure throws and leaves the hours fetched so far in place.
  const forecast = async (into, offsets) => {
    for (const i of offsets) {
      for (const [k, pts] of Object.entries(dirs)) {
        const r = await ttRoute(pts, h0 + i * 36e5, timed);
        into[k].push({ ms: h0 + i * 36e5, sec: r.sec, noTrafficSec: r.noTrafficSec, stops: r.stops });
      }
    }
  };
  const errors = [];
  // A forecast saved before per-point times existed is refreshed now rather than when it falls due.
  const timedIn = (x) => !!x?.out?.[0]?.stops;
  if (timedIn(prev?.hourly) && Date.now() - prev.hourlyAt < HOURLY_EVERY_MS) {
    res.hourlyAt = prev.hourlyAt;
    res.hourly = prev.hourly;
  } else {
    const hourly = { out: [], back: [] };
    try {
      await forecast(hourly, Array.from({ length: 24 }, (_, i) => i));
      res.hourly = hourly;
      res.hourlyAt = Date.now();
    } catch (e) {
      // A failed forecast request must not throw away the live times above. Keep the last forecast (or the
      // hours fetched so far) and leave hourlyAt old so the next run tries again.
      console.error(`[drive] hourly forecast: ${e.message}`);
      errors.push(`hourly: ${e.message}`);
      res.hourly = prev?.hourly || hourly;
      res.hourlyAt = prev?.hourly ? prev.hourlyAt : 0;
    }
  }
  // Days 2-7 on a coarser grid. The page joins this onto the end of the hourly series.
  // The hold-off after a failed refresh (longTriedAt) applies whether or not the saved forecast has per-point times.
  const holdOff = Date.now() - (prev?.longTriedAt || 0) < LONG_RETRY_MS;
  if (prev?.long && (holdOff || (timedIn(prev.long) && Date.now() - prev.longAt < LONG_EVERY_MS))) {
    res.longAt = prev.longAt;
    res.long = prev.long;
    if (holdOff) res.longTriedAt = prev.longTriedAt;
  } else if (errors.length) {
    // TomTom is already failing on this run; do not spend more requests on it.
    res.long = prev?.long || { out: [], back: [] };
    res.longAt = prev?.long ? prev.longAt : 0;
  } else {
    const long = { out: [], back: [] };
    const offsets = [];
    for (let i = 24; i <= LONG_TO_H; i += LONG_STEP_H) offsets.push(i);
    try {
      await forecast(long, offsets);
      res.long = long;
      res.longAt = Date.now();
    } catch (e) {
      // Keep whichever reaches further, the last long forecast or the part fetched now, and stamp it so the
      // next attempt is an hour away: a request that keeps failing must not burn the quota every 15 minutes.
      console.error(`[drive] long forecast: ${e.message}`);
      errors.push(`long: ${e.message}`);
      const end = (x) => x?.out?.at(-1)?.ms || 0;
      res.long = end(prev?.long) >= end(long) ? prev?.long || long : { out: long.out.slice(0, long.back.length), back: long.back };
      res.longAt = Date.now() - LONG_EVERY_MS + LONG_RETRY_MS;
      res.longTriedAt = Date.now();
    }
  }
  if (errors.length) res.hourlyError = errors.join('; ').slice(0, 200);
  return res;
}

// ---------- main ----------
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
let history = await previousHistory();
for (const dest of DESTINATIONS) {
  const status = {};
  const f = dest.feeds;
  const pts = dest.route.points;
  const t0 = Math.floor(Date.now() / 36e5) * 36e5;
  const prev = await previous(dest);
  const [ch, cm, cl, inc, al] = await Promise.all([
    source(status, 'chain', () => chain(f), [], prev),
    source(status, 'cams', () => cams(f), [], prev),
    source(status, 'closures', () => closures(f, dest.route.highway), [], prev),
    source(status, 'incidents', () => incidents(f, dest.route), [], prev),
    source(status, 'alerts', () => alerts(pts.filter((p) => f.alertPoints.includes(p.id))), [], prev),
  ]);
  const weather = {};
  const failed = [];
  const kept = [];
  for (const p of pts) {
    try {
      weather[p.id] = await nwsPoint(p, t0);
    } catch (e) {
      console.error(`[weather:${p.id}] ${e.message}`);
      // Keep this point's last good forecast, re-aligned to the new t0.
      const old = carriedWeather(prev, p.id, t0);
      if (old) {
        weather[p.id] = old;
        kept.push(p.id);
      } else failed.push(p.id);
    }
  }
  for (const p of pts) if (weather[p.id]) weather[p.id].snowPast = pastSnow(prev, p.id, t0);
  ttCalls = 0;
  const dr = TT_KEY ? await source(status, 'drive', () => drive(dest, prev), null, prev) : null;
  if (dr?.hourlyError && status.drive.ok) status.drive.hourlyError = dr.hourlyError;
  if (dr) delete dr.hourlyError;
  const wxErr = [failed.length ? `missing: ${failed.join(', ')}` : '', kept.length ? `carried over: ${kept.join(', ')}` : ''].filter(Boolean).join('; ');
  status.weather = wxErr
    ? { ok: false, error: wxErr, at: Date.now(), ...(kept.length ? { dataAt: Math.min(...kept.map((id) => weather[id].at)) } : {}) }
    : { ok: true, at: Date.now() };
  const tomtom = TT_KEY ? quotaUsed(prev?.tomtom, ttCalls) : null;
  const out = { generatedAt: Date.now(), t0, hours: HOURS, status, chain: ch, closures: cl, incidents: inc, alerts: al, cams: cm, weather, drive: dr, tomtom };
  // What chain control really is this hour, next to what was forecast for it (first destination only: one highway).
  if (dest === DESTINATIONS[0]) {
    const mtn = dest.route.mountainPoints;
    const lv = (dir) => { const m = status.chain.ok ? chainFor(out, dest.route.highway, dir).max : -1; return m < 0 ? null : m; };
    const now0 = (field) => mtn.map((id) => weather[id]?.[field]?.[0] ?? null);
    history = addHistory(history, { t: t0, e: lv(dest.route.outboundDir), w: lv(dest.route.returnDir), s: now0('snow'), c: now0('temp') }, mtn);
    await writeFile(new URL('../data/history.json', import.meta.url), JSON.stringify(history));
  }
  await writeFile(new URL(`../data/${dest.id}.json`, import.meta.url), JSON.stringify(out));
  console.log(dest.id, Object.entries(status).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL'}`).join(' '),
    `chain=${ch.length} cams=${cm.length} closures=${cl.length} incidents=${inc.length} alerts=${al.length} weather=${Object.keys(weather).length}`,
    tomtom ? `tomtom: ${ttCalls} requests this run, ${tomtom.n} today (${tomtom.day} UTC)${tomtom.prev ? `, ${tomtom.prev.n} on ${tomtom.prev.day}` : ''}` : '',
    dr ? `drive: out ${Math.round(dr.out.sec / 60)}min back ${Math.round(dr.back.sec / 60)}min hourly=${dr.hourly.out.length} (${Math.round((Date.now() - dr.hourlyAt) / 6e4)}min old) long=${dr.long?.out.length ?? 0} (${Math.round((Date.now() - (dr.longAt || 0)) / 6e4)}min old)` : TT_KEY ? 'drive: FAILED' : 'drive: no TOMTOM_KEY');
}

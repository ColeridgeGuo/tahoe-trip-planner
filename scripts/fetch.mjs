// Pulls official feeds (Caltrans, CHP, NWS) and writes one slim JSON per destination.
// Node 22+, no dependencies. Run: node scripts/fetch.mjs
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { DESTINATIONS } from '../js/config.js';
import { CC_URL, normalizeChain, incidentDir } from '../js/normalize.js';
import { HOURS, source, carriedWeather, hourly, ptToMs, stopTimes, pastSnow, addHistory, quotaUsed, dedupe, streamUrl, liveStreams, incidentRoad, MONTHLY_QUOTA, HOURLY_EVERY_MS, LONG_EVERY_MS, LONG_STEP_H, LONG_TO_H, keptLive, keptHours, snotelStations, SNOTEL_EVERY_MS } from './lib.mjs';
import { chainFor, roadsOf, isDetour } from '../js/logic.js';

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

// What the previous run published (or a local run left behind), read back at the start of every run:
//   data/<destination>.json  a source that fails this time keeps its last good data from here (source() and
//                            carriedWeather() in ./lib.mjs); it also carries the last day's snowfall, the
//                            TomTom forecasts that are not due yet and today's request count;
//   data/history.json        the hourly record of real chain control (addHistory in ./lib.mjs).
// Null only when there is none yet (404) or it cannot be parsed. If the site cannot be reached after several
// tries, this throws and the run stops before deploying: going on without the file would forget the snow
// that has just fallen, refetch every TomTom forecast (about 200 requests) and replace the whole history
// with one row. The next run, 15 minutes later, tries again; the site keeps its current data meanwhile.
async function published(name) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (owner) {
    let last = '';
    for (let i = 0; i < 5; i++) {
      try {
        const r = await fetch(`https://${owner.toLowerCase()}.github.io/${repo}/data/${name}.json?ts=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
        if (r.status === 404) return null;
        if (r.ok) {
          const text = await r.text();
          try { return JSON.parse(text); } catch { console.error(`[${name}] published file is not valid JSON, starting without it`); return null; }
        }
        last = `HTTP ${r.status}`;
      } catch (e) { last = String(e.message); }
      await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
    }
    throw new Error(`[${name}] could not read the published file (${last}); not deploying, so it is not overwritten`);
  }
  try {
    return JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
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
  // Which highways to show cameras for, and between which longitudes.
  const roads = feeds.camRoads || [{ highway: feeds.camHighway, lonMin: feeds.camLonMin }];
  for (const d of feeds.cctvDistricts) {
    const j = await get(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${pad(d)}.json`);
    for (const { cctv: c } of j.data) {
      const l = c.location;
      const road = roads.find((x) => x.highway === l.route);
      if (!road || c.inService !== 'true' || +l.longitude < (road.lonMin ?? -Infinity) || +l.longitude > (road.lonMax ?? Infinity)) continue;
      const img = c.imageData?.static?.currentImageURL;
      if (!img) continue;
      out.push({
        name: l.locationName.replace(/^Hwy \d+ at /i, '').replace(/^\d+ - /, '').replace(/_/g, ' '),
        place: l.nearbyPlace,
        lat: +l.latitude,
        lon: +l.longitude,
        elevFt: +l.elevation || null,
        img,
        stream: streamUrl(c.imageData.streamingVideoURL),
      });
    }
  }
  const probe = (url) => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).then((r) => r.status, () => 0);
  return liveStreams(out.sort((a, b) => a.lon - b.lon), probe);
}

async function closures(feeds, route) {
  const now = Date.now();
  const roads = roadsOf(route);
  const out = [];
  for (const d of feeds.lcsDistricts) {
    const j = await get(`https://cwwp2.dot.ca.gov/data/d${d}/lcs/lcsStatusD${pad(d)}.json`);
    for (const { lcs: c } of j.data) {
      const b = c.location.begin;
      const e = c.location.end;
      const road = roads.find((x) => x.highway === b.beginRoute);
      if (!road) continue;
      if (road.lonMax != null && Math.min(+b.beginLongitude, +e.endLongitude) > road.lonMax) continue; // past the turn-off
      const k = c.closure;
      const t = k.closureTimestamp;
      const start = +t.closureStartEpoch * 1000;
      const indefinite = t.isClosureEndIndefinite === 'true';
      const end = indefinite ? null : +t.closureEndEpoch * 1000;
      if (k.code1098?.isCode1098 === 'true') continue; // crew reported finished
      if ((end && end < now) || start > now + 8 * 864e5) continue;
      out.push({
        hw: road.highway,
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
  const box = feeds.incidentBox;
  const roads = roadsOf(route);
  const out = [];
  for (const log of xml.split('<Log ').slice(1)) {
    const ll = /(\d+):(\d+)/.exec(tag(log, 'LATLON'));
    if (!ll) continue;
    const lat = +ll[1] / 1e6;
    const lon = -ll[2] / 1e6;
    if (lat < box.latMin || lat > box.latMax || lon < box.lonMin || lon > box.lonMax) continue;
    const loc = tag(log, 'Location');
    const desc = tag(log, 'LocationDesc');
    const on = incidentRoad(loc, desc, roads, feeds.incidentMatch, incidentDir);
    if (!on) continue;
    const lonMax = roads.find((x) => x.highway === on.hw).lonMax;
    if (lonMax != null && lon > lonMax) continue; // past the turn-off
    const details = [...log.matchAll(/<IncidentDetail>([\s\S]*?)<\/IncidentDetail>/g)].map((m) => unq(m[1]).replace(/^\[\d+\]\s*/, ''));
    out.push({
      id: (/ID = "([^"]+)"/.exec(log) || [])[1],
      time: ptToMs(tag(log, 'LogTime')),
      type: tag(log, 'LogType').replace(/^\w+-/, ''),
      loc,
      desc,
      hw: on.hw,
      dir: on.dir,
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

// ---------- measured snow (SNOTEL) ----------
// One request for all of a destination's stations, three days of hourly readings. The stations report once
// an hour, so the last answer is reused until it is SNOTEL_EVERY_MS old.
async function snotel(stations, prevFile) {
  const old = prevFile?.snotel;
  if (old?.at && Date.now() - old.at < SNOTEL_EVERY_MS && old.stations?.length === stations.length && old.stations.every((s, i) => s.id === stations[i].id)) return old;
  const day = (ms) => new Date(ms - 8 * 36e5).toISOString().slice(0, 10); // station time is PST
  const q = new URLSearchParams({ stationTriplets: stations.map((s) => s.id).join(','), elements: 'SNWD,WTEQ,TOBS', duration: 'HOURLY', beginDate: `${day(Date.now() - 3 * 864e5)} 00:00`, endDate: `${day(Date.now() + 864e5)} 00:00`, periodRef: 'END', centralTendencyType: 'NONE', returnFlags: 'false' });
  const list = snotelStations(await get(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`), stations);
  if (!list.some((s) => s.at)) throw new Error('no readings in the answer');
  return { at: Date.now(), stations: list };
}

// ---------- TomTom drive times ----------
// The key comes from the TOMTOM_KEY secret. Errors are built without the request URL so the key can never
// end up in the published JSON or the logs.
const TT_KEY = process.env.TOMTOM_KEY || '';
let ttCalls = 0; // requests sent on this run, retries included: each one counts against the monthly quota
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
// How often each part is refreshed, and what that costs against the free monthly quota, is set out in
// ./lib.mjs (TomTom quota). Whatever is not due is carried over from the previously published file.
const LONG_RETRY_MS = 60 * 6e4; // after a failed long refresh, wait this long rather than retrying every run
async function drive(dest, prevFile) {
  const pt = (id) => dest.route.points.find((p) => p.id === id);
  const way = [dest.route.points[0], ...dest.route.drivePins.map(pt), pt(dest.route.townPoint)];
  // A waypoint on a divided road has a spot on each carriageway (`pin`), used for the matching direction.
  const pinned = (p, k) => (p.pin ? { ...p, lat: p.pin[k][0], lon: p.pin[k][1] } : p);
  const dirs = { out: way.map((p) => pinned(p, 'out')), back: [...way].reverse().map((p) => pinned(p, 'back')) };
  // The points the page shows conditions for, in route order (west to east). Every drive time carries
  // `stops`: seconds from departure to each of them, in this order whichever way the trip goes.
  const timed = dest.route.points.filter((p) => p.offsetH != null);
  const prev = prevFile?.drive;
  const live = keptLive(prev, Date.now());
  const res = live || { at: Date.now() };
  for (const [k, pts] of Object.entries(live ? {} : dirs)) {
    res[k] = await ttRoute(pts, null, timed);
    console.log(`drive ${k}: ${res[k].km} km, legs ${pts.map((p) => p.id).join(' > ')}: ${res[k].legs.map((l) => `${l.km}km/${l.min}min`).join(', ')}; reaches ${timed.map((p, i) => `${p.id} ${res[k].stops[i] == null ? '?' : Math.round(res[k].stops[i] / 60)}min`).join(', ')}`);
  }
  const h0 = Math.ceil(Date.now() / 36e5) * 36e5;
  // Fills `into` for the given hour offsets; a failure throws and leaves the hours fetched so far in place.
  // Hours in `kept` (see keptHours in ./lib.mjs) are taken from the last forecast instead of being fetched.
  const forecast = async (into, offsets, kept = new Map()) => {
    for (const i of offsets) {
      const old = kept.get(h0 + i * 36e5);
      for (const [k, pts] of Object.entries(dirs)) {
        if (old) { into[k].push(old[k]); continue; }
        const r = await ttRoute(pts, h0 + i * 36e5, timed);
        into[k].push({ ms: h0 + i * 36e5, sec: r.sec, noTrafficSec: r.noTrafficSec, stops: r.stops, at: Date.now() });
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
      await forecast(hourly, Array.from({ length: 24 }, (_, i) => i), keptHours(prev?.hourly, prev?.hourlyAt, h0, Date.now(), (x) => isDetour(x, dest.route)));
      res.hourly = hourly;
      res.hourlyAt = Date.now();
      const round = ['out', 'back'].map((k) => hourly[k].filter((x) => isDetour(x, dest.route)).length);
      if (round[0] + round[1]) console.log(`drive hourly: TomTom routes round a closure for ${round[0]} outbound and ${round[1]} return hour(s); not shown as drive times, asked again within 3 h`);
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
  // A saved forecast that no longer reaches the end of the week the page shows is refreshed early.
  const holdOff = Date.now() - (prev?.longTriedAt || 0) < LONG_RETRY_MS;
  const reaches = (prev?.long?.out?.at(-1)?.ms || 0) >= Date.now() + 167 * 36e5;
  if (prev?.long && (holdOff || (timedIn(prev.long) && reaches && Date.now() - prev.longAt < LONG_EVERY_MS))) {
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
let history = await published('history');
for (const dest of DESTINATIONS) {
  const status = {};
  const f = dest.feeds;
  const pts = dest.route.points;
  const t0 = Math.floor(Date.now() / 36e5) * 36e5;
  const prev = await published(dest.id);
  const sn = dest.resort.snotel || [];
  const [ch, cm, cl, inc, al, obs] = await Promise.all([
    source(status, 'chain', () => chain(f), [], prev),
    source(status, 'cams', () => cams(f), [], prev),
    source(status, 'closures', () => closures(f, dest.route), [], prev),
    source(status, 'incidents', () => incidents(f, dest.route), [], prev),
    source(status, 'alerts', () => alerts(pts.filter((p) => f.alertPoints.includes(p.id))), [], prev),
    sn.length ? source(status, 'snotel', () => snotel(sn, prev), null, prev) : null,
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
  // Only a destination marked `driveTimes: 'tomtom'` spends TomTom requests; the others link to Google Maps.
  const useTT = TT_KEY && dest.driveTimes === 'tomtom';
  const dr = useTT ? await source(status, 'drive', () => drive(dest, prev), null, prev) : null;
  if (dr?.hourlyError && status.drive.ok) status.drive.hourlyError = dr.hourlyError;
  if (dr) delete dr.hourlyError;
  const wxErr = [failed.length ? `missing: ${failed.join(', ')}` : '', kept.length ? `carried over: ${kept.join(', ')}` : ''].filter(Boolean).join('; ');
  status.weather = wxErr
    ? { ok: false, error: wxErr, at: Date.now(), ...(kept.length ? { dataAt: Math.min(...kept.map((id) => weather[id].at)) } : {}) }
    : { ok: true, at: Date.now() };
  const tomtom = useTT ? quotaUsed(prev?.tomtom, ttCalls) : null;
  const out = { generatedAt: Date.now(), t0, hours: HOURS, status, chain: ch, closures: cl, incidents: inc, alerts: al, cams: cm, weather, drive: dr, tomtom, snotel: obs };
  // What chain control really is this hour, next to what was forecast for it (first destination only: one highway).
  if (dest === DESTINATIONS[0]) {
    const mtn = dest.route.mountainPoints;
    const lv = (dir) => { const m = status.chain.ok ? chainFor(out, dest.route.highway, dir).max : -1; return m < 0 ? null : m; };
    const now0 = (field) => mtn.map((id) => weather[id]?.[field]?.[0] ?? null);
    // The live drive time each way and the part of it on the mountain section: every leg but the long one
    // that starts or ends at the origin. Only from a reading taken in this hour: not one carried over after a
    // failure, nor a live reading from before the hour that is being reused because a new one is not due yet.
    const mtnMin = (x, out) => (out ? x.legs.slice(1) : x.legs.slice(0, -1)).reduce((s, l) => s + l.min, 0);
    const live = dr && status.drive.ok && dr.at >= t0 ? { d: [dr.out.sec, dr.back.sec], m: [mtnMin(dr.out, true), mtnMin(dr.back, false)] } : {};
    history = addHistory(history, { t: t0, e: lv(dest.route.outboundDir), w: lv(dest.route.returnDir), s: now0('snow'), c: now0('temp'), ...live, ...(obs && status.snotel.ok ? { sd: obs.stations.map((x) => x.depth) } : {}) }, mtn);
    await writeFile(new URL('../data/history.json', import.meta.url), JSON.stringify(history));
  }
  await writeFile(new URL(`../data/${dest.id}.json`, import.meta.url), JSON.stringify(out));
  console.log(dest.id, Object.entries(status).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL'}`).join(' '),
    `chain=${ch.length} cams=${cm.length} closures=${cl.length} incidents=${inc.length} alerts=${al.length} weather=${Object.keys(weather).length}`,
    tomtom ? `tomtom: ${ttCalls} requests this run, ${tomtom.n} today (${tomtom.day} UTC), ${tomtom.monthN} of ${MONTHLY_QUOTA} in ${tomtom.month}${tomtom.prev ? `, ${tomtom.prev.n} on ${tomtom.prev.day}` : ''}` : '',
    dr ? `drive: out ${Math.round(dr.out.sec / 60)}min back ${Math.round(dr.back.sec / 60)}min hourly=${dr.hourly.out.length} (${Math.round((Date.now() - dr.hourlyAt) / 6e4)}min old) long=${dr.long?.out.length ?? 0} (${Math.round((Date.now() - (dr.longAt || 0)) / 6e4)}min old)` : dest.driveTimes !== 'tomtom' ? 'drive: not fetched (Google Maps link)' : TT_KEY ? 'drive: FAILED' : 'drive: no TOMTOM_KEY');
}

// Pulls official feeds (Caltrans, CHP, NWS) and writes one slim JSON per destination.
// Node 22+, no dependencies. Run: node scripts/fetch.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { DESTINATIONS } from '../js/config.js';
import { CC_URL, normalizeChain } from '../js/normalize.js';

const UA = 'tahoe-trip-planner (personal trip dashboard, github pages)';
const HOURS = 168;
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

// Each source records ok/error so the UI can say "couldn't confirm" instead of silently passing.
async function source(status, key, fn, fallback) {
  try {
    const v = await fn();
    status[key] = { ok: true, at: Date.now() };
    return v;
  } catch (e) {
    console.error(`[${key}] ${e.message}`);
    status[key] = { ok: false, error: String(e.message).slice(0, 200), at: Date.now() };
    return fallback;
  }
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
  return out.sort((a, b) => a.start - b.start || a.lon - b.lon);
}

// ---------- CHP ----------
const unq = (s) => (s || '').replace(/^"|"$/g, '').trim();
const tag = (x, t) => unq((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x) || [])[1]);
// CHP times are Pacific wall-clock; resolve to an epoch without a tz library.
function ptToMs(str) {
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
async function incidents(feeds) {
  const xml = await get('https://media.chp.ca.gov/sa_xml/sa.xml', { json: false });
  const re = new RegExp(feeds.incidentMatch, 'i');
  const box = feeds.incidentBox;
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
      area: tag(log, 'Area'),
      lat,
      lon,
      details: details.slice(-3),
    });
  }
  return out.sort((a, b) => a.lon - b.lon);
}

// ---------- NWS ----------
function durH(iso) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(iso);
  return (+m[1] || 0) * 24 + (+m[2] || 0);
}
// Expand NWS interval series to one value per hour. Accumulated fields are spread evenly over the interval.
function hourly(series, t0, accumulate) {
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
async function nwsPoint(p, t0) {
  const meta = await get(`https://api.weather.gov/points/${p.lat},${p.lon}`, { accept: 'application/geo+json' });
  const g = (await get(meta.properties.forecastGridData, { accept: 'application/geo+json', tries: 4 })).properties;
  return {
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
async function ttRoute(points, departMs) {
  const locs = points.map((p) => `${p.lat},${p.lon}`).join(':');
  const q = new URLSearchParams({ key: TT_KEY, traffic: 'true', travelMode: 'car', routeType: 'fastest', computeTravelTimeFor: 'all', routeRepresentation: 'summaryOnly' });
  if (departMs) q.set('departAt', new Date(departMs).toISOString().replace(/\.\d+Z$/, 'Z'));
  let last = 'no response';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?${q}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const m = (await r.json()).routes?.[0]?.summary;
        if (!m?.travelTimeInSeconds) throw new Error('no route in response');
        return { sec: m.travelTimeInSeconds, noTrafficSec: m.noTrafficTravelTimeInSeconds ?? null, historicSec: m.historicTrafficTravelTimeInSeconds ?? null, km: Math.round(m.lengthInMeters / 1000) };
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
// Live drive time both ways on every run; hourly forecasts for the next 24 h are refreshed about once an hour
// and otherwise carried over from the previously published file, to stay well inside the free daily quota.
async function drive(dest) {
  const way = dest.route.points.filter((p) => p.offsetH != null);
  const dirs = { out: way, back: [...way].reverse() };
  const res = { at: Date.now() };
  for (const [k, pts] of Object.entries(dirs)) res[k] = await ttRoute(pts);
  let prev = null;
  try {
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    if (owner) prev = (await get(`https://${owner.toLowerCase()}.github.io/${repo}/data/${dest.id}.json`, { tries: 1 })).drive;
  } catch { /* first run or site unreachable: just recompute */ }
  if (prev?.hourly && Date.now() - prev.hourlyAt < 55 * 6e4) {
    res.hourlyAt = prev.hourlyAt;
    res.hourly = prev.hourly;
  } else {
    const h0 = Math.ceil(Date.now() / 36e5) * 36e5;
    res.hourly = { out: [], back: [] };
    for (let i = 0; i < 24; i++) {
      for (const [k, pts] of Object.entries(dirs)) {
        const r = await ttRoute(pts, h0 + i * 36e5);
        res.hourly[k].push({ ms: h0 + i * 36e5, sec: r.sec, noTrafficSec: r.noTrafficSec });
      }
    }
    res.hourlyAt = Date.now();
  }
  return res;
}

// ---------- main ----------
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
for (const dest of DESTINATIONS) {
  const status = {};
  const f = dest.feeds;
  const pts = dest.route.points;
  const t0 = Math.floor(Date.now() / 36e5) * 36e5;
  const [ch, cm, cl, inc, al] = await Promise.all([
    source(status, 'chain', () => chain(f), []),
    source(status, 'cams', () => cams(f), []),
    source(status, 'closures', () => closures(f, dest.route.highway), []),
    source(status, 'incidents', () => incidents(f), []),
    source(status, 'alerts', () => alerts(pts.filter((p) => f.alertPoints.includes(p.id))), []),
  ]);
  const weather = {};
  const failed = [];
  for (const p of pts) {
    try {
      weather[p.id] = await nwsPoint(p, t0);
    } catch (e) {
      console.error(`[weather:${p.id}] ${e.message}`);
      failed.push(p.id);
    }
  }
  const dr = TT_KEY ? await source(status, 'drive', () => drive(dest), null) : null;
  status.weather = failed.length ? { ok: false, error: `missing: ${failed.join(', ')}`, at: Date.now() } : { ok: true, at: Date.now() };
  const out = { generatedAt: Date.now(), t0, hours: HOURS, status, chain: ch, closures: cl, incidents: inc, alerts: al, cams: cm, weather, drive: dr };
  await writeFile(new URL(`../data/${dest.id}.json`, import.meta.url), JSON.stringify(out));
  console.log(dest.id, Object.entries(status).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL'}`).join(' '),
    `chain=${ch.length} cams=${cm.length} closures=${cl.length} incidents=${inc.length} alerts=${al.length} weather=${Object.keys(weather).length}`,
    dr ? `drive: out ${Math.round(dr.out.sec / 60)}min back ${Math.round(dr.back.sec / 60)}min hourly=${dr.hourly.out.length} (${Math.round((Date.now() - dr.hourlyAt) / 6e4)}min old)` : TT_KEY ? 'drive: FAILED' : 'drive: no TOMTOM_KEY');
}

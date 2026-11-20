// Pure decision logic: no DOM, no network. Everything works on the JSON produced by scripts/fetch.mjs.
const TZ = 'America/Los_Angeles';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
export const dayKey = (ms) => dayFmt.format(ms);
export const hourOf = (ms) => +hourFmt.format(ms) % 24;

export const LV = { ok: 0, info: 0, caution: 1, nogo: 2 };
const worst = (a, b) => (LV[b] > LV[a] ? b : a);

// Thresholds, in metric. Snow is depth of new snow per hour.
export const TH = {
  snowLight: 2, // mm/h: roads start to get slick
  snowHeavy: 25, // mm/h (~1 in/h): chain control very likely
  snowExtreme: 50, // mm/h (~2 in/h): closures / spin-outs likely
  gustRoad: 80, // km/h on the pass
  gustLiftMod: 55, // km/h on the summit: upper lifts may go on hold
  gustLiftHigh: 80, // km/h: gondola and upper mountain likely on hold
  // Snow already on the road when you cross: this much new snow (mm) within this many hours before, either
  // rule, while it is packTemp (°C) or colder as you cross. Chain control is then probably still up.
  // First guesses, to be checked against data/history.json after real storms.
  pack: [{ hours: 12, mm: 50 }, { hours: 24, mm: 100 }],
  packTemp: 1,
  staleMin: 120,
  liveHorizonH: 6, // live road status only decides trips starting this soon
  // Extra drive time on the mountain section in snow, in minutes [from, to]. TomTom's times for a later
  // departure come from its usual traffic for that hour and know nothing about snow. Rough figures: the 30
  // miles of chain-control road take about 35 min dry and about twice that at the 25-30 mph limit, plus the
  // queue at the checkpoint. To be checked against the real drive times kept in data/history.json.
  snowDelay: { light: [20, 40], heavy: [45, 90] },
  closureMarginMin: 30, // a closure counts if it is in force within this long of when the drive passes it
};

export function index(data) {
  const hours = [];
  for (let i = 0; i < data.hours; i++) {
    const ms = data.t0 + i * 36e5;
    hours.push({ i, ms, day: dayKey(ms), h: hourOf(ms) });
  }
  const days = [...new Set(hours.map((x) => x.day))];
  return { hours, days };
}

// Hour `i` of a forecast field. Hours before the file's first hour are read from `<field>Past` where the fetch
// script keeps them (only `snowPast`: the last day's snowfall, so snow already on the ground is not forgotten).
const at = (w, field, i) => {
  if (!w) return null;
  if (i >= 0) return i < w[field].length ? w[field][i] : null;
  const past = w[field + 'Past'];
  return past && past.length + i >= 0 ? past[past.length + i] : null;
};
const idx = (data, ms) => Math.round((ms - data.t0) / 36e5);

export function offsetFor(route, point, direction) {
  if (point.offsetH == null) return direction === 'out' ? route.driveHours : 0;
  return direction === 'out' ? point.offsetH : route.driveHours - point.offsetH;
}

// A Google Maps directions link for this trip (free, no key: https://developers.google.com/maps/documentation/urls).
// It opens the live drive time for leaving now; a later departure is set inside Google Maps, the link cannot
// carry one. The route's mountain pins go in as waypoints so Google shows the same road the page reports on.
// The resort end is `route.mapsPlace` (a name Google finds) or the town point.
export function mapsUrl(dest, direction) {
  const r = dest.route;
  const pt = (id) => r.points.find((p) => p.id === id);
  const ll = (p, k) => (p.pin ? p.pin[k] : [p.lat, p.lon]).join(',');
  const home = ll(r.points[0], direction);
  const resort = r.mapsPlace || ll(pt(r.townPoint), direction);
  const via = r.drivePins.map((id) => ll(pt(id), direction));
  const q = new URLSearchParams({ api: '1', origin: direction === 'out' ? home : resort, destination: direction === 'out' ? resort : home, travelmode: 'driving' });
  if (via.length) q.set('waypoints', (direction === 'out' ? via : via.reverse()).join('|'));
  return `https://www.google.com/maps/dir/?${q}`;
}

// Where a drive time carries `stops` (seconds from departure to each timed route point, in route order, from
// TomTom), it is passed on so alongRoute() can use the real pass-through times.
// How long the drive takes for a given departure: live TomTom time if leaving about now, otherwise the
// forecast (hourly for the next day, then a coarser grid out to 7 days), otherwise the route's fixed estimate.
// A forecast that is not a drive time: TomTom expected the mountain road to be shut at that hour (a hold during
// a storm, say) and went round, hours longer even without traffic, doubling back to pass the route's waypoints.
// Such a point says nothing about how long the drive takes once the road is open, and it is usually gone the
// next time TomTom is asked. The page leaves it out and the fetch asks again sooner (keptHours in scripts/lib.mjs).
export const DETOUR_X = 1.6;
export const isDetour = (x, route) => x?.noTrafficSec > route.driveHours * 3600 * DETOUR_X;
const DRIVE_GAP_MS = 3 * 36e5; // widest gap between two forecast points that is still interpolated across
export function driveTime(data, dest, departMs, direction, nowMs = Date.now()) {
  const fixed = { hours: dest.route.driveHours, src: 'fixed' };
  const d = data.drive;
  if (!d || !d[direction]) return fixed;
  if (departMs - nowMs < 30 * 6e4 && nowMs - d.at < 45 * 6e4) {
    const x = d[direction];
    const base = x.historicSec ?? x.noTrafficSec;
    return { hours: x.sec / 3600, src: 'live', sec: x.sec, deltaMin: base ? Math.round((x.sec - base) / 60) : null, vs: x.historicSec ? 'usual' : 'free', stops: x.stops || null };
  }
  const near = d.hourly?.[direction] || [];
  const nearEnd = near.length ? near[near.length - 1].ms : -Infinity;
  const h = [...near, ...(d.long?.[direction] || []).filter((x) => x.ms > nearEnd)].filter((x) => !isDetour(x, dest.route));
  const i = h.findIndex((x) => x.ms > departMs);
  const a = i > 0 ? h[i - 1] : i === 0 ? h[0] : h[h.length - 1];
  const b = i > 0 ? h[i] : a;
  // Between two points: interpolate unless the gap is too wide. Outside the series: only within an hour of its end.
  if (!a || (i > 0 ? b.ms - a.ms > DRIVE_GAP_MS : Math.abs(a.ms - departMs) > 60 * 6e4)) return fixed;
  const f = b.ms === a.ms ? 0 : Math.min(1, Math.max(0, (departMs - a.ms) / (b.ms - a.ms)));
  const sec = a.sec + (b.sec - a.sec) * f;
  const free = a.noTrafficSec;
  const mix = (x, y) => (x == null || y == null ? null : x + (y - x) * f);
  const stops = a.stops && b.stops ? a.stops.map((x, k) => mix(x, b.stops[k])) : null;
  return { hours: sec / 3600, src: 'forecast', sec, deltaMin: free ? Math.round((sec - free) / 60) : null, vs: 'free', stops };
}

// Seconds from departure to each timed route point, in travel order. `stopSec` holds the times TomTom gave
// (in route order, null where unknown). A point without one is placed between its timed neighbours in
// proportion to the route's fixed offsets; with no times at all that is the fixed offsets scaled to `hours`.
function passTimes(route, ordered, direction, hours, stopSec) {
  const pts = route.points.filter((p) => p.offsetH != null);
  const total = hours * 3600;
  const last = ordered.length - 1;
  const nominal = ordered.map((p) => offsetFor(route, p, direction));
  const known = ordered.map((p, k) => {
    if (k === 0) return 0;
    if (k === last) return total;
    const s = stopSec?.[pts.indexOf(p)];
    return Number.isFinite(s) && s > 0 && s < total ? s : null;
  });
  // A time that would put a point before the one ahead of it on the road is dropped.
  let prev = 0;
  for (let k = 1; k < last; k++) {
    if (known[k] == null) continue;
    if (known[k] < prev) known[k] = null;
    else prev = known[k];
  }
  return ordered.map((_, k) => {
    if (known[k] != null) return known[k];
    let a = k;
    let b = k;
    while (known[a] == null) a--;
    while (known[b] == null) b++;
    const span = nominal[b] - nominal[a];
    return known[a] + (span > 0 ? ((nominal[k] - nominal[a]) / span) * (known[b] - known[a]) : 0);
  });
}

// Conditions at each route point at the moment you'd drive through it.
export function alongRoute(data, dest, departMs, direction, hours = dest.route.driveHours, stopSec = null) {
  const r = dest.route;
  const pts = r.points.filter((p) => p.offsetH != null);
  const ordered = direction === 'out' ? pts : [...pts].reverse();
  const secs = passTimes(r, ordered, direction, hours, stopSec);
  return ordered.map((p, k) => {
    const ms = departMs + secs[k] * 1000;
    const i = idx(data, ms);
    const w = data.weather[p.id];
    return {
      point: p,
      ms,
      missing: !w || at(w, 'temp', i) == null,
      temp: at(w, 'temp', i),
      snow: at(w, 'snow', i),
      qpf: at(w, 'qpf', i),
      gust: at(w, 'gust', i),
      pop: at(w, 'pop', i),
      snowLevel: at(w, 'snowLevel', i),
      elevM: w?.elevM ?? null,
    };
  });
}

// A forecast point whose last fetch failed keeps its previous forecast (`carried`, fetched at `at`).
// Returns when the oldest such forecast among these points was fetched, or null if all are fresh.
export function weatherStaleAt(data, ids) {
  const ats = ids.map((id) => data.weather[id]).filter((w) => w?.carried && w.at).map((w) => w.at);
  return ats.length ? Math.min(...ats) : null;
}
// Tag a factor built on carried-over data with its age; once too old it is no better than caution.
function stamp(f, at, nowMs) {
  if (at == null) return f;
  f.staleAt = at;
  if (nowMs - at > TH.staleMin * 6e4) f.level = worst(f.level, 'caution');
  return f;
}

// What an NWS alert means for the drive, by its event name. Only alerts about the road count: snow, ice, wind
// strong enough to matter on the pass, fog, flooding. The rest (Lake Wind Advisory, which is for boats on the
// lake and is out most winter weeks, Freeze Warning, watches, statements) are still listed but leave the
// verdict alone. So are Avalanche Warning and Watch: they are issued for the backcountry, not the highway,
// and when a slide path does threaten the road Caltrans closes it, which the closure and chain feeds show.
const ALERT_NOGO = /blizzard|ice storm/i;
const ALERT_ROAD = /winter storm warning|winter weather advisory|snow squall|freezing (rain|fog|drizzle)|^high wind warning|^wind advisory|dense fog advisory|flash flood warning|^flood warning/i;
export const alertLevel = (event) => (ALERT_NOGO.test(event) ? 'nogo' : ALERT_ROAD.test(event) ? 'caution' : 'ok');

// Forecast-only factors for a given departure. Used for the verdict and the hour-by-hour strip.
// With `vehicle`, snow heavy enough (or enough of it lying) that chain control is very likely is judged for
// that vehicle as R2 would be: a car that needs chains and has none is a no-go, not just a caution.
export function forecastFactors(data, dest, departMs, direction, hours = dest.route.driveHours, nowMs = Date.now(), stopSec = null, vehicle = null) {
  const r = dest.route;
  const stops = alongRoute(data, dest, departMs, direction, hours, stopSec);
  const mtn = stops.filter((s) => r.mountainPoints.includes(s.point.id));
  const factors = [];

  // Snowfall while crossing the mountain section: look one hour either side of the pass-through time.
  let peak = { rate: 0, stop: null };
  let missing = mtn.length === 0;
  for (const s of mtn) {
    const w = data.weather[s.point.id];
    if (!w) { missing = true; continue; }
    const i = idx(data, s.ms);
    for (const j of [i - 1, i, i + 1]) {
      const v = at(w, 'snow', j);
      if (v == null) { if (j === i) missing = true; continue; }
      if (v > peak.rate) peak = { rate: v, stop: s };
    }
  }
  // Snow already on the road: what fell in the hours before crossing, if it is still freezing by then. A
  // storm that has just ended leaves chain control up for hours, although nothing is falling any more.
  let pack = null;
  for (const s of mtn) {
    const w = data.weather[s.point.id];
    const i = idx(data, s.ms);
    const temp = at(w, 'temp', i);
    if (temp == null || temp > TH.packTemp) continue;
    for (const rule of TH.pack) {
      let mm = 0;
      for (let j = i - rule.hours; j < i; j++) mm += at(w, 'snow', j) ?? 0;
      // Of the rules met, report the one furthest over its limit.
      if (mm >= rule.mm && (!pack || mm / rule.mm > pack.mm / pack.limit)) pack = { mm, hours: rule.hours, limit: rule.mm, stop: s, temp };
    }
  }
  if (missing && peak.rate === 0) factors.push({ key: 'snow', level: 'caution', msg: 'snowUnknown' });
  else if (peak.rate < TH.snowLight && pack) factors.push({ key: 'snow', level: 'caution', msg: 'snowPack', v: { ...peak, pack } });
  else if (peak.rate >= TH.snowExtreme) factors.push({ key: 'snow', level: 'nogo', msg: 'snowExtreme', v: peak });
  else if (peak.rate >= TH.snowHeavy) factors.push({ key: 'snow', level: 'caution', msg: 'snowHeavy', v: peak });
  else if (peak.rate >= TH.snowLight) factors.push({ key: 'snow', level: 'caution', msg: 'snowLight', v: peak });
  else factors.push({ key: 'snow', level: 'ok', msg: peak.rate > 0 ? 'snowTrace' : 'snowNone', v: peak });
  const snow = factors[factors.length - 1];
  // How much the snow is expected to add to the drive, and what the chain control it brings means for this car.
  const kind = snow.msg === 'snowHeavy' || snow.msg === 'snowExtreme' ? 'heavy' : snow.msg === 'snowLight' || snow.msg === 'snowPack' ? 'light' : null;
  const delay = kind ? TH.snowDelay[kind] : null;
  if (vehicle && kind) {
    // Heavy snow or snow lying on the road: expect R2. Light snow: R1 at most, and only worth a reminder.
    const r2 = kind === 'heavy' || snow.msg === 'snowPack';
    const cv = chainVerdict(r2 ? 2 : 1, vehicle);
    if (r2 && cv.level === 'nogo') { snow.level = 'nogo'; snow.need = cv.msg === 'chainR2Carry' ? 'fcCarry' : 'fcNoChains'; }
    else if (r2 && cv.msg === 'chainInstall') snow.need = 'fcInstall';
    else if (!r2 && cv.level === 'nogo') snow.need = 'fcLight';
  }

  // NWS alerts overlapping the drive.
  const endMs = departMs + hours * 36e5;
  const active = data.alerts.filter((a) => a.onset < endMs && a.ends > departMs);
  const aLevel = active.reduce((l, a) => worst(l, alertLevel(a.event)), 'ok');
  factors.push({ key: 'alerts', level: active.length ? aLevel : 'ok', msg: active.length ? 'alertsActive' : 'alertsNone', v: active });

  const gust = Math.max(0, ...mtn.map((s) => s.gust ?? 0));
  if (gust >= TH.gustRoad) factors.push({ key: 'wind', level: 'caution', msg: 'windHigh', v: gust });

  const wxAt = weatherStaleAt(data, r.mountainPoints);
  for (const f of factors) if (f.key === 'snow' || f.key === 'wind') stamp(f, wxAt, nowMs);

  // `heavy`: snowing hard enough that chain control is very likely, so the charts can tell it from light snow.
  return { factors, stops, level: factors.reduce((l, f) => worst(l, f.level), 'ok'), heavy: peak.rate >= TH.snowHeavy, delay };
}

// What a given chain level means for this vehicle.
export function chainVerdict(level, v) {
  // Unknown: the feed gave no usable reading (see chainFor). That is not the same as "no chain control".
  if (level < 0) return { level: 'caution', msg: 'chainUnknown' };
  if (level === 0) return { level: 'ok', msg: 'chainNone' };
  if (level >= 4) return { level: 'nogo', msg: 'chainClosed' };
  if (level === 3) return { level: 'nogo', msg: 'chainR3' };
  const awdOk = v.drive === 'awd' && v.snowTires;
  if (level === 1) {
    if (awdOk || v.snowTires) return { level: 'caution', msg: v.chains ? 'chainR1Pass' : 'chainR1PassNoChains' };
    return v.chains ? { level: 'caution', msg: 'chainInstall' } : { level: 'nogo', msg: 'chainNeedChains' };
  }
  // R2: only 4WD/AWD with snow-rated tires on all wheels are exempt, and must still carry chains.
  if (awdOk) return v.chains ? { level: 'caution', msg: 'chainR2Pass' } : { level: 'nogo', msg: 'chainR2Carry' };
  return v.chains ? { level: 'caution', msg: 'chainInstall' } : { level: 'nogo', msg: 'chainNeedChains' };
}

// Chain control on one highway in one direction, optionally only the checkpoints inside `box`
// ({ latMin, latMax, lonMin, lonMax }, any of them). `max` is the strictest level, or -1 when it cannot be
// told: no checkpoint came back at all, or none shows a restriction but some carry a status that is not an
// R level or a closure (`unknown`, e.g. traffic being held). A restriction that is known always wins.
const inBox = (c, b) => !b || ((b.latMin == null || c.lat >= b.latMin) && (b.latMax == null || c.lat <= b.latMax) && (b.lonMin == null || c.lon >= b.lonMin) && (b.lonMax == null || c.lon <= b.lonMax));
export function chainFor(data, highway, dir, box) {
  const rows = data.chain.filter((c) => c.hw === highway && (!c.dir || c.dir === dir) && inBox(c, box));
  const unknown = rows.filter((c) => c.level < 0);
  const top = rows.reduce((m, c) => Math.max(m, c.level), -1);
  return { rows, max: top <= 0 && unknown.length ? -1 : top, active: rows.filter((c) => c.level > 0), unknown };
}
// Chain control along an alternate route: every leg of it (`alt.legs`: highway, direction each way, and the
// stretch that is actually driven), so a pass that is open does not hide a closed road further on.
export function altChain(data, alt, direction) {
  const parts = alt.legs.map((l) => chainFor(data, l.highway, direction === 'out' ? l.out : l.back, l.box));
  const top = Math.max(...parts.map((p) => p.max));
  return { rows: parts.flatMap((p) => p.rows), max: top <= 0 && parts.some((p) => p.max < 0) ? -1 : top, active: parts.flatMap((p) => p.active), unknown: parts.flatMap((p) => p.unknown) };
}

// The roads a trip is checked on: the route's main highway, plus any other it uses on the way (`route.also`,
// e.g. CA-267 from Truckee to Northstar), each with its own direction of travel there and back. A road with
// `lonMax` is left at that longitude: whatever lies further east on it is past the turn-off.
export function roadsOf(route) {
  return [{ highway: route.highway, label: route.label, outboundDir: route.outboundDir, returnDir: route.returnDir, lonMax: route.lonMax }, ...(route.also || [])];
}
// Which of the route's roads a record (chain checkpoint, closure, incident) is on. Records saved before
// roads were told apart carry no `hw` and belong to the main highway.
const roadOf = (route, rec) => { const rs = roadsOf(route); return rs.find((x) => x.highway === (rec.hw ?? route.highway)) || rs[0]; };
// Is this record on the trip in the given direction ('out' / 'back')? It has to face the way the trip
// travels on its road, and not lie past the point where the trip leaves that road.
export function onTrip(route, direction) {
  return (rec) => {
    const road = roadOf(route, rec);
    // A closure has two ends (lon, endLon): it is past the turn-off only if both are.
    if (road.lonMax != null && rec.lon != null && Math.min(rec.lon, rec.endLon ?? rec.lon) > road.lonMax) return false;
    return inDir(rec.dir, direction === 'out' ? road.outboundDir : road.returnDir);
  };
}
// Chain control on every road of the trip, in the direction travelled on each.
export function chainOn(data, route, direction) {
  const on = onTrip(route, direction);
  const hws = roadsOf(route).map((x) => x.highway);
  const rows = data.chain.filter((c) => hws.includes(c.hw) && on(c));
  // As in chainFor(): a status that cannot be read is never taken for "no chain control".
  const unknown = rows.filter((c) => c.level < 0);
  const top = rows.reduce((m, c) => Math.max(m, c.level), -1);
  // Every road has to be heard from: a clear I-80 says nothing about CA-267 when the feed has no row for it.
  const silent = hws.some((hw) => !rows.some((c) => c.hw === hw));
  return { rows, max: top <= 0 && (unknown.length || silent) ? -1 : top, active: rows.filter((c) => c.level > 0), unknown };
}

// Not the road itself: ramps and connectors, and the rest areas and side streets Caltrans lists under the
// same route (I-80 has "Rest Area / Full" records all winter: the Donner Summit rest areas, not the freeway).
export const isRamp = (c) => /ramp|connector|rest area|surface street/i.test(c.facility || '');
export const isFull = (c) => /full/i.test(c.type) && !isRamp(c);
// Closures and incidents carry a direction of travel ('East', 'West', 'East / West'). A record with no
// direction, or one that is not stated, counts for both ways.
export const inDir = (recDir, dir) => !dir || !recDir || recDir === 'N/A' || recDir.includes(dir);
// `dir` is a direction name ('East'), or a test such as onTrip() gives for a route with more than one road.
const facing = (dir) => (typeof dir === 'function' ? dir : (rec) => inDir(rec.dir, dir));
export function closuresDuring(data, fromMs, toMs, dir) {
  const on = facing(dir);
  return data.closures.filter((c) => !isRamp(c) && on(c) && c.start < toMs && (c.end == null || c.end > fromMs));
}
// The closures in force when the drive gets to them, not at any time during the whole drive: a night closure
// near Kyburz that starts three hours after you have passed it does not count. `stops` is alongRoute() for
// this departure. Each closure is timed at both of its ends and counts if it is in force between those two
// moments, give or take TH.closureMarginMin (a stop for food, slower traffic). One without a position is
// checked against the whole drive, as before.
export function closuresOnDrive(data, dest, stops, direction, dir) {
  const r = dest.route;
  const pass = passOf(r, stops, direction);
  const margin = TH.closureMarginMin * 6e4;
  const on = facing(dir);
  const here = (lat, lon) => (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? timeAt(r, pass, direction, { lat, lon }).ms : null);
  return data.closures.filter((c) => {
    if (isRamp(c) || !on(c)) return false;
    const a = here(c.lat, c.lon);
    const b = here(c.endLat, c.endLon) ?? a;
    const [from, to] = a == null ? [stops[0].ms, stops[stops.length - 1].ms] : [Math.min(a, b) - margin, Math.max(a, b) + margin];
    return c.start < to && (c.end == null || c.end > from);
  });
}
export const isSerious = (x) => /collision|closure|sigalert|fatal|spin/i.test(x.type);
// East of where the mountain road begins (route.mountainLonMin). A record without a position counts.
export const onMountain = (route, x) => route.mountainLonMin == null || !Number.isFinite(x.lon) || x.lon >= route.mountainLonMin;
export const incidentsFor = (data, dir) => data.incidents.filter(facing(dir));

export function evaluate(data, dest, opts) {
  const { departMs, direction, vehicle, nowMs = Date.now() } = opts;
  const r = dest.route;
  const dir = direction === 'out' ? r.outboundDir : r.returnDir;
  const dt = driveTime(data, dest, departMs, direction, nowMs);
  const endMs = departMs + dt.hours * 36e5;
  const live = departMs - nowMs <= TH.liveHorizonH * 36e5;
  const st = data.status || {};
  const factors = [];
  const fc = forecastFactors(data, dest, departMs, direction, dt.hours, nowMs, dt.stops, vehicle);
  // A source that failed on the last refresh either has nothing (unconfirmed), or still carries its last good
  // data: that is judged as usual, tagged with its age, and no better than caution once it is too old.
  const src = (k) => st[k]?.ok !== false || st[k].dataAt != null;
  const add = (k, f) => factors.push(stamp(f, st[k]?.ok === false ? st[k].dataAt : null, nowMs));

  // 1. Chain control (live)
  if (!src('chain')) factors.push({ key: 'chain', level: 'caution', msg: 'srcFailed' });
  else {
    const c = chainOn(data, r, direction);
    const cv = chainVerdict(c.max, vehicle);
    add('chain', { key: 'chain', level: live ? cv.level : 'info', msg: c.max < 0 && !c.rows.length ? 'chainNoRows' : cv.msg, v: c, live });
  }

  // 2. Closures (scheduled + active lane closures), in the direction of travel
  if (!src('closures')) factors.push({ key: 'closures', level: 'caution', msg: 'srcFailed' });
  else {
    const cl = closuresOnDrive(data, dest, fc.stops, direction, onTrip(r, direction));
    const full = cl.filter(isFull);
    const delay = Math.max(0, ...cl.map((c) => c.delayMin));
    const level = full.length ? 'nogo' : cl.length && delay >= 15 ? 'caution' : 'ok';
    add('closures', { key: 'closures', level, msg: full.length ? 'closedFull' : cl.length ? 'closedLanes' : 'closedNone', v: { list: cl, full, delay } });
  }

  // 3. CHP incidents (live only), in the direction of travel
  if (!src('incidents')) factors.push({ key: 'incidents', level: 'caution', msg: 'srcFailed' });
  else {
    const all = incidentsFor(data, onTrip(r, direction));
    // Only the mountain section decides. Collisions in the Sacramento valley are an hour or two from the pass,
    // are usually cleared by then, and the delay they cause is already in the TomTom drive time.
    const serious = all.filter((x) => isSerious(x) && onMountain(r, x));
    const level = live && serious.length ? 'caution' : live ? 'ok' : 'info';
    add('incidents', { key: 'incidents', level, msg: all.length ? 'incSome' : 'incNone', v: { all, serious }, live });
  }

  // 4-6. Forecast for the drive window
  if (!src('alerts')) factors.push({ key: 'alerts', level: 'caution', msg: 'srcFailed' });
  for (const f of fc.factors) {
    if (f.key !== 'alerts') factors.push(f);
    else if (src('alerts')) add('alerts', f);
  }

  // Drive time (TomTom). Only an unusually slow drive changes the verdict. Carried-over times are still used
  // while they are recent enough for driveTime(); after that it falls back to the fixed estimate.
  // Snow on the way adds time TomTom does not know about. The one exception: leaving now with chain control
  // already up, where the live time has the slow traffic in it.
  const chainNow = factors.find((f) => f.key === 'chain')?.v?.max > 0;
  if (fc.delay && !(dt.src === 'live' && chainNow)) dt.snowMin = fc.delay;
  if (dt.src !== 'fixed') add('drive', { key: 'drive', level: dt.deltaMin >= 60 ? 'caution' : 'ok', msg: dt.src === 'live' ? 'driveLive' : 'driveFc', v: dt });
  else if (st.drive?.ok === false) factors.push({ key: 'drive', level: 'info', msg: 'driveFailed' });
  // No drive times are fetched for this destination: say what the times on the page assume and link to the live one.
  else if (dest.driveTimes === 'maps') factors.push({ key: 'drive', level: 'info', msg: 'driveMaps' });

  // 7. Lift wind-hold risk on the ski day (arrival day for outbound trips)
  if (direction === 'out') {
    const liftDay = dayKey(endMs + 6 * 36e5);
    const lift = liftRisk(data, dest, liftDay);
    if (lift) lift.day = liftDay;
    if (lift) factors.push(stamp({ key: 'lift', level: lift.level === 'high' ? 'caution' : 'ok', msg: `lift_${lift.level}`, v: lift }, weatherStaleAt(data, [dest.resort.summitPoint]), nowMs));
  }

  // 8. Cold along the route (EV range)
  const temps = fc.stops.map((s) => s.temp).filter((t) => t != null);
  if (vehicle.ev && temps.length) {
    const min = Math.min(...temps);
    const evAt = weatherStaleAt(data, fc.stops.map((s) => s.point.id));
    factors.push({ key: 'ev', level: 'info', msg: min <= -7 ? 'evCold' : min <= 2 ? 'evCool' : 'evMild', v: min, ...(evAt ? { staleAt: evAt } : {}) });
  }

  // 9. Freshness
  const ageMin = (nowMs - data.generatedAt) / 6e4;
  if (ageMin > TH.staleMin) factors.push({ key: 'fresh', level: 'caution', msg: 'stale', v: ageMin });

  const level = factors.reduce((l, f) => worst(l, f.level), 'ok');
  return { level: level === 'ok' ? 'go' : level, factors, stops: fc.stops, live, dir, drive: dt, endMs };
}

// Hour-by-hour departure risk for one day, forecast-only.
export function departureStrip(data, dest, ix, day, direction, nowMs = Date.now(), vehicle = null) {
  // Always 24 columns: hours earlier today that the forecast no longer covers are shown as past.
  const have = ix.hours.filter((h) => h.day === day);
  const first = have[0];
  const lead = first ? Array.from({ length: first.h }, (_, h) => ({ i: -1, ms: first.ms - (first.h - h) * 36e5, day, h })) : [];
  return [...lead, ...have]
    .map((h) => {
      if (h.i < 0) return { ...h, past: true, level: 'ok', drive: null };
      const dt = driveTime(data, dest, Math.max(h.ms, nowMs), direction, nowMs);
      const fc = forecastFactors(data, dest, h.ms, direction, dt.hours, nowMs, dt.stops, vehicle);
      return { ...h, past: h.ms + 36e5 <= nowMs, level: fc.level, heavy: fc.heavy, drive: dt.src === 'fixed' ? null : dt };
    });
}
export function bestWindow(strip, from = 5, to = 21) {
  const ok = strip.filter((s) => !s.past && s.h >= from && s.h <= to);
  let best = null;
  let run = [];
  const flush = () => { if (run.length && (!best || run.length > best.length)) best = run; run = []; };
  for (const s of ok) {
    if (s.level === 'ok' && (!run.length || s.h === run[run.length - 1].h + 1)) run.push(s);
    else { flush(); if (s.level === 'ok') run.push(s); }
  }
  flush();
  return best ? { from: best[0].h, to: best[best.length - 1].h } : null;
}

// The latest departure of the day that the forecast still calls clear, when leaving later than that is
// worse: the deadline for the drive home before a storm arrives. `cells` is departureStrip() for one day (or a
// week-overview row). Returns { h, ms }, or null when there is no such deadline: the forecast stays clear to
// the end of the day, or no departure between `from` and `to` is clear at all (`none: true` tells that apart).
export function lastClear(cells, from = 5, to = 21) {
  const ahead = cells.filter((s) => !s.past && !s.none);
  const last = ahead.filter((s) => s.level === 'ok' && s.h >= from && s.h <= to).at(-1);
  if (!last) return ahead.some((s) => s.h >= from && s.h <= to) ? { none: true } : null;
  return ahead.some((s) => s.h > last.h && s.level !== 'ok') ? { h: last.h, ms: last.ms } : null;
}

// One row per day for the week overview: 24 hourly departures each (level + drive time), the fastest
// low-risk departure of the day within the usual waking window, the latest clear departure where later is
// worse (lastClear), and the range of drive times shown.
export function weekOverview(data, dest, ix, direction, nowMs = Date.now(), from = 5, to = 21, vehicle = null) {
  let lo = Infinity;
  let hi = -Infinity;
  const rows = ix.days.map((day) => {
    const byH = new Map(departureStrip(data, dest, ix, day, direction, nowMs, vehicle).map((s) => [s.h, s]));
    const cells = Array.from({ length: 24 }, (_, h) => byH.get(h) || { h, day, none: true });
    let best = null;
    for (const c of cells) {
      if (c.none || c.past || !c.drive) continue;
      lo = Math.min(lo, c.drive.sec);
      hi = Math.max(hi, c.drive.sec);
      if (c.h < from || c.h > to) continue;
      if (!best || LV[c.level] < LV[best.level] || (LV[c.level] === LV[best.level] && c.drive.sec < best.drive.sec)) best = c;
    }
    const last = lastClear(cells, from, to);
    return { day, cells, best, last: last?.none ? null : last };
  }).filter((r) => r.cells.some((c) => !c.none && !c.past));
  return { rows, lo: lo === Infinity ? null : lo, hi: hi === -Infinity ? null : hi };
}

// ---------- daily summaries ----------
export function daily(data, ix, pointId, hFrom = 0, hTo = 23) {
  const w = data.weather[pointId];
  if (!w) return [];
  return ix.days.map((day) => {
    const hs = ix.hours.filter((h) => h.day === day && h.h >= hFrom && h.h <= hTo);
    const col = (f) => hs.map((h) => w[f][h.i]).filter((v) => v != null);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const temp = col('temp');
    const snow = sum(col('snow'));
    const qpf = sum(col('qpf'));
    const sl = col('snowLevel');
    const have = hs.filter((h) => w.temp[h.i] != null);
    return {
      day,
      // The first and last hour the figures cover: today starts at the current hour, the last day ends early.
      h0: have.length ? have[0].h : null,
      h1: have.length ? have[have.length - 1].h : null,
      n: temp.length,
      full: temp.length >= Math.min(20, hTo - hFrom + 1),
      hi: temp.length ? Math.max(...temp) : null,
      lo: temp.length ? Math.min(...temp) : null,
      feelsLo: col('feels').length ? Math.min(...col('feels')) : null,
      gust: col('gust').length ? Math.max(...col('gust')) : null,
      wind: col('wind').length ? sum(col('wind')) / col('wind').length : null,
      pop: col('pop').length ? Math.max(...col('pop')) : null,
      sky: col('sky').length ? sum(col('sky')) / col('sky').length : null,
      snow,
      qpf,
      ratio: snow >= 5 && qpf >= 0.5 ? snow / qpf : null,
      slLo: sl.length ? Math.min(...sl) : null,
      slHi: sl.length ? Math.max(...sl) : null,
    };
  }).filter((d) => d.n > 0);
}

export function liftRisk(data, dest, day) {
  const w = data.weather[dest.resort.summitPoint];
  if (!w) return null;
  const ix = index(data);
  const g = ix.hours.filter((h) => h.day === day && h.h >= 8 && h.h <= 16).map((h) => w.gust[h.i]).filter((v) => v != null);
  if (!g.length) return null;
  const gust = Math.max(...g);
  return { gust, level: gust >= TH.gustLiftHigh ? 'high' : gust >= TH.gustLiftMod ? 'mod' : 'low' };
}

// Ski-day outlook: fresh snow = overnight + daytime up to closing.
export function skiDays(data, dest, ix) {
  const sid = dest.resort.summitPoint;
  const w = data.weather[sid];
  if (!w) return [];
  const day = daily(data, ix, sid, 8, 16);
  return day.map((d, k) => {
    const prevDay = ix.days[ix.days.indexOf(d.day) - 1];
    const overnight = ix.hours
      .filter((h) => (h.day === prevDay && h.h >= 16) || (h.day === d.day && h.h < 8))
      .reduce((s, h) => s + (w.snow[h.i] || 0), 0);
    const lift = liftRisk(data, dest, d.day);
    return { ...d, overnight, fresh: overnight + d.snow, lift, k };
  });
}

// ---------- clothing ----------
// Returns i18n keys; the UI turns them into text.
export function clothing(mtn, town) {
  const out = { mountain: [], town: [] };
  if (mtn) {
    const f = mtn.feelsLo ?? mtn.lo;
    const wet = mtn.snow >= 5 || (mtn.pop ?? 0) >= 50;
    out.mountain.push(f <= -12 ? 'baseHeavy' : f <= -4 ? 'baseMid' : 'baseLight');
    out.mountain.push(f <= -12 ? 'midPuffy' : f <= -5 ? 'midFleece' : f <= 2 ? 'midLight' : 'midNone');
    out.mountain.push(f <= -8 ? 'shellInsulated' : wet || f <= 2 ? 'shellHard' : 'shellSoft');
    out.mountain.push(f <= -10 ? 'handsMitts' : f <= -3 ? 'handsGloves' : 'handsSpring');
    if (f <= -10 || (mtn.gust ?? 0) >= 40) out.mountain.push('faceCover');
    out.mountain.push(wet || (mtn.sky ?? 50) >= 70 ? 'lensLow' : (mtn.sky ?? 50) <= 30 ? 'lensSun' : 'lensAll');
    if (f <= -15) out.mountain.push('warmers');
  }
  if (town) {
    const t = town.lo;
    out.town.push(t <= -8 ? 'townParka' : t <= 2 ? 'townPuffy' : t <= 10 ? 'townJacket' : 'townLight');
    if (town.snow >= 10 || (town.pop ?? 0) >= 50) out.town.push('townBoots');
    if (t <= -3) out.town.push('townHat');
  }
  return out;
}

// ----- food along the way -----
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dowFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
// Day of the week (0 = Sunday) and minutes since midnight, Pacific time.
function clock(ms) {
  const p = Object.fromEntries(dowFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { dow: DOW.indexOf(p.weekday.toLowerCase()), min: (+p.hour % 24) * 60 + +p.minute };
}
// 'HH:MM-HH:MM[,HH:MM-HH:MM]' as [open, close] minutes; a close at or before the open runs past midnight.
function ranges(spec) {
  if (!spec) return [];
  return String(spec).split(',').map((s) => {
    const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const a = +m[1] * 60 + +m[2];
    let b = +m[3] * 60 + +m[4];
    if (b <= a) b += 1440;
    return [a, b];
  }).filter(Boolean);
}
const dayRanges = (hours, dow) => ranges(DOW[dow] in hours ? hours[DOW[dow]] : hours.daily);

// Whether a place is open at `ms`, from its hand-entered hours: { state: 'open' | 'closing' | 'closed' | 'unknown' }.
// 'closing' is open but shutting within `soonMin`. `closeMin` / `openMin` are minutes until it closes / next opens.
export function openAt(hours, ms, soonMin = 45) {
  if (!hours) return { state: 'unknown' };
  const { dow, min } = clock(ms);
  // Today's ranges, plus yesterday's that run past midnight.
  const spans = [...dayRanges(hours, dow), ...dayRanges(hours, (dow + 6) % 7).map(([a, b]) => [a - 1440, b - 1440])];
  const cur = spans.filter(([a, b]) => min >= a && min < b).sort((x, y) => y[1] - x[1])[0];
  if (cur) return { state: cur[1] - min <= soonMin ? 'closing' : 'open', closeMin: cur[1] - min };
  const next = spans.map(([a]) => a).filter((a) => a > min).sort((x, y) => x - y)[0];
  return { state: 'closed', openMin: next != null ? next - min : null };
}

// Hours from the origin to a place on a normal drive: the place is dropped onto the nearest leg between
// two timed route points and takes its share of that leg's time. An explicit `offsetH` wins.
export function placeOffsetH(route, place) {
  if (Number.isFinite(place.offsetH)) return place.offsetH;
  const pts = route.points.filter((p) => p.offsetH != null);
  const k = Math.cos((place.lat * Math.PI) / 180);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const [bx, by] = [(b.lon - a.lon) * k, b.lat - a.lat];
    const [px, py] = [(place.lon - a.lon) * k, place.lat - a.lat];
    const f = Math.min(1, Math.max(0, (px * bx + py * by) / (bx * bx + by * by || 1)));
    const d = (px - f * bx) ** 2 + (py - f * by) ** 2;
    if (!best || d < best.d) best = { d, h: a.offsetH + f * (b.offsetH - a.offsetH) };
  }
  return best ? best.h : 0;
}

// The timed route points of a drive (alongRoute()) with their nominal offset in driving order, for timeAt().
function passOf(r, stops, direction) {
  return stops.map((x) => ({ at: offsetFor(r, x.point, direction), ms: x.ms, point: x.point }));
}
// When this drive is at a place (anything with lat / lon, or an explicit offsetH): its share of the leg it lies
// on, between the times the drive reaches the route points either side. `leg` is those two points.
function timeAt(r, pass, direction, place) {
  const at = offsetFor(r, { offsetH: placeOffsetH(r, place) }, direction);
  let i = pass.findIndex((x) => x.at >= at);
  if (i <= 0) i = i === 0 ? 1 : pass.length - 1;
  const [a, b] = [pass[i - 1], pass[i]];
  return { at, ms: a.ms + (b.at > a.at ? (at - a.at) / (b.at - a.at) : 0) * (b.ms - a.ms), leg: [a.point, b.point] };
}

// The places on this destination's route in the order you drive past them, each with the time you would
// reach it for this departure, whether it is open then, and the leg it is on (`leg`: the route points
// before and after it, in driving order). Uses the drive time already on hand
// (`hours`, `stopSec` from driveTime()), so it costs no extra lookups.
export function foodStops(data, dest, places, departMs, direction, hours = dest.route.driveHours, stopSec = null) {
  const r = dest.route;
  const pass = passOf(r, alongRoute(data, dest, departMs, direction, hours, stopSec), direction);
  return places.filter((p) => !p.highway || p.highway === r.highway).map((p) => {
    const x = timeAt(r, pass, direction, p);
    return { place: p, at: x.at, ms: x.ms, open: openAt(p.hours, x.ms), leg: x.leg };
  }).sort((x, y) => x.at - y.at);
}

// ---------- TomTom allowance ----------
// How much of the month's free TomTom requests is used, from the count the fetch script publishes
// (`data.tomtom`). lv 1: close to the allowance, lv 2: past it. `from` is set only when the count began
// part-way through the month, so the figure is lower than what TomTom has really served.
export const QUOTA_WARN = 0.8;
export function quotaState(tt) {
  if (!tt?.quota || tt.monthN == null) return null;
  const pct = tt.monthN / tt.quota;
  return { n: tt.monthN, quota: tt.quota, pct, lv: pct >= 1 ? 2 : pct >= QUOTA_WARN ? 1 : 0, month: tt.month, from: tt.from && !tt.from.endsWith('-01') ? tt.from : null };
}

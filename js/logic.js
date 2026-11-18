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

// Where a drive time carries `stops` (seconds from departure to each timed route point, in route order, from
// TomTom), it is passed on so alongRoute() can use the real pass-through times.
// How long the drive takes for a given departure: live TomTom time if leaving about now, otherwise the
// forecast (hourly for the next day, then a coarser grid out to 7 days), otherwise the route's fixed estimate.
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
  const h = [...near, ...(d.long?.[direction] || []).filter((x) => x.ms > nearEnd)];
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

// Forecast-only factors for a given departure. Used for the verdict and the hour-by-hour strip.
export function forecastFactors(data, dest, departMs, direction, hours = dest.route.driveHours, nowMs = Date.now(), stopSec = null) {
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

  // NWS alerts overlapping the drive.
  const endMs = departMs + hours * 36e5;
  const active = data.alerts.filter((a) => a.onset < endMs && a.ends > departMs);
  let aLevel = 'ok';
  for (const a of active) {
    if (/blizzard|ice storm|avalanche warning/i.test(a.event)) aLevel = worst(aLevel, 'nogo');
    else if (/warning|advisory/i.test(a.event)) aLevel = worst(aLevel, 'caution');
  }
  factors.push({ key: 'alerts', level: active.length ? aLevel : 'ok', msg: active.length ? 'alertsActive' : 'alertsNone', v: active });

  const gust = Math.max(0, ...mtn.map((s) => s.gust ?? 0));
  if (gust >= TH.gustRoad) factors.push({ key: 'wind', level: 'caution', msg: 'windHigh', v: gust });

  const wxAt = weatherStaleAt(data, r.mountainPoints);
  for (const f of factors) if (f.key === 'snow' || f.key === 'wind') stamp(f, wxAt, nowMs);

  // `heavy`: snowing hard enough that chain control is very likely, so the charts can tell it from light snow.
  return { factors, stops, level: factors.reduce((l, f) => worst(l, f.level), 'ok'), heavy: peak.rate >= TH.snowHeavy };
}

// What a given chain level means for this vehicle.
export function chainVerdict(level, v) {
  if (level <= 0) return { level: 'ok', msg: 'chainNone' };
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

export function chainFor(data, highway, dir) {
  const rows = data.chain.filter((c) => c.hw === highway && (!c.dir || c.dir === dir));
  const max = rows.reduce((m, c) => Math.max(m, c.level), -1);
  return { rows, max, active: rows.filter((c) => c.level > 0) };
}

export const isRamp = (c) => /ramp|connector/i.test(c.facility || '');
export const isFull = (c) => /full/i.test(c.type) && !isRamp(c);
// Closures and incidents carry a direction of travel ('East', 'West', 'East / West'). A record with no
// direction, or one that is not stated, counts for both ways.
export const inDir = (recDir, dir) => !dir || !recDir || recDir === 'N/A' || recDir.includes(dir);
export function closuresDuring(data, fromMs, toMs, dir) {
  return data.closures.filter((c) => !isRamp(c) && inDir(c.dir, dir) && c.start < toMs && (c.end == null || c.end > fromMs));
}
export const isSerious = (x) => /collision|closure|sigalert|fatal|spin/i.test(x.type);
// East of where the mountain road begins (route.mountainLonMin). A record without a position counts.
export const onMountain = (route, x) => route.mountainLonMin == null || !Number.isFinite(x.lon) || x.lon >= route.mountainLonMin;
export const incidentsFor = (data, dir) => data.incidents.filter((x) => inDir(x.dir, dir));

export function evaluate(data, dest, opts) {
  const { departMs, direction, vehicle, nowMs = Date.now() } = opts;
  const r = dest.route;
  const dir = direction === 'out' ? r.outboundDir : r.returnDir;
  const dt = driveTime(data, dest, departMs, direction, nowMs);
  const endMs = departMs + dt.hours * 36e5;
  const live = departMs - nowMs <= TH.liveHorizonH * 36e5;
  const st = data.status || {};
  const factors = [];
  // A source that failed on the last refresh either has nothing (unconfirmed), or still carries its last good
  // data: that is judged as usual, tagged with its age, and no better than caution once it is too old.
  const src = (k) => st[k]?.ok !== false || st[k].dataAt != null;
  const add = (k, f) => factors.push(stamp(f, st[k]?.ok === false ? st[k].dataAt : null, nowMs));

  // 1. Chain control (live)
  if (!src('chain')) factors.push({ key: 'chain', level: 'caution', msg: 'srcFailed' });
  else {
    const c = chainFor(data, r.highway, dir);
    const cv = chainVerdict(c.max, vehicle);
    add('chain', { key: 'chain', level: live ? cv.level : 'info', msg: cv.msg, v: c, live });
  }

  // 2. Closures (scheduled + active lane closures), in the direction of travel
  if (!src('closures')) factors.push({ key: 'closures', level: 'caution', msg: 'srcFailed' });
  else {
    const cl = closuresDuring(data, departMs, endMs, dir);
    const full = cl.filter(isFull);
    const delay = Math.max(0, ...cl.map((c) => c.delayMin));
    const level = full.length ? 'nogo' : cl.length && delay >= 15 ? 'caution' : 'ok';
    add('closures', { key: 'closures', level, msg: full.length ? 'closedFull' : cl.length ? 'closedLanes' : 'closedNone', v: { list: cl, full, delay } });
  }

  // 3. CHP incidents (live only), in the direction of travel
  if (!src('incidents')) factors.push({ key: 'incidents', level: 'caution', msg: 'srcFailed' });
  else {
    const all = incidentsFor(data, dir);
    // Only the mountain section decides. Collisions in the Sacramento valley are an hour or two from the pass,
    // are usually cleared by then, and the delay they cause is already in the TomTom drive time.
    const serious = all.filter((x) => isSerious(x) && onMountain(r, x));
    const level = live && serious.length ? 'caution' : live ? 'ok' : 'info';
    add('incidents', { key: 'incidents', level, msg: all.length ? 'incSome' : 'incNone', v: { all, serious }, live });
  }

  // 4-6. Forecast for the drive window
  if (!src('alerts')) factors.push({ key: 'alerts', level: 'caution', msg: 'srcFailed' });
  const fc = forecastFactors(data, dest, departMs, direction, dt.hours, nowMs, dt.stops);
  for (const f of fc.factors) {
    if (f.key !== 'alerts') factors.push(f);
    else if (src('alerts')) add('alerts', f);
  }

  // Drive time (TomTom). Only an unusually slow drive changes the verdict. Carried-over times are still used
  // while they are recent enough for driveTime(); after that it falls back to the fixed estimate.
  if (dt.src !== 'fixed') add('drive', { key: 'drive', level: dt.deltaMin >= 60 ? 'caution' : 'ok', msg: dt.src === 'live' ? 'driveLive' : 'driveFc', v: dt });
  else if (st.drive?.ok === false) factors.push({ key: 'drive', level: 'info', msg: 'driveFailed' });

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
export function departureStrip(data, dest, ix, day, direction, nowMs = Date.now()) {
  // Always 24 columns: hours earlier today that the forecast no longer covers are shown as past.
  const have = ix.hours.filter((h) => h.day === day);
  const first = have[0];
  const lead = first ? Array.from({ length: first.h }, (_, h) => ({ i: -1, ms: first.ms - (first.h - h) * 36e5, day, h })) : [];
  return [...lead, ...have]
    .map((h) => {
      if (h.i < 0) return { ...h, past: true, level: 'ok', drive: null };
      const dt = driveTime(data, dest, Math.max(h.ms, nowMs), direction, nowMs);
      const fc = forecastFactors(data, dest, h.ms, direction, dt.hours, nowMs, dt.stops);
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

// One row per day for the week overview: 24 hourly departures each (level + drive time), the fastest
// low-risk departure of the day within the usual waking window, and the range of drive times shown.
export function weekOverview(data, dest, ix, direction, nowMs = Date.now(), from = 5, to = 21) {
  let lo = Infinity;
  let hi = -Infinity;
  const rows = ix.days.map((day) => {
    const byH = new Map(departureStrip(data, dest, ix, day, direction, nowMs).map((s) => [s.h, s]));
    const cells = Array.from({ length: 24 }, (_, h) => byH.get(h) || { h, day, none: true });
    let best = null;
    for (const c of cells) {
      if (c.none || c.past || !c.drive) continue;
      lo = Math.min(lo, c.drive.sec);
      hi = Math.max(hi, c.drive.sec);
      if (c.h < from || c.h > to) continue;
      if (!best || LV[c.level] < LV[best.level] || (LV[c.level] === LV[best.level] && c.drive.sec < best.drive.sec)) best = c;
    }
    return { day, cells, best };
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
    return {
      day,
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

// The places on this destination's route in the order you drive past them, each with the time you would
// reach it for this departure, whether it is open then, and the leg it is on (`leg`: the route points
// before and after it, in driving order). Uses the drive time already on hand
// (`hours`, `stopSec` from driveTime()), so it costs no extra lookups.
export function foodStops(data, dest, places, departMs, direction, hours = dest.route.driveHours, stopSec = null) {
  const r = dest.route;
  const pass = alongRoute(data, dest, departMs, direction, hours, stopSec).map((x) => ({ at: offsetFor(r, x.point, direction), ms: x.ms, point: x.point }));
  return places.filter((p) => !p.highway || p.highway === r.highway).map((p) => {
    const at = offsetFor(r, { offsetH: placeOffsetH(r, p) }, direction);
    let i = pass.findIndex((x) => x.at >= at);
    if (i <= 0) i = i === 0 ? 1 : pass.length - 1;
    const [a, b] = [pass[i - 1], pass[i]];
    const ms = a.ms + (b.at > a.at ? (at - a.at) / (b.at - a.at) : 0) * (b.ms - a.ms);
    return { place: p, at, ms, open: openAt(p.hours, ms), leg: [a.point, b.point] };
  }).sort((x, y) => x.at - y.at);
}

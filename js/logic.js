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

const at = (w, field, i) => (w && i >= 0 && i < w[field].length ? w[field][i] : null);
const idx = (data, ms) => Math.round((ms - data.t0) / 36e5);

export function offsetFor(route, point, direction) {
  if (point.offsetH == null) return direction === 'out' ? route.driveHours : 0;
  return direction === 'out' ? point.offsetH : route.driveHours - point.offsetH;
}

// Conditions at each route point at the moment you'd drive through it.
export function alongRoute(data, dest, departMs, direction) {
  const r = dest.route;
  const pts = r.points.filter((p) => p.offsetH != null);
  const ordered = direction === 'out' ? pts : [...pts].reverse();
  return ordered.map((p) => {
    const ms = departMs + offsetFor(r, p, direction) * 36e5;
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

// Forecast-only factors for a given departure. Used for the verdict and the hour-by-hour strip.
export function forecastFactors(data, dest, departMs, direction) {
  const r = dest.route;
  const stops = alongRoute(data, dest, departMs, direction);
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
  if (missing && peak.rate === 0) factors.push({ key: 'snow', level: 'caution', msg: 'snowUnknown' });
  else if (peak.rate >= TH.snowExtreme) factors.push({ key: 'snow', level: 'nogo', msg: 'snowExtreme', v: peak });
  else if (peak.rate >= TH.snowHeavy) factors.push({ key: 'snow', level: 'caution', msg: 'snowHeavy', v: peak });
  else if (peak.rate >= TH.snowLight) factors.push({ key: 'snow', level: 'caution', msg: 'snowLight', v: peak });
  else factors.push({ key: 'snow', level: 'ok', msg: peak.rate > 0 ? 'snowTrace' : 'snowNone', v: peak });

  // NWS alerts overlapping the drive.
  const endMs = departMs + r.driveHours * 36e5;
  const active = data.alerts.filter((a) => a.onset < endMs && a.ends > departMs);
  let aLevel = 'ok';
  for (const a of active) {
    if (/blizzard|ice storm|avalanche warning/i.test(a.event)) aLevel = worst(aLevel, 'nogo');
    else if (/warning|advisory/i.test(a.event)) aLevel = worst(aLevel, 'caution');
  }
  factors.push({ key: 'alerts', level: active.length ? aLevel : 'ok', msg: active.length ? 'alertsActive' : 'alertsNone', v: active });

  const gust = Math.max(0, ...mtn.map((s) => s.gust ?? 0));
  if (gust >= TH.gustRoad) factors.push({ key: 'wind', level: 'caution', msg: 'windHigh', v: gust });

  return { factors, stops, level: factors.reduce((l, f) => worst(l, f.level), 'ok') };
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
export function closuresDuring(data, fromMs, toMs) {
  return data.closures.filter((c) => !isRamp(c) && c.start < toMs && (c.end == null || c.end > fromMs));
}

export function evaluate(data, dest, opts) {
  const { departMs, direction, vehicle, nowMs = Date.now() } = opts;
  const r = dest.route;
  const dir = direction === 'out' ? r.outboundDir : r.returnDir;
  const endMs = departMs + r.driveHours * 36e5;
  const live = departMs - nowMs <= TH.liveHorizonH * 36e5;
  const st = data.status || {};
  const factors = [];
  const src = (k) => st[k]?.ok !== false;

  // 1. Chain control (live)
  if (!src('chain')) factors.push({ key: 'chain', level: 'caution', msg: 'srcFailed' });
  else {
    const c = chainFor(data, r.highway, dir);
    const cv = chainVerdict(c.max, vehicle);
    factors.push({ key: 'chain', level: live ? cv.level : 'info', msg: cv.msg, v: c, live });
  }

  // 2. Closures (scheduled + active lane closures)
  if (!src('closures')) factors.push({ key: 'closures', level: 'caution', msg: 'srcFailed' });
  else {
    const cl = closuresDuring(data, departMs, endMs);
    const full = cl.filter(isFull);
    const delay = Math.max(0, ...cl.map((c) => c.delayMin));
    const level = full.length ? 'nogo' : cl.length && delay >= 15 ? 'caution' : 'ok';
    factors.push({ key: 'closures', level, msg: full.length ? 'closedFull' : cl.length ? 'closedLanes' : 'closedNone', v: { list: cl, full, delay } });
  }

  // 3. CHP incidents (live only)
  if (!src('incidents')) factors.push({ key: 'incidents', level: 'caution', msg: 'srcFailed' });
  else {
    const serious = data.incidents.filter((x) => /collision|closure|sigalert|fatal|spin/i.test(x.type));
    const level = live && serious.length ? 'caution' : live ? 'ok' : 'info';
    factors.push({ key: 'incidents', level, msg: data.incidents.length ? 'incSome' : 'incNone', v: { all: data.incidents, serious }, live });
  }

  // 4-6. Forecast for the drive window
  if (!src('alerts')) factors.push({ key: 'alerts', level: 'caution', msg: 'srcFailed' });
  const fc = forecastFactors(data, dest, departMs, direction);
  for (const f of fc.factors) if (f.key !== 'alerts' || src('alerts')) factors.push(f);

  // 7. Lift wind-hold risk on the ski day (arrival day for outbound trips)
  if (direction === 'out') {
    const lift = liftRisk(data, dest, dayKey(endMs + 6 * 36e5));
    if (lift) factors.push({ key: 'lift', level: lift.level === 'high' ? 'caution' : 'ok', msg: `lift_${lift.level}`, v: lift });
  }

  // 8. Cold along the route (EV range)
  const temps = fc.stops.map((s) => s.temp).filter((t) => t != null);
  if (vehicle.ev && temps.length) {
    const min = Math.min(...temps);
    factors.push({ key: 'ev', level: 'info', msg: min <= -7 ? 'evCold' : min <= 2 ? 'evCool' : 'evMild', v: min });
  }

  // 9. Freshness
  const ageMin = (nowMs - data.generatedAt) / 6e4;
  if (ageMin > TH.staleMin) factors.push({ key: 'fresh', level: 'caution', msg: 'stale', v: ageMin });

  const level = factors.reduce((l, f) => worst(l, f.level), 'ok');
  return { level: level === 'ok' ? 'go' : level, factors, stops: fc.stops, live, dir };
}

// Hour-by-hour departure risk for one day, forecast-only.
export function departureStrip(data, dest, ix, day, direction, nowMs = Date.now()) {
  return ix.hours
    .filter((h) => h.day === day)
    .map((h) => ({ ...h, past: h.ms + 36e5 <= nowMs, level: forecastFactors(data, dest, h.ms, direction).level }));
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

import { DESTINATIONS, DEFAULT_VEHICLE } from './config.js';
import { CC_URL, normalizeChain } from './normalize.js';
import { makeT } from './i18n.js';
import { list } from './sync.js';
import * as L from './logic.js';

const TZ = 'America/Los_Angeles';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem('tr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tr.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const S = {
  lang: store.get('lang', 'zh'),
  tu: store.get('tu', 'C'), // temperature unit
  lu: store.get('lu', 'imp'), // length system
  theme: store.get('theme', 'auto'), // auto follows the device
  vehicle: { ...DEFAULT_VEHICLE, ...store.get('vehicle', {}) },
  destId: store.get('dest', DESTINATIONS[0].id),
  direction: store.get('direction', 'out'),
  depart: 'now', // or { day, h }
  tab: (location.hash || '#verdict').slice(1),
  wxPoint: null,
  data: null,
  ix: null,
  error: null,
  chainLiveAt: null,
  camsLoaded: new Set(),
};
let t = makeT(S.lang);
const dest = () => DESTINATIONS.find((d) => d.id === S.destId) || DESTINATIONS[0];
const nm = (o) => (typeof o === 'string' ? o : o[S.lang] || o.en);
const TABS = ['verdict', 'weather', 'roads', 'wear', 'resort', 'list'];
if (!TABS.includes(S.tab)) S.tab = 'verdict';

// ---------- formatting ----------
const loc = () => (S.lang === 'zh' ? 'zh-CN' : 'en-US');
const minus = (s) => String(s).replace('-', '−');
const fT = (c) => (c == null ? '–' : minus(Math.round(S.tu === 'C' ? c : c * 1.8 + 32)) + (S.tu === 'C' ? '°C' : '°F'));
const fT0 = (c) => (c == null ? '–' : minus(Math.round(S.tu === 'C' ? c : c * 1.8 + 32)) + '°');
function fSnow(mm) {
  if (mm == null) return '–';
  const v = S.lu === 'imp' ? mm / 25.4 : mm / 10;
  const u = S.lu === 'imp' ? '″' : ' cm';
  if (v < 0.05) return '0' + u;
  return (v >= 10 ? Math.round(v) : v.toFixed(1)) + u;
}
const fRain = (mm) => (mm == null ? '–' : S.lu === 'imp' ? (mm / 25.4).toFixed(2) + '″' : mm.toFixed(1) + ' mm');
const fElev = (m) => (m == null ? '–' : S.lu === 'imp' ? (Math.round((m * 3.28084) / 100) * 100).toLocaleString('en-US') + ' ft' : (Math.round(m / 50) * 50).toLocaleString('en-US') + ' m');
const fWind = (k) => (k == null ? '–' : S.lu === 'imp' ? Math.round(k / 1.609) + ' mph' : Math.round(k) + ' km/h');
const fDist = (km) => (S.lu === 'imp' ? Math.round(km / 1.609) + ' mi' : Math.round(km) + ' km');
const fTime = (ms) => new Intl.DateTimeFormat(loc(), { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: S.lang !== 'zh' }).format(ms);
const fHour = (h) => (S.lang === 'zh' ? `${h}时` : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`);
const fDayMs = (ms) => new Intl.DateTimeFormat(loc(), { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric' }).format(ms);
const dayMs = (day) => Date.parse(day + 'T12:00:00-08:00');
function fDay(day) {
  const today = L.dayKey(Date.now());
  if (day === today) return t('today');
  if (day === L.dayKey(Date.now() + 864e5)) return t('tomorrow');
  return fDayMs(dayMs(day));
}
const fDayFull = (day) => fDayMs(dayMs(day));
const fWhen = (ms) => `${fDay(L.dayKey(ms))} ${fTime(ms)}`;
function fAgo(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 6e4));
  if (m < 1) return t('justNow');
  return t('ago', { v: m < 90 ? `${m} ${t('min')}` : `${Math.round(m / 60)} ${t('hr')}` });
}
const ALERT_ZH = {
  'Winter Storm Warning': '冬季风暴警告', 'Winter Storm Watch': '冬季风暴监视', 'Winter Weather Advisory': '冬季天气提示', 'Blizzard Warning': '暴风雪警告',
  'Wind Advisory': '大风提示', 'High Wind Warning': '强风警告', 'High Wind Watch': '强风监视', 'Avalanche Warning': '雪崩警告', 'Avalanche Watch': '雪崩监视',
  'Lake Wind Advisory': '湖区大风提示', 'Freeze Warning': '冰冻警告', 'Dense Fog Advisory': '浓雾提示', 'Flood Watch': '洪水监视', 'Special Weather Statement': '特别天气声明',
};
const alertName = (e) => (S.lang === 'zh' && ALERT_ZH[e] ? `${ALERT_ZH[e]} (${e})` : e);

// ---------- data ----------
function departMs() {
  if (S.depart === 'now' || !S.ix) return Date.now();
  const h = S.ix.hours.find((x) => x.day === S.depart.day && x.h === S.depart.h);
  return h ? Math.max(h.ms, Date.now()) : Date.now();
}

async function loadData() {
  try {
    const r = await fetch(`data/${S.destId}.json?ts=${Math.floor(Date.now() / 6e4)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const liveChain = S.data && S.chainLiveAt ? S.data.chain : null;
    S.data = d;
    if (liveChain) { d.chain = liveChain; d.status.chain = { ok: true, at: S.chainLiveAt }; }
    S.ix = L.index(d);
    S.error = null;
  } catch (e) {
    S.error = String(e.message || e);
  }
  softRender();
  liveChain();
}

// Chain control straight from Caltrans (CORS-enabled), so the verdict is not limited by the scheduled refresh.
async function liveChain() {
  if (!S.data) return;
  const f = dest().feeds;
  try {
    const all = [];
    for (const d of f.ccDistricts) {
      const r = await fetch(CC_URL(d), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      all.push(...normalizeChain(await r.json(), f.chainHighways));
    }
    S.data.chain = all;
    S.chainLiveAt = Date.now();
    S.data.status.chain = { ok: true, at: S.chainLiveAt };
    softRender();
  } catch (e) {
    console.warn('live chain', e);
  }
}

// ---------- rendering ----------
const seg = (act, cur, opts) => `<div class="seg" role="group">${opts.map(([v, label]) => `<button data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${label}</button>`).join('')}</div>`;
const dot = (level) => `<span class="dot ${level}"></span>`;
// Collapsible section. Collapsed sections render without their body, so hidden images and streams never load.
const folded = new Set(store.get('folded', []));
function card(key, title, body, extra = '', cls = '') {
  const c = folded.has(key);
  return `<section class="card ${cls} ${c ? 'collapsed' : ''}" data-k="${key}"><h2 data-act="fold" data-v="${key}"><button class="fold" type="button" aria-expanded="${!c}"><span class="chev" aria-hidden="true"></span><span>${title}</span></button>${extra}</h2><div class="cbody">${c ? '' : body}</div></section>`;
}

function renderChrome() {
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en';
  const d = dest();
  document.documentElement.dataset.theme = S.theme;
  const sub = `<span class="via">${esc(d.route.label)} · ${fDist(d.route.distanceKm)}</span>`;
  $('#title').innerHTML = `<span class="brand">Tahoe Trip Planner</span><span class="where">` + (DESTINATIONS.length > 1
    ? `<select data-change="dest" aria-label="${t('dest')}">${DESTINATIONS.map((x) => `<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${esc(nm(x.name))}</option>`).join('')}</select>${sub}`
    : `<strong>${esc(nm(d.name))}</strong>${sub}`) + '</span>';
  $('#toggles').innerHTML =
    seg('lang', S.lang, [['zh', '中'], ['en', 'EN']]) + seg('tu', S.tu, [['C', '°C'], ['F', '°F']]) + seg('lu', S.lu, [['imp', 'in·ft'], ['met', 'cm·m']]) +
    `<button class="icon" data-act="theme" title="${t('theme')}: ${t('th.' + S.theme)}" aria-label="${t('theme')}: ${t('th.' + S.theme)}">${{ auto: '<svg viewBox="0 0 16 16" style="width:.95rem;height:.95rem" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>', light: '☀', dark: '☾' }[S.theme]}</button>` +
    `<button class="icon" data-act="refresh" title="${t('refresh')}" aria-label="${t('refresh')}">↻</button><button class="icon" data-act="settings" title="${t('settings')}" aria-label="${t('settings')}">⚙</button>`;
  $('#tabs').innerHTML = TABS.map((k) => `<a href="#${k}" class="${k === S.tab ? 'on' : ''}" ${k === S.tab ? 'aria-current="page"' : ''}>${t('tabs.' + k)}</a>`).join('');
  const st = S.data
    ? `${t('dataAt')} ${fAgo(S.data.generatedAt)}${S.chainLiveAt ? ` · ${t('chainLive')} ${t('liveTag')} ${fAgo(S.chainLiveAt)}` : ''}`
    : S.error ? `${t('loadFail')}: ${esc(S.error)}` : t('loading');
  $('#status').textContent = st;
  $('#foot').textContent = t('srcs');
}

function render() {
  t = makeT(S.lang);
  renderChrome();
  const m = $('#main');
  if (!S.data) { m.innerHTML = `<p class="muted pad">${S.error ? `${t('loadFail')}: ${esc(S.error)}` : t('loading')}</p>`; if (S.tab === 'list') m.innerHTML = viewList(); return; }
  m.innerHTML = { verdict: viewVerdict, weather: viewWeather, roads: viewRoads, wear: viewWear, resort: viewResort, list: viewList }[S.tab]();
}
// Background refreshes must not reload live streams or steal focus from the list input.
function softRender() {
  if (S.tab === 'resort' && S.camsLoaded.size) return renderChrome();
  if (S.tab === 'list' && document.activeElement?.id === 'newItem') return renderChrome();
  render();
}

// ----- verdict -----
function factorText(f) {
  const d = dest();
  const hw = d.route.label;
  const v = f.v;
  const where = (rows) => [...new Set(rows.map((r) => r.name))].slice(0, 2).join(', ');
  switch (f.key) {
    case 'chain': {
      if (!v) return t('m.' + f.msg);
      const top = v.rows.filter((r) => r.level === v.max);
      return t('m.' + f.msg, { hw, n: v.max, where: esc(where(top)) }) + (f.live ? '' : ` <span class="muted">(${t('refOnly')})</span>`);
    }
    case 'closures':
      if (!v) return t('m.' + f.msg);
      return t('m.' + f.msg, { hw, n: v.full.length || v.list.length, d: v.delay, where: esc(v.full.map((c) => `${c.from} → ${c.to}`).slice(0, 2).join('; ')) });
    case 'incidents':
      if (!v) return t('m.' + f.msg);
      return t('m.' + f.msg, { hw, n: v.all.length, s: v.serious.length }) + (f.live ? '' : ` <span class="muted">(${t('refOnly')})</span>`);
    case 'snow':
      return t('m.' + f.msg, v?.stop ? { rate: fSnow(v.rate), where: esc(nm(v.stop.point.name)) } : {});
    case 'alerts':
      if (!Array.isArray(v) || !v.length) return t('m.' + f.msg);
      return v.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(alertName(a.event))}</a> <span class="muted">${fWhen(a.onset)} – ${fWhen(a.ends)}</span>`).join('<br>');
    case 'wind': return t('m.' + f.msg, { v: fWind(v) });
    case 'lift': return t('m.' + f.msg, { v: fWind(v.gust), day: fDay(L.dayKey(departMs() + (d.route.driveHours + 6) * 36e5)) });
    case 'ev': return t('m.' + f.msg, { v: fT(v) });
    case 'fresh': return t('m.' + f.msg, { v: fAgo(Date.now() - v * 6e4).replace(/前$| ago$/, '') });
    default: return '';
  }
}

function viewVerdict() {
  const d = dest();
  const dm = departMs();
  const ev = L.evaluate(S.data, d, { departMs: dm, direction: S.direction, vehicle: S.vehicle });
  const day = L.dayKey(dm);
  const strip = L.departureStrip(S.data, d, S.ix, day, S.direction);
  const win = L.bestWindow(strip);
  const pick = S.depart !== 'now';
  const ends = S.direction === 'out' ? [d.route.points[0], d.route.points.find((p) => p.id === d.route.townPoint)] : [d.route.points.find((p) => p.id === d.route.townPoint), d.route.points[0]];

  const controls = `<div class="controls">
    ${seg('direction', S.direction, [['out', t('out')], ['back', t('back')]])}
    ${seg('mode', pick ? 'pick' : 'now', [['now', t('now')], ['pick', t('pick')]])}
    ${pick ? `<select data-change="day" aria-label="${t('day')}">${S.ix.days.map((x) => `<option value="${x}" ${x === day ? 'selected' : ''}>${fDay(x)}${x === L.dayKey(Date.now()) || x === L.dayKey(Date.now() + 864e5) ? ' · ' + fDayFull(x) : ''}</option>`).join('')}</select>` : ''}
  </div>`;

  const hero = `<section class="hero ${ev.level}">
    <div class="route">${esc(nm(ends[0].name))} → ${esc(nm(ends[1].name))}</div>
    <h1>${t(ev.level)}</h1>
    <p>${t(ev.level + 'Sub')}</p>
    <div class="times"><span>${t('departAt')} <b>${fWhen(dm)}</b></span><span>${t('arriveAt')} <b>${fTime(dm + d.route.driveHours * 36e5)}</b></span></div>
  </section>`;

  const order = { nogo: 0, caution: 1, ok: 2, info: 3 };
  const factors = [...ev.factors].sort((a, b) => order[a.level] - order[b.level]).map((f) => {
    const tag = ['chain', 'incidents'].includes(f.key) ? t('liveTag') : ['snow', 'alerts', 'wind', 'lift', 'ev'].includes(f.key) ? t('fcTag') : '';
    const link = { chain: '#roads', closures: '#roads', incidents: '#roads', snow: '#weather', lift: '#resort' }[f.key];
    return `<li class="${f.level}">${dot(f.level)}<div><div class="ft">${t('f.' + f.key)}${tag ? `<span class="tag">${tag}</span>` : ''}${link ? `<a class="more" href="${link}">›</a>` : ''}</div><div class="fm">${factorText(f)}</div></div></li>`;
  }).join('');

  const stripHtml = `<div class="strip" role="group">${strip.map((s) => {
    const sel = pick ? S.depart.h === s.h : L.hourOf(dm) === s.h;
    return `<button data-act="hour" data-v="${s.h}" class="${s.past ? 'past' : s.level} ${sel ? 'sel' : ''}" ${s.past ? 'disabled' : ''} title="${fHour(s.h)}"><i></i><span>${s.h % 3 === 0 ? fHour(s.h) : ''}</span></button>`;
  }).join('')}</div>
  <p class="note"><b>${win ? `${t('bestWin')}: ${fHour(win.from)} – ${fHour(win.to + 1)}` : t('noWin')}</b> · ${t('stripHint')}</p>`;

  const along = `<div class="tablewrap"><table><thead><tr><th></th><th>${t('time')}</th><th>${t('temp')}</th><th>${t('snowRate')}</th><th>${t('snowLevel')}</th><th>${t('gust')}</th></tr></thead><tbody>${ev.stops.map((s) => `<tr>
      <th>${esc(nm(s.point.name))}<small>${fElev(s.elevM)}</small></th><td>${fTime(s.ms)}</td>${s.missing ? `<td colspan="4" class="muted">${t('noData')}</td>` : `<td>${fT0(s.temp)}</td><td class="${s.snow >= L.TH.snowHeavy ? 'bad' : s.snow >= L.TH.snowLight ? 'warn' : ''}">${s.snow > 0 ? fSnow(s.snow) + '/h' : s.qpf > 0.1 ? '🌧' : '–'}</td><td>${fElev(s.snowLevel)}</td><td>${fWind(s.gust)}</td>`}</tr>`).join('')}</tbody></table></div>`;

  return controls + hero + card('basis', t('basis'), `<ul class="factors">${factors}</ul>`) + card('strip', `${t('stripTitle')} · ${fDay(day)}`, stripHtml) + card('along', t('alongTitle'), along);
}

// ----- weather -----
function viewWeather() {
  const d = dest();
  const pts = d.route.points;
  if (!S.wxPoint || !pts.find((p) => p.id === S.wxPoint)) S.wxPoint = d.resort.summitPoint;
  const w = S.data.weather[S.wxPoint];
  const chips = `<div class="chips">${pts.map((p) => `<button data-act="wx" data-v="${p.id}" class="${p.id === S.wxPoint ? 'on' : ''}">${esc(nm(p.name))}</button>`).join('')}</div>`;
  if (!w) return chips + `<p class="muted pad">${t('noData')}</p>`;
  const days = L.daily(S.data, S.ix, S.wxPoint);
  const maxSnow = Math.max(25, ...days.map((x) => x.snow));
  const dailyHtml = `<div class="tablewrap"><table class="daily"><thead><tr><th>${t('day')}</th><th>${t('hiLo')}</th><th class="wide">${t('snow')}</th><th>${t('snowLevel')}</th><th>${t('ratio')}</th><th>${t('gust')}</th><th>${t('precip')}</th></tr></thead><tbody>${days.map((x) => `<tr>
    <th>${fDay(x.day)}</th><td>${fT0(x.hi)} / ${fT0(x.lo)}</td>
    <td class="wide"><div class="bar"><i style="width:${Math.round((x.snow / maxSnow) * 100)}%"></i><span>${x.snow > 0 ? fSnow(x.snow) : '–'}</span></div></td>
    <td>${x.slLo == null ? '–' : x.slHi - x.slLo < 150 ? fElev(x.slLo) : `${fElev(x.slLo).replace(/ \w+$/, '')}–${fElev(x.slHi)}`}</td><td>${x.ratio ? Math.round(x.ratio) + ':1' : '–'}</td><td>${fWind(x.gust)}</td><td>${x.qpf >= 0.1 ? fRain(x.qpf) : '–'}</td></tr>`).join('')}</tbody></table></div>
    <p class="note">${t('ratioNote')}</p>`;

  const hrs = S.ix.hours.filter((h) => h.ms >= Date.now() - 36e5 && w.temp[h.i] != null);
  const maxRate = Math.max(10, ...hrs.map((h) => w.snow[h.i] || 0));
  const elev = w.elevM;
  const hourly = `<div class="hours">${hrs.map((h) => {
    const sn = w.snow[h.i] || 0;
    const sl = w.snowLevel[h.i];
    const below = sl != null && elev != null && sl <= elev;
    return `<div class="hcol ${h.h === 0 ? 'newday' : ''} ${h.h < 6 || h.h >= 18 ? 'night' : ''}">
      <div class="hd">${h.h === 0 || h === hrs[0] ? fDay(h.day) : ''}</div><div class="hh">${fHour(h.h)}</div>
      <div class="ht">${fT0(w.temp[h.i])}</div>
      <div class="hbar"><i style="height:${Math.round((sn / maxRate) * 100)}%"></i></div>
      <div class="hs">${sn >= 0.3 ? fSnow(sn).replace(' cm', '') : (w.qpf[h.i] || 0) > 0.1 ? '🌧' : ''}</div>
      <div class="hl ${below ? 'below' : ''}">${sl == null ? '' : S.lu === 'imp' ? (sl * 3.28084 / 1000).toFixed(1) + 'k' : Math.round(sl / 10) * 10}</div>
      <div class="hg">${w.gust[h.i] == null ? '' : Math.round(S.lu === 'imp' ? w.gust[h.i] / 1.609 : w.gust[h.i])}</div>
    </div>`;
  }).join('')}</div>
  <div class="legend"><span>${t('temp')}</span><span class="k snow">${t('snow')} (${S.lu === 'imp' ? 'in' : 'cm'}/h)</span><span>${t('snowLevel')} (${S.lu === 'imp' ? '×1000 ft' : 'm'})</span><span>${t('gust')} (${S.lu === 'imp' ? 'mph' : 'km/h'})</span></div>`;

  return chips + `<p class="note pad0">${t('elevNote', { v: fElev(elev) })} · ${t('source')}: NWS ${esc(w.office)} · ${t('updated')} ${fWhen(Date.parse(w.updated))}</p>` + card('daily', t('daily7'), dailyHtml) + card('hourly', t('hourly'), hourly);
}

// ----- roads -----
const rBadge = (lv, status) => `<span class="badge ${lv <= 0 ? (lv < 0 ? 'na' : 'ok') : lv >= 3 ? 'nogo' : 'caution'}">${lv === 4 ? 'CLOSED' : lv < 0 ? esc(status || '?') : 'R' + lv}</span>`;
function viewRoads() {
  const d = dest();
  const r = d.route;
  const dir = S.direction === 'out' ? r.outboundDir : r.returnDir;
  const c = L.chainFor(S.data, r.highway, dir);
  const dirLabel = t(dir === 'East' ? 'east' : 'west');
  const chain = `<div class="controls">${seg('direction', S.direction, [['out', `${t('out')} · ${t(r.outboundDir === 'East' ? 'east' : 'west')}`], ['back', `${t('back')} · ${t(r.returnDir === 'East' ? 'east' : 'west')}`]])}</div>
    <ul class="rows">${c.rows.map((x) => `<li>${rBadge(x.level, x.status)}<div><b>${esc(x.name.replace(/\s*\((unselect|holding)[^)]*\)/i, ''))}</b><small>${x.elevFt ? fElev(x.elevFt / 3.28084) + ' · ' : ''}${esc(x.at)}</small>${x.level !== 0 ? `<p>${esc(x.desc)}</p>` : ''}</div></li>`).join('') || `<li class="muted">${t('noData')}</li>`}</ul>`;

  const alts = `<ul class="rows">${r.alternates.map((a) => {
    const x = L.chainFor(S.data, a.highway, dir);
    const txt = x.max < 0 ? t('altNA') : x.max === 0 ? t('altNone') : x.max >= 4 ? t('altClosed') : t('altMax', { n: x.max });
    return `<li>${rBadge(x.max, '')}<div><b>${esc(nm(a.label))}</b><small>${txt}${x.active.length ? ' · ' + esc([...new Set(x.active.map((k) => k.name))].slice(0, 3).join(', ')) : ''}</small></div></li>`;
  }).join('')}</ul>`;

  const now = Date.now();
  const clRow = (k) => `<li><span class="badge ${L.isFull(k) ? 'nogo' : k.start <= now ? 'caution' : 'na'}">${k.start <= now ? t('activeNow') : t('upcoming')}</span><div><b>${esc(k.from)} → ${esc(k.to)}</b>
    <small>${esc(k.facility)} · ${esc(k.type)} · ${esc(k.work)} · ${esc(k.dir)}</small><small>${fWhen(k.start)} ${t('until')} ${k.end ? fWhen(k.end) : t('indefinite')}${k.delayMin ? ' · ' + t('delay', { d: k.delayMin }) : ''}${k.total ? ' · ' + t('lanesOf', { a: k.lanes, b: k.total }) : ''}</small></div></li>`;
  const soon = S.data.closures.filter((k) => !L.isRamp(k) && k.start < now + 48 * 36e5);
  const later = S.data.closures.filter((k) => L.isRamp(k) || k.start >= now + 48 * 36e5);
  const clos = S.data.closures.length
    ? `<ul class="rows">${soon.map(clRow).join('') || `<li class="muted">${t('closNone48')}</li>`}</ul>${later.length ? `<details><summary>${t('closMore', { n: later.length })}</summary><ul class="rows">${later.map(clRow).join('')}</ul></details>` : ''}`
    : `<p class="muted">${t('closNone')}</p>`;

  const inc = S.data.incidents.length
    ? `<ul class="rows">${S.data.incidents.map((x) => `<li><span class="badge ${/collision|closure|sigalert|fatal|spin/i.test(x.type) ? 'caution' : 'na'}">${x.time ? fTime(x.time) : ''}</span><div><b>${esc(x.type)}</b><small>${esc(x.loc)}${x.desc ? ' · ' + esc(x.desc) : ''} · ${esc(x.area)}</small>${x.details.length ? `<p>${x.details.map(esc).join('<br>')}</p>` : ''}</div></li>`).join('')}</ul>`
    : `<p class="muted">${t('incNoneShort')}</p>`;

  const bust = Math.floor(Date.now() / 3e5);
  const cams = `<p class="note">${t('camHint')}</p><div class="cams">${S.data.cams.map((x, i) => `<button class="cam" data-act="cam" data-v="${i}"><img loading="lazy" alt="${esc(x.name)}" src="${esc(x.img)}?t=${bust}"><span>${esc(x.name)}<small>${x.elevFt ? fElev(x.elevFt / 3.28084) : ''}</small></span></button>`).join('')}</div>`;

  const st = (k) => (S.data.status[k]?.ok === false ? `<span class="tag bad">${t('loadFail')}</span>` : '');
  return card('chain', `${r.label} ${t('chainTitle')}`, chain, `<span class="tag">${S.chainLiveAt ? t('liveTag') : fAgo(S.data.generatedAt)}</span>${st('chain')}`) +
    card('alts', t('altTitle'), alts) + card('inc', t('incTitle'), inc, st('incidents')) + card('clos', t('closTitle'), clos, st('closures')) + card('cams', t('camTitle'), cams, st('cams')) + `<p class="note pad0">${t('srcTextNote')} · ${t('chainDir', { dir: dirLabel })}</p>`;
}

// ----- wear -----
function viewWear() {
  const d = dest();
  const mtn = L.daily(S.data, S.ix, d.resort.summitPoint, 8, 16);
  const town = L.daily(S.data, S.ix, d.route.townPoint, 7, 22);
  const cards = mtn.filter((m) => m.n >= 3).map((m) => {
    const tw = town.find((x) => x.day === m.day);
    const c = L.clothing(m, tw);
    const li = (a) => a.map((k) => `<li>${t('w.' + k)}</li>`).join('');
    const title = `${fDay(m.day)}${fDay(m.day) === fDayFull(m.day) ? '' : ` <small>${fDayFull(m.day)}</small>`}`;
    return card('wear' + S.ix.days.indexOf(m.day), title, `<div class="stats"><span>${t('feels')} <b>${fT(m.feelsLo ?? m.lo)}</b></span><span>${t('gust')} <b>${fWind(m.gust)}</b></span><span>${t('snow')} <b>${fSnow(m.snow)}</b></span></div>
      <div class="two"><div><h3>${t('mountain')}</h3><ul>${li(c.mountain)}</ul></div><div><h3>${t('town')} <small>${tw ? `${fT0(tw.hi)} / ${fT0(tw.lo)}` : ''}</small></h3><ul>${li(c.town)}</ul></div></div>`, '', 'wear');
  }).join('');
  return cards || `<p class="muted pad">${t('noData')}</p>`;
}

// ----- resort -----
function viewResort() {
  const d = dest();
  const days = L.skiDays(S.data, d, S.ix).filter((x) => x.n >= 3);
  const best = days.reduce((b, x) => (x.fresh > (b?.fresh ?? 0) ? x : b), null);
  const maxF = Math.max(50, ...days.map((x) => x.fresh));
  const outlook = `<div class="tablewrap"><table class="daily"><thead><tr><th>${t('day')}</th><th class="wide">${t('fresh')}</th><th>${t('ratio')}</th><th>${t('gust')}</th><th>${t('liftRisk')}</th></tr></thead><tbody>${days.map((x) => `<tr class="${best && best.fresh >= 75 && x.day === best.day ? 'best' : ''}">
    <th>${fDay(x.day)}${best && best.fresh >= 75 && x.day === best.day ? `<small class="star">★ ${t('bestDay')}</small>` : ''}</th>
    <td class="wide"><div class="bar"><i style="width:${Math.round((x.fresh / maxF) * 100)}%"></i><span>${x.fresh >= 1 ? fSnow(x.fresh) : '–'}</span></div>${x.overnight >= 5 ? `<small>${t('overnight')} ${fSnow(x.overnight)}</small>` : ''}</td>
    <td>${x.ratio ? Math.round(x.ratio) + ':1' : '–'}</td><td>${fWind(x.gust)}</td><td>${x.lift ? `<span class="badge ${x.lift.level === 'high' ? 'nogo' : x.lift.level === 'mod' ? 'caution' : 'ok'}">${t(x.lift.level)}</span>` : '–'}</td></tr>`).join('')}</tbody></table></div><p class="note">${t('liftNote')}</p>`;

  const cams = `<div class="rcams">${d.resort.cams.map((c, i) => `<figure>${S.camsLoaded.has(i)
    ? `<iframe src="${esc(c.embed)}" title="${esc(nm(c.name))}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>`
    : `<button class="load" data-act="rcam" data-v="${i}">▶ ${t('camLoad')}</button>`}<figcaption>${esc(nm(c.name))}</figcaption></figure>`).join('')}</div>`;
  const k = d.resort.links;
  const links = `<div class="links"><a href="${k.lifts}" target="_blank" rel="noopener">${t('lifts')} ↗</a><a href="${k.snow}" target="_blank" rel="noopener">${t('snowReport')} ↗</a><a href="${k.cams}" target="_blank" rel="noopener">${t('allCams')} ↗</a></div>`;
  return card('outlook', `${esc(nm(d.name))} · ${t('outlook')}`, outlook) + card('rcams', t('resortCams'), cams) + card('links', t('official'), links);
}

// ----- list -----
function viewList() {
  const items = list.visible();
  const st = list.status();
  return card('list', t('listTitle'), `<p class="note">${t('listHint')}</p>
    <form class="add" data-form="add"><input id="newItem" autocomplete="off" maxlength="200" placeholder="${t('addPh')}" aria-label="${t('add')}"><button>${t('add')}</button></form>
    <ul class="todo">${items.map((i) => `<li class="${i.done ? 'done' : ''}"><label><input type="checkbox" data-change="toggle" data-v="${i.id}" ${i.done ? 'checked' : ''}><span>${esc(i.text)}</span></label><button class="x" data-act="del" data-v="${i.id}" aria-label="delete">×</button></li>`).join('') || `<li class="muted">${t('empty')}</li>`}</ul>
    ${items.some((i) => i.done) ? `<button class="ghost" data-act="clearDone">${t('clearDone')}</button>` : ''}`, `<button class="tag link ${st}" data-act="settings">${st === 'off' ? t('sync.setup') : t('sync.' + st)}</button>`);
}

// ----- dialogs -----
function openSettings() {
  const v = S.vehicle;
  const chk = (k, label) => `<label class="chk"><input type="checkbox" data-change="veh" data-v="${k}" ${v[k] ? 'checked' : ''}>${label}</label>`;
  $('#dlg').innerHTML = `<form method="dialog"><h2>${t('settings')}</h2>
    <h3>${t('theme')}</h3>${seg('themeSet', S.theme, [['auto', t('th.auto')], ['light', t('th.light')], ['dark', t('th.dark')]])}
    <h3>${t('vehicle')}</h3>${seg('drive', v.drive, [['awd', t('awd')], ['2wd', t('twd')]])}<div class="chks">${chk('snowTires', t('snowTires'))}${chk('chains', t('chains'))}${chk('ev', t('ev'))}</div>
    <h3>${t('syncTitle')}</h3><p class="note">${t('syncHelp')} <a href="https://github.com/settings/tokens/new?scopes=gist&description=Tahoe%20Run%20checklist" target="_blank" rel="noopener">${t('makeToken')} ↗</a></p>
    ${list.hasToken() ? `<p><span class="tag ${list.status()}">${t('sync.' + list.status())}</span> <button type="button" class="ghost" data-act="disconnect">${t('disconnect')}</button></p>`
      : `<div class="add"><input id="token" type="password" autocomplete="off" placeholder="${t('tokenPh')}"><button type="button" data-act="connect">${t('save')}</button></div>`}
    <button class="ghost close">${t('close')}</button></form>`;
  if (!$('#dlg').open) $('#dlg').showModal();
}
function openCam(i) {
  const c = S.data.cams[i];
  $('#dlg').innerHTML = `<form method="dialog" class="camdlg"><h2>${esc(c.name)} <small>${esc(c.place)}</small></h2><img alt="${esc(c.name)}" src="${esc(c.img)}?t=${Date.now()}">
    <div class="links">${c.stream ? `<a href="${esc(c.stream)}" target="_blank" rel="noopener">${t('openStream')} ↗</a>` : ''}</div><button class="ghost close">${t('close')}</button></form>`;
  $('#dlg').showModal();
}

// ---------- events ----------
const setPref = (k, v) => { S[k] = v; store.set(k, v); };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case 'lang': setPref('lang', v); break;
    case 'tu': setPref('tu', v); break;
    case 'lu': setPref('lu', v); break;
    case 'theme': setPref('theme', { auto: 'light', light: 'dark', dark: 'auto' }[S.theme]); break;
    case 'themeSet': setPref('theme', v); t = makeT(S.lang); openSettings(); break;
    case 'direction': setPref('direction', v); break;
    case 'mode': S.depart = v === 'now' ? 'now' : { day: L.dayKey(Date.now()), h: Math.min(23, L.hourOf(Date.now()) + 1) }; break;
    case 'hour': S.depart = { day: S.depart === 'now' ? L.dayKey(Date.now()) : S.depart.day, h: +v }; break;
    case 'wx': S.wxPoint = v; break;
    case 'refresh': b.classList.add('spin'); loadData(); if (list.hasToken()) list.sync(); return;
    case 'settings': t = makeT(S.lang); return openSettings();
    case 'cam': return openCam(+v);
    case 'rcam': S.camsLoaded.add(+v); break;
    case 'fold': {
      const sec = b.closest('.card');
      const open = folded.has(v);
      open ? folded.delete(v) : folded.add(v);
      store.set('folded', [...folded]);
      sec.classList.toggle('collapsed', !open);
      sec.querySelector('.fold').setAttribute('aria-expanded', open);
      const body = sec.querySelector('.cbody');
      if (!open && v === 'rcams') { S.camsLoaded.clear(); body.innerHTML = ''; } // stop the streams
      if (open && !body.innerHTML.trim()) break; // was rendered collapsed: build it now
      return;
    }
    case 'del': list.remove(v); return;
    case 'clearDone': list.clearDone(); return;
    case 'drive': S.vehicle.drive = v; store.set('vehicle', S.vehicle); openSettings(); break;
    case 'connect': { const tok = $('#token').value; if (tok.trim()) list.connect(tok).then(openSettings); return; }
    case 'disconnect': list.disconnect(); return openSettings();
    default: return;
  }
  render();
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  switch (el.dataset.change) {
    case 'day': S.depart = { day: el.value, h: S.depart === 'now' ? 8 : S.depart.h }; break;
    case 'dest': setPref('destId', el.value); store.set('dest', el.value); S.data = null; S.chainLiveAt = null; S.camsLoaded.clear(); loadData(); break;
    case 'toggle': list.toggle(el.dataset.v); return;
    case 'veh': S.vehicle[el.dataset.v] = el.checked; store.set('vehicle', S.vehicle); break;
    default: return;
  }
  render();
});
document.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'add') return;
  e.preventDefault();
  const inp = $('#newItem');
  list.add(inp.value);
  render();
  $('#newItem')?.focus();
});
window.addEventListener('hashchange', () => {
  const k = location.hash.slice(1);
  if (TABS.includes(k)) { S.tab = k; render(); window.scrollTo(0, 0); }
});
list.subscribe(() => { if (S.tab === 'list') { const typing = document.activeElement?.id === 'newItem' && $('#newItem').value; if (!typing) render(); } if ($('#dlg').open && $('#token') == null && $('#dlg h3')) openSettings(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadData(); if (list.hasToken()) list.sync(); } });
setInterval(() => { if (!document.hidden) loadData(); }, 5 * 6e4);

render();
loadData();
if (list.hasToken()) list.sync();

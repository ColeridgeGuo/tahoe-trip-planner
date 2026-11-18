import { DESTINATIONS, DEFAULT_VEHICLE, CARTO_KEY, TOMTOM_WEB_KEY } from './config.js';
import { CC_URL, normalizeChain } from './normalize.js';
import { makeT } from './i18n.js';
import { list, gist } from './sync.js';
import { alerts } from './alerts.js';
import { FOOD } from './food.js';
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
  offline: false, // showing the last saved data because the network could not be reached
  chainLiveAt: null,
  camsLoaded: new Set(),
  alertErr: false, // the last attempt to save an alert failed
  mapShow: { traffic: false, inc: true, clos: false, cams: false, food: true, ...store.get('mapShow', {}) },
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
function fDur(sec, short) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  if (short) return `${h}:${String(m % 60).padStart(2, '0')}`;
  return S.lang === 'zh' ? `${h} 小时 ${m % 60} 分` : `${h} h ${m % 60} min`;
}
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

// The hour picked on the strip, if it is still ahead: the departure a change alert can be set for.
function pickedHour() {
  if (S.depart === 'now' || !S.ix) return null;
  const h = S.ix.hours.find((x) => x.day === S.depart.day && x.h === S.depart.h);
  return h && h.ms > Date.now() ? h : null;
}

// "Live" only holds while the network is reachable; offline, say how old the reading is instead.
const liveTag = (at) => (S.offline ? fAgo(at || S.data.generatedAt) : t('liveTag'));

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
    S.offline = r.headers.get('X-Offline-Copy') === '1'; // set by sw.js when it had to fall back to its saved copy
  } catch (e) {
    S.error = String(e.message || e);
    S.offline = !!S.data;
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
// Inline SVG icons (Feather, MIT) so they render identically on every platform instead of as emoji.
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  theme: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>'),
  refresh: svg('<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};
const seg = (act, cur, opts) => `<div class="seg" role="group">${opts.map(([v, label, tip]) => `<button data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}"${tip ? ` data-tip="${tip}" aria-label="${tip}"` : ''}>${label}</button>`).join('')}</div>`;
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
    seg('lang', S.lang, [['zh', '中', t('tip.zh')], ['en', 'EN', t('tip.en')]]) + seg('tu', S.tu, [['C', '°C', t('tip.C')], ['F', '°F', t('tip.F')]]) + seg('lu', S.lu, [['imp', 'in·ft', t('tip.imp')], ['met', 'cm·m', t('tip.met')]]) +
    `<button class="icon" data-act="theme" data-tip="${t('tip.theme')}" aria-label="${t('theme')}: ${t('th.' + S.theme)}">${IC.theme}</button>` +
    `<button class="icon" data-act="refresh" data-tip="${t('tip.refresh')}" aria-label="${t('refresh')}">${IC.refresh}</button><button class="icon" data-act="settings" data-tip="${t('tip.settings')}" aria-label="${t('settings')}">${IC.settings}</button>`;
  $('#tabs').innerHTML = TABS.map((k) => `<a href="#${k}" class="${k === S.tab ? 'on' : ''}" ${k === S.tab ? 'aria-current="page"' : ''}>${t('tabs.' + k)}</a>`).join('');
  const st = S.data
    ? `${t('dataAt')} ${fAgo(S.data.generatedAt)}${S.chainLiveAt ? ` · ${t('chainLive')} ${S.offline ? '' : t('liveTag') + ' '}${fAgo(S.chainLiveAt)}` : ''}`
    : S.error ? `${t('loadFail')}: ${esc(S.error)}` : t('loading');
  $('#status').textContent = st;
  const off = $('#offline');
  off.hidden = !(S.offline && S.data);
  if (!off.hidden) off.textContent = t('offline', { when: fWhen(S.data.generatedAt), ago: fAgo(S.data.generatedAt) });
  $('#foot').textContent = t('srcs');
}

function render() {
  t = makeT(S.lang);
  alerts.context({ lang: S.lang, vehicle: S.vehicle });
  renderChrome();
  const m = $('#main');
  if (!S.data) { m.innerHTML = `<p class="muted pad">${S.error ? `${t('loadFail')}: ${esc(S.error)}` : t('loading')}</p>`; if (S.tab === 'list') m.innerHTML = viewList(); return; }
  // Keep the live map element across re-renders so tiles and the current view are not thrown away.
  const keep = MAP.map ? $('#map') : null;
  m.innerHTML = { verdict: viewVerdict, weather: viewWeather, roads: viewRoads, wear: viewWear, resort: viewResort, list: viewList }[S.tab]();
  const slot = $('#map');
  if (slot && keep) { slot.replaceWith(keep); drawMap(); } else if (slot) initMap(); else destroyMap();
}

// ----- map (Leaflet, loaded only when the roads tab needs it) -----
const MAP = { map: null, tiles: null, tileKind: null, flow: null, flowKind: null, overlay: null, route: null, routeId: null, loading: null };
const isDark = () => S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return (MAP.loading ||= new Promise((res, rej) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'js/vendor/leaflet.css' });
    const js = Object.assign(document.createElement('script'), { src: 'js/vendor/leaflet.js', onload: res, onerror: rej });
    document.head.append(css, js);
  }));
}
function destroyMap() {
  if (MAP.map) MAP.map.remove();
  MAP.map = MAP.tiles = MAP.tileKind = MAP.flow = MAP.flowKind = MAP.overlay = null;
}
async function initMap() {
  const el = $('#map');
  const id = S.destId;
  try {
    await loadLeaflet();
    if (MAP.routeId !== id) { MAP.route = (await import(`./routes/${id}.js`)).default; MAP.routeId = id; }
  } catch (e) {
    console.warn('map', e);
    if ($('#map')) $('#map').innerHTML = `<p class="muted pad">${t('mapFail')}</p>`;
    return;
  }
  if ($('#map') !== el || MAP.map || S.destId !== id) return; // page moved on while loading
  const LF = window.L;
  MAP.map = LF.map(el, { scrollWheelZoom: false, zoomSnap: 0.5 }).fitBounds(dest().route.mapFocus);
  MAP.map.attributionControl.setPrefix('');
  MAP.map.on('click', () => MAP.map.scrollWheelZoom.enable());
  el.addEventListener('mouseleave', () => MAP.map?.scrollWheelZoom.disable());
  MAP.overlay = LF.layerGroup().addTo(MAP.map);
  drawMap();
}
function drawMap() {
  const LF = window.L;
  const { map, route } = MAP;
  if (!map || !S.data) return;
  map.invalidateSize();
  const kind = isDark() ? 'dark' : 'light';
  if (MAP.tileKind !== kind) {
    MAP.tiles?.remove();
    // Light: OpenStreetMap. Dark: CARTO dark tiles if a key is configured (they are watermarked without one),
    // otherwise the same OSM tiles colour-inverted in CSS.
    const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const cartoDark = kind === 'dark' && CARTO_KEY;
    MAP.tiles = (cartoDark
      ? LF.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, { subdomains: 'abcd', maxZoom: 18, attribution: `${osm} © <a href="https://carto.com/attributions">CARTO</a>` })
      : LF.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: osm })
    ).addTo(map);
    map.getContainer().classList.toggle('invert', kind === 'dark' && !cartoDark);
    MAP.tileKind = kind;
  }
  // Live traffic flow (TomTom), drawn above the base map and below our own markers.
  const flowKind = S.mapShow.traffic && TOMTOM_WEB_KEY ? kind : null;
  if (MAP.flowKind !== flowKind) {
    MAP.flow?.remove();
    MAP.flow = flowKind && LF.tileLayer(`https://api.tomtom.com/traffic/map/4/tile/flow/${flowKind === 'dark' ? 'relative0-dark' : 'relative0'}/{z}/{x}/{y}.png?key=${TOMTOM_WEB_KEY}&tileSize=256`,
      { maxZoom: 18, zIndex: 5, opacity: 0.9, attribution: '© <a href="https://www.tomtom.com">TomTom</a>' }).addTo(map);
    MAP.flowKind = flowKind;
  }
  const g = MAP.overlay.clearLayers();
  const css = getComputedStyle(document.documentElement);
  const col = (lv) => css.getPropertyValue(lv >= 3 ? '--nogo' : lv >= 1 ? '--caution' : '--ok').trim();
  const r = dest().route;
  const dir = S.direction === 'out' ? r.outboundDir : r.returnDir;
  const pop = (title, lines) => `<b>${esc(title)}</b>${lines.filter(Boolean).map((x) => `<br>${x}`).join('')}`;
  const mark = (lat, lon, cls, label, html, z = 0) => LF.marker([lat, lon], { icon: LF.divIcon({ className: `mk ${cls}`, html: label, iconSize: null }), zIndexOffset: z }).bindPopup(html, { maxWidth: 260 }).addTo(g);

  // With traffic on, the flow colours are the road; keep our own line out of the way.
  if (!flowKind) LF.polyline(route, { color: css.getPropertyValue('--accent').trim(), weight: 4, opacity: 0.55 }).addTo(g);

  // Chain control: colour the stretch from each active checkpoint to the next one in the direction of travel.
  const nearest = (lat, lon) => { let b = 0, bd = Infinity; route.forEach(([a, o], i) => { const d = (a - lat) ** 2 + ((o - lon) * 0.78) ** 2; if (d < bd) { bd = d; b = i; } }); return b; };
  const cps = L.chainFor(S.data, r.highway, dir).rows.map((c) => ({ ...c, i: nearest(c.lat, c.lon) })).sort((a, b) => (S.direction === 'out' ? a.i - b.i : b.i - a.i));
  cps.forEach((c, k) => {
    const next = cps[k + 1];
    if (c.level > 0 && next && next.i !== c.i) LF.polyline(route.slice(Math.min(c.i, next.i), Math.max(c.i, next.i) + 1), { color: col(c.level), weight: 7, opacity: 0.95 }).addTo(g);
  });
  for (const c of cps) {
    const name = c.name.replace(/\s*\((unselect|holding)[^)]*\)/i, '');
    const label = c.level === 4 ? '✕' : c.level > 0 ? 'R' + c.level : '';
    mark(c.lat, c.lon, `mk-cc ${c.level >= 3 ? 'nogo' : c.level > 0 ? 'caution' : 'ok'} ${c.level > 0 ? 'big' : ''}`, label,
      pop(name, [c.level > 0 ? esc(c.desc) : t('mapNone'), `<span class="muted">${c.elevFt ? fElev(c.elevFt / 3.28084) + ' · ' : ''}${esc(c.at)}</span>`]), c.level > 0 ? 500 : 0);
  }
  if (S.mapShow.inc) for (const x of L.incidentsFor(S.data, dir)) mark(x.lat, x.lon, `mk-inc ${/collision|closure|sigalert|fatal|spin/i.test(x.type) ? 'caution' : ''}`, '!', pop(x.type, [esc(x.loc), x.time ? `<span class="muted">${fTime(x.time)} · ${esc(x.area)}</span>` : '', ...x.details.map(esc)]), 300);
  if (S.mapShow.clos) for (const k of S.data.closures) if (k.lat && !L.isRamp(k) && L.inDir(k.dir, dir)) mark(k.lat, k.lon, `mk-cl ${L.isFull(k) ? 'nogo' : ''}`, '', pop(`${k.from} → ${k.to}`, [esc(`${k.type} · ${k.work}`), `<span class="muted">${fWhen(k.start)} ${t('until')} ${k.end ? fWhen(k.end) : t('indefinite')}</span>`]), 100);
  if (S.mapShow.food) for (const x of foodNow()) mark(x.place.lat, x.place.lon, 'mk-food', '', pop(x.place.name, [esc([x.place.town, x.place.cuisine && nm(x.place.cuisine)].filter(Boolean).join(' · ')), `${t('food.arrive', { v: fTime(x.ms) })} · ${foodOpenText(x.open)}`, x.place.note ? esc(nm(x.place.note)) : '', `<a href="${esc(foodUrl(x.place))}" target="_blank" rel="noopener">Google Maps</a>`]), 200);
  if (S.mapShow.cams) S.data.cams.forEach((c) => mark(c.lat, c.lon, 'mk-cam', '', `<b>${esc(c.name)}</b><img class="popcam" alt="" src="${esc(c.img)}?t=${Math.floor(Date.now() / 3e5)}">`, 50));
}
// Places to eat on this route for the departure currently picked, in driving order.
function foodNow() {
  const d = dest();
  const dm = departMs();
  const dr = L.driveTime(S.data, d, dm, S.direction);
  return L.foodStops(S.data, d, FOOD, dm, S.direction, dr.hours, dr.stops);
}
const foodUrl = (p) => p.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name} ${p.town || ''}`.trim())}`;
function foodOpenText(o) {
  if (o.state === 'unknown') return t('food.unknown');
  if (o.state === 'open') return t('food.open');
  if (o.state === 'closing') return t('food.closing', { n: Math.round(o.closeMin / 5) * 5 });
  return o.openMin != null && o.openMin <= 180 ? t('food.opensIn', { v: fGap(o.openMin) }) : t('food.closed');
}
const fGap = (min) => (min < 60 ? (S.lang === 'zh' ? `${min} 分钟` : `${min} min`) : fDur(min * 60));
const foodCls = (o) => (o.state === 'open' ? 'ok' : o.state === 'closing' ? 'caution' : 'na');
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
      if (f.msg === 'snowPack') return t('m.snowPack', { h: v.pack.hours, total: fSnow(v.pack.mm), temp: fT(v.pack.temp), where: esc(nm(v.pack.stop.point.name)) });
      return t('m.' + f.msg, v?.stop ? { rate: fSnow(v.rate), where: esc(nm(v.stop.point.name)) } : {});
    case 'alerts':
      if (!Array.isArray(v) || !v.length) return t('m.' + f.msg);
      return v.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(alertName(a.event))}</a> <span class="muted">${fWhen(a.onset)} – ${fWhen(a.ends)}</span>`).join('<br>');
    case 'wind': return t('m.' + f.msg, { v: fWind(v) });
    case 'lift': return t('m.' + f.msg, { v: fWind(v.gust), day: fDay(v.day) });
    case 'drive': {
      if (!v) return t('m.' + f.msg, { v: fDur(d.route.driveHours * 3600) });
      const dm = v.deltaMin;
      const cmp = dm == null ? '' : Math.abs(dm) < 5 ? t(v.vs === 'usual' ? 'm.driveSame' : 'm.driveFree') : t(`m.drive${dm > 0 ? 'More' : 'Less'}${v.vs === 'usual' ? 'Usual' : 'Free'}`, { d: Math.abs(dm) });
      return t('m.' + f.msg, { v: fDur(v.sec) }) + cmp;
    }
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

  // Change alert for this direction: the one that is on, and a button to watch the hour picked on the strip.
  const plan = alerts.plan(S.direction);
  const sel = pickedHour();
  const busy = alerts.status() === 'busy';
  const alertRow = plan || sel ? `<div class="alertrow">
    ${plan ? `<span class="tag ok">${t('al.on', { when: fWhen(plan.departMs) })}</span><button class="ghost" data-act="alertOff" ${busy ? 'disabled' : ''}>${t('al.off')}</button>` : ''}
    ${sel && plan?.departMs !== sel.ms ? `<button class="ghost" data-act="alertOn" ${busy ? 'disabled' : ''}>${t(plan ? 'al.move' : 'al.remind')}</button>` : ''}
    ${busy ? `<span class="muted">${t('al.saving')}</span>` : S.alertErr ? `<span class="tag bad">${t('al.failed')}</span>` : ''}</div>` : '';

  const hero = `<section class="hero ${ev.level}">
    <div class="route">${esc(nm(ends[0].name))} → ${esc(nm(ends[1].name))}</div>
    <h1>${t(ev.level)}</h1>
    <p>${t(ev.level + 'Sub')}</p>
    <div class="times"><span>${t('departAt')} <b>${fWhen(dm)}</b></span><span>${t('arriveAt')} <b>${fTime(ev.endMs)}</b></span>${ev.drive.src === 'fixed' ? '' : `<span>${t('driveLabel')} <b>${fDur(ev.drive.sec)}</b></span>`}</div>
  </section>`;

  const order = { nogo: 0, caution: 1, ok: 2, info: 3 };
  const factors = [...ev.factors].sort((a, b) => order[a.level] - order[b.level]).map((f) => {
    const tag = f.staleAt ? fAgo(f.staleAt) : ['chain', 'incidents'].includes(f.key) || f.msg === 'driveLive' ? liveTag(f.key === 'chain' && S.chainLiveAt) : f.msg === 'driveFc' ? t('fcTag') : ['snow', 'alerts', 'wind', 'lift', 'ev'].includes(f.key) ? t('fcTag') : '';
    const link = { chain: '#roads', closures: '#roads', incidents: '#roads', snow: '#weather', lift: '#resort', drive: '#roads' }[f.key];
    return `<li class="${f.level}">${dot(f.level)}<div><div class="ft">${t('f.' + f.key)}${tag ? `<span class="tag">${tag}</span>` : ''}${link ? `<a class="more" href="${link}">›</a>` : ''}</div><div class="fm">${factorText(f)}${f.staleAt ? ` <span class="muted">${t('m.srcStale', { v: fAgo(f.staleAt) })}</span>` : ''}</div></div></li>`;
  }).join('');

  const hasDrive = strip.some((x) => x.drive && !x.past);
  const stripHtml = `<div class="strip" role="group">${strip.map((s) => {
    const sel = pick ? S.depart.h === s.h : L.hourOf(dm) === s.h;
    return `<button data-act="hour" data-v="${s.h}" class="${s.past ? 'past' : s.level}${s.heavy && !s.past ? ' heavy' : ''} ${sel ? 'sel' : ''}" ${s.past ? 'disabled' : ''} title="${fHour(s.h)}"><i></i><span>${s.h % 3 === 0 ? fHour(s.h) : ''}</span>${hasDrive ? `<span class="dr">${s.h % 3 === 0 && s.drive && !s.past ? fDur(s.drive.sec, true) : ''}</span>` : ''}</button>`;
  }).join('')}</div>
  <p class="note"><b>${win ? `${t('bestWin')}: ${fHour(win.from)} – ${fHour(win.to + 1)}` : t('noWin')}</b> · ${t('stripHint')}${hasDrive ? ' ' + t('stripDrive') : ''}</p>`;

  const along = `<div class="tablewrap"><table><thead><tr><th></th><th>${t('time')}</th><th>${t('temp')}</th><th>${t('snowRate')}</th><th>${t('snowLevel')}</th><th>${t('gust')}</th></tr></thead><tbody>${ev.stops.map((s) => `<tr>
      <th>${esc(nm(s.point.name))}<small>${fElev(s.elevM)}</small></th><td>${fTime(s.ms)}</td>${s.missing ? `<td colspan="4" class="muted">${t('noData')}</td>` : `<td>${fT0(s.temp)}</td><td class="${s.snow >= L.TH.snowHeavy ? 'bad' : s.snow >= L.TH.snowLight ? 'warn' : ''}">${s.snow > 0 ? fSnow(s.snow) + '/h' : s.qpf > 0.1 ? '🌧' : '–'}</td><td>${fElev(s.snowLevel)}</td><td>${fWind(s.gust)}</td>`}</tr>`).join('')}</tbody></table></div>`;

  return controls + alertRow + hero + card('basis', t('basis'), `<ul class="factors">${factors}</ul>`) + card('strip', `${t('stripTitle')} · ${fDay(day)}`, stripHtml) + card('week', t('wkTitle'), folded.has('week') ? '' : weekHtml()) + card('along', t('alongTitle'), along);
}

// Week overview: one row of 24 bars per day, for both directions. Colour is the forecast risk (same as the
// hourly strip), bar height is the drive time for leaving at that hour.
function weekHtml() {
  const d = dest();
  const now = Date.now();
  const town = d.route.points.find((p) => p.id === d.route.townPoint);
  const head = `<div class="wkrow wkhead" aria-hidden="true"><span></span><div class="wkbars">${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? fHour(h) : ''}</span>`).join('')}</div></div>`;
  const block = (dir) => {
    const wk = L.weekOverview(S.data, d, S.ix, dir, now);
    const span = wk.hi - wk.lo;
    const ends = dir === 'out' ? [d.route.points[0], town] : [town, d.route.points[0]];
    const rows = wk.rows.map((r) => `<div class="wkrow"><div class="wklab"><b>${fDay(r.day)}</b><small>${r.best ? `${fHour(r.best.h)} ${fDur(r.best.drive.sec, true)}` : ''}</small></div><div class="wkbars" role="group" aria-label="${fDay(r.day)}">${r.cells.map((c) => {
      if (c.none) return '<span></span>';
      const drive = c.drive && !c.past;
      const pct = drive ? Math.round(30 + 70 * (span > 60 ? (c.drive.sec - wk.lo) / span : 0.5)) : 30;
      const sel = S.depart !== 'now' && S.direction === dir && S.depart.day === r.day && S.depart.h === c.h;
      const tip = `${fDay(r.day)} ${fHour(c.h)}${drive ? ' · ' + fDur(c.drive.sec, true) : ''}`;
      return `<button data-act="wk" data-v="${dir}|${r.day}|${c.h}" class="${c.past ? 'past' : c.level}${c.heavy && !c.past ? ' heavy' : ''}${drive ? '' : ' nd'}${sel ? ' sel' : ''}${c === r.best ? ' best' : ''}" ${c.past ? 'disabled' : ''} title="${tip}" aria-label="${tip}"><i style="height:${pct}%"></i></button>`;
    }).join('')}</div></div>`).join('');
    return `<h3 class="wkdir">${t(dir)} · ${esc(nm(ends[0].name))} → ${esc(nm(ends[1].name))}${wk.lo == null ? '' : `<span>${t('driveLabel')} ${fDur(wk.lo, true)} – ${fDur(wk.hi, true)}</span>`}</h3><div class="wk">${head}${rows}</div>`;
  };
  return block('out') + block('back') + `<div class="legend"><span><i class="lg ok"></i>${t('wkOk')}</span><span><i class="lg caution"></i>${t('wkCaution')}</span><span><i class="lg caution heavy"></i>${t('wkHeavy')}</span><span><i class="lg nogo"></i>${t('wkNogo')}</span></div><p class="note">${t('wkHint')}</p>`;
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
  const dirSeg = `<div class="controls">${seg('direction', S.direction, [['out', `${t('out')} · ${t(r.outboundDir === 'East' ? 'east' : 'west')}`], ['back', `${t('back')} · ${t(r.returnDir === 'East' ? 'east' : 'west')}`]])}</div>`;
  const lay = (k, label) => `<button data-act="mapLayer" data-v="${k}" class="${S.mapShow[k] ? 'on' : ''}" aria-pressed="${S.mapShow[k]}">${label}</button>`;
  const mapHtml = `<div class="chips">${TOMTOM_WEB_KEY ? lay('traffic', t('mapTraffic')) : ''}${lay('inc', t('mapInc'))}${lay('clos', t('mapClos'))}${lay('cams', t('mapCams'))}${FOOD.length ? lay('food', t('mapFood')) : ''}</div><div id="map"></div>
    <div class="legend"><span><i class="lg ok"></i>${t('mapNone')}</span><span><i class="lg caution"></i>R1 / R2</span><span><i class="lg nogo"></i>${t('mapClosed')}</span></div>${S.mapShow.traffic && TOMTOM_WEB_KEY ? `<p class="note">${t('mapTrafficNote')}</p>` : ''}<p class="note">${t('mapNote')}</p>`;
  const chain = `<ul class="rows">${c.rows.map((x) => `<li>${rBadge(x.level, x.status)}<div><b>${esc(x.name.replace(/\s*\((unselect|holding)[^)]*\)/i, ''))}</b><small>${x.elevFt ? fElev(x.elevFt / 3.28084) + ' · ' : ''}${esc(x.at)}</small>${x.level !== 0 ? `<p>${esc(x.desc)}</p>` : ''}</div></li>`).join('') || `<li class="muted">${t('noData')}</li>`}</ul>`;

  const alts = `<ul class="rows">${r.alternates.map((a) => {
    const x = L.chainFor(S.data, a.highway, dir);
    const txt = x.max < 0 ? t('altNA') : x.max === 0 ? t('altNone') : x.max >= 4 ? t('altClosed') : t('altMax', { n: x.max });
    return `<li>${rBadge(x.max, '')}<div><b>${esc(nm(a.label))}</b><small>${txt}${x.active.length ? ' · ' + esc([...new Set(x.active.map((k) => k.name))].slice(0, 3).join(', ')) : ''}</small></div></li>`;
  }).join('')}</ul>`;

  const now = Date.now();
  const clRow = (k) => `<li><span class="badge ${L.isFull(k) ? 'nogo' : k.start <= now ? 'caution' : 'na'}">${k.start <= now ? t('activeNow') : t('upcoming')}</span><div><b>${esc(k.from)} → ${esc(k.to)}</b>
    <small>${esc(k.facility)} · ${esc(k.type)} · ${esc(k.work)} · ${esc(k.dir)}</small><small>${fWhen(k.start)} ${t('until')} ${k.end ? fWhen(k.end) : t('indefinite')}${k.delayMin ? ' · ' + t('delay', { d: k.delayMin }) : ''}${k.total ? ' · ' + t('lanesOf', { a: k.lanes, b: k.total }) : ''}</small></div></li>`;
  // The mountain section first (stable, so each group stays in time order): it is the part with no way round.
  const closDir = S.data.closures.filter((k) => L.inDir(k.dir, dir)).sort((a, b) => L.onMountain(r, b) - L.onMountain(r, a));
  const soon = closDir.filter((k) => !L.isRamp(k) && k.start < now + 48 * 36e5);
  const later = closDir.filter((k) => L.isRamp(k) || k.start >= now + 48 * 36e5);
  const clos = closDir.length
    ? `<ul class="rows">${soon.map(clRow).join('') || `<li class="muted">${t('closNone48')}</li>`}</ul>${later.length ? `<details><summary>${t('closMore', { n: later.length })}</summary><ul class="rows">${later.map(clRow).join('')}</ul></details>` : ''}`
    : `<p class="muted">${t('closNone')}</p>`;

  const incDir = L.incidentsFor(S.data, dir);
  const inc = incDir.length
    ? `<ul class="rows">${incDir.map((x) => `<li><span class="badge ${L.isSerious(x) && L.onMountain(r, x) ? 'caution' : 'na'}">${x.time ? fTime(x.time) : ''}</span><div><b>${esc(x.type)}</b><small>${esc(x.loc)}${x.desc ? ' · ' + esc(x.desc) : ''} · ${esc(x.area)}</small>${x.details.length ? `<p>${x.details.map(esc).join('<br>')}</p>` : ''}</div></li>`).join('')}</ul>`
    : `<p class="muted">${t('incNoneShort')}</p>`;

  const bust = Math.floor(Date.now() / 3e5);
  const cams = `<p class="note">${t('camHint')}</p><div class="cams">${S.data.cams.map((x, i) => `<button class="cam" data-act="cam" data-v="${i}"><img loading="lazy" alt="${esc(x.name)}" src="${esc(x.img)}?t=${bust}"><span>${esc(x.name)}<small>${x.elevFt ? fElev(x.elevFt / 3.28084) : ''}</small></span></button>`).join('')}</div>`;

  // Places to eat, in the order this direction passes them, timed for the departure picked on the first tab.
  const stops = foodNow();
  // With a long list: a heading per town in driving order, and a switch to hide what will be shut on arrival.
  const many = stops.length > 6;
  const shown = many && S.foodOpenOnly ? stops.filter((x) => ['open', 'closing'].includes(x.open.state)) : stops;
  const legs = [];
  for (const x of shown) {
    const k = x.place.town;
    if (legs.at(-1)?.k !== k) legs.push({ k, title: k, rows: [] });
    legs.at(-1).rows.push(x);
  }
  const foodRows = (rows) => `<ul class="rows">${rows.map((x) => `<li><span class="badge ${foodCls(x.open)}">${fTime(x.ms)}</span><div><b><a href="${esc(foodUrl(x.place))}" target="_blank" rel="noopener">${esc(x.place.name)}</a></b>
    <small>${esc([x.place.town, x.place.cuisine && nm(x.place.cuisine)].filter(Boolean).join(' · '))}</small><small>${foodOpenText(x.open)}</small>${x.place.note ? `<p>${esc(nm(x.place.note))}</p>` : ''}</div></li>`).join('')}</ul>`;
  const food = (many ? `<div class="chips"><button data-act="foodOpen" class="${S.foodOpenOnly ? 'on' : ''}" aria-pressed="${!!S.foodOpenOnly}">${t('food.openOnly')}</button></div>` : '') +
    (shown.length ? (many ? legs.map((g) => `<h3 class="leg">${esc(g.title)} · ${g.rows.length}</h3>${foodRows(g.rows)}`).join('') : foodRows(shown)) : `<p class="muted">${t('food.noneOpen')}</p>`) + `<p class="note">${t('food.note')}</p>`;
  const foodCard = stops.length ? card('food', t('food.title'), food, `<span class="tag">${S.depart === 'now' ? t('food.fromNow') : t('food.from', { when: fWhen(departMs()) })}</span>`) : '';

  // A failed source shows how old its carried-over data is, or "failed" when there is none.
  const st = (k) => { const s = S.data.status[k]; return s?.ok === false ? `<span class="tag bad">${s.dataAt ? t('srcStaleTag', { v: fAgo(s.dataAt) }) : t('loadFail')}</span>` : ''; };
  return dirSeg + card('map', `${r.label} ${t('mapTitle')}`, mapHtml) + foodCard + card('chain', `${r.label} ${t('chainTitle')}`, chain, `<span class="tag">${S.chainLiveAt ? liveTag(S.chainLiveAt) : fAgo(S.data.generatedAt)}</span>${st('chain')}`) +
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
    ${list.hasToken() ? `<p><span class="tag ${list.status()}">${t('sync.' + list.status())}</span> <button type="button" class="ghost" data-act="disconnect">${t('disconnect')}</button></p>${list.status() === 'err' ? `<p class="note">${syncWhy()}</p>` : ''}`
      : `<div class="add"><input id="token" type="password" autocomplete="off" placeholder="${t('tokenPh')}"><button type="button" data-act="connect">${t('save')}</button></div>`}
    <h3>${t('al.title')}</h3><p class="note">${t('al.help')}</p>${alertSettings()}
    <button class="ghost close">${t('close')}</button></form>`;
  if (!$('#dlg').open) $('#dlg').showModal();
}
// Why the checklist sync failed, in words: the token was rejected, lacks the gist permission, or GitHub was unreachable.
function syncWhy() {
  const e = list.error();
  const code = +(/GitHub (\d+)/.exec(e) || [])[1];
  return `${t(code === 401 ? 'syncWhy.token' : code === 403 || code === 404 ? 'syncWhy.scope' : code ? 'syncWhy.github' : 'syncWhy.net')} <span class="muted">(${esc(e)})</span>`;
}
function alertSettings() {
  const why = alerts.blocker();
  if (why !== 'ok') return `<p><span class="tag bad">${t({ unsupported: 'al.unsupported', denied: 'al.denied', token: 'al.needToken' }[why])}</span></p>`;
  const id = gist.id();
  // On GitHub Pages the repository is known from the address, so the secrets page can be linked directly.
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  const repo = m && location.pathname.split('/')[1];
  return `<p><span class="tag ok">${t(alerts.enabled() ? 'al.thisOn' : 'al.ready')}</span> <button type="button" class="ghost" data-act="alertTest">${t('al.test')}</button></p>
    ${id ? `<p class="note">${t('al.secret')}${repo ? ` <a href="https://github.com/${m[1]}/${repo}/settings/secrets/actions/new" target="_blank" rel="noopener">${t('al.openSecrets')} ↗</a>` : ''}</p>
    <div class="add"><input id="gistId" readonly value="${esc(id)}" aria-label="ALERT_GIST_ID"><button type="button" data-act="alertCopy">${t('al.copy')}</button></div>` : ''}`;
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
    case 'theme': { // one click always flips what is on screen; landing on the device's own scheme resumes following it
      const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
      const dark = S.theme === 'dark' || (S.theme === 'auto' && sysDark);
      setPref('theme', !dark === sysDark ? 'auto' : dark ? 'light' : 'dark');
      break;
    }
    case 'themeSet': setPref('theme', v); t = makeT(S.lang); openSettings(); break;
    case 'direction': setPref('direction', v); break;
    case 'mode': S.depart = v === 'now' ? 'now' : { day: L.dayKey(Date.now()), h: Math.min(23, L.hourOf(Date.now()) + 1) }; break;
    case 'wk': { const [dir, day, h] = v.split('|'); setPref('direction', dir); S.depart = { day, h: +h }; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    case 'hour': S.depart = { day: S.depart === 'now' ? L.dayKey(Date.now()) : S.depart.day, h: +v }; break;
    case 'wx': S.wxPoint = v; break;
    case 'refresh': b.classList.add('spin'); loadData(); if (list.hasToken()) list.sync(); return;
    case 'settings': t = makeT(S.lang); return openSettings();
    case 'cam': return openCam(+v);
    case 'rcam': S.camsLoaded.add(+v); break;
    case 'foodOpen': S.foodOpenOnly = !S.foodOpenOnly; break;
    case 'mapLayer': S.mapShow[v] = !S.mapShow[v]; store.set('mapShow', S.mapShow); break;
    case 'fold': {
      const sec = b.closest('.card');
      const open = folded.has(v);
      open ? folded.delete(v) : folded.add(v);
      store.set('folded', [...folded]);
      sec.classList.toggle('collapsed', !open);
      sec.querySelector('.fold').setAttribute('aria-expanded', open);
      const body = sec.querySelector('.cbody');
      if (!open && v === 'rcams') { S.camsLoaded.clear(); body.innerHTML = ''; } // stop the streams
      if (!open && v === 'map') { destroyMap(); body.innerHTML = ''; }
      if (open && !body.innerHTML.trim()) break; // was rendered collapsed: build it now
      return;
    }
    case 'del': list.remove(v); return;
    case 'clearDone': list.clearDone(); return;
    case 'drive': S.vehicle.drive = v; store.set('vehicle', S.vehicle); openSettings(); break;
    case 'connect': { const tok = $('#token').value; if (tok.trim()) list.connect(tok).then(openSettings); return; }
    case 'disconnect': list.disconnect(); return openSettings();
    case 'alertOn': { // asks for notification permission, so it has to start inside this tap
      const h = pickedHour();
      if (!h) break;
      if (alerts.blocker() !== 'ok') return openSettings();
      S.alertErr = false;
      alerts.set(S.direction, { dest: S.destId, departMs: h.ms }, { lang: S.lang, vehicle: S.vehicle }).catch(() => { S.alertErr = true; }).finally(() => { if (alerts.blocker() !== 'ok') openSettings(); render(); });
      return;
    }
    case 'alertOff': S.alertErr = false; alerts.clear(S.direction).catch(() => { S.alertErr = true; }).finally(render); return;
    case 'alertTest': alerts.test(t('al.testTitle'), t('al.testBody')).catch(() => openSettings()); return;
    case 'alertCopy': navigator.clipboard?.writeText($('#gistId').value).then(() => { b.textContent = t('al.copied'); }); $('#gistId').select(); return;
    default: return;
  }
  render();
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  switch (el.dataset.change) {
    case 'day': S.depart = { day: el.value, h: S.depart === 'now' ? 8 : S.depart.h }; break;
    case 'dest': destroyMap(); setPref('destId', el.value); store.set('dest', el.value); S.data = null; S.chainLiveAt = null; S.camsLoaded.clear(); loadData(); break;
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
alerts.subscribe(() => { if (S.tab === 'verdict' && S.data) softRender(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadData(); if (list.hasToken()) list.sync(); alerts.refresh(); } });
setInterval(() => { if (!document.hidden) loadData(); }, 5 * 6e4);
// If the device switches to the scheme that was pinned by hand, go back to following the device.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (S.theme === (e.matches ? 'dark' : 'light')) { setPref('theme', 'auto'); renderChrome(); }
  drawMap();
});

window.addEventListener('online', () => { loadData(); if (list.hasToken()) list.sync(); });
if ('serviceWorker' in navigator) {
  // On the very first visit the worker takes over after the data was already fetched; fetch once more so a copy is saved.
  navigator.serviceWorker.addEventListener('controllerchange', () => loadData());
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline', e));
}

render();
loadData();
if (list.hasToken()) list.sync().then(() => alerts.refresh());

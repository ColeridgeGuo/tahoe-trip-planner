import { DESTINATIONS, DEFAULT_VEHICLE, CARTO_KEY, TOMTOM_WEB_KEY } from './config.js';
import { CC_URL, normalizeChain } from './normalize.js';
import { makeT } from './i18n.js';
import { list, gist } from './sync.js';
import { alerts } from './alerts.js';
import { FOOD } from './food.js';
import * as L from './logic.js';
import { shareQuery, parseShare, sharedDepart } from './share.js';

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
// A saved destination that no longer exists would ask for a data file that is not there.
if (!DESTINATIONS.some((d) => d.id === S.destId)) S.destId = DESTINATIONS[0].id;
// A share link: show the view it describes, this once. The reader's own saved destination and direction are
// left alone, and the address is cleaned up so that a reload or a later change is not pulled back to the link.
const DEST_IDS = DESTINATIONS.map((d) => d.id);
const SHARED = parseShare(location.search, DEST_IDS);
if (SHARED) {
  if (SHARED.destId) S.destId = SHARED.destId;
  if (SHARED.direction) S.direction = SHARED.direction;
  if (SHARED.depart) S.depart = SHARED.depart;
  S.tab = 'verdict';
  try { history.replaceState(null, '', location.pathname); } catch { /* keep the address as it is */ }
}
let sharedCheck = !!SHARED?.depart; // the link's departure still has to be checked against the forecast
// A departure from a link, once the forecast is on hand: an hour that has gone by, or is beyond the
// forecast, shows "now" and says so.
function checkShared() {
  sharedCheck = false;
  const dep = sharedDepart(S.depart, S.ix.hours, Date.now());
  S.shareGone = dep !== S.depart;
  S.depart = dep;
}

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
// A change in depth: signed, and zero is "0" rather than a dash.
const fDelta = (mm) => (mm == null ? '–' : (mm > 0 ? '+' : mm < 0 ? '−' : '') + fSnow(Math.abs(mm)));
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
// Building an Intl formatter is slow and the week chart asks for several hundred dates per redraw, so each
// kind is built once per language.
const fmts = new Map();
const dtf = (kind, opts) => {
  const k = `${S.lang}|${kind}`;
  if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat(loc(), { timeZone: TZ, ...opts }));
  return fmts.get(k);
};
const fTime = (ms) => dtf('time', { hour: 'numeric', minute: '2-digit', hour12: S.lang !== 'zh' }).format(ms);
const fHour = (h) => (S.lang === 'zh' ? `${h}时` : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`);
const fDayMs = (ms) => dtf('day', { weekday: 'short', month: 'numeric', day: 'numeric' }).format(ms);
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

// The hours of a day that can still be left at: in the forecast and not gone by.
const openHours = (day) => S.ix.hours.filter((x) => x.day === day && x.ms + 36e5 > Date.now());
// The hour to show when a day is picked: the same hour as before if that day has it, otherwise the next one
// it has (today, when that hour has gone by) or its last (the final day, where the forecast stops early).
function hourOn(day, h) {
  const open = openHours(day);
  return (open.find((x) => x.h >= h) || open.at(-1))?.h ?? h;
}
// A picked departure that has gone by (the page was left open) is "now" from then on, and says so in the
// controls, instead of showing an hour that is no longer on offer.
function dropPastDepart() {
  if (S.depart !== 'now' && S.ix && !sharedCheck && !openHours(S.depart.day).some((x) => x.h === S.depart.h)) S.depart = 'now';
}

// "Live" only holds while the network is reachable; offline, say how old the reading is instead.
const liveTag = (at) => (S.offline ? fAgo(at || S.data.generatedAt) : t('liveTag'));

// One request per destination at a time: the timer, the tab coming back to the front and the network coming
// back can all ask at the same moment.
let loading = null;
function loadData() {
  const id = S.destId;
  if (loading?.id === id) return loading.p;
  const p = fetchData(id).finally(() => { if (loading?.p === p) loading = null; });
  loading = { id, p };
  return p;
}
// index.html starts the first request before the scripts have loaded (window.__boot); it is used once.
function firstFetch(id) {
  const boot = window.__boot;
  window.__boot = null;
  return boot?.id === id ? boot.p : null;
}
async function fetchData(id) {
  try {
    const r = await (firstFetch(id) || fetch(`data/${id}.json?ts=${Math.floor(Date.now() / 6e4)}`, { cache: 'no-store' }));
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (id !== S.destId) return; // another destination was picked while this one was loading
    // Keep the chain control read straight from Caltrans only while it is newer than the file's own reading.
    // If those direct requests stop working, the scheduled refresh takes over instead of an old "live" one.
    const fileAt = d.status?.chain?.ok ? d.status.chain.at : 0;
    if (S.data && S.chainLiveAt && S.chainLiveAt >= fileAt) { d.chain = S.data.chain; d.status.chain = { ok: true, at: S.chainLiveAt }; }
    else S.chainLiveAt = null;
    S.data = d;
    S.ix = L.index(d);
    if (sharedCheck) checkShared();
    S.error = null;
    S.offline = r.headers.get('X-Offline-Copy') === '1'; // set by sw.js when it had to fall back to its saved copy
  } catch (e) {
    if (id !== S.destId) return;
    S.error = String(e.message || e);
    S.offline = !!S.data;
  }
  softRender();
  liveChain();
}

// Chain control straight from Caltrans (CORS-enabled), so the verdict is not limited by the scheduled refresh.
// The two district files are 150-220 KB each and Caltrans sends them uncompressed, so they are only asked
// for on the tabs that show chain control, and not while the reading on hand (the data file's, refreshed
// every 15 minutes, or the last one read here) is under LIVE_CHAIN_MS old. The refresh button always asks.
const LIVE_CHAIN_MS = 4 * 6e4;
let chainBusy = null;
let chainForce = false;
async function liveChain() {
  const force = chainForce;
  chainForce = false;
  if (!S.data || !['verdict', 'roads'].includes(S.tab) || document.hidden) return;
  const id = S.destId;
  const st = S.data.status?.chain;
  if (chainBusy === id || (!force && Date.now() - Math.max(S.chainLiveAt || 0, st?.ok ? st.at : 0) < LIVE_CHAIN_MS)) return;
  chainBusy = id;
  const f = dest().feeds;
  try {
    const parts = await Promise.all(f.ccDistricts.map(async (d) => {
      const r = await fetch(CC_URL(d), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      return normalizeChain(await r.json(), f.chainHighways);
    }));
    if (id !== S.destId || !S.data) return; // the answer is for a destination that is no longer shown
    S.data.chain = parts.flat();
    S.chainLiveAt = Date.now();
    S.data.status.chain = { ok: true, at: S.chainLiveAt };
    softRender();
  } catch (e) {
    console.warn('live chain', e);
  } finally {
    if (chainBusy === id) chainBusy = null;
  }
}

// ---------- rendering ----------
// Inline SVG icons (Feather, MIT) so they render identically on every platform instead of as emoji.
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  refresh: svg('<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};
const seg = (act, cur, opts) => `<div class="seg" role="group">${opts.map(([v, label, tip]) => `<button data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}"${tip ? ` data-tip="${tip}" aria-label="${tip}"` : ''}>${label}</button>`).join('')}</div>`;
const dot = (level) => `<span class="dot ${level}"></span>`;
// Collapsible section. Collapsed sections render without their body, so hidden images and streams never load.
const folded = new Set(store.get('folded', []));
// One icon per card, shown left of its title. The wear cards (one per day) share one.
const CARD_IC = {
  basis: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  strip: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  week: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  along: '<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><path d="M8 16h.01M8 20h.01M12 18h.01M12 22h.01M16 16h.01M16 20h.01"/>',
  daily: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  hourly: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
  chain: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  past: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l-4 2"/>',
  inc: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  clos: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
  alts: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  cams: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
  wear: '<path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  outlook: '<path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07"/>',
  obs: '<path d="M2 20h20M6 20V10M10 20V4M14 20v-8M18 20v-5"/>',
  rcams: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  links: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  list: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
};
function card(key, title, body, extra = '', cls = '') {
  const c = folded.has(key);
  const ic = CARD_IC[key.replace(/\d+$/, '')];
  return `<section class="card ${cls} ${c ? 'collapsed' : ''}" data-k="${key}"><h2 data-act="fold" data-v="${key}"><button class="fold" type="button" aria-expanded="${!c}"><span class="chev" aria-hidden="true"></span>${ic ? `<span class="cic">${svg(ic)}</span>` : ''}<span>${title}</span></button>${extra}</h2><div class="cbody">${c ? '' : body}</div></section>`;
}
// One button above the first card that folds or unfolds every card on the tab. Left out when the tab has a single card.
const foldAllBtn = (keys) => {
  const all = keys.every((k) => folded.has(k));
  return `<div class="foldall"><button class="ghost" data-act="foldAll" aria-expanded="${!all}"><span class="chev" aria-hidden="true"></span>${t(all ? 'unfoldAll' : 'foldAll')}</button></div>`;
};
function withFoldAll(html) {
  const keys = [...html.matchAll(/<section class="card [^>]*data-k="([^"]+)"/g)].map((x) => x[1]);
  return keys.length < 2 ? html : html.replace('<section class="card ', foldAllBtn(keys) + '<section class="card ');
}
const cardKeys = () => [...document.querySelectorAll('#main .card[data-k]')].map((x) => x.dataset.k);

function renderChrome() {
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en';
  const d = dest();
  document.documentElement.dataset.theme = S.theme;
  const sub = `<span class="via">${esc(d.route.label)} · ${fDist(d.route.distanceKm)}</span>`;
  $('#title').innerHTML = `<span class="brand"><img class="logo" src="icon.svg" alt="" width="24" height="24">Tahoe Trip Planner</span><span class="where">` + (DESTINATIONS.length > 1
    ? `<select data-change="dest" aria-label="${t('dest')}">${DESTINATIONS.map((x) => `<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${esc(nm(x.name))}</option>`).join('')}</select>${sub}`
    : `<strong>${esc(nm(d.name))}</strong>${sub}`) + '</span>';
  // Language, units and theme are set-once choices and live in the settings dialog.
  $('#toggles').innerHTML =
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
  // TomTom requests used this month, as counted by the fetch script. Close to the allowance it also shows
  // as a banner, which can be put away for that month and level on this device.
  const q = S.data && L.quotaState(S.data.tomtom);
  const qv = q && { n: q.n.toLocaleString('en-US'), q: q.quota.toLocaleString('en-US'), p: Math.floor(q.pct * 100) };
  $('#quota').textContent = q ? [t('quota.used', qv), q.from ? t('quota.from', { d: `${+q.from.slice(5, 7)}/${+q.from.slice(8)}` }) : '', t('quota.ref')].filter(Boolean).join(' · ') : '';
  $('#quota').className = q?.lv === 2 ? 'over' : q?.lv === 1 ? 'warn' : '';
  const qw = $('#quotawarn');
  qw.hidden = !(q?.lv && store.get('quotaSeen', '') !== `${q.month}:${q.lv}`);
  qw.className = q?.lv === 2 ? 'over' : '';
  if (!qw.hidden) qw.innerHTML = `<span>${t(q.lv === 2 ? 'al.qOver' : 'al.qWarn', qv)}${t('al.qRef')}</span><button data-act="quotaSeen" data-v="${q.month}:${q.lv}">${t('quota.hide')}</button>`;
}

function render() {
  t = makeT(S.lang);
  alerts.context({ lang: S.lang, vehicle: S.vehicle });
  renderChrome();
  const m = $('#main');
  if (!S.data) { m.innerHTML = `<p class="muted pad">${S.error ? `${t('loadFail')}: ${esc(S.error)}` : t('loading')}</p>`; if (S.tab === 'list') m.innerHTML = viewList(); return; }
  dropPastDepart();
  // Keep the live map element across re-renders so tiles and the current view are not thrown away.
  const keep = MAP.map ? $('#map') : null;
  const view = viewState(m);
  m.innerHTML = withFoldAll({ verdict: viewVerdict, weather: viewWeather, roads: viewRoads, wear: viewWear, resort: viewResort, list: viewList }[S.tab]());
  viewState(m, view);
  const slot = $('#map');
  if (slot && keep) { slot.replaceWith(keep); drawMap(); } else if (slot) initMap(); else destroyMap();
}

// A redraw replaces the whole tab, and background refreshes redraw it every few minutes. What the reader had
// scrolled sideways (the hourly forecast, wide tables) and the lists they had opened are put back, as long as
// it is still the same tab of the same destination with the same parts.
const SCROLLERS = '.hours, .tablewrap, .chips';
function viewState(m, old) {
  const sc = [...m.querySelectorAll(SCROLLERS)];
  const dt = [...m.querySelectorAll('details')];
  if (!old) return { sig: m.dataset.view, left: sc.map((x) => x.scrollLeft), open: dt.map((x) => x.open) };
  m.dataset.view = `${S.tab}|${S.destId}|${S.wxPoint}`; // what is on the page from now on
  if (old.sig !== m.dataset.view || old.left.length !== sc.length || old.open.length !== dt.length) return null;
  sc.forEach((x, i) => { if (old.left[i]) x.scrollLeft = old.left[i]; });
  dt.forEach((x, i) => { x.open = old.open[i]; });
  return null;
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
  const on = L.onTrip(r, S.direction); // on one of the trip's roads, facing the way it travels there
  const pop = (title, lines) => `<b>${esc(title)}</b>${lines.filter(Boolean).map((x) => `<br>${x}`).join('')}`;
  const mark = (lat, lon, cls, label, html, z = 0) => LF.marker([lat, lon], { icon: LF.divIcon({ className: `mk ${cls}`, html: label, iconSize: null }), zIndexOffset: z }).bindPopup(html, { maxWidth: 260 }).addTo(g);

  // With traffic on, the flow colours are the road; keep our own line out of the way.
  if (!flowKind) LF.polyline(route, { color: css.getPropertyValue('--accent').trim(), weight: 4, opacity: 0.55 }).addTo(g);

  // Chain control: colour the stretch from each active checkpoint to the next one in the direction of travel.
  const nearest = (lat, lon) => { let b = 0, bd = Infinity; route.forEach(([a, o], i) => { const d = (a - lat) ** 2 + ((o - lon) * 0.78) ** 2; if (d < bd) { bd = d; b = i; } }); return b; };
  const cps = L.chainOn(S.data, r, S.direction).rows.map((c) => ({ ...c, i: nearest(c.lat, c.lon) })).sort((a, b) => (S.direction === 'out' ? a.i - b.i : b.i - a.i));
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
  if (S.mapShow.inc) for (const x of L.incidentsFor(S.data, on)) mark(x.lat, x.lon, `mk-inc ${/collision|closure|sigalert|fatal|spin/i.test(x.type) ? 'caution' : ''}`, '!', pop(x.type, [esc(x.loc), x.time ? `<span class="muted">${fTime(x.time)} · ${esc(x.area)}</span>` : '', ...x.details.map(esc)]), 300);
  if (S.mapShow.clos) for (const k of S.data.closures) if (k.lat && !L.isRamp(k) && on(k)) mark(k.lat, k.lon, `mk-cl ${L.isFull(k) ? 'nogo' : ''}`, '', pop(`${k.from} → ${k.to}`, [esc(`${k.type} · ${k.work}`), `<span class="muted">${fWhen(k.start)} ${t('until')} ${k.end ? fWhen(k.end) : t('indefinite')}</span>`]), 100);
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
  const need = f.need ? ' ' + t('m.' + f.need) : '';
  switch (f.key) {
    case 'chain': {
      if (!v) return t('m.' + f.msg);
      const top = v.max < 0 ? v.unknown : v.rows.filter((r) => r.level === v.max);
      // Name the road the strictest checkpoint is on (CA-267 rather than I-80 on the way to Northstar).
      const road = top.length && L.roadsOf(d.route).find((x) => x.highway === top[0].hw);
      return t('m.' + f.msg, { hw: road?.label || hw, n: v.max, where: esc(where(top)), st: esc([...new Set(top.map((r) => r.status || '?'))].slice(0, 2).join(', ')) }) + (f.live ? '' : ` <span class="muted">(${t('refOnly')})</span>`);
    }
    case 'closures':
      if (!v) return t('m.' + f.msg);
      return t('m.' + f.msg, { hw, n: v.full.length || v.list.length, d: v.delay, where: esc(v.full.map((c) => `${c.from} → ${c.to}`).slice(0, 2).join('; ')) });
    case 'incidents':
      if (!v) return t('m.' + f.msg);
      return t('m.' + f.msg, { hw, n: v.all.length, s: v.serious.length, from: esc(nm((d.route.points.find((p) => p.role === 'foothill') || d.route.points[0]).name)) }) + (f.live ? '' : ` <span class="muted">(${t('refOnly')})</span>`);
    case 'snow':
      if (f.msg === 'snowPack') return t('m.snowPack', { h: v.pack.hours, total: fSnow(v.pack.mm), temp: fT(v.pack.temp), where: esc(nm(v.pack.stop.point.name)) }) + need;
      return t('m.' + f.msg, v?.stop ? { rate: fSnow(v.rate), where: esc(nm(v.stop.point.name)) } : {}) + need;
    case 'alerts':
      if (!Array.isArray(v) || !v.length) return t('m.' + f.msg);
      return v.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(alertName(a.event))}</a> <span class="muted">${fWhen(a.onset)} – ${fWhen(a.ends)}${L.alertLevel(a.event) === 'ok' ? ' · ' + t('m.alertInfo') : ''}</span>`).join('<br>');
    case 'wind': return t('m.' + f.msg, { v: fWind(v) });
    case 'lift': return t('m.' + f.msg, { v: fWind(v.gust), day: fDay(v.day), lifts: nm(d.resort.windLifts) });
    case 'drive': {
      if (f.msg === 'driveMaps') return `${t('m.driveMaps', { v: fDur(d.route.driveHours * 3600) })} <a href="${esc(L.mapsUrl(d, S.direction))}" target="_blank" rel="noopener">${t('mapsLive')}</a>`;
      if (f.msg === 'driveDetour') return t('m.driveDetour', { v: fDur(v.detour), u: fDur(d.route.driveHours * 3600) });
      if (!v) return t('m.' + f.msg, { v: fDur(d.route.driveHours * 3600) });
      const dm = v.deltaMin;
      const cmp = dm == null ? '' : Math.abs(dm) < 5 ? t(v.vs === 'usual' ? 'm.driveSame' : 'm.driveFree') : t(`m.drive${dm > 0 ? 'More' : 'Less'}${v.vs === 'usual' ? 'Usual' : 'Free'}`, { d: Math.abs(dm) });
      return t('m.' + f.msg, { v: fDur(v.sec) }) + cmp + (v.snowMin ? ' ' + t('m.driveSnow', { a: v.snowMin[0], b: v.snowMin[1] }) : '');
    }
    case 'ev': return t('m.' + f.msg, { v: fT(v), climb: nm(d.route.climb) });
    case 'light': return t('m.' + f.msg, { where: esc(nm(v.at.point.name)), rise: v.rise ? fTime(v.rise) : '–', set: v.set ? fTime(v.set) : '–' });
    case 'fresh': return t('m.' + f.msg, { v: fAgo(Date.now() - v * 6e4).replace(/前$| ago$/, '') });
    default: return '';
  }
}

function viewVerdict() {
  const d = dest();
  const dm = departMs();
  const ev = L.evaluate(S.data, d, { departMs: dm, direction: S.direction, vehicle: S.vehicle });
  const day = L.dayKey(dm);
  const strip = L.departureStrip(S.data, d, S.ix, day, S.direction, Date.now(), S.vehicle);
  const win = L.bestWindow(strip);
  // On the way home: the last departure the forecast still calls clear, when later is worse.
  const last = S.direction === 'back' ? L.lastClear(strip) : null;
  const pick = S.depart !== 'now';
  const ends = S.direction === 'out' ? [d.route.points[0], d.route.points.find((p) => p.id === d.route.townPoint)] : [d.route.points.find((p) => p.id === d.route.townPoint), d.route.points[0]];

  const controls = `<div class="controls">
    ${seg('direction', S.direction, [['out', t('out')], ['back', t('back')]])}
    ${seg('mode', pick ? 'pick' : 'now', [['now', t('now')], ['pick', t('pick')]])}
    ${pick ? `<span class="when"><select data-change="day" aria-label="${t('day')}">${S.ix.days.map((x) => `<option value="${x}" ${x === day ? 'selected' : ''}>${fDay(x)}${x === L.dayKey(Date.now()) || x === L.dayKey(Date.now() + 864e5) ? ' · ' + fDayFull(x) : ''}</option>`).join('')}</select>
    <select data-change="hour" aria-label="${t('stripTitle')}">${strip.filter((x) => !x.past).map((x) => `<option value="${x.h}" ${x.h === S.depart.h ? 'selected' : ''}>${x.h % 12 || 12} ${x.h < 12 ? 'am' : 'pm'}</option>`).join('')}</select></span>` : ''}
  </div>${S.shareGone ? `<p class="note">${t('shareGone')}</p>` : ''}`;

  // Change alert for this direction: the one that is on, and a button to watch the hour picked on the strip.
  const plan = alerts.plan(d.id, S.direction);
  const sel = pickedHour();
  const busy = alerts.status() === 'busy';
  const alertRow = plan || sel ? `<div class="alertrow">
    ${plan ? `<span class="tag ok">${t('al.on', { when: fWhen(plan.departMs) })}</span><button class="ghost" data-act="alertOff" ${busy ? 'disabled' : ''}>${t('al.off')}</button>` : ''}
    ${sel && plan?.departMs !== sel.ms ? `<button class="ghost" data-act="alertOn" ${busy ? 'disabled' : ''}>${t(plan ? 'al.move' : 'al.remind')}</button>` : ''}
    ${busy ? `<span class="muted">${t('al.saving')}</span>` : S.alertErr ? `<span class="tag bad">${t('al.failed')}</span>` : ''}</div>` : '';

  const hero = `<section class="hero ${ev.level}">
    <button class="share" data-act="share">${IC.share}<span>${t('share')}</span></button>
    <div class="route">${esc(nm(ends[0].name))} → ${esc(nm(ends[1].name))}</div>
    <h1>${t(ev.level)}</h1>
    <p>${t(ev.level + 'Sub')}</p>
    <div class="times"><span>${t('departAt')} <b>${fWhen(dm)}</b></span><span>${t('arriveAt')} <b>${fTime(ev.endMs)}</b></span>${ev.drive.src === 'fixed' ? '' : `<span>${t('driveLabel')} <b>${fDur(ev.drive.sec)}</b></span>`}${ev.drive.snowMin ? `<span>${t('snowLater', { a: ev.drive.snowMin[0], b: ev.drive.snowMin[1] })}</span>` : ''}<span><a href="${esc(L.mapsUrl(d, S.direction))}" target="_blank" rel="noopener">${t(d.driveTimes === 'maps' ? 'mapsLive' : 'mapsNav')}</a></span></div>
  </section>`;

  const order = { nogo: 0, caution: 1, ok: 2, info: 3 };
  // Whether the mountain road is driven in the dark: listed with the reasons, without changing the verdict.
  const sun = L.daylight(ev.stops, d.route);
  const light = sun ? [{ key: 'light', level: 'info', msg: !sun.dark.length ? 'lightDay' : sun.before ? 'lightBefore' : 'lightAfter', v: sun }] : [];
  const factors = [...ev.factors, ...light].sort((a, b) => order[a.level] - order[b.level]).map((f) => {
    const tag = f.staleAt ? fAgo(f.staleAt) : ['chain', 'incidents'].includes(f.key) || f.msg === 'driveLive' || f.msg === 'driveDetour' ? liveTag(f.key === 'chain' && S.chainLiveAt) : f.msg === 'driveFc' ? t('fcTag') : ['snow', 'alerts', 'wind', 'lift', 'ev'].includes(f.key) ? t('fcTag') : '';
    const link = { chain: '#roads', closures: '#roads', incidents: '#roads', snow: '#weather', lift: '#resort', drive: '#roads' }[f.key];
    return `<li class="${f.level}">${dot(f.level)}<div><div class="ft">${t('f.' + f.key)}${tag ? `<span class="tag">${tag}</span>` : ''}${link ? `<a class="more" href="${link}">›</a>` : ''}</div><div class="fm">${factorText(f)}${f.staleAt ? ` <span class="muted">${t('m.srcStale', { v: fAgo(f.staleAt) })}</span>` : ''}</div></div></li>`;
  }).join('');

  const hasDrive = strip.some((x) => x.drive && !x.past);
  const stripHtml = `<div class="strip" role="group">${strip.map((s) => {
    const sel = pick ? S.depart.h === s.h : L.hourOf(dm) === s.h;
    return `<button data-act="hour" data-v="${s.h}" class="${s.past ? 'past' : s.level}${s.heavy && !s.past ? ' heavy' : ''} ${sel ? 'sel' : ''}" ${s.past ? 'disabled' : ''} title="${fHour(s.h)}"><i></i><span>${s.h % 3 === 0 ? fHour(s.h) : ''}</span>${hasDrive ? `<span class="dr">${s.h % 3 === 0 && s.drive && !s.past ? fDur(s.drive.sec, true) : ''}</span>` : ''}</button>`;
  }).join('')}</div>
  <p class="note"><b>${win ? `${t('bestWin')}: ${fHour(win.from)} – ${fHour(win.to + 1)}` : t('noWin')}${last?.h != null ? ` · ${t('lastOk', { h: fHour(last.h) })}` : ''}</b> · ${t('stripHint')}${hasDrive ? ' ' + t('stripDrive') : ''}</p>`;

  const along = `<div class="tablewrap"><table><thead><tr><th></th><th>${t('time')}</th><th>${t('temp')}</th><th>${t('snowRate')}</th><th>${t('snowLevel')}</th><th>${t('gust')}</th></tr></thead><tbody>${ev.stops.map((s) => `<tr>
      <th>${esc(nm(s.point.name))}<small>${fElev(s.elevM)}</small></th><td>${fTime(s.ms)}${L.sunDown(s.point.lat, s.point.lon, s.ms) ? `<span class="night" title="${t('nightTip')}" aria-label="${t('nightTip')}">${svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>')}</span>` : ''}</td>${s.missing ? `<td colspan="4" class="muted">${t('noData')}</td>` : `<td>${fT0(s.temp)}</td><td class="${s.snow >= L.TH.snowHeavy ? 'bad' : s.snow >= L.TH.snowLight ? 'warn' : ''}">${s.snow > 0 ? fSnow(s.snow) + '/h' : s.qpf > 0.1 ? '🌧' : '–'}</td><td>${fElev(s.snowLevel)}</td><td>${fWind(s.gust)}</td>`}</tr>`).join('')}</tbody></table></div>`;

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
    const wk = L.weekOverview(S.data, d, S.ix, dir, now, 5, 21, S.vehicle);
    const span = wk.hi - wk.lo;
    const ends = dir === 'out' ? [d.route.points[0], town] : [town, d.route.points[0]];
    const rows = wk.rows.map((r) => `<div class="wkrow"><div class="wklab"><b>${fDay(r.day)}</b><small>${r.best ? `${fHour(r.best.h)} ${fDur(r.best.drive.sec, true)}` : ''}</small>${dir === 'back' ? `<small class="wklast">${r.last ? t('wkLast', { h: fHour(r.last.h) }) : ''}</small>` : ''}</div><div class="wkbars" role="group" aria-label="${fDay(r.day)}">${r.cells.map((c) => {
      if (c.none) return '<span></span>';
      const drive = c.drive && !c.past;
      const pct = drive ? Math.round(30 + 70 * (span > 60 ? (c.drive.sec - wk.lo) / span : 0.5)) : 30;
      const sel = S.depart !== 'now' && S.direction === dir && S.depart.day === r.day && S.depart.h === c.h;
      const tip = `${fDay(r.day)} ${fHour(c.h)}${drive ? ' · ' + fDur(c.drive.sec, true) : ''}`;
      return `<button data-act="wk" data-v="${dir}|${r.day}|${c.h}" class="${c.past ? 'past' : c.level}${c.heavy && !c.past ? ' heavy' : ''}${drive || d.driveTimes === 'maps' ? '' : ' nd'}${sel ? ' sel' : ''}${c === r.best ? ' best' : ''}" ${c.past ? 'disabled' : ''} title="${tip}" aria-label="${tip}"><i style="height:${pct}%"></i></button>`;
    }).join('')}</div></div>`).join('');
    return `<h3 class="wkdir">${t(dir)} · ${esc(nm(ends[0].name))} → ${esc(nm(ends[1].name))}${wk.lo == null ? '' : `<span>${t('driveLabel')} ${fDur(wk.lo, true)} – ${fDur(wk.hi, true)}</span>`}</h3><div class="wk">${head}${rows}</div>`;
  };
  return block(S.direction) + `<div class="legend"><span><i class="lg ok"></i>${t('wkOk')}</span><span><i class="lg caution"></i>${t('wkCaution')}</span><span><i class="lg caution heavy"></i>${t('wkHeavy')}</span><span><i class="lg nogo"></i>${t('wkNogo')}</span></div><p class="note">${t(d.driveTimes === 'maps' ? 'wkHintMaps' : 'wkHint')}${S.direction === 'back' ? ' ' + t('wkLastHint') : ''}</p>`;
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
    <th>${fDay(x.day)}${x.h0 >= 3 ? `<small>${t('fromH', { h: fHour(x.h0) })}</small>` : x.h1 < 21 ? `<small>${t('toH', { h: fHour(x.h1) })}</small>` : ''}</th><td>${fT0(x.hi)} / ${fT0(x.lo)}</td>
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
// The hourly record of real chain control (data/history.json), read when the card that shows it is open.
// One file per destination; a destination whose record has not started yet has none (404) and shows "no data".
const HIST = { id: null, data: null, at: 0, loading: null };
function loadHistory() {
  const id = S.destId;
  if (HIST.id !== id) Object.assign(HIST, { id, data: null, at: 0, loading: null });
  if (HIST.loading || Date.now() - HIST.at < 10 * 6e4) return;
  const done = (j) => { if (HIST.id !== id) return; HIST.data = j; HIST.at = Date.now(); HIST.loading = null; if (S.tab === 'roads' && S.data) softRender(); };
  HIST.loading = fetch(`data/${L.historyFile(dest(), DESTINATIONS[0])}.json?ts=${Math.floor(Date.now() / 6e4)}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : r.status === 404 ? { rows: [] } : Promise.reject(new Error(r.status))))
    .then(done, (e) => { console.warn('history', e); if (HIST.id === id) { HIST.loading = null; HIST.at = Date.now() - 9 * 6e4; if (!HIST.data) done({ rows: [] }); } });
}
const chainWord = (lv) => (lv >= 4 ? t('pastClosed') : lv > 0 ? `R${lv}` : t('mapNone'));
function pastHtml() {
  loadHistory(); // and again once it is ten minutes old
  if (!HIST.data) return `<p class="muted">${t('loading')}</p>`;
  const p = L.chainPast(HIST.data, S.direction);
  if (!p.since) return `<p class="muted">${t('noData')}</p>`;
  const cls = (lv) => (lv == null ? 'na' : lv >= 3 ? 'nogo' : lv > 0 ? 'caution' : 'ok');
  const bars = p.cells.map((c) => {
    const tip = `${fDay(c.day)} ${fHour(c.h)} · ${c.level == null ? t('noData') : chainWord(c.level)}`;
    return `<span class="${cls(c.level)}${c.h === 0 ? ' newday' : ''}" title="${tip}" aria-label="${tip}"><i style="height:${c.level == null ? 100 : [22, 60, 100, 100, 100][c.level]}%"></i></span>`;
  }).join('');
  const ticks = p.cells.map((c) => `<span>${c.h % 6 === 0 ? fHour(c.h) : ''}</span>`).join('');
  const days = p.cells.map((c, i) => `<span>${c.h === 0 || i === 0 ? fDay(c.day) : ''}</span>`).join('');
  const s = p.since;
  const sum = s.open ? t('pastAll', { lv: chainWord(s.level) }) : s.fromStart ? t('pastFrom', { lv: chainWord(s.level), when: fWhen(s.t) }) : t(s.level > 0 ? 'pastSince' : 'pastClear', { lv: chainWord(s.level), when: fWhen(s.t), n: s.hours });
  return `<p class="pastsum"><b>${sum}</b></p><div class="past"><div class="pastrow days" aria-hidden="true">${days}</div><div class="pastrow bars" role="img" aria-label="${sum}">${bars}</div><div class="pastrow ticks" aria-hidden="true">${ticks}</div></div>
    <div class="legend"><span><i class="lg ok"></i>${t('mapNone')}</span><span><i class="lg caution"></i>R1 / R2</span><span><i class="lg nogo"></i>${t('mapClosed')}</span><span><i class="lg na"></i>${t('noData')}</span></div><p class="note">${t('pastNote')}</p>`;
}
const rBadge = (lv, status) => `<span class="badge ${lv <= 0 ? (lv < 0 ? 'na' : 'ok') : lv >= 3 ? 'nogo' : 'caution'}">${lv === 4 ? 'CLOSED' : lv < 0 ? esc(status || '?') : 'R' + lv}</span>`;
function viewRoads() {
  const d = dest();
  const r = d.route;
  const dir = S.direction === 'out' ? r.outboundDir : r.returnDir;
  const on = L.onTrip(r, S.direction);
  const roads = L.roadsOf(r);
  const c = L.chainOn(S.data, r, S.direction);
  const dirLabel = t(dir === 'East' ? 'east' : 'west');
  const dirSeg = `<div class="controls">${seg('direction', S.direction, [['out', `${t('out')} · ${t(r.outboundDir === 'East' ? 'east' : 'west')}`], ['back', `${t('back')} · ${t(r.returnDir === 'East' ? 'east' : 'west')}`]])}</div>`;
  const lay = (k, label) => `<button data-act="mapLayer" data-v="${k}" class="${S.mapShow[k] ? 'on' : ''}" aria-pressed="${S.mapShow[k]}">${label}</button>`;
  const mapHtml = `<div class="chips">${TOMTOM_WEB_KEY ? lay('traffic', t('mapTraffic')) : ''}${lay('inc', t('mapInc'))}${lay('clos', t('mapClos'))}${lay('cams', t('mapCams'))}${FOOD.length ? lay('food', t('mapFood')) : ''}</div><div id="map"></div>
    <div class="legend"><span><i class="lg ok"></i>${t('mapNone')}</span><span><i class="lg caution"></i>R1 / R2</span><span><i class="lg nogo"></i>${t('mapClosed')}</span></div>${S.mapShow.traffic && TOMTOM_WEB_KEY ? `<p class="note">${t('mapTrafficNote')}</p>` : ''}<p class="note">${t('mapNote')}</p>`;
  const chain = `<ul class="rows">${c.rows.map((x) => `<li>${rBadge(x.level, x.status)}<div><b>${x.hw !== r.highway ? esc(roads.find((k) => k.highway === x.hw)?.label || x.hw) + ' · ' : ''}${esc(x.name.replace(/\s*\((unselect|holding)[^)]*\)/i, ''))}</b><small>${x.elevFt ? fElev(x.elevFt / 3.28084) + ' · ' : ''}${esc(x.at)}</small>${x.level !== 0 ? `<p>${esc(x.desc)}</p>` : ''}</div></li>`).join('') || `<li class="muted">${t('noData')}</li>`}</ul>`;

  const alts = `<ul class="rows">${r.alternates.map((a) => {
    const x = L.altChain(S.data, a, S.direction);
    const txt = x.max < 0 ? t('altNA') : x.max === 0 ? t('altNone') : x.max >= 4 ? t('altClosed') : t('altMax', { n: x.max });
    // The strictest checkpoints first, each named with its road when that is not the alternate's main highway.
    const names = [...x.active].sort((p, q) => q.level - p.level).map((k) => (k.hw === a.highway ? '' : k.hw.replace('SR-', 'CA-') + ' ') + k.name);
    return `<li>${rBadge(x.max, '')}<div><b>${esc(nm(a.label))}</b><small>${txt}${names.length ? ' · ' + esc([...new Set(names)].slice(0, 3).join(', ')) : ''}</small></div></li>`;
  }).join('')}</ul>`;

  const now = Date.now();
  const clRow = (k) => `<li><span class="badge ${L.isFull(k) ? 'nogo' : k.start <= now ? 'caution' : 'na'}">${k.start <= now ? t('activeNow') : t('upcoming')}</span><div><b>${esc(k.from)} → ${esc(k.to)}</b>
    <small>${esc(k.facility)} · ${esc(k.type)} · ${esc(k.work)} · ${esc(k.dir)}</small><small>${fWhen(k.start)} ${t('until')} ${k.end ? fWhen(k.end) : t('indefinite')}${k.delayMin ? ' · ' + t('delay', { d: k.delayMin }) : ''}${k.total ? ' · ' + t('lanesOf', { a: k.lanes, b: k.total }) : ''}</small></div></li>`;
  // The mountain section first (stable, so each group stays in time order): it is the part with no way round.
  const closDir = S.data.closures.filter(on).sort((a, b) => L.onMountain(r, b) - L.onMountain(r, a));
  const soon = closDir.filter((k) => !L.isRamp(k) && k.start < now + 48 * 36e5);
  const later = closDir.filter((k) => L.isRamp(k) || k.start >= now + 48 * 36e5);
  const clos = closDir.length
    ? `<ul class="rows">${soon.map(clRow).join('') || `<li class="muted">${t('closNone48')}</li>`}</ul>${later.length ? `<details><summary>${t('closMore', { n: later.length })}</summary><ul class="rows">${later.map(clRow).join('')}</ul></details>` : ''}`
    : `<p class="muted">${t('closNone')}</p>`;

  const incDir = L.incidentsFor(S.data, on);
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
  // The map as the overview, then by how much each one can change the trip: what can stop you, the ways round, the nice-to-haves.
  return dirSeg + card('map', `${r.label} ${t('mapTitle')}`, mapHtml) +
    card('chain', `${roads.map((k) => k.label).join(' + ')} ${t('chainTitle')}`, chain, `<span class="tag">${S.chainLiveAt ? liveTag(S.chainLiveAt) : fAgo(S.data.generatedAt)}</span>${st('chain')}`) + card('past', `${roads.map((k) => k.label).join(' + ')} ${roads.length > 1 ? t(S.direction) : dirLabel} · ${t('pastTitle')}`, folded.has('past') ? '' : pastHtml()) + card('inc', t('incTitle'), inc, st('incidents')) + card('clos', t('closTitle'), clos, st('closures')) +
    card('alts', t('altTitle'), alts) + card('cams', t('camTitle'), cams, st('cams')) + foodCard + `<p class="note pad0">${t('srcTextNote')} · ${t('chainDir', { dir: dirLabel })}</p>`;
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
    <td>${x.ratio ? Math.round(x.ratio) + ':1' : '–'}</td><td>${fWind(x.gust)}</td><td>${x.lift ? `<span class="badge ${x.lift.level === 'high' ? 'nogo' : x.lift.level === 'mod' ? 'caution' : 'ok'}">${t(x.lift.level)}</span>` : '–'}</td></tr>`).join('')}</tbody></table></div><p class="note">${t('liftNote', { dest: esc(nm(d.name)) })}</p>`;

  const cams = `<div class="rcams">${d.resort.cams.map((c, i) => `<figure>${S.camsLoaded.has(i)
    ? `<iframe src="${esc(c.embed)}" title="${esc(nm(c.name))}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>`
    : `<button class="load" data-act="rcam" data-v="${i}">▶ ${t('camLoad')}</button>`}<figcaption>${esc(nm(c.name))}</figcaption></figure>`).join('')}</div>`;
  const k = d.resort.links;
  const links = `<div class="links"><a href="${k.lifts}" target="_blank" rel="noopener">${t('lifts')} ↗</a><a href="${k.snow}" target="_blank" rel="noopener">${t('snowReport')} ↗</a><a href="${k.cams}" target="_blank" rel="noopener">${t('allCams')} ↗</a></div>`;
  // Measured snow at the SNOTEL stations nearby, next to the forecast above.
  const sn = S.data.snotel?.stations || [];
  const snAt = Math.max(0, ...sn.map((x) => x.at || 0));
  const cfg = (id) => (d.resort.snotel || []).find((x) => x.id === id);
  const obs = snAt ? `<div class="tablewrap"><table class="daily"><thead><tr><th>${t('obsStation')}</th><th>${t('obsDepth')}</th><th>${t('obs24')}</th><th>${t('obs48')}</th><th>${t('obsWater')}</th><th>${t('temp')}</th></tr></thead><tbody>${sn.filter((x) => x.at && cfg(x.id)).map((x) => `<tr>
    <th>${esc(cfg(x.id).name)}<small>${esc(nm(cfg(x.id).where))} · ${fElev(cfg(x.id).elevFt / 3.28084)}</small></th><td>${fSnow(x.depth)}</td><td>${fDelta(x.d24)}</td><td>${fDelta(x.d48)}</td><td>${x.water24 == null ? '–' : fRain(Math.max(0, x.water24))}</td><td>${fT0(x.temp)}</td></tr>`).join('')}</tbody></table></div><p class="note">${t('obsNote', { when: fWhen(snAt) })}</p>` : `<p class="muted">${t('obsNone')}</p>`;
  const stObs = S.data.status.snotel;
  const obsCard = (d.resort.snotel || []).length ? card('obs', `${t('obsTitle')} · SNOTEL`, obs, stObs?.ok === false ? `<span class="tag bad">${stObs.dataAt ? t('srcStaleTag', { v: fAgo(stObs.dataAt) }) : t('loadFail')}</span>` : '') : '';
  return card('outlook', `${esc(nm(d.name))} · ${t('outlook')}`, outlook) + obsCard + card('rcams', t('resortCams'), cams) + card('links', t('official'), links);
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
// A token typed but not yet saved. Kept so that redrawing the dialog, or closing it by a click outside, does not lose it.
let tokenDraft = '';
// Every dialog closes the same way: the × pinned to its top right corner, a click outside, or Escape.
const dhead = (title) => `<div class="dhead"><h2>${title}</h2><button class="icon" aria-label="${t('close')}">${IC.x}</button></div>`;
// Closing the settings with such a token asks first, inside the dialog, whether to save it.
let closeAsk = false;
function closeDlg() {
  const d = $('#dlg');
  if (!d.querySelector('#token') || !tokenDraft.trim()) return d.close();
  closeAsk = true;
  openSettings();
  d.querySelector('.confirm').scrollIntoView({ block: 'nearest' });
}
function openSettings() {
  const v = S.vehicle;
  const chk = (k, label) => `<label class="chk"><input type="checkbox" data-change="veh" data-v="${k}" ${v[k] ? 'checked' : ''}>${label}</label>`;
  $('#dlg').innerHTML = `<form method="dialog">${dhead(t('settings'))}
    <h3>${t('theme')}</h3>${seg('themeSet', S.theme, [['auto', t('th.auto')], ['light', t('th.light')], ['dark', t('th.dark')]])}
    <h3>${t('lang')}</h3>${seg('lang', S.lang, [['zh', '中', t('tip.zh')], ['en', 'EN', t('tip.en')]])}
    <h3>${t('units')}</h3><div class="segs">${seg('tu', S.tu, [['C', '°C', t('tip.C')], ['F', '°F', t('tip.F')]])}${seg('lu', S.lu, [['imp', 'in·ft', t('tip.imp')], ['met', 'cm·m', t('tip.met')]])}</div>
    <h3>${t('vehicle')}</h3>${seg('drive', v.drive, [['awd', t('awd')], ['2wd', t('twd')]])}<div class="chks">${chk('snowTires', t('snowTires'))}${chk('chains', t('chains'))}${chk('ev', t('ev'))}</div>
    <h3>${t('syncTitle')}</h3><p class="note">${t('syncHelp')} <a href="https://github.com/settings/tokens/new?scopes=gist&description=Tahoe%20Run%20checklist" target="_blank" rel="noopener">${t('makeToken')} ↗</a></p>
    ${list.hasToken() ? `<p><span class="tag ${list.status()}">${t('sync.' + list.status())}</span> <button type="button" class="ghost" data-act="disconnect">${t('disconnect')}</button></p>${list.status() === 'err' ? `<p class="note">${syncWhy()}</p>` : ''}`
      : `<div class="add"><input id="token" type="password" autocomplete="off" placeholder="${t('tokenPh')}" value="${esc(tokenDraft)}"><button type="button" data-act="connect">${t('save')}</button></div>`}
    <h3>${t('al.title')}</h3><p class="note">${t('al.help')}</p>${alertSettings()}
    ${closeAsk && !list.hasToken() ? `<div class="confirm" role="alert"><p>${t('unsaved')}</p><button type="button" data-act="connect">${t('save')}</button><button type="button" class="ghost" data-act="discard">${t('discard')}</button></div>`
      : ''}</form>`;
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
  stopLive();
  $('#dlg').innerHTML = `<form method="dialog" class="camdlg">${dhead(`${esc(c.name)} <small>${esc(c.place)}</small>`)}<div id="camView"><img alt="${esc(c.name)}" src="${esc(c.img)}?t=${Date.now()}"></div>
    <p class="note" id="camMsg" role="status" hidden></p>
    <div class="links">${c.stream ? `<button type="button" id="camLive" data-act="camLive" data-v="${i}">▶ ${t('openStream')}</button>` : ''}</div></form>`;
  $('#dlg').showModal();
}

// Live stream of a roadside camera, played inside the camera dialog.
// Caltrans serves the streams from several servers and any single request (the playlist or a piece of video)
// is refused with 403 about one time in three, whichever camera it is. Opening the address in a new tab gave
// the browser's error page whenever the first request was the unlucky one, so the stream is played here with
// a player that simply asks again. hls.js is used where the browser can run it; iPhones play it natively.
// A refusal carries no CORS header, so the player cannot tell it from a stream that does not exist; it gives
// up when nothing is playing after LIVE_WAIT_MS and the still picture comes back with a button to try again.
const LIVE_WAIT_MS = 25000;
const LIVE = { hls: null, loading: null, timer: 0, run: 0 };
const LIVE_RETRY = { maxNumRetry: 6, retryDelayMs: 300, maxRetryDelayMs: 1500, backoff: 'linear', shouldRetry: (cfg, n) => n < cfg.maxNumRetry };
const livePolicy = (ms) => ({ default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: ms, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: LIVE_RETRY } });
function loadHls() {
  if (window.Hls) return Promise.resolve();
  return (LIVE.loading ||= new Promise((res, rej) => {
    document.head.append(Object.assign(document.createElement('script'), { src: 'js/vendor/hls.light.min.js', onload: res, onerror: () => { LIVE.loading = null; rej(); } }));
  }));
}
function stopLive() {
  LIVE.run++;
  clearTimeout(LIVE.timer);
  LIVE.hls?.destroy();
  LIVE.hls = null;
  const v = $('#camView video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}
async function playLive(i) {
  const c = S.data.cams[i];
  const view = $('#camView');
  const msg = $('#camMsg');
  const btn = $('#camLive');
  if (!c?.stream || !view) return;
  stopLive();
  const run = LIVE.run;
  const say = (k) => { msg.textContent = k ? t(k) : ''; msg.hidden = !k; };
  // Back to the still picture, with the button offering another try.
  const fail = () => {
    if (run !== LIVE.run) return;
    stopLive();
    view.innerHTML = `<img alt="${esc(c.name)}" src="${esc(c.img)}?t=${Date.now()}">`;
    say('streamFail');
    btn.hidden = false;
    btn.textContent = `▶ ${t('streamRetry')}`;
  };
  btn.hidden = true;
  say('streamWait');
  view.innerHTML = `<video controls autoplay muted playsinline poster="${esc(c.img)}"></video>`;
  const video = view.firstChild;
  const giveUp = setTimeout(fail, LIVE_WAIT_MS);
  video.addEventListener('playing', () => { clearTimeout(giveUp); if (run === LIVE.run) say(''); });
  await loadHls().catch(() => {});
  if (run !== LIVE.run) return;
  if (window.Hls?.isSupported()) {
    const hls = (LIVE.hls = new window.Hls({ manifestLoadPolicy: livePolicy(20000), playlistLoadPolicy: livePolicy(20000), fragLoadPolicy: livePolicy(60000) }));
    hls.on(window.Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(); });
    hls.loadSource(c.stream);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    let tries = 0;
    video.addEventListener('error', () => {
      if (run !== LIVE.run) return;
      if (++tries > LIVE_RETRY.maxNumRetry) return fail();
      LIVE.timer = setTimeout(() => { video.src = c.stream; video.play().catch(() => {}); }, 400);
    });
    video.src = c.stream;
  } else fail();
}
$('#dlg').addEventListener('close', stopLive);
$('#dlg').addEventListener('input', (e) => { if (e.target.id === 'token') tokenDraft = e.target.value; });
// A click outside a dialog closes it. The dialog element covers only its own box, so a click that
// lands on it but outside that box is on the backdrop. The press must start outside too, so dragging the
// video's controls out of the box and letting go there does not close it.
let dlgDownOutside = false;
const outsideDlg = (e) => {
  const d = $('#dlg');
  if (e.target !== d) return false;
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
$('#dlg').addEventListener('pointerdown', (e) => { dlgDownOutside = outsideDlg(e); });
$('#dlg').addEventListener('click', (e) => { if (dlgDownOutside && outsideDlg(e)) closeDlg(); dlgDownOutside = false; });
// Escape and the dialog's own close button go the same way.
$('#dlg').addEventListener('cancel', (e) => { e.preventDefault(); closeDlg(); });
$('#dlg').addEventListener('submit', (e) => { e.preventDefault(); closeDlg(); });
$('#dlg').addEventListener('close', () => { closeAsk = false; });

// ---------- sharing ----------
// A link to the view on the verdict tab, from the button in the corner of the verdict card. Phones and tablets hand it to the system share sheet; elsewhere it
// is copied, which is what a share sheet on a computer mostly ends in anyway.
function shareView(btn) {
  const d = dest();
  const url = `${location.origin}${location.pathname}?${shareQuery(S)}`;
  const text = [nm(d.name), t(S.direction), S.depart === 'now' ? '' : `${fDayFull(S.depart.day)} ${fHour(S.depart.h)}`].filter(Boolean).join(' · ');
  const done = (k) => {
    const label = btn.querySelector('span');
    if (!label) return;
    label.textContent = t(k);
    setTimeout(() => { if (label.isConnected) label.textContent = t('share'); }, 2500);
  };
  const copy = () => copyText(url).then(() => done('shareCopied'), () => done('shareFail'));
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ title: 'Tahoe Trip Planner', text, url }).catch((e) => { if (e?.name !== 'AbortError') copy(); }); // closing the sheet is not a failure
  } else copy();
}
// The clipboard API needs a secure page and permission; the old selection-based copy covers the rest.
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return; } catch { /* fall through */ }
  const ta = Object.assign(document.createElement('textarea'), { value: s, readOnly: true });
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy');
}

// ---------- events ----------
const setPref = (k, v) => { S[k] = v; store.set(k, v); };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const v = b.dataset.v;
  if (b.dataset.act === 'share') return shareView(b);
  S.shareGone = false; // the note about an expired link has been seen once the reader does anything
  switch (b.dataset.act) {
    // These three live in the settings dialog, which is redrawn in place.
    case 'lang': case 'tu': case 'lu': setPref(b.dataset.act, v); if (b.closest('#dlg')) { t = makeT(S.lang); openSettings(); } break;
    case 'themeSet': setPref('theme', v); t = makeT(S.lang); openSettings(); break;
    case 'direction': setPref('direction', v); break;
    case 'mode': { // the next full hour, which after 23:00 is midnight tomorrow
      const next = Date.now() + 36e5;
      S.depart = v === 'now' ? 'now' : { day: L.dayKey(next), h: L.hourOf(next) };
      break;
    }
    case 'wk': { const [dir, day, h] = v.split('|'); setPref('direction', dir); S.depart = { day, h: +h }; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    case 'hour': S.depart = { day: S.depart === 'now' ? L.dayKey(Date.now()) : S.depart.day, h: +v }; break;
    case 'wx': S.wxPoint = v; break;
    case 'quotaSeen': store.set('quotaSeen', b.dataset.v); renderChrome(); return;
    case 'refresh': b.classList.add('spin'); chainForce = true; loadData(); if (list.hasToken()) list.sync(); return;
    case 'settings': t = makeT(S.lang); return openSettings();
    case 'cam': return openCam(+v);
    case 'camLive': return playLive(+v);
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
      const fa = $('.foldall'); // keep the fold-all button in step without a full render
      if (fa) fa.outerHTML = foldAllBtn(cardKeys());
      return;
    }
    case 'foldAll': { // unfolds only when every card is already folded
      const keys = cardKeys();
      const open = keys.every((k) => folded.has(k));
      for (const k of keys) open ? folded.delete(k) : folded.add(k);
      store.set('folded', [...folded]);
      if (!open) S.camsLoaded.clear(); // stop the streams
      break;
    }
    case 'del': list.remove(v); return;
    case 'clearDone': list.clearDone(); return;
    case 'drive': S.vehicle.drive = v; store.set('vehicle', S.vehicle); openSettings(); break;
    case 'connect': { const tok = $('#token').value; if (tok.trim()) { const ask = closeAsk; tokenDraft = ''; closeAsk = false; list.connect(tok).then(() => (ask && list.status() !== 'err' ? $('#dlg').close() : openSettings())); } return; }
    case 'discard': tokenDraft = ''; closeAsk = false; $('#dlg').close(); return;
    case 'disconnect': list.disconnect(); return openSettings();
    case 'alertOn': { // asks for notification permission, so it has to start inside this tap
      const h = pickedHour();
      if (!h) break;
      if (alerts.blocker() !== 'ok') return openSettings();
      S.alertErr = false;
      alerts.set(S.destId, S.direction, { departMs: h.ms }, { lang: S.lang, vehicle: S.vehicle }).catch(() => { S.alertErr = true; }).finally(() => { if (alerts.blocker() !== 'ok') openSettings(); render(); });
      return;
    }
    case 'alertOff': S.alertErr = false; alerts.clear(S.destId, S.direction).catch(() => { S.alertErr = true; }).finally(render); return;
    case 'alertTest': alerts.test(t('al.testTitle'), t('al.testBody')).catch(() => openSettings()); return;
    case 'alertCopy': navigator.clipboard?.writeText($('#gistId').value).then(() => { b.textContent = t('al.copied'); }); $('#gistId').select(); return;
    default: return;
  }
  render();
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  S.shareGone = false;
  switch (el.dataset.change) {
    case 'day': S.depart = { day: el.value, h: hourOn(el.value, S.depart === 'now' ? 8 : S.depart.h) }; break;
    case 'hour': S.depart = { day: S.depart === 'now' ? L.dayKey(Date.now()) : S.depart.day, h: +el.value }; break;
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
  if (TABS.includes(k)) { S.tab = k; render(); window.scrollTo(0, 0); liveChain(); }
});
list.subscribe(() => { if (S.tab === 'list') { const typing = document.activeElement?.id === 'newItem' && $('#newItem').value; if (!typing) render(); } if ($('#dlg').open && $('#token') == null && $('#dlg h3')) openSettings(); });
alerts.subscribe(() => { if (S.tab === 'verdict' && S.data) softRender(); });
// The same link, while the page is already open: a tapped alert (sw.js) asks for the view of its departure.
function openView(url) {
  const v = parseShare(new URL(url, location.href).search, DEST_IDS);
  if (!v) return;
  const moved = v.destId && v.destId !== S.destId;
  if (moved) { destroyMap(); S.destId = v.destId; S.data = null; S.ix = null; S.chainLiveAt = null; S.camsLoaded.clear(); }
  if (v.direction) S.direction = v.direction;
  S.shareGone = false;
  if (v.depart) { S.depart = v.depart; sharedCheck = true; if (S.ix) checkShared(); }
  S.tab = 'verdict';
  render();
  window.scrollTo(0, 0);
  loadData();
}
// The view a tapped alert left for this page (see sw.js), taken once and only while it is fresh.
const OPEN_KEY = new URL('__open', location.href).href;
const OPEN_FRESH_MS = 2 * 6e4;
async function takeOpen() {
  try {
    const hit = await caches.match(OPEN_KEY);
    if (!hit) return null;
    for (const k of await caches.keys()) await (await caches.open(k)).delete(OPEN_KEY);
    const { url, at } = await hit.json();
    return Date.now() - at < OPEN_FRESH_MS ? url : null;
  } catch { return null; }
}
const openPending = () => takeOpen().then((url) => { if (url) openView(url); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadData(); if (list.hasToken()) list.sync(); alerts.refresh(); openPending(); } });
setInterval(() => { if (!document.hidden) loadData(); }, 5 * 6e4);
// If the device switches to the scheme that was pinned by hand, go back to following the device.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (S.theme === (e.matches ? 'dark' : 'light')) { setPref('theme', 'auto'); renderChrome(); }
  drawMap();
});

window.addEventListener('online', () => { loadData(); if (list.hasToken()) list.sync(); });
if ('serviceWorker' in navigator) {
  // On the very first visit the worker takes over after the data was already fetched; fetch once more so a copy is saved.
  // A request still on its way was sent before the worker took over and is not saved, so wait for it first.
  navigator.serviceWorker.addEventListener('controllerchange', () => Promise.resolve(loading?.p).then(() => loadData()));
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open') { takeOpen(); openView(e.data.url); } });
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline', e));
}

render();
loadData();
openPending();
if (list.hasToken()) list.sync().then(() => alerts.refresh());

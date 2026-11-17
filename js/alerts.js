// Change alerts (Web Push). The page only records what to watch: a planned departure per direction, the
// vehicle, and this device's push subscription. It is saved next to the checklist in the private Gist, where
// the scheduled workflow (scripts/notify.mjs) reads it and pushes a notification when the verdict or the chain
// level for that departure changes. The signing (VAPID) key pair is created here on first use and kept in the
// same Gist, so there is no key to copy around: the workflow only needs to know which Gist to read.
import { gist, list } from './sync.js';

export const ALERT_FILE = 'tahoe-trip-alerts.json';
const KEY = 'tr.alerts';
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

let device = ls.get('tr.dev');
if (!device) { device = b64u(crypto.getRandomValues(new Uint8Array(9))); ls.set('tr.dev', device); }

let st = { v: 2, lang: 'zh', vehicle: null, plans: {}, vapid: null, subs: {}, ts: 0, ...(ls.get(KEY) || {}) };
let status = 'idle'; // idle | busy | ok | err
let onChange = () => {};
const setStatus = (s) => { status = s; onChange(); };

// Other devices write to the same file, so every save starts from the copy in the Gist: their subscriptions
// and the shared key are kept, and whatever this device just changed (`mine`) is laid on top.
async function save(mine) {
  setStatus('busy');
  try {
    const remote = (await gist.read(ALERT_FILE)) || {};
    st = { ...st, ...remote, vapid: remote.vapid || st.vapid, subs: { ...st.subs, ...remote.subs }, plans: { ...remote.plans } };
    mine(st);
    for (const [k, p] of Object.entries(st.plans)) if (p.departMs <= Date.now()) delete st.plans[k];
    st.v = 2;
    st.ts = Date.now();
    ls.set(KEY, st);
    await gist.write(ALERT_FILE, st);
    setStatus('ok');
  } catch (e) {
    console.warn('alerts', e);
    setStatus('err');
    throw e;
  }
}

async function newVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}
// This device's push subscription under the shared key, created if missing. Needs notification permission.
async function subscription(vapid) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = sub?.options?.applicationServerKey;
  if (sub && key && b64u(key) !== vapid.publicKey) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(vapid.publicKey) });
  const j = sub.toJSON();
  return { endpoint: j.endpoint, keys: j.keys, at: Date.now(), ua: navigator.userAgent.slice(0, 120) };
}

export const alerts = {
  subscribe(fn) { onChange = fn; },
  status: () => status,
  // 'ok', or why not: 'unsupported' (on iPhone the page must be opened from the Home Screen), 'denied', 'token'.
  blocker() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (!list.hasToken()) return 'token';
    return 'ok';
  },
  enabled: () => typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!st.subs[device],
  // The plan for a direction, unless its departure time has passed.
  plan(direction, nowMs = Date.now()) { const p = st.plans[direction]; return p && p.departMs > nowMs ? p : null; },
  any: (nowMs = Date.now()) => Object.values(st.plans).some((p) => p.departMs > nowMs),
  // Must be called from a tap: the permission prompt is only allowed in response to one.
  async set(direction, plan, ctx) {
    if ((await Notification.requestPermission()) !== 'granted') { onChange(); throw new Error('denied'); }
    await save(() => {});
    setStatus('busy'); // still working: registering with the browser's push service can take a few seconds
    let sub;
    try {
      if (!st.vapid) st.vapid = await newVapid();
      sub = await Promise.race([subscription(st.vapid), new Promise((_, no) => setTimeout(no, 30000, new Error('push service timeout')))]);
    } catch (e) {
      console.warn('alerts', e);
      setStatus('err');
      throw e;
    }
    await save((s) => {
      s.vapid ||= st.vapid;
      s.subs[device] = sub;
      s.plans[direction] = { ...plan, setAt: Date.now() };
      Object.assign(s, ctx);
    });
  },
  clear: (direction) => save((s) => { delete s.plans[direction]; }),
  // Language and vehicle decide the wording and the verdict, so keep the saved copy current while a plan is on.
  context(ctx) {
    if (JSON.stringify({ lang: st.lang, vehicle: st.vehicle }) === JSON.stringify(ctx)) return;
    Object.assign(st, ctx);
    ls.set(KEY, st);
    if (alerts.any() && list.hasToken()) save((s) => Object.assign(s, ctx)).catch(() => {});
  },
  // On opening the page: pick up a plan set on another device, and re-register this device if the browser
  // replaced its push subscription (they expire from time to time).
  async refresh() {
    if (alerts.blocker() !== 'ok') return;
    try {
      const remote = await gist.read(ALERT_FILE);
      if (remote && (remote.ts || 0) > (st.ts || 0)) { st = { ...st, ...remote }; ls.set(KEY, st); onChange(); }
      if (Notification.permission !== 'granted' || !st.vapid || !alerts.any()) return;
      const sub = await subscription(st.vapid);
      if (st.subs[device]?.endpoint !== sub.endpoint) await save((s) => { s.subs[device] = sub; });
    } catch (e) { console.warn('alerts', e); }
  },
  // A notification shown by this device itself, to check that permission and the notification style work.
  async test(title, body) {
    if ((await Notification.requestPermission()) !== 'granted') { onChange(); throw new Error('denied'); }
    await (await navigator.serviceWorker.ready).showNotification(title, { body, icon: 'icon-192.png', tag: 'tahoe-test' });
  },
};

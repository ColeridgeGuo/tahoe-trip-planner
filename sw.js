// Offline support. Everything the page needs is kept in one cache and refreshed on every successful
// request, so the copy on the device is always the last one that loaded. The network is always tried
// first; the cached copy is only used when the network fails or takes too long (weak mountain signal).
const CACHE = 'tahoe-v2';
const SHELL = [
  './', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'css/style.css',
  'js/app.js', 'js/alerts.js', 'js/config.js', 'js/food.js', 'js/i18n.js', 'js/logic.js', 'js/normalize.js', 'js/share.js', 'js/sync.js',
  'js/routes/heavenly.js', 'js/routes/kirkwood.js', 'js/routes/northstar.js', 'js/vendor/leaflet.css', 'js/vendor/leaflet.js',
];
const TIMEOUT_MS = 6000;
// Marks a response that came from the cache because the network was unavailable, so the page can say so.
const OFFLINE_HEADER = 'X-Offline-Copy';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// One cache entry per file: the data URL carries a changing ?ts= that must not create new entries.
const keyOf = (req) => {
  const u = new URL(req.url);
  if (req.mode === 'navigate') return new URL('./', self.registration.scope).href;
  return u.origin + u.pathname;
};

async function fromCache(key, isData) {
  const hit = await caches.match(key);
  if (!hit || !isData) return hit;
  const headers = new Headers(hit.headers);
  headers.set(OFFLINE_HEADER, '1');
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

async function networkFirst(e) {
  const req = e.request;
  const key = keyOf(req);
  const isData = new URL(req.url).pathname.includes('/data/');
  const net = fetch(req).then(async (res) => {
    if (res.ok) await (await caches.open(CACHE)).put(key, res.clone());
    return res;
  });
  e.waitUntil(net.catch(() => {})); // a slow answer still updates the cache after the page gave up waiting
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, TIMEOUT_MS, null); });
  try {
    const res = await Promise.race([net, slow]);
    if (res?.ok) return res;
    return (await fromCache(key, isData)) || res || (await net);
  } catch (err) {
    const hit = await fromCache(key, isData);
    if (hit) return hit;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The libraries under js/vendor/ only change when a new version is put in, under the same name, which is rare.
// They are answered from the saved copy at once and refreshed in the background, so the map and the camera
// player do not wait on a weak connection; a new version is picked up on the visit after.
async function cacheFirst(e) {
  const key = keyOf(e.request);
  const cache = await caches.open(CACHE);
  const net = fetch(e.request).then(async (res) => {
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });
  const hit = await cache.match(key);
  if (!hit) return net;
  e.waitUntil(net.catch(() => {}));
  return hit;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only this site's own files. Map tiles, cameras, Caltrans and GitHub requests go straight to the network.
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== self.location.origin) return;
  e.respondWith(u.pathname.includes('/js/vendor/') ? cacheFirst(e) : networkFirst(e));
});

// Change alerts sent by the scheduled workflow (scripts/notify.mjs). The payload is JSON: { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tahoe Trip Planner', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag, renotify: !!d.tag, data: { url: d.url || './' },
  }));
});
// Tapping an alert opens the view it is about (its url carries the resort, direction and departure, as a
// share link does). A page that is already open is told to show it; otherwise a new one is opened at that
// address. The address is also left in the cache for a moment, for the page to pick up when it comes to the
// front: an installed app on iOS may be resumed without the message reaching it, or opened at its start page.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const note = caches.open(CACHE).then((c) => c.put(new URL('__open', self.registration.scope).href, new Response(JSON.stringify({ url, at: Date.now() })))).catch(() => {});
  e.waitUntil(note.then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then((cs) => {
    const open = cs.find((c) => c.url.startsWith(self.registration.scope));
    if (!open) return self.clients.openWindow(url);
    open.postMessage({ type: 'open', url });
    return open.focus();
  }));
});

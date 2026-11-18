// Checklist storage: localStorage first, optionally mirrored to a private GitHub Gist.
// Items carry a timestamp and deletions are tombstones, so two devices merge without losing edits.
const K = { list: 'tr.list', token: 'tr.gh', gist: 'tr.gist' };
const FILE = 'tahoe-run-checklist.json';
const API = 'https://api.github.com';
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let items = [];
try { items = JSON.parse(ls.get(K.list) || '[]'); } catch { items = []; }
let status = ls.get(K.token) ? 'busy' : 'off';
let lastError = ''; // why the last sync failed: 'GitHub 401', or the browser's network error text
let onChange = () => {};
let timer = null;

const persist = () => ls.set(K.list, JSON.stringify(items));
const setStatus = (s) => { status = s; onChange(); };

export const list = {
  subscribe(fn) { onChange = fn; },
  status: () => status,
  hasToken: () => !!ls.get(K.token),
  error: () => lastError,
  visible: () => items.filter((i) => !i.del).sort((a, b) => a.done - b.done || a.created - b.created),
  add(text) {
    text = text.trim();
    if (!text) return;
    items.push({ id: crypto.randomUUID(), text: text.slice(0, 200), done: false, created: Date.now(), ts: Date.now() });
    changed();
  },
  toggle(id) { const i = items.find((x) => x.id === id); if (i) { i.done = !i.done; i.ts = Date.now(); changed(); } },
  remove(id) { const i = items.find((x) => x.id === id); if (i) { i.del = true; i.ts = Date.now(); changed(); } },
  clearDone() { for (const i of items) if (i.done && !i.del) { i.del = true; i.ts = Date.now(); } changed(); },
  async connect(token) { ls.set(K.token, token.trim()); ls.set(K.gist, null); return sync(); },
  disconnect() { ls.set(K.token, null); ls.set(K.gist, null); setStatus('off'); },
  sync,
};

// Other small JSON files kept in the same Gist (the trip-alert plan). Needs the token; creates the Gist if needed.
export const gist = {
  id: () => ls.get(K.gist),
  async ensure() { if (!ls.get(K.gist)) await sync(); const id = ls.get(K.gist); if (!id) throw new Error('no gist'); return id; },
  async read(name) {
    const g = await gh(`/gists/${await gist.ensure()}`);
    try { return JSON.parse(g.files[name]?.content || 'null'); } catch { return null; }
  },
  async write(name, obj) {
    await gh(`/gists/${await gist.ensure()}`, { method: 'PATCH', body: JSON.stringify({ files: { [name]: { content: JSON.stringify(obj, null, 1) } } }) });
  },
};

function changed() {
  persist();
  onChange();
  clearTimeout(timer);
  timer = setTimeout(sync, 800);
}

function merge(remote) {
  const map = new Map(items.map((i) => [i.id, i]));
  for (const r of remote) {
    const l = map.get(r.id);
    if (!l || (r.ts || 0) > (l.ts || 0)) map.set(r.id, r);
  }
  const cutoff = Date.now() - 30 * 864e5;
  return [...map.values()].filter((i) => !(i.del && i.ts < cutoff));
}

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${ls.get(K.token)}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

async function sync() {
  if (!ls.get(K.token)) return setStatus('off');
  setStatus('busy');
  try {
    let id = ls.get(K.gist);
    let remote = [];
    if (!id) {
      const mine = await gh('/gists?per_page=100');
      id = mine.find((g) => g.files && g.files[FILE])?.id || null;
    }
    if (id) {
      const g = await gh(`/gists/${id}`);
      try { remote = JSON.parse(g.files[FILE]?.content || '[]'); } catch { remote = []; }
    }
    items = merge(remote);
    persist();
    const body = JSON.stringify({ description: 'Tahoe Trip Planner checklist', public: false, files: { [FILE]: { content: JSON.stringify(items, null, 1) } } });
    if (!id) id = (await gh('/gists', { method: 'POST', body })).id;
    else if (JSON.stringify(remote) !== JSON.stringify(items)) await gh(`/gists/${id}`, { method: 'PATCH', body });
    ls.set(K.gist, id);
    lastError = '';
    setStatus('ok');
  } catch (e) {
    console.warn('sync', e);
    lastError = String(e.message || e).slice(0, 80);
    setStatus('err');
  }
}

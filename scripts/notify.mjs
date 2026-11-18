// Change alerts. Runs after scripts/fetch.mjs on every scheduled refresh: reads the departure the user is
// watching (saved by the page in their private Gist), works out the verdict and the chain level for it from
// the data just fetched, and sends a Web Push notification when either differs from what was last sent.
// Node 22+, no dependencies. Never fails the workflow: any problem is logged and the deploy carries on.
import { writeFile, readFile } from 'node:fs/promises';
import { createECDH, createCipheriv, createPrivateKey, createHash, hkdfSync, randomBytes, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DESTINATIONS, DEFAULT_VEHICLE } from '../js/config.js';
import { evaluate, chainFor, LV, hourOf } from '../js/logic.js';
import { makeT } from '../js/i18n.js';

const FILE = 'tahoe-trip-alerts.json';
const TZ = 'America/Los_Angeles';
const CHAIN_WINDOW_MS = 24 * 36e5; // chain control is a live reading: only worth a push this close to leaving
const START_WINDOW_MS = 3 * 36e5; // "alert is on" is only sent for a departure that was set this recently
const DRIVE_STEP_SEC = 30 * 60; // a drive time this much longer or shorter than last reported is worth a push
const PRE_MS = 2 * 36e5; // the last summary goes out this long before leaving
const EVE_HOUR = 20; // the evening summary goes out from this hour (Pacific) on the day before
const WD_QUIET_MS = 24 * 36e5; // "refresh has stopped" is repeated at most this often
const RANK = { go: 0, caution: 1, nogo: 2 };
const NEEDED = ['chain', 'closures', 'incidents', 'alerts', 'weather']; // sources the verdict rests on
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------- what to say ----------
// The verdict and chain level for one planned departure, or null when a source failed on this run: a verdict
// built on a gap would flip to "caution" and back, and that is not a change in the road.
export function planState(data, dest, plan, vehicle, nowMs = Date.now()) {
  if (NEEDED.some((k) => data.status?.[k]?.ok === false)) return null;
  const r = dest.route;
  const ev = evaluate(data, dest, { departMs: plan.departMs, direction: plan.direction, vehicle, nowMs });
  const worst = Math.max(...ev.factors.map((f) => LV[f.level]));
  return {
    level: ev.level,
    drive: ev.drive.src !== 'fixed', // false: no TomTom time for this departure, the fixed estimate was used
    ...(ev.drive.src !== 'fixed' ? { sec: Math.round(ev.drive.sec) } : {}), // the TomTom drive time, when there is one
    chain: chainFor(data, r.highway, ev.dir).max,
    why: worst > 0 ? ev.factors.filter((f) => LV[f.level] === worst).map((f) => f.key) : [],
  };
}

// The summaries still owed for a departure: one the evening before (from 20:00 Pacific on the previous day)
// and one two hours before leaving. Returns which are due now.
export function summariesDue(plan, nowMs) {
  const hour0 = Math.floor(plan.departMs / 36e5) * 36e5;
  const eveMs = hour0 - hourOf(hour0) * 36e5 - (24 - EVE_HOUR) * 36e5; // Pacific offsets are whole hours
  const pre = nowMs >= plan.departMs - PRE_MS;
  return { eve: nowMs >= eveMs, pre };
}
const fDur = (sec) => `${Math.floor(Math.round(sec / 60) / 60)}:${String(Math.round(sec / 60) % 60).padStart(2, '0')}`;

// Compares with what was last sent (`told`). Returns the notification to send and the new `told`, or null.
// `told` holds: level, chain, drive (as in planState), sec (the drive time last reported), and eve / pre once
// that summary has gone out or its moment had already passed when the alert was set.
export function decide(told, cur, plan, dest, lang, nowMs = Date.now()) {
  const t = makeT(lang);
  const r = dest.route;
  const dir = plan.direction === 'out' ? r.outboundDir : r.returnDir;
  const chainName = (n) => (n >= 4 ? t('al.chainClosed') : n > 0 ? `R${n}` : n === 0 ? t('al.chainNone') : t('al.chainNA'));
  const when = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: lang !== 'zh' }).format(plan.departMs);
  const name = dest.name[lang] || dest.name.en;
  const title = t('al.nTitle', { dest: name, dir: t(plan.direction), when });
  const hw = `${r.label} ${t(dir === 'East' ? 'east' : 'west')}`;
  const why = cur.why.length ? '\n' + t('al.nWhy', { list: cur.why.map((k) => t('f.' + k)).join(lang === 'zh' ? '、' : ', ') }) : '';
  const due = summariesDue(plan, nowMs);
  const flags = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  const driveTxt = cur.sec != null ? t('al.nDriveNow', { v: fDur(cur.sec) }) : '';
  if (!told) {
    // A summary whose moment has already passed is not sent later: the message below says the same.
    const now = { level: cur.level, chain: cur.chain, drive: cur.drive, ...(cur.sec != null ? { sec: cur.sec } : {}), ...flags(due) };
    // No record of this departure although it was set a while ago: the published state was lost (a failed
    // run, a site outage). Take the current reading as the baseline quietly instead of announcing it again.
    if (nowMs - (plan.setAt || 0) > START_WINDOW_MS) return { silent: true, told: now };
    return { title, body: t('al.nStart', { level: t(cur.level), hw, chain: chainName(cur.chain) }) + (driveTxt ? '\n' + driveTxt : '') + why, told: now };
  }
  // The drive time was part of the last verdict and is missing now (TomTom failed): an apparent improvement
  // may only be the lost traffic delay, so it is not reported until drive times are back. Worse is still sent.
  const blind = told.drive && !cur.drive && RANK[cur.level] < RANK[told.level];
  const level = blind ? told.level : cur.level;
  const lines = [];
  if (level !== told.level) lines.push(t('al.nLevel', { a: t(told.level), b: t(level) }));
  const chainNow = plan.departMs - nowMs <= CHAIN_WINDOW_MS && cur.chain !== told.chain;
  if (chainNow) lines.push(t('al.nChain', { hw, a: chainName(told.chain), b: chainName(cur.chain) }));
  // Drive time: reported when it moved half an hour or more from the one last reported.
  const driveNow = cur.sec != null && told.sec != null && Math.abs(cur.sec - told.sec) >= DRIVE_STEP_SEC;
  if (driveNow) lines.push(t(cur.sec > told.sec ? 'al.nDriveUp' : 'al.nDriveDown', { a: fDur(told.sec), b: fDur(cur.sec), d: Math.round(Math.abs(cur.sec - told.sec) / 60) }));
  // Summaries: sent once each, even when nothing changed, so that silence is not mistaken for a dead alert.
  const sum = due.pre && !told.pre ? 'pre' : due.eve && !told.eve ? 'eve' : null;
  if (sum) lines.unshift(t(sum === 'pre' ? 'al.nSumPre' : 'al.nSumEve', { level: t(level), hw, chain: chainName(cur.chain) }) + (driveTxt && !driveNow ? '\n' + driveTxt : ''));
  // The drive time last reported: the first one seen is the baseline, and it then moves only when a
  // notification stated the current one.
  const sec = cur.sec != null && (told.sec == null || driveNow || sum) ? cur.sec : told.sec;
  const next = {
    level,
    chain: chainNow || sum ? cur.chain : told.chain,
    drive: blind ? told.drive : cur.drive,
    ...(sec != null ? { sec } : {}),
    ...flags({ eve: told.eve || !!sum, pre: told.pre || sum === 'pre' }),
  };
  if (!lines.length) {
    // Nothing to say, but a drive time has appeared for the first time: remember it as the baseline.
    return told.sec == null && cur.sec != null ? { silent: true, told: next } : null;
  }
  return { title, body: lines.join('\n') + why, told: next };
}

// The scheduled refresh has stopped (the hourly watchdog found the published data too old and started this
// run). Says so once a day at most; `wd` is when it was last said.
export function watchdogNote(wd, ageMin, lang, nowMs = Date.now()) {
  if (wd?.at && nowMs - wd.at < WD_QUIET_MS) return null;
  const t = makeT(lang);
  return { title: t('al.wdTitle'), body: t('al.wdBody', { v: ageMin >= 120 ? `${Math.round(ageMin / 60)} ${t('hr')}` : `${Math.round(ageMin)} ${t('min')}` }) };
}

// ---------- Web Push (RFC 8291 message encryption, RFC 8292 VAPID) ----------
export function encrypt(plaintext, p256dh, auth, { salt = randomBytes(16), ecdh } = {}) {
  if (!ecdh) { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); }
  const ua = Buffer.from(p256dh, 'base64url');
  const as = ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(ua), Buffer.from(auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = as.length;
  return Buffer.concat([head, as, body]);
}
export function vapidAuth(endpoint, vapid, subject, nowMs = Date.now()) {
  const part = (o) => b64u(JSON.stringify(o));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key: vapid.privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}
async function push(sub, vapid, subject, payload) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(4 * 3600), Urgency: 'high', Authorization: vapidAuth(sub.endpoint, vapid, subject) },
    body: encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 404 || r.status === 410 ? ' (subscription expired; open the page on that device to renew it)' : ''} ${(await r.text()).slice(0, 120)}`);
}

// ---------- reading the plan and the last state ----------
// ALERT_GIST_ID is the Gist's id or its URL. A secret Gist is readable by anyone who knows the id, so no
// token is needed; the id itself is the secret.
async function readPlan() {
  if (process.env.ALERT_PLAN_FILE) return JSON.parse(await readFile(process.env.ALERT_PLAN_FILE, 'utf8')); // local testing
  const m = /(?:gist\.github\.com\/([^/\s]+)\/)?([0-9a-f]{20,})\s*$/i.exec(process.env.ALERT_GIST_ID || '');
  if (!m) return undefined;
  const owner = m[1] || process.env.GITHUB_REPOSITORY_OWNER;
  const api = async (headers) => {
    const r = await fetch(`https://api.github.com/gists/${m[2]}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tahoe-trip-planner', ...headers }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`gist API HTTP ${r.status}`);
    const f = (await r.json()).files?.[FILE];
    return f ? JSON.parse(f.content) : null;
  };
  const raw = async () => {
    const r = await fetch(`https://gist.githubusercontent.com/${owner}/${m[2]}/raw/${FILE}?ts=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`gist raw HTTP ${r.status}`);
    return r.json();
  };
  const tries = [...(process.env.GITHUB_TOKEN ? [() => api({ Authorization: `Bearer ${process.env.GITHUB_TOKEN}` })] : []), () => api({}), raw];
  let err;
  for (const f of tries) { try { return await f(); } catch (e) { err = e; } }
  throw err;
}
const stateUrl = new URL('../data/alerts.json', import.meta.url);
// What was last sent, published with the site by the previous run. It holds no trip details: only a hash per
// watched departure with the verdict and chain level last notified.
async function lastState() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (owner && !process.env.ALERT_PLAN_FILE) {
    let err;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`https://${owner.toLowerCase()}.github.io/${repo}/data/alerts.json?ts=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
        if (r.ok) return await r.json();
        if (r.status === 404) return {};
        err = new Error(`last state: HTTP ${r.status}`);
      } catch (e) { err = e; }
      await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
    }
    throw err;
  }
  try { return JSON.parse(await readFile(stateUrl, 'utf8')); } catch { return {}; }
}

async function main() {
  // The state file is rebuilt on every run and published with the site, so whatever happens below, the
  // previous state has to be written back or the next run would find none.
  const state = await lastState();
  await writeFile(stateUrl, JSON.stringify(state));
  const cfg = await readPlan();
  if (cfg === undefined) return console.log('alerts: ALERT_GIST_ID not set, skipping');
  const now = Date.now();
  const plans = Object.entries(cfg?.plans || {}).map(([direction, p]) => ({ ...p, direction })).filter((p) => p.departMs > now);
  const subs = Object.entries(cfg?.subs || {});
  const next = {};
  const lang = cfg?.lang === 'en' ? 'en' : 'zh';
  const send = async (payload) => {
    let sent = 0;
    for (const [id, sub] of subs) {
      try { await push(sub, cfg.vapid, site, { url: site, ...payload }); sent++; }
      catch (e) { console.error(`alerts: device ${id}: ${e.message}`); }
    }
    console.log(`alerts: sent to ${sent} of ${subs.length} device(s)`);
    return sent;
  };
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  const site = owner ? `https://${owner.toLowerCase()}.github.io/${repo}/` : 'http://localhost:8000/';
  // Started by the watchdog because the scheduled refresh stopped: say so, once a day at most. An ordinary
  // scheduled run (workflow_dispatch without that flag) means the schedule is back, and clears the record.
  if (process.env.WATCHDOG_AGE_MIN) {
    const note = watchdogNote(state._wd, +process.env.WATCHDOG_AGE_MIN, lang, now);
    next._wd = state._wd;
    if (note && process.env.ALERT_DRY) console.log(`--- ${note.title}\n${note.body}\n---`);
    if (note && (process.env.ALERT_DRY || (subs.length && (await send({ ...note, tag: 'refresh-stopped' }))))) next._wd = { at: now };
    console.log(`alerts: watchdog run, published data was ${process.env.WATCHDOG_AGE_MIN} min old${note ? '' : ', already reported in the last day'}`);
  } else if (state._wd && process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') next._wd = state._wd;
  for (const plan of plans) {
    const dest = DESTINATIONS.find((d) => d.id === plan.dest) || DESTINATIONS[0];
    const key = createHash('sha256').update(`${cfg.vapid?.publicKey}|${dest.id}|${plan.direction}|${plan.departMs}`).digest('hex').slice(0, 16);
    if (state[key]) next[key] = state[key];
    const data = JSON.parse(await readFile(new URL(`../data/${dest.id}.json`, import.meta.url), 'utf8'));
    const cur = planState(data, dest, plan, { ...DEFAULT_VEHICLE, ...cfg.vehicle }, now);
    if (!cur) { console.log(`alerts: ${plan.direction} skipped, a source failed on this run`); continue; }
    const msg = decide(state[key], cur, plan, dest, lang, now);
    console.log(`alerts: ${plan.direction} in ${Math.round((plan.departMs - now) / 36e5)} h: ${cur.level}, chain ${cur.chain}${cur.sec != null ? `, drive ${Math.round(cur.sec / 60)} min` : ''}${msg ? (msg.silent ? '' : state[key] ? ' -> notifying' : ' -> first check, notifying') : ', nothing to send'}`);
    if (!msg) continue;
    if (msg.silent) { console.log(`alerts: ${plan.direction}: recording the current state without notifying`); next[key] = msg.told; continue; }
    if (process.env.ALERT_DRY) { console.log(`--- ${msg.title}\n${msg.body}\n---`); next[key] = msg.told; continue; }
    if (await send({ title: msg.title, body: msg.body, tag: `trip-${plan.direction}` })) next[key] = msg.told; // nothing delivered: leave the state alone so the next run tries again
  }
  if (!plans.length) console.log('alerts: no departure being watched');
  await writeFile(stateUrl, JSON.stringify(next));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => console.error(`alerts: ${e.message}`));
}

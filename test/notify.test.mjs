// Change alerts: when a push notification is sent for the departure being watched (scripts/notify.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planState, decide, summariesDue, watchdogNote, quotaNote, watched, planUrl } from '../scripts/notify.mjs';
import { quotaState } from '../js/logic.js';
import { parseShare } from '../js/share.js';
import { dest, H, MIN, NOW, AWD, makeData, fail, chainRow, closure, liveDrive } from './helpers.mjs';

const plan = (over = {}) => ({ dest: dest.id, direction: 'out', departMs: NOW + 3 * H, setAt: NOW - 10 * MIN, ...over });
const state = (data, p = plan()) => planState(data, dest, p, AWD, NOW);
// The fixture departure is at 09:00 on the same morning, so the evening-before summary is already behind it.
const told = (over = {}) => ({ level: 'go', chain: 0, drive: false, eve: true, ...over });
const cur = (over = {}) => ({ level: 'go', chain: 0, drive: false, why: [], ...over });
const say = (t, c, p = plan(), lang = 'zh') => decide(t, c, p, dest, lang, NOW);

describe('the state of a watched departure', () => {
  test('quiet: go, no reason given', () => {
    assert.deepEqual(state(makeData({ chain: [chainRow(0)] })), { level: 'go', drive: false, chain: 0, why: [] });
  });
  test('names what makes it worse than go', () => {
    const s = state(makeData({ chain: [chainRow(2)], closures: [closure({ end: NOW + 12 * H })] }));
    assert.equal(s.level, 'nogo');
    assert.equal(s.chain, 2);
    assert.deepEqual(s.why, ['closures']); // only the worst factors, not the R2 caution
  });
  test('chain control is read for the direction of the trip', () => {
    const data = makeData({ chain: [chainRow(2, 'West'), chainRow(0, 'East')] });
    assert.equal(state(data).chain, 0);
    assert.equal(state(data, plan({ direction: 'back' })).chain, 2);
  });
  test('says whether a TomTom time went into the verdict', () => {
    const withTime = state(makeData({ drive: liveDrive() }), plan({ departMs: NOW + 10 * MIN }));
    assert.equal(withTime.drive, true);
    assert.equal(withTime.sec, 13500);
    assert.equal(state(makeData()).drive, false);
    assert.equal(state(makeData()).sec, undefined);
  });
  for (const key of ['chain', 'closures', 'incidents', 'alerts', 'weather']) {
    test(`${key} failed on this run: the state says so`, () => {
      assert.deepEqual(state(fail(makeData(), key)).partial, [key]);
      assert.deepEqual(state(fail(makeData(), key, NOW - 20 * MIN)).partial, [key]); // even with carried-over data
    });
  }
  test('a failed camera feed or TomTom does not hold alerts back', () => {
    assert.notEqual(state(fail(fail(makeData(), 'cams'), 'drive')), null);
  });
});

describe('whether to notify', () => {
  test('nothing changed: silence', () => {
    assert.equal(say(told(), cur()), null);
    assert.equal(say(told({ level: 'caution', chain: 1 }), cur({ level: 'caution', chain: 1, why: ['chain'] })), null);
  });
  test('first check of a departure just set: confirms the alert is on and records the state', () => {
    const m = say(undefined, cur({ level: 'caution', chain: 1, why: ['chain'] }));
    assert.ok(m.title && m.body);
    assert.ok(!m.silent);
    assert.ok(m.body.includes('R1'));
    assert.deepEqual(m.told, { level: 'caution', chain: 1, drive: false, eve: true });
  });
  test('no record of a departure set hours ago: take the state quietly, do not announce it again', () => {
    const m = say(undefined, cur(), plan({ setAt: NOW - 3 * H - MIN }));
    assert.equal(m.silent, true);
    assert.equal(m.title, undefined);
    assert.deepEqual(m.told, { level: 'go', chain: 0, drive: false, eve: true });
  });
  test('the verdict changed, either way', () => {
    const worse = say(told(), cur({ level: 'nogo', why: ['closures'] }));
    assert.equal(worse.told.level, 'nogo');
    assert.ok(worse.body.length > 0);
    assert.equal(say(told({ level: 'nogo' }), cur()).told.level, 'go');
  });
  test('the chain level changed for a trip within 24 hours', () => {
    const m = say(told(), cur({ chain: 2 }));
    assert.ok(m.body.includes('R2'));
    assert.equal(m.told.chain, 2);
    assert.equal(say(told({ chain: 2 }), cur({ chain: 0 })).told.chain, 0); // lifted
  });
  test('a chain change for a trip further away is not sent, and not forgotten', () => {
    const far = plan({ departMs: NOW + 24 * H + MIN });
    assert.equal(say(told(), cur({ chain: 2 }), far), null);
    // If the verdict changes meanwhile, the chain level last told stays, so it is still reported once the trip is near.
    const m = say(told(), cur({ level: 'caution', chain: 2, why: ['snow'] }), far);
    assert.equal(m.told.chain, 0);
    assert.ok(!m.body.includes('R2'));
    assert.ok(say(m.told, cur({ level: 'caution', chain: 2, why: ['snow'] }), plan({ departMs: NOW + 23 * H })).body.includes('R2'));
  });
  test('both changed: one notification with both', () => {
    const m = say(told(), cur({ level: 'caution', chain: 1, why: ['chain'] }));
    assert.equal(m.body.split('\n').length, 3); // verdict, chain, reason
    assert.deepEqual(m.told, { level: 'caution', chain: 1, drive: false, eve: true });
  });
  test('TomTom dropped out: an apparent improvement is held back until drive times return', () => {
    const before = told({ level: 'caution', drive: true });
    assert.equal(say(before, cur({ level: 'go', drive: false })), null);
    const back = say(before, cur({ level: 'go', drive: true }));
    assert.deepEqual(back.told, { level: 'go', chain: 0, drive: true, eve: true });
  });
  test('TomTom dropped out: getting worse is still sent', () => {
    const m = say(told({ level: 'caution', drive: true }), cur({ level: 'nogo', drive: false, why: ['closures'] }));
    assert.deepEqual(m.told, { level: 'nogo', chain: 0, drive: false, eve: true });
  });
  test('held-back improvement does not block a chain change', () => {
    const m = say(told({ level: 'caution', chain: 1, drive: true }), cur({ level: 'go', chain: 2, drive: false }));
    assert.deepEqual(m.told, { level: 'caution', chain: 2, drive: true, eve: true });
  });
  test('English and Chinese both produce a message', () => {
    for (const lang of ['zh', 'en']) {
      const m = say(told(), cur({ level: 'nogo', chain: 4, why: ['closures', 'chain'] }), plan({ direction: 'back' }), lang);
      assert.ok(m.title.length > 0 && m.body.length > 0, lang);
      assert.ok(!/undefined|\{\w+\}/.test(m.title + m.body), lang); // every placeholder filled, every key found
    }
  });
});

describe('drive time changes', () => {
  const MINS = 60;
  test('half an hour longer than last reported: sent, and that becomes the new baseline', () => {
    const m = say(told({ drive: true, sec: 4 * 3600 }), cur({ drive: true, sec: 4 * 3600 + 30 * MINS }));
    assert.ok(m.body.includes('4:00') && m.body.includes('4:30'));
    assert.equal(m.told.sec, 4 * 3600 + 30 * MINS);
  });
  test('less than half an hour: silence, and the baseline stays so small steps cannot creep past it unseen', () => {
    const before = told({ drive: true, sec: 4 * 3600 });
    assert.equal(say(before, cur({ drive: true, sec: 4 * 3600 + 29 * MINS })), null);
    assert.equal(say(before, cur({ drive: true, sec: 4 * 3600 - 29 * MINS })), null);
  });
  test('half an hour shorter is sent too', () => {
    const m = say(told({ drive: true, sec: 5 * 3600 }), cur({ drive: true, sec: 4 * 3600 + 20 * MINS }));
    assert.ok(m.body.includes('4:20'));
  });
  test('the first drive time seen is recorded quietly', () => {
    const m = say(told(), cur({ drive: true, sec: 4 * 3600 }));
    assert.equal(m.silent, true);
    assert.equal(m.told.sec, 4 * 3600);
  });
  test('TomTom missing on this run: nothing sent, the baseline is kept', () => {
    assert.equal(say(told({ drive: true, sec: 4 * 3600 }), cur({ drive: false })), null);
    const m = say(told({ drive: true, sec: 4 * 3600 }), cur({ drive: false, chain: 1 }));
    assert.equal(m.told.sec, 4 * 3600);
  });
  test('the first message states the drive time', () => {
    const m = say(undefined, cur({ drive: true, sec: 4 * 3600 + 5 * MINS }));
    assert.ok(m.body.includes('4:05'));
    assert.equal(m.told.sec, 4 * 3600 + 5 * MINS);
  });
});

describe('summaries before leaving', () => {
  // Leaving Thursday 15 Jan at 07:00 Pacific. NOW is Tuesday 06:00.
  const depart = NOW + 49 * H;
  const eve = depart - 11 * H; // Wednesday 20:00 Pacific
  const p = plan({ departMs: depart, setAt: NOW });
  const at = (ms, t, c = cur()) => decide(t, c, p, dest, 'zh', ms);
  const fresh = { level: 'go', chain: 0, drive: false };
  test('due from 20:00 Pacific the evening before, and from two hours before leaving', () => {
    assert.deepEqual(summariesDue(p, eve - MIN), { eve: false, pre: false });
    assert.deepEqual(summariesDue(p, eve), { eve: true, pre: false });
    assert.deepEqual(summariesDue(p, depart - 2 * H), { eve: true, pre: true });
  });
  test('nothing before the evening', () => {
    assert.equal(at(eve - MIN, fresh), null);
  });
  test('the evening summary goes out once, although nothing changed', () => {
    const m = at(eve, fresh, cur({ drive: true, sec: 4 * 3600 }));
    assert.ok(m.body.includes('4:00'));
    assert.equal(m.told.eve, true);
    assert.equal(m.told.pre, undefined);
    assert.equal(at(eve + 15 * MIN, m.told, cur({ drive: true, sec: 4 * 3600 })), null);
  });
  test('two hours before leaving: the last summary, once', () => {
    const m = at(depart - 2 * H, { ...fresh, eve: true });
    assert.equal(m.told.pre, true);
    assert.equal(at(depart - 2 * H + 15 * MIN, m.told), null);
  });
  test('a summary and a change on the same run are one notification', () => {
    const m = at(eve, fresh, cur({ level: 'caution', why: ['snow'] }));
    assert.equal(m.body.split('\n').length, 3); // summary, verdict change, reason
    assert.equal(m.told.level, 'caution');
  });
  test('an alert set after the evening has passed does not get that summary later', () => {
    const m = at(eve + H, undefined, cur(), );
    assert.equal(decide(undefined, cur(), plan({ departMs: depart, setAt: eve + H }), dest, 'zh', eve + H).told.eve, true);
    assert.ok(m);
  });
  test('a missed evening summary is not sent after the two-hour one', () => {
    const m = at(depart - H, fresh);
    assert.equal(m.told.eve, true);
    assert.equal(m.told.pre, true);
    assert.equal(at(depart - 30 * MIN, m.told), null);
  });
  test('the summary carries the chain level even for a trip more than a day away', () => {
    const late = plan({ departMs: NOW + 64 * H, setAt: NOW }); // Thursday 22:00: the evening before is 26 h ahead of it
    const m = decide({ ...fresh }, cur({ chain: 2 }), late, dest, 'zh', late.departMs - 26 * H);
    assert.ok(m.body.includes('R2'));
    assert.equal(m.told.chain, 2);
  });
  test('English and Chinese both fill every placeholder', () => {
    for (const lang of ['zh', 'en']) {
      for (const [ms, t] of [[eve, fresh], [depart - 2 * H, { ...fresh, eve: true, sec: 3 * 3600 }]]) {
        const m = decide(t, cur({ drive: true, sec: 5 * 3600 }), p, dest, lang, ms);
        assert.ok(!/undefined|\{\w+\}/.test(m.title + m.body), lang + m.body);
      }
    }
  });
});

describe('the scheduled refresh stopped', () => {
  test('said once, then not again for a day', () => {
    const m = watchdogNote(undefined, 70, 'zh', NOW);
    assert.ok(m.title && m.body.includes('70'));
    assert.equal(watchdogNote({ at: NOW - 23 * H }, 70, 'zh', NOW), null);
    assert.ok(watchdogNote({ at: NOW - 25 * H }, 70, 'zh', NOW));
  });
  test('a long outage is given in hours; both languages fill every placeholder', () => {
    assert.ok(watchdogNote(undefined, 600, 'zh', NOW).body.includes('10 小时'));
    for (const lang of ['zh', 'en']) assert.ok(!/undefined|\{\w+\}/.test(watchdogNote(undefined, 600, lang, NOW).body));
  });
});

describe('a source failed on this run', () => {
  const gap = (over = {}) => cur({ level: 'caution', why: ['snow'], partial: ['weather'], ...over });
  test('nothing is announced for a departure not reported on yet', () => {
    assert.equal(say(undefined, gap()), null);
  });
  test('the verdict is held: a gap in the data is not a change in the road', () => {
    assert.equal(say(told(), gap()), null);
    assert.equal(say(told({ level: 'caution' }), gap({ level: 'go' })), null);
  });
  test('a chain change from a working feed still goes out, with the verdict as last said', () => {
    const m = say(told(), gap({ chain: 2 }));
    assert.match(m.body, /R2/);
    assert.doesNotMatch(m.body, /原因|谨慎/);
    assert.equal(m.told.level, 'go');
    assert.equal(m.told.chain, 2);
  });
  test('the chain level is held too when it is the chain feed that failed', () => {
    assert.equal(say(told(), gap({ chain: 2, partial: ['chain'] })), null);
    assert.equal(say(told({ chain: 2 }), gap({ chain: 0, partial: ['chain'] })), null);
  });
  test('the summary before leaving is not put off, and says what did not update', () => {
    const soon = plan({ departMs: NOW + 90 * MIN });
    const m = say(told(), gap(), soon);
    assert.match(m.body, /快出发了/);
    assert.match(m.body, /天气预报这次没更新/);
    assert.equal(m.told.pre, true);
    assert.equal(m.told.level, 'go');
    // Once the source is back, the real change is reported against what was last said.
    const back = say(m.told, cur({ level: 'caution', why: ['snow'] }), soon);
    assert.match(back.body, /可以出发.*谨慎|→/s);
    assert.equal(back.told.level, 'caution');
  });
  test('a drive time that moved half an hour still goes out', () => {
    const m = say(told({ drive: true, sec: 4 * 3600 }), gap({ drive: true, sec: 4 * 3600 + 40 * 60 }));
    assert.ok(m && !m.silent);
    assert.equal(m.told.level, 'go');
  });
});

describe('snow and the drive time in a notification', () => {
  test('the estimated extra time for snow is said next to the drive time', () => {
    const m = say(undefined, cur({ level: 'caution', why: ['snow'], drive: true, sec: 13320, snowMin: [45, 90] }));
    assert.match(m.body, /3:42/);
    assert.match(m.body, /45–90/);
    assert.equal(m.told.snowMin, undefined); // not part of what is compared next time
    assert.doesNotMatch(say(undefined, cur({ drive: true, sec: 13320 })).body, /雪天/);
  });
});

describe('TomTom allowance', () => {
  const tt = (monthN, o = {}) => ({ day: '2026-12-20', n: 500, month: '2026-12', monthN, from: '2026-12-01', quota: 20000, ...o });
  test('the level: fine below 80%, close from 80%, past it from 100%', () => {
    assert.deepEqual([15999, 16000, 19999, 20000].map((n) => quotaState(tt(n)).lv), [0, 1, 1, 2]);
    assert.equal(quotaState({ day: '2026-11-18', n: 5 }), null); // a file published before the month was counted
    assert.equal(quotaState(null), null);
  });
  test('a count that began part-way through the month says from when; a whole month does not', () => {
    assert.equal(quotaState(tt(180, { from: '2026-12-18' })).from, '2026-12-18');
    assert.equal(quotaState(tt(180)).from, null);
  });
  test('nothing is sent below 80%', () => {
    assert.equal(quotaNote(undefined, tt(15000), 'zh'), null);
  });
  test('said once at 80% and once more at 100%, then again the next month', () => {
    const a = quotaNote(undefined, tt(16100), 'zh');
    assert.ok(a.body.includes('16,100') && a.body.includes('20,000') && a.body.includes('80%'));
    assert.deepEqual(a.told, { month: '2026-12', lv: 1 });
    assert.equal(quotaNote(a.told, tt(17000), 'zh'), null);
    const b = quotaNote(a.told, tt(20010), 'zh');
    assert.deepEqual(b.told, { month: '2026-12', lv: 2 });
    assert.equal(quotaNote(b.told, tt(21000), 'zh'), null);
    assert.ok(quotaNote(b.told, tt(16500, { month: '2027-01' }), 'zh'));
  });
  test('both languages fill every placeholder', () => {
    for (const lang of ['zh', 'en']) for (const n of [16100, 20010]) { const m = quotaNote(undefined, tt(n), lang); assert.ok(!/undefined|\{\w+\}/.test(m.title + m.body), m.body); }
  });
});

describe('the deadline for the drive home', () => {
  const back = (over = {}) => plan({ direction: 'back', departMs: NOW + 6 * H, ...over });
  const snowFrom = (h) => { const d = makeData(); for (let i = h; i < 48; i++) d.weather.pass.snow[i] = 5; return d; };
  test('worked out for the day of a return trip only', () => {
    assert.equal(state(snowFrom(16), back()).late, 14);
    assert.equal(state(snowFrom(0), back()).late, -1);
    assert.equal('late' in state(makeData(), back()), false);
    assert.equal('late' in state(snowFrom(16)), false); // outbound
  });
  test('named when the alert starts, and remembered', () => {
    const m = say(undefined, cur({ late: 14 }), back());
    assert.ok(m.body.includes('14时'));
    assert.equal(m.told.late, 14);
  });
  test('appears, moves two hours or goes: one notification; an hour either way: none', () => {
    assert.ok(say(told(), cur({ late: 15 }), back()).body.includes('15时'));
    assert.equal(say(told({ late: 15 }), cur({ late: 14 }), back()), null);
    const moved = say(told({ late: 15 }), cur({ late: 13 }), back());
    assert.ok(moved.body.includes('13时'));
    assert.equal(moved.told.late, 13);
    const gone = say(told({ late: 15 }), cur(), back());
    assert.ok(gone.body.length > 0);
    assert.equal('late' in gone.told, false);
    assert.ok(say(told({ late: 15 }), cur({ late: -1 }), back()).body.includes('5–21'));
  });
  test('a source failed on this run: the deadline is held', () => {
    assert.equal(say(told({ late: 15 }), cur({ partial: ['weather'] }), back()), null);
  });
  test('time passing is not the forecast clearing: nothing is sent once the deadline or the day is behind', () => {
    const p = back({ departMs: NOW + 17 * H }); // leaving at 23:00
    const at = (t, c, h) => decide(t, c, p, dest, 'zh', NOW - 6 * H + h * H);
    assert.equal(at(told({ late: 14, pre: true }), cur({ late: -1 }), 15.5), null); // 14 h has gone by
    assert.equal(at(told({ late: 14, pre: true }), cur(), 22), null); // nothing left to judge after 21 h
    assert.equal(at(told({ late: -1, pre: true }), cur(), 22), null);
    assert.ok(at(told({ late: 14 }), cur({ late: 11 }), 9).body.includes('11时')); // still ahead: reported
  });
  test('both languages fill every placeholder', () => {
    for (const lang of ['zh', 'en']) for (const late of [14, -1, undefined]) { const m = say(told({ late: 9 }), cur({ late }), back(), lang); assert.ok(!/undefined|\{\w+\}/.test(m.body), m.body); }
  });
});

describe('which departures are watched', () => {
  test('one per resort and direction, and plans from an older page still count', () => {
    const plans = watched({ plans: {
      'heavenly:out': { dest: 'heavenly', direction: 'out', departMs: NOW + H },
      'kirkwood:out': { dest: 'kirkwood', direction: 'out', departMs: NOW + 2 * H },
      back: { dest: 'heavenly', departMs: NOW + 3 * H }, // older page: keyed by the bare direction
      'kirkwood:back': { dest: 'kirkwood', direction: 'back', departMs: NOW - H }, // already left
    } }, NOW);
    assert.deepEqual(plans.map((p) => `${p.dest}:${p.direction}`), ['heavenly:out', 'kirkwood:out', 'heavenly:back']);
    assert.deepEqual(watched(null, NOW), []);
  });
});

describe('where tapping the notification leads', () => {
  test('the address names the resort, the direction and the departure hour (Pacific), as a share link does', () => {
    const p = plan({ direction: 'back', departMs: Date.UTC(2026, 10, 22, 15) }); // 07:00 PST on Nov 22
    const url = planUrl('https://example.github.io/tahoe-trip-planner/', dest, p);
    assert.equal(url, `https://example.github.io/tahoe-trip-planner/?resort=${dest.id}&dir=back&date=2026-11-22&time=7:00`);
    assert.deepEqual(parseShare(new URL(url).search, [dest.id]), { destId: dest.id, direction: 'back', depart: { day: '2026-11-22', h: 7 } });
  });
});

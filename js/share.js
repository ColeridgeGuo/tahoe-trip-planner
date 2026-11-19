// Share links: the destination, the direction and the departure picked on the verdict tab, carried in the
// address so that opening the link shows the same view. Example: ?resort=kirkwood&dir=back&date=2026-11-22&time=7:00
// Nothing here asks any service for anything; the link only tells the page what to show.

// The query string for a view. "Leave now" has no date or time: whoever opens the link sees their own now.
export function shareQuery({ destId, direction, depart }) {
  const q = new URLSearchParams({ resort: destId, dir: direction === 'back' ? 'back' : 'out' });
  if (depart && depart !== 'now') { q.set('date', depart.day); q.set('time', `${depart.h}:00`); }
  return q.toString().replace(/%3A/g, ':');
}

// What a link asks for, or null when the address carries none of it. Anything unknown or malformed is left
// out rather than guessed, so a damaged link opens the reader's usual view for that part.
export function parseShare(search, destIds) {
  const q = new URLSearchParams(search);
  const out = {};
  const resort = q.get('resort');
  if (resort && destIds.includes(resort)) out.destId = resort;
  const dir = q.get('dir');
  if (dir === 'out' || dir === 'back') out.direction = dir;
  const date = q.get('date');
  const time = /^(\d{1,2})(?::00)?$/.exec(q.get('time') || '');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T12:00:00Z'))) {
    const h = time ? +time[1] : 8; // a date without a time: the same hour the day picker starts from
    if (h <= 23) out.depart = { day: date, h };
  }
  return Object.keys(out).length ? out : null;
}

// The departure a link asked for, once the forecast is loaded: kept while that hour is in the forecast and
// has not gone by, otherwise "now". `hours` is the index built by logic.js.
export function sharedDepart(depart, hours, now) {
  if (!depart || depart === 'now') return 'now';
  const h = hours.find((x) => x.day === depart.day && x.h === depart.h);
  return h && h.ms + 36e5 > now ? depart : 'now';
}

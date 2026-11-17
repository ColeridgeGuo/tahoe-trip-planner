// Shared by the fetch script (Node) and the browser (live chain-control refresh).
export const CC_URL = (d) => `https://cwwp2.dot.ca.gov/data/d${d}/cc/ccStatusD${String(d).padStart(2, '0')}.json`;

// 0-3 = R level, 4 = closed, -1 = unknown
export function chainLevel(status, desc = '') {
  const m = /R-?\s?([0-3])/i.exec(status || '');
  if (m) return +m[1];
  if (/clos/i.test(status + ' ' + desc)) return 4;
  return -1;
}

export function normalizeChain(json, highways) {
  const out = new Map();
  for (const row of json?.data || []) {
    const c = row.cc;
    const l = c?.location;
    if (!l || !highways.includes(l.route) || c.inService === 'false') continue;
    const s = c.statusData || {};
    const rec = {
      hw: l.route,
      name: l.locationName,
      place: l.nearbyPlace,
      dir: l.direction || '',
      mp: +l.milepost || 0,
      lat: +l.latitude,
      lon: +l.longitude,
      elevFt: +l.elevation || null,
      status: s.status || '',
      level: chainLevel(s.status, s.statusDescription),
      desc: s.statusDescription || '',
      at: `${s.statusTimestamp?.statusDate || ''} ${(s.statusTimestamp?.statusTime || '').slice(0, 5)}`.trim(),
    };
    const key = `${rec.hw}|${rec.name}|${rec.dir}`;
    const prev = out.get(key);
    if (!prev || rec.level > prev.level) out.set(key, rec);
  }
  return [...out.values()].sort((a, b) => a.hw.localeCompare(b.hw) || a.lon - b.lon);
}

// Which way a CHP incident faces on the route highway. CHP writes it as "Us50 E / Sly Park Rd" in the location
// or "WB 50 JEO ..." in the description. Returns one of `dirs` (e.g. ['East', 'West']) or '' when the log does
// not say, and '' is treated as affecting both directions.
const DIR_NAMES = { N: 'North', S: 'South', E: 'East', W: 'West' };
export function incidentDir(loc, desc, hwNum, dirs) {
  const text = `${loc || ''} | ${desc || ''}`;
  const hw = `(?:^|[^0-9])${hwNum}`;
  const m =
    new RegExp(`${hw}\\s+([NSEW])(?=\\s|/|$)`, 'i').exec(loc || '') || // Us50 E / ...
    new RegExp(`\\b([NSEW])B\\s*(?:(?:US|SR|I|HWY)[- ]?)?${hwNum}(?![0-9])`, 'i').exec(text) || // WB 50, EB US-50
    new RegExp(`${hw}\\s*([NSEW])B\\b`, 'i').exec(text) || // 50 WB
    (new RegExp(`${hw}(?![0-9])`).test(loc || '') ? /^\W*([NSEW])B\b/i.exec(desc || '') : null); // on the highway, desc starts "EB ..."
  const d = m ? DIR_NAMES[m[1].toUpperCase()] : '';
  return dirs.includes(d) ? d : '';
}

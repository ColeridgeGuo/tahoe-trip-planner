// Destinations are pure config. To add a resort, append an entry here.
// All internal units are metric (°C, mm, m, km/h); elevFt on points is only a label.
const ORIGIN = { id: 'origin', name: { zh: '圣马特奥', en: 'San Mateo' }, lat: 37.563, lon: -122.3255, offsetH: 0, role: 'origin' };
const US50_POINTS = [
  ORIGIN,
  { id: 'sac', name: { zh: '萨克拉门托', en: 'Sacramento' }, lat: 38.5816, lon: -121.4944, offsetH: 1.75, role: 'valley' },
  { id: 'placerville', name: { zh: 'Placerville', en: 'Placerville' }, lat: 38.7296, lon: -120.7985, offsetH: 2.4, role: 'foothill' },
  { id: 'kyburz', name: { zh: 'Kyburz', en: 'Kyburz' }, lat: 38.7746, lon: -120.2977, offsetH: 3.0, role: 'mountain' },
  { id: 'pass', name: { zh: 'Echo Summit 垭口', en: 'Echo Summit' }, lat: 38.8121, lon: -120.0303, offsetH: 3.4, role: 'mountain' },
  { id: 'town', name: { zh: '南太浩湖', en: 'South Lake Tahoe' }, lat: 38.9399, lon: -119.9772, offsetH: 3.75, role: 'mountain' },
];

export const DESTINATIONS = [
  {
    id: 'heavenly',
    // How often TomTom drive times are refreshed: 'full' or 'light' (scripts/lib.mjs). The daily quota is
    // split about 2:1:1 between this destination and the other two.
    // Where drive times come from. 'tomtom': fetched and shown on the page (this uses the whole free monthly
    // TomTom allowance, so only one destination has it). 'maps': nothing is fetched; the page shows the usual
    // drive time and a link that opens the live one in Google Maps.
    driveTimes: 'tomtom',
    name: { zh: 'Heavenly', en: 'Heavenly' },
    route: {
      label: 'US-50',
      highway: 'US-50',
      driveHours: 3.75,
      distanceKm: 335,
      climb: { zh: '2,250 m', en: '7,400 ft' }, // to the highest point of the drive, for the EV range note
      mapFocus: [[38.68, -120.86], [38.97, -119.9]], // default map view: the mountain section
      outboundDir: 'East',
      returnDir: 'West',
      points: [
        ...US50_POINTS,
        { id: 'base', name: { zh: 'Heavenly 山脚 (California Lodge)', en: 'Heavenly base (California Lodge)' }, lat: 38.9353, lon: -119.94, role: 'resort' },
        { id: 'summit', name: { zh: 'Heavenly 山顶', en: 'Heavenly summit' }, lat: 38.9195, lon: -119.9005, role: 'resort' },
      ],
      mountainPoints: ['kyburz', 'pass', 'town'],
      // Where the mountain road begins (Placerville). Only CHP incidents east of here change the verdict, and
      // closures east of here are listed first.
      mountainLonMin: -120.85,
      // Drive-time lookups go origin > these > town. Only points on the undivided two-lane mountain road are
      // used: they pin the route to this highway without forcing a detour through a city centre, and they
      // sit on a road that is the same in both directions.
      drivePins: ['kyburz', 'pass'],
      townPoint: 'town',
      mapsPlace: 'Heavenly California Lodge, South Lake Tahoe, CA', // the resort end of the Google Maps link
      // Each alternate is judged on every road it uses (`legs`), in the direction driven on the way out and
      // back, and only on the stretch that is driven (`box`): I-80 then CA-89 down the west shore past
      // Emerald Bay (Truckee to South Lake Tahoe); CA-88 to Picketts Junction then CA-89 over Luther Pass.
      alternates: [
        {
          highway: 'I-80',
          label: { zh: 'I-80 (Donner Summit) → CA-89', en: 'I-80 (Donner Summit) → CA-89' },
          legs: [{ highway: 'I-80', out: 'East', back: 'West' }, { highway: 'SR-89', out: 'South', back: 'North', box: { latMin: 38.9, latMax: 39.33 } }],
        },
        {
          highway: 'SR-88',
          label: { zh: 'CA-88 (Carson Pass) → CA-89', en: 'CA-88 (Carson Pass) → CA-89' },
          legs: [{ highway: 'SR-88', out: 'East', back: 'West', box: { lonMax: -119.915 } }, { highway: 'SR-89', out: 'North', back: 'South', box: { latMin: 38.77, latMax: 38.87, lonMax: -119.915 } }],
        },
      ],
    },
    // What the fetch script pulls from Caltrans / CHP for this destination.
    feeds: {
      ccDistricts: [3, 10],
      chainHighways: ['US-50', 'I-80', 'SR-88', 'SR-89'],
      cctvDistricts: [3],
      camHighway: 'US-50',
      camLonMin: -120.85,
      lcsDistricts: [3],
      incidentBox: { latMin: 38.5, latMax: 39.0, lonMin: -121.6, lonMax: -119.9 },
      incidentMatch: '(^|[^0-9])50([^0-9]|$)',
      alertPoints: ['pass', 'town', 'summit'],
    },
    resort: {
      basePoint: 'base',
      windLifts: { zh: 'Gondola 和山顶缆车', en: 'Gondola and summit lifts' }, // what a strong summit wind stops first
      summitPoint: 'summit',
      // SNOTEL stations whose measured snow the resort tab shows (NRCS; id is the station triplet, `where` says
      // where the station is relative to the resort).
      snotel: [
        { id: '518:CA:SNTL', name: 'Heavenly Valley', where: { zh: '雪场山上', en: 'on the mountain' }, elevFt: 8540 },
        { id: '463:CA:SNTL', name: 'Echo Peak', where: { zh: '垭口附近', en: 'near the pass' }, elevFt: 7650 },
      ],
      cams: [
        { name: { zh: 'Tram 缆车', en: 'Tram' }, embed: 'https://player.brownrice.com/embed/heavenlytram' },
        { name: { zh: 'Gondola 中站', en: 'Gondola mid-station' }, embed: 'https://player.brownrice.com/embed/heavenlymidstation' },
        { name: { zh: 'Dipper', en: 'Dipper' }, embed: 'https://player.brownrice.com/embed/heavenlydipper' },
        { name: { zh: 'East Peak', en: 'East Peak' }, embed: 'https://player.brownrice.com/embed/heavenlyeastpeak' },
      ],
      links: {
        cams: 'https://www.skiheavenly.com/the-mountain/mountain-conditions/mountain-cams.aspx',
        lifts: 'https://www.skiheavenly.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx',
        snow: 'https://www.skiheavenly.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx',
      },
    },
  },
  {
    id: 'kirkwood',
    driveTimes: 'maps',
    name: { zh: 'Kirkwood', en: 'Kirkwood' },
    route: {
      label: 'CA-88',
      highway: 'SR-88',
      driveHours: 3.5,
      distanceKm: 288,
      climb: { zh: '2,450 m', en: '8,000 ft' },
      mapFocus: [[38.38, -120.72], [38.74, -120.03]],
      outboundDir: 'East',
      returnDir: 'West',
      // The trip leaves CA-88 at Kirkwood Meadows Dr. Chain checkpoints, closures and incidents further east
      // (Caples Lake, Carson Pass) are not on it.
      lonMax: -120.075,
      points: [
        ORIGIN,
        { id: 'stockton', name: { zh: '斯托克顿', en: 'Stockton' }, lat: 37.9577, lon: -121.2908, offsetH: 1.3, role: 'valley' },
        { id: 'pinegrove', name: { zh: 'Pine Grove', en: 'Pine Grove' }, lat: 38.4079, lon: -120.6503, offsetH: 2.45, role: 'foothill' },
        { id: 'hams', name: { zh: "Ham's Station", en: "Ham's Station" }, lat: 38.5446, lon: -120.371, offsetH: 2.9, role: 'mountain' },
        { id: 'spur', name: { zh: 'Carson Spur', en: 'Carson Spur' }, lat: 38.7056, lon: -120.109, offsetH: 3.3, role: 'mountain' },
        { id: 'town', name: { zh: 'Kirkwood 村', en: 'Kirkwood village' }, lat: 38.6846, lon: -120.0652, offsetH: 3.5, role: 'mountain' },
        { id: 'summit', name: { zh: 'Kirkwood 山顶', en: 'Kirkwood summit' }, lat: 38.662, lon: -120.062, role: 'resort' },
      ],
      mountainPoints: ['hams', 'spur', 'town'],
      // Both on the two-lane mountain stretch of CA-88 (Caltrans chain-control checkpoints).
      drivePins: ['hams', 'spur'],
      townPoint: 'town',
      mountainLonMin: -120.7, // Pine Grove
      mapsPlace: 'Kirkwood Mountain Resort, Kirkwood, CA', // the resort end of the Google Maps link
      // US-50 to Meyers, CA-89 over Luther Pass, then CA-88 back west over Carson Pass.
      alternates: [
        {
          highway: 'US-50',
          label: { zh: 'US-50 (Echo Summit) → CA-89 → CA-88 (Carson Pass)', en: 'US-50 (Echo Summit) → CA-89 → CA-88 (Carson Pass)' },
          legs: [
            { highway: 'US-50', out: 'East', back: 'West', box: { lonMax: -119.99 } },
            { highway: 'SR-89', out: 'South', back: 'North', box: { latMin: 38.77, latMax: 38.87, lonMax: -119.915 } },
            { highway: 'SR-88', out: 'West', back: 'East', box: { lonMin: -120.07, lonMax: -119.915 } },
          ],
        },
      ],
    },
    feeds: {
      ccDistricts: [10, 3],
      chainHighways: ['SR-88', 'US-50', 'SR-89'],
      cctvDistricts: [10],
      camHighway: 'SR-88',
      camLonMin: -120.7,
      lcsDistricts: [10],
      incidentBox: { latMin: 38.2, latMax: 38.8, lonMin: -121.1, lonMax: -120.0 },
      incidentMatch: '(^|[^0-9])88([^0-9]|$)',
      alertPoints: ['spur', 'town', 'summit'],
    },
    resort: {
      basePoint: 'town',
      windLifts: { zh: '高处缆车', en: 'Upper lifts' },
      summitPoint: 'summit',
      snotel: [
        { id: '1067:CA:SNTL', name: 'Carson Pass', where: { zh: '雪场以东 5 公里', en: '3 mi east of the resort' }, elevFt: 8360 },
      ],
      cams: [
        { name: { zh: 'Cornice', en: 'Cornice' }, embed: 'https://player.brownrice.com/embed/kirkwoodcornice' },
      ],
      links: {
        cams: 'https://www.kirkwood.com/the-mountain/mountain-conditions/mountain-cams.aspx',
        lifts: 'https://www.kirkwood.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx',
        snow: 'https://www.kirkwood.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx',
      },
    },
  },
  {
    id: 'northstar',
    driveTimes: 'maps',
    name: { zh: 'Northstar', en: 'Northstar' },
    route: {
      label: 'I-80',
      highway: 'I-80',
      driveHours: 3.75,
      distanceKm: 345,
      climb: { zh: '2,200 m', en: '7,200 ft' },
      mapFocus: [[39.05, -121.0], [39.42, -120.05]],
      outboundDir: 'East',
      returnDir: 'West',
      // The trip leaves I-80 at the CA-267 junction in Truckee; what lies further east (Boca, Floriston, the
      // state line) is not on it.
      lonMax: -120.16,
      // The last stretch, Truckee to Northstar Dr, is on CA-267, which has its own chain control and runs
      // north-south. It is checked along with the main highway, each in its own direction of travel.
      also: [{ highway: 'SR-267', label: 'CA-267', outboundDir: 'South', returnDir: 'North' }],
      points: [
        ORIGIN,
        // Where I-80 passes Sacramento (north of downtown), so the drive can be timed against it.
        { id: 'sac', name: { zh: '萨克拉门托', en: 'Sacramento' }, lat: 38.6415, lon: -121.4697, offsetH: 1.8, role: 'valley' },
        { id: 'colfax', name: { zh: 'Colfax', en: 'Colfax' }, lat: 39.1007, lon: -120.9533, offsetH: 2.65, role: 'foothill' },
        { id: 'gap', name: { zh: 'Emigrant Gap', en: 'Emigrant Gap' }, lat: 39.2968, lon: -120.6727, offsetH: 3.05, role: 'mountain' },
        // I-80 is a divided freeway, so the drive-time waypoint sits on the carriageway of each direction
        // (a single point could snap to the far side and force a turn-around).
        { id: 'pass', name: { zh: 'Donner Summit 垭口', en: 'Donner Summit' }, lat: 39.3393, lon: -120.3472, offsetH: 3.35, role: 'mountain', pin: { out: [39.33949, -120.347], back: [39.33995, -120.34771] } },
        { id: 'truckee', name: { zh: 'Truckee', en: 'Truckee' }, lat: 39.328, lon: -120.1833, offsetH: 3.5, role: 'mountain' },
        { id: 'town', name: { zh: 'Northstar 村', en: 'Northstar village' }, lat: 39.2746, lon: -120.121, offsetH: 3.75, role: 'mountain' },
        { id: 'summit', name: { zh: 'Northstar 山顶', en: 'Northstar summit' }, lat: 39.25, lon: -120.135, role: 'resort' },
      ],
      mountainPoints: ['gap', 'pass', 'truckee', 'town'],
      drivePins: ['pass'],
      townPoint: 'town',
      mountainLonMin: -121.0, // just below Colfax
      mapsPlace: 'Northstar California Resort, Truckee, CA',
      // US-50 to South Lake Tahoe, then CA-89 up the west shore past Emerald Bay.
      alternates: [
        {
          highway: 'US-50',
          label: { zh: 'US-50 (Echo Summit) → CA-89', en: 'US-50 (Echo Summit) → CA-89' },
          legs: [{ highway: 'US-50', out: 'East', back: 'West' }, { highway: 'SR-89', out: 'North', back: 'South', box: { latMin: 38.9, latMax: 39.18 } }],
        },
      ],
    },
    feeds: {
      ccDistricts: [3],
      chainHighways: ['I-80', 'SR-267', 'US-50', 'SR-89'],
      cctvDistricts: [3],
      camRoads: [{ highway: 'I-80', lonMin: -121.0, lonMax: -120.16 }, { highway: 'SR-267' }],
      lcsDistricts: [3],
      incidentBox: { latMin: 38.5, latMax: 39.45, lonMin: -121.6, lonMax: -120.0 },
      incidentMatch: '(^|[^0-9])80([^0-9]|$)',
      alertPoints: ['pass', 'town', 'summit'],
    },
    resort: {
      basePoint: 'town',
      windLifts: { zh: 'Gondola 和山顶缆车', en: 'Gondola and summit lifts' },
      summitPoint: 'summit',
      snotel: [
        { id: '834:CA:SNTL', name: 'Truckee #2', where: { zh: '雪场西北 6 公里，低处', en: '4 mi northwest, low down' }, elevFt: 6500 },
        { id: '784:CA:SNTL', name: 'Palisades Tahoe', where: { zh: '西南 16 公里，高处', en: '10 mi southwest, high up' }, elevFt: 8010 },
      ],
      cams: [
        { name: { zh: 'Village 村', en: 'Village' }, embed: 'https://player.brownrice.com/embed/northstarvillage' },
        { name: { zh: '半山 (Tahoe Zephyr)', en: 'Mid-mountain (Tahoe Zephyr)' }, embed: 'https://player.brownrice.com/embed/northstarmidmountain' },
        { name: { zh: '量雪尺', en: 'Snow stake' }, embed: 'https://player.brownrice.com/embed/northstarsnowstake' },
      ],
      links: {
        cams: 'https://www.northstarcalifornia.com/the-mountain/mountain-conditions/mountain-cams.aspx',
        lifts: 'https://www.northstarcalifornia.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx',
        snow: 'https://www.northstarcalifornia.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx',
      },
    },
  },
];

export const DEFAULT_VEHICLE = { drive: 'awd', snowTires: true, chains: true, ev: true };

// CARTO Basemaps keys for the dark map style. Each key is locked by CARTO to the site it was issued for,
// so the right one is picked by hostname. No key for the current host = dark mode falls back to
// colour-inverted OpenStreetMap tiles. Free for non-commercial use up to 5M requests a month.
const CARTO_KEYS = {
  'coleridgeguo.github.io': 'cb1_5b2s_1_77644b2d4b975a7320a48ce3',
  localhost: 'cb1_5b2s_2_6463e6586c468ef9c1dc849e',
};
export const CARTO_KEY = (typeof location !== 'undefined' && CARTO_KEYS[location.hostname]) || '';

// TomTom key for the traffic-flow map layer. It is locked by TomTom to this site's domain and can only
// read traffic tiles. Hosts without a key simply do not get the traffic toggle.
const TOMTOM_WEB_KEYS = { 'coleridgeguo.github.io': 'Sni236fzfK6Qa6eLr8NFxqTuvgb48J5F' };
export const TOMTOM_WEB_KEY = (typeof location !== 'undefined' && TOMTOM_WEB_KEYS[location.hostname]) || '';

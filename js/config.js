// Destinations are pure config. To add a resort, append an entry here.
// All internal units are metric (°C, mm, m, km/h); elevFt on points is only a label.
const US50_POINTS = [
  { id: 'origin', name: { zh: '圣马特奥', en: 'San Mateo' }, lat: 37.563, lon: -122.3255, offsetH: 0, role: 'origin' },
  { id: 'sac', name: { zh: '萨克拉门托', en: 'Sacramento' }, lat: 38.5816, lon: -121.4944, offsetH: 1.75, role: 'valley' },
  { id: 'placerville', name: { zh: 'Placerville', en: 'Placerville' }, lat: 38.7296, lon: -120.7985, offsetH: 2.4, role: 'foothill' },
  { id: 'kyburz', name: { zh: 'Kyburz', en: 'Kyburz' }, lat: 38.7746, lon: -120.2977, offsetH: 3.0, role: 'mountain' },
  { id: 'pass', name: { zh: 'Echo Summit 垭口', en: 'Echo Summit' }, lat: 38.8121, lon: -120.0303, offsetH: 3.4, role: 'mountain' },
  { id: 'town', name: { zh: '南太浩湖', en: 'South Lake Tahoe' }, lat: 38.9399, lon: -119.9772, offsetH: 3.75, role: 'mountain' },
];

export const DESTINATIONS = [
  {
    id: 'heavenly',
    name: { zh: 'Heavenly', en: 'Heavenly' },
    route: {
      label: 'US-50',
      highway: 'US-50',
      driveHours: 3.75,
      distanceKm: 306,
      outboundDir: 'East',
      returnDir: 'West',
      points: [
        ...US50_POINTS,
        { id: 'base', name: { zh: 'Heavenly 山脚 (California Lodge)', en: 'Heavenly base (California Lodge)' }, lat: 38.9353, lon: -119.94, role: 'resort' },
        { id: 'summit', name: { zh: 'Heavenly 山顶', en: 'Heavenly summit' }, lat: 38.9195, lon: -119.9005, role: 'resort' },
      ],
      mountainPoints: ['kyburz', 'pass', 'town'],
      townPoint: 'town',
      alternates: [
        { highway: 'I-80', label: { zh: 'I-80 (Donner Summit) → CA-89', en: 'I-80 (Donner Summit) → CA-89' } },
        { highway: 'SR-88', label: { zh: 'CA-88 (Carson Pass) → CA-89', en: 'CA-88 (Carson Pass) → CA-89' } },
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
      summitPoint: 'summit',
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
];

export const DEFAULT_VEHICLE = { drive: 'awd', snowTires: true, chains: true, ev: true };

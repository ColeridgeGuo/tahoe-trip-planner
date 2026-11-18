// Places to eat along the way. Hand-kept: add an entry here and it shows on the Roads map and in the
// "Food along the way" card, in the order you drive past it.
//
//   id       short unique key
//   name     as on the sign
//   town     where it is, shown next to the name
//   highway  the route it belongs to (matches a destination's route.highway)
//   lat/lon  the restaurant itself, 4 decimals
//   cuisine  { zh, en }
//   note     { zh, en }, optional: what to order, when it suits
//   url      optional Google Maps link; without one a search link for name + town is used
//   hours    optional, Pacific time. `daily` is every day; a weekday key (sun mon tue wed thu fri sat)
//            overrides it, null means closed that day. Times are 'HH:MM-HH:MM', several ranges separated
//            by commas, a closing time past midnight is fine ('17:00-01:00'). Leave `hours` out when
//            unknown. These are typed in by hand and go stale: the page says "about" and links to Google Maps.
//   offsetH  optional: hours from the origin on a normal drive. Normally worked out from lat/lon.
// From the shared Google Maps list "Ski trip food" (2026-11-17). Hours: the Tuesday hours are Google's;
// other days are filled from restaurant listings where they agree, otherwise assumed the same as Tuesday.
export const FOOD = [
  { id: 'sit-lo-saigon', name: 'Sit Lo Saigon', town: 'Davis', highway: 'US-50', lat: 38.5469, lon: -121.7397, cuisine: { zh: '越南河粉', en: 'Vietnamese pho' }, hours: { daily: '08:00-00:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Sit%20Lo%20Saigon%20424%20G%20St%2C%20Davis%2C%20CA%2095616' },
  { id: 'hunan-style', name: 'Hunan Style', town: 'Davis', highway: 'US-50', lat: 38.5499, lon: -121.74, cuisine: { zh: '湘菜', en: 'Hunan Chinese' }, hours: { daily: '11:00-21:00', fri: '11:00-21:30', sat: '11:00-21:30' }, url: 'https://www.google.com/maps/search/?api=1&query=Hunan%20Style%20-%20Traditional%20Hunan%20Chinese%20Cuisine%20630%20G%20St%2C%20Davis%2C%20CA%2095616' },
  { id: 'yang-kee', name: 'Yang Kee Dumpling', town: 'Davis', highway: 'US-50', lat: 38.5422, lon: -121.7252, cuisine: { zh: '饺子、小笼包', en: 'Dumplings' }, hours: { daily: '11:00-15:00,16:30-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Yang%20Kee%20Dumpling%202151%20Cowell%20Blvd%20C%2C%20Davis%2C%20CA%2095618' },
  { id: 'hunan-bar', name: 'Hunan Bar & Restaurant', town: 'Davis', highway: 'US-50', lat: 38.5433, lon: -121.7425, cuisine: { zh: '中餐', en: 'Chinese' }, hours: { daily: '11:00-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Hunan%20Bar%20%26%20Restaurant%20207%20D%20St%2C%20Davis%2C%20CA%2095616' },
  { id: 'kin-thai', name: 'Kin Thai Street Eatery', town: 'Sacramento', highway: 'US-50', lat: 38.5765, lon: -121.4802, cuisine: { zh: '泰国菜', en: 'Thai' }, hours: { daily: '11:00-15:00,16:30-21:00', sat: '11:00-21:00', sun: '12:00-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Kin%20Thai%20Street%20Eatery%201050%2020th%20St%20Ste%20180%2C%20Sacramento%2C%20CA%2095811' },
  { id: 'urban-roots', name: 'Urban Roots Brewery & Smokehouse', town: 'Sacramento', highway: 'US-50', lat: 38.5656, lon: -121.4941, cuisine: { zh: '精酿啤酒、烟熏烤肉', en: 'Brewpub, barbecue' }, hours: { daily: '11:00-21:00', fri: '11:00-22:00', sat: '11:00-22:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Urban%20Roots%20Brewery%20%26%20Smokehouse%201322%20V%20St%2C%20Sacramento%2C%20CA%2095818' },
  { id: 'doma', name: 'Doma Korean Restaurant', town: 'Sacramento', highway: 'US-50', lat: 38.5704, lon: -121.3422, cuisine: { zh: '韩餐', en: 'Korean' }, hours: { daily: '11:00-21:30', sun: '11:00-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Doma%20Korean%20Restaurant%209521%20Folsom%20Blvd%20A%2C%20Sacramento%2C%20CA%2095827' },
  { id: 'jang-su', name: 'Jang Su Korean BBQ', town: 'Sacramento', highway: 'US-50', lat: 38.5552, lon: -121.3346, cuisine: { zh: '韩式烤肉', en: 'Korean barbecue' }, url: 'https://www.google.com/maps/search/?api=1&query=Jang%20Su%20Korean%20BBQ%203643%20Bradshaw%20Rd%2C%20Sacramento%2C%20CA%2095827' },
  { id: 't-kee', name: 'T Kee Cafe', town: 'Sacramento', highway: 'US-50', lat: 38.5244, lon: -121.4967, cuisine: { zh: '粤菜、茶餐厅', en: 'Cantonese' }, note: { zh: '不在高速边，从 US-50 往南约 10–15 分钟', en: 'Not by the freeway: 10–15 min south of US-50' }, hours: { daily: '11:00-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=T%20Kee%20Cafe%201910%20Fruitridge%20Rd%2C%20Sacramento%2C%20CA%2095822' },
  { id: 'da-fei-ge', name: 'Da Fei Ge', town: 'Sacramento', highway: 'US-50', lat: 38.5235, lon: -121.4972, cuisine: { zh: '烧烤、煲仔饭', en: 'Chinese skewers, clay pot rice' }, note: { zh: '不在高速边，从 US-50 往南约 10–15 分钟', en: 'Not by the freeway: 10–15 min south of US-50' }, hours: { daily: '16:30-22:30' }, url: 'https://www.google.com/maps/search/?api=1&query=Da%20Fei%20Ge%20Restaurant%20-%20Chinese%205635%20Freeport%20Blvd%20Ste%201%2C%20Sacramento%2C%20CA%2095822' },
  { id: 'old-gui-lin', name: 'Old Gui Lin', town: 'Sacramento', highway: 'US-50', lat: 38.5274, lon: -121.496, cuisine: { zh: '桂林米粉', en: 'Guilin rice noodles' }, note: { zh: '不在高速边，从 US-50 往南约 10–15 分钟', en: 'Not by the freeway: 10–15 min south of US-50' }, hours: { daily: '11:00-20:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Old%20Gui%20Lin%205131%20Freeport%20Blvd%2C%20Sacramento%2C%20CA%2095822' },
  { id: 'top-choice', name: '美麗華桂林米粉 Top Choice', town: 'Sacramento', highway: 'US-50', lat: 38.507, lon: -121.4352, cuisine: { zh: '桂林米粉', en: 'Guilin rice noodles' }, note: { zh: '不在高速边，从 US-50 往南约 10–15 分钟', en: 'Not by the freeway: 10–15 min south of US-50' }, hours: { daily: '10:00-19:00' }, url: 'https://www.google.com/maps/search/?api=1&query=%E7%BE%8E%E9%BA%97%E8%8F%AF%E6%A1%82%E6%9E%97%E7%B1%B3%E7%B2%89%20Top%20Choice%20Restaurant%206540%20Stockton%20Blvd%20%237%2C%20Sacramento%2C%20CA%2095823' },
  { id: 'flame-cafe', name: 'Flame Cafe', town: 'Sacramento', highway: 'US-50', lat: 38.4947, lon: -121.4568, cuisine: { zh: '中餐', en: 'Chinese' }, note: { zh: '不在高速边，从 US-50 往南约 10–15 分钟', en: 'Not by the freeway: 10–15 min south of US-50' }, hours: { daily: '11:00-20:00', wed: null, thu: null, fri: '11:00-21:00', sat: '11:00-21:00' }, url: 'https://www.google.com/maps/search/?api=1&query=Flame%20Cafe%204220%20Florin%20Rd%2C%20Sacramento%2C%20CA%2095823' },
  { id: 'my-thai', name: 'My Thai Cuisine', town: 'South Lake Tahoe', highway: 'US-50', lat: 38.9155, lon: -120.0007, cuisine: { zh: '泰国菜', en: 'Thai' }, hours: { daily: '11:00-15:00,16:30-21:30' }, url: 'https://www.google.com/maps/search/?api=1&query=My%20Thai%20Cuisine%202108%20Lake%20Tahoe%20Blvd%2C%20South%20Lake%20Tahoe%2C%20CA%2096150' },
];

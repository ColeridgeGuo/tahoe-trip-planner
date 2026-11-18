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
export const FOOD = [];

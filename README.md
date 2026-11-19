# Tahoe Trip Planner

A go / no-go dashboard for driving from the Bay Area to a Tahoe ski resort (Heavenly via US-50, Kirkwood via CA-88, Northstar via I-80 and CA-267): chain control, closures, CHP incidents, route weather, what to wear, resort cams and a packing checklist. Static site, no backend.

## How it works

- `scripts/fetch.mjs` pulls Caltrans (chain control, lane closures, cameras), CHP incidents, NWS gridded forecasts and alerts, and TomTom drive times, and writes `data/<destination>.json`.
- `.github/workflows/deploy.yml` runs that script and publishes the site to GitHub Pages. Nothing is committed back to the repo.
- The workflow has no schedule of its own. An external cron-job triggers it every 15 minutes through `workflow_dispatch`, because GitHub's built-in scheduler runs late and unevenly.
- Only Heavenly (`driveTimes: 'tomtom'` in `js/config.js`) gets drive times from TomTom; it uses the whole free allowance. Kirkwood and Northstar (`driveTimes: 'maps'`) send no TomTom requests: the page uses the route's usual drive time for them and links to Google Maps for the live one (`mapsUrl` in `js/logic.js`, a plain Maps URL, no key and no charge; it cannot carry a departure time, so a later departure is set inside Google Maps). The best-departure hints, drive-time bars and drive-time alerts therefore exist for Heavenly only.
- Drive times come from TomTom (`TOMTOM_KEY` secret): live every 30 minutes, hourly for the next 24 h (the next 3 hours refreshed hourly, the rest every 12 h), and every 2 h out to 8 days (refreshed once a day). That is about 506 requests a day, or 15,700 of the 20,000 free Routing API requests a month.
- Each drive time also says when the drive reaches every point along the route (Sacramento, Placerville, Kyburz, Echo Summit), read off the route TomTom returned, so the weather shown for a point is the weather at the moment you are there. This costs no extra requests. A point the chosen route does not pass (TomTom sometimes goes via Stockton instead of Sacramento) is placed between its neighbours.
- The verdict also counts snow that has already fallen: enough new snow in the 12 or 24 hours before you cross, while it is still freezing, is a caution even when nothing is falling any more (`TH.pack` in `js/logic.js`). The fetch script keeps the last 24 hours of snowfall (`snowPast`) for this.
- TomTom's drive time for a later departure is its usual traffic for that hour and knows nothing about snow. When the forecast has snow falling or lying as you cross, the page adds an estimated range for the pass (`TH.snowDelay`: 20-40 min in light snow or on packed snow, 45-90 min in heavy snow) next to the drive time and the arrival time. The TomTom figure itself, the pass-through times and the verdict are not changed by it. Leaving now with chain control already up, the live time is left as it is.
- Forecast snow is judged for the vehicle set in Settings: heavy snow, or snow lying on the road, is treated as R2 chain control, so a car that needs chains and has none gets a no-go instead of a caution; light snow only adds a reminder to bring chains.
- Only CHP collisions on the mountain section (east of `route.mountainLonMin`, Placerville) change the verdict. Valley incidents are listed, and their delay is already in the TomTom drive time.
- Chain control that cannot be read is never shown as "no chain control": a checkpoint whose status is not an R level or a closure (traffic being held, for instance), or a feed that answers without any checkpoint for the route, gives "cannot confirm" and a caution.
- Only NWS alerts about the road change the verdict (winter storm, blizzard, ice, snow squall, high wind, fog, flooding; `alertLevel` in `js/logic.js`). Others, such as Lake Wind Advisory or Freeze Warning, are listed without changing it. That includes Avalanche Warning and Watch: they are for the backcountry, and a slide path that threatens the highway shows up as a Caltrans closure.
- The resort tab shows measured snow next to the forecast: depth, its change over 24 and 48 hours, and the water that fell in 24 hours, from the NRCS SNOTEL stations listed under `resort.snotel` in `js/config.js` (one free request per destination an hour, no key). The depth is also kept in `data/history.json` (`sd`).
- For the drive home, the hour strip and the week chart name the latest departure of the day that the forecast still calls clear, when leaving later is worse (`lastClear` in `js/logic.js`). A change alert on a return trip states it, and sends a notification when it appears, goes, or moves two hours or more.
- A lane closure counts when it is in force as the drive reaches that stretch (within 30 minutes either way), not at any time during the drive.
- Alternate routes are judged on every road they use (`alternates[].legs` in `js/config.js`): I-80 with CA-89 past Emerald Bay, CA-88 with CA-89 over Luther Pass.
- `data/history.json` records, hour by hour, the real chain-control level each way next to the snowfall and temperature forecast for that hour (about two months). It is there to check the snow thresholds against real storms. Each row also keeps the live drive time each way and the minutes spent on the mountain section (`d`, `m`), to replace the estimated snow delay with measured figures.
- `data/<destination>.json` carries `tomtom`: the requests sent so far today (UTC day), yesterday's total, and the month's count against the 20,000 allowance (`monthN`, `quota`, and `from`, the day the month's count began), also printed in the run log. The page shows the month's count in the footer. From 80% of the allowance, and again past it, the page shows a banner and the devices registered for change alerts get one notification each time (`quotaNote` in `scripts/notify.mjs`). Only requests sent by the fetch script are counted, so the TomTom dashboard remains the reference.
- If a source fails on a run, its last good data is carried over from the previously published file (up to 24 h) and the page shows how old it is.
- Every run starts by reading back what the previous run published (the data file and `history.json`), with several tries. If the site cannot be reached at all the run stops without deploying, rather than publish a file that has forgotten the last day's snowfall and refetch every TomTom forecast; the next run tries again.
- Change alerts on a run where a source failed: the verdict is held at what was last sent (a gap in the data is not a change in the road), but a chain-control change read from a working feed, a drive-time change and the two summaries still go out, and the summary says which source did not update.
- The page additionally reads chain control straight from Caltrans on every load, so that part is always live. If those direct requests stop working while the page stays open, the reading from the scheduled refresh takes over as soon as it is the newer one.
- Change alerts: pick a departure time on the Verdict tab and turn on the alert. The page saves that departure and the device's Web Push subscription in the same private Gist as the checklist; after every refresh `scripts/notify.mjs` re-evaluates it and pushes a notification when the verdict or the chain-control level changed, or the drive time moved 30 minutes or more from the one last reported, plus a summary at 8 pm the evening before and two hours before leaving. What was last sent is published as `data/alerts.json` (a hash, two levels and a drive time, no trip details).
- Share links: the Share button in the corner of the verdict card makes a link carrying the destination, the direction and the picked departure (`?resort=kirkwood&dir=back&date=2026-11-22&time=7:00`, see `js/share.js`). Opening it shows that view once, without changing the reader's saved destination, and the parameters are then removed from the address. A departure that has gone by opens as "leave now". Phones use the system share sheet, computers copy the link. It is all in the page: no request is added anywhere.
- The checklist is stored in the browser and can sync through a private GitHub Gist (Settings → paste a token with only the `gist` scope).

## Watchdog

`.github/workflows/watchdog.yml` is a safety net for the external cron-job. Once an hour (GitHub's own scheduler) it checks how old the published data is. Up to 45 minutes it does nothing. Beyond that it starts the refresh itself, and that run pushes a "scheduled refresh stopped" notification to the devices registered for change alerts, once a day at most. It fetches nothing while the cron-job works. GitHub disables scheduled workflows after 60 days without a commit and emails the owner when it does.

## Setup

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Repo → Settings → Secrets and variables → Actions: add `TOMTOM_KEY` (optional; without it the page uses a fixed drive time).
3. For change alerts, add the secret `ALERT_GIST_ID` (the ID is shown under Settings → Change alerts once sync is connected). On an iPhone the page has to be added to the Home Screen to receive notifications.
4. Push to `main`. The first run deploys the site.
5. Point an external cron-job at the workflow's `workflow_dispatch` endpoint (`POST /repos/<owner>/<repo>/actions/workflows/deploy.yml/dispatches` with `{"ref":"main"}` and a token that has Actions write access), every 15 minutes.

## Run locally

```bash
node scripts/fetch.mjs
```

```bash
python3 -m http.server 8000
```

## Tests

```bash
node --test "test/*.test.mjs"
```

No dependencies (Node 22+). They cover the verdict, chain control per vehicle, closure and incident direction, what happens when a source fails, pass-through times and change alerts, and run on every pull request (`.github/workflows/test.yml`).

## Add a destination

Append an entry to `DESTINATIONS` in `js/config.js` (route points, highways, resort cams), add its map line as `js/routes/<id>.js`, and list that file in `SHELL` in `sw.js`. Thresholds for the verdict live in `TH` in `js/logic.js`.

- `drivePins` are the waypoints TomTom is routed through. Use only points on the mountain road, never a town centre. On a divided freeway give the point a `pin` with a spot on each carriageway (see Donner Summit).
- A trip that uses a second highway at the end lists it under `route.also` with its own directions (CA-267 for Northstar); chain control, closures and incidents are then checked on both. `route.lonMax` cuts off what lies past the turn-off.
- Every new destination adds TomTom requests: redo the budget in `scripts/lib.mjs` (a test checks it stays under the quota).

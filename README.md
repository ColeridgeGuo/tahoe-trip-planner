# Tahoe Trip Planner

A go / no-go dashboard for driving from the Bay Area to a Tahoe ski resort: chain control, closures, CHP incidents, route weather, what to wear, resort cams and a packing checklist. Static site, no backend.

## How it works

- `scripts/fetch.mjs` pulls Caltrans (chain control, lane closures, cameras), CHP incidents, NWS gridded forecasts and alerts, and TomTom drive times, and writes `data/<destination>.json`.
- `.github/workflows/deploy.yml` runs that script and publishes the site to GitHub Pages. Nothing is committed back to the repo.
- The workflow has no schedule of its own. An external cron-job triggers it every 15 minutes through `workflow_dispatch`, because GitHub's built-in scheduler runs late and unevenly.
- Drive times come from TomTom (`TOMTOM_KEY` secret): live on every run, hourly for the next 24 h (refreshed hourly), and every 2 h out to 7 days (refreshed every 12 h). That is about 1,640 of the 2,500 free requests a day.
- Each drive time also says when the drive reaches every point along the route (Sacramento, Placerville, Kyburz, Echo Summit), read off the route TomTom returned, so the weather shown for a point is the weather at the moment you are there. This costs no extra requests. A point the chosen route does not pass (TomTom sometimes goes via Stockton instead of Sacramento) is placed between its neighbours.
- The verdict also counts snow that has already fallen: enough new snow in the 12 or 24 hours before you cross, while it is still freezing, is a caution even when nothing is falling any more (`TH.pack` in `js/logic.js`). The fetch script keeps the last 24 hours of snowfall (`snowPast`) for this.
- TomTom's drive time for a later departure is its usual traffic for that hour and knows nothing about snow. When the forecast has snow falling or lying as you cross, the page adds an estimated range for the pass (`TH.snowDelay`: 20-40 min in light snow or on packed snow, 45-90 min in heavy snow) next to the drive time and the arrival time. The TomTom figure itself, the pass-through times and the verdict are not changed by it. Leaving now with chain control already up, the live time is left as it is.
- Forecast snow is judged for the vehicle set in Settings: heavy snow, or snow lying on the road, is treated as R2 chain control, so a car that needs chains and has none gets a no-go instead of a caution; light snow only adds a reminder to bring chains.
- Only CHP collisions on the mountain section (east of `route.mountainLonMin`, Placerville) change the verdict. Valley incidents are listed, and their delay is already in the TomTom drive time.
- Chain control that cannot be read is never shown as "no chain control": a checkpoint whose status is not an R level or a closure (traffic being held, for instance), or a feed that answers without any checkpoint for the route, gives "cannot confirm" and a caution.
- Only NWS alerts about the road change the verdict (winter storm, blizzard, ice, snow squall, high wind, fog, flooding; `alertLevel` in `js/logic.js`). Others, such as Lake Wind Advisory or Freeze Warning, are listed without changing it.
- A lane closure counts when it is in force as the drive reaches that stretch (within 30 minutes either way), not at any time during the drive.
- Alternate routes are judged on every road they use (`alternates[].legs` in `js/config.js`): I-80 with CA-89 past Emerald Bay, CA-88 with CA-89 over Luther Pass.
- `data/history.json` records, hour by hour, the real chain-control level each way next to the snowfall and temperature forecast for that hour (about two months). It is there to check the snow thresholds against real storms. Each row also keeps the live drive time each way and the minutes spent on the mountain section (`d`, `m`), to replace the estimated snow delay with measured figures.
- `data/<destination>.json` carries `tomtom`: the requests sent so far today (UTC day) and yesterday's total, also printed in the run log.
- If a source fails on a run, its last good data is carried over from the previously published file (up to 24 h) and the page shows how old it is.
- Every run starts by reading back what the previous run published (the data file and `history.json`), with several tries. If the site cannot be reached at all the run stops without deploying, rather than publish a file that has forgotten the last day's snowfall and refetch every TomTom forecast; the next run tries again.
- Change alerts on a run where a source failed: the verdict is held at what was last sent (a gap in the data is not a change in the road), but a chain-control change read from a working feed, a drive-time change and the two summaries still go out, and the summary says which source did not update.
- The page additionally reads chain control straight from Caltrans on every load, so that part is always live.
- Change alerts: pick a departure time on the Verdict tab and turn on the alert. The page saves that departure and the device's Web Push subscription in the same private Gist as the checklist; after every refresh `scripts/notify.mjs` re-evaluates it and pushes a notification when the verdict or the chain-control level changed, or the drive time moved 30 minutes or more from the one last reported, plus a summary at 8 pm the evening before and two hours before leaving. What was last sent is published as `data/alerts.json` (a hash, two levels and a drive time, no trip details).
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

Append an entry to `DESTINATIONS` in `js/config.js` (route points, highways, resort cams). Thresholds for the verdict live in `TH` in `js/logic.js`.

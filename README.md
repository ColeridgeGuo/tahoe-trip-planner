# Tahoe Trip Planner

A go / no-go dashboard for driving from the Bay Area to a Tahoe ski resort (Heavenly via US-50, Kirkwood via CA-88, Northstar via I-80 and CA-267): chain control, closures, CHP incidents, route weather, what to wear, resort cams and a packing checklist. Static site, no backend.

## How it works

- `scripts/fetch.mjs` pulls Caltrans (chain control, lane closures, cameras), CHP incidents, NWS gridded forecasts and alerts, and TomTom drive times, and writes `data/<destination>.json`.
- `.github/workflows/deploy.yml` runs that script and publishes the site to GitHub Pages. Nothing is committed back to the repo.
- The workflow has no schedule of its own. An external cron-job triggers it every 15 minutes through `workflow_dispatch`, because GitHub's built-in scheduler runs late and unevenly.
- Drive times come from TomTom (`TOMTOM_KEY` secret): live, hourly for the next 24 h, and every 2 h out to 7 days. The three destinations share the 2,500 free requests a day about 2:1:1. Heavenly (`driveRefresh: 'full'`) gets live times on every run and re-fetches its next-24-h forecast every 2 h; Kirkwood and Northstar (`'light'`) get live times every 30 minutes and re-fetch theirs every 12 h. For all three the next 3 hours are re-fetched hourly and days 2 to 7 once a day. About 2,050 requests a day in total; the arithmetic is in `scripts/lib.mjs`.
- Each drive time also says when the drive reaches every point along the route (for Heavenly: Sacramento, Placerville, Kyburz, Echo Summit), read off the route TomTom returned, so the weather shown for a point is the weather at the moment you are there. This costs no extra requests. A point the chosen route does not pass (TomTom sometimes goes via Stockton instead of Sacramento) is placed between its neighbours.
- If a source fails on a run, its last good data is carried over from the previously published file (up to 24 h) and the page shows how old it is.
- The page additionally reads chain control straight from Caltrans on every load, so that part is always live.
- Change alerts: pick a departure time on the Verdict tab and turn on the alert. The page saves that departure and the device's Web Push subscription in the same private Gist as the checklist; after every refresh `scripts/notify.mjs` re-evaluates it and pushes a notification when the verdict or the chain-control level changed. What was last sent is published as `data/alerts.json` (a hash and two levels, no trip details).
- The checklist is stored in the browser and can sync through a private GitHub Gist (Settings → paste a token with only the `gist` scope).

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

# Tahoe Trip Planner

A go / no-go dashboard for driving from the Bay Area to a Tahoe ski resort: chain control, closures, CHP incidents, route weather, what to wear, resort cams and a packing checklist. Static site, no backend.

## How it works

- `scripts/fetch.mjs` pulls Caltrans (chain control, lane closures, cameras), CHP incidents, NWS gridded forecasts and alerts, and TomTom drive times, and writes `data/<destination>.json`.
- `.github/workflows/deploy.yml` runs that script and publishes the site to GitHub Pages. Nothing is committed back to the repo.
- The workflow has no schedule of its own. An external cron-job triggers it every 15 minutes through `workflow_dispatch`, because GitHub's built-in scheduler runs late and unevenly.
- Drive times come from TomTom (`TOMTOM_KEY` secret): live on every run, hourly for the next 24 h (refreshed hourly), and every 2 h out to 7 days (refreshed every 12 h). That is about 1,640 of the 2,500 free requests a day.
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

## Add a destination

Append an entry to `DESTINATIONS` in `js/config.js` (route points, highways, resort cams). Thresholds for the verdict live in `TH` in `js/logic.js`.

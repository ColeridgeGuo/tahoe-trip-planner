# Tahoe Trip Planner

A go / no-go dashboard for driving from the Bay Area to a Tahoe ski resort: chain control, closures, CHP incidents, route weather, what to wear, resort cams and a packing checklist. Static site, no backend.

## How it works

- `scripts/fetch.mjs` pulls Caltrans (chain control, lane closures, cameras), CHP incidents and NWS gridded forecasts and alerts, and writes `data/<destination>.json`.
- `.github/workflows/deploy.yml` runs that script every 15 minutes and publishes the site to GitHub Pages. Nothing is committed back to the repo.
- If a source fails on a run, its last good data is carried over from the previously published file (up to 24 h) and the page shows how old it is.
- The page additionally reads chain control straight from Caltrans on every load, so that part is always live.
- The checklist is stored in the browser and can sync through a private GitHub Gist (Settings → paste a token with only the `gist` scope).

## Setup

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Push to `main`. The first run deploys the site.

GitHub pauses scheduled workflows after 60 days without repo activity; re-enable under the Actions tab if that happens.

## Run locally

```bash
node scripts/fetch.mjs
```

```bash
python3 -m http.server 8000
```

## Add a destination

Append an entry to `DESTINATIONS` in `js/config.js` (route points, highways, resort cams). Thresholds for the verdict live in `TH` in `js/logic.js`.

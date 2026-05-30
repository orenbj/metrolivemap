# Metro Live Map

Real-time map of LA Metro rail and rapid bus lines. Live at **[orenbj.github.io/metrolivemap](https://orenbj.github.io/metrolivemap)**. Custom domain `livemap.metro.net` configured (CNAME pending DNS delegation).

## Features

| Feature | Details |
|---------|---------|
| **Live vehicle positions** | Trains and buses streamed via WebSocket; GPS spike and teleport rejection |
| **Track-aligned heading** | Vehicle arrows follow route polyline tangent, not raw GPS bearing |
| **Smooth motion** | Rail markers glide along the route polyline between GPS fixes; buses glide straight-line. Never extrapolates past the latest fix |
| **Station arrivals** | Next trains/buses per direction from GTFS-RT; closest vehicle per direction highlighted |
| **Boarding badges** | At terminus/origin stops: badge shows vehicles ready to board vs. in service |
| **Click interactions** | Vehicles: destination, next stop, live ETA; Stations: live arrival list |
| **Route filtering & search** | Hide/show lines, search station names, auto-locate |
| **Dark mode** | Toggle; persisted across sessions |
| **Metro Bike Share** | Real-time station availability; pie charts ≥ zoom 13, dot markers below |
| **Metro Micro zones** | Service area polygons; tap to open Metro Micro app or store links |
| **Service alerts** | GTFS-RT alert banners on affected station popups; legend badges |
| **Translation** | Each browser's built-in translate feature (Chrome / Edge / Safari menu, iOS Safari AA menu, Android Chrome menu) — covers ~100 languages including alert prose |
| **Responsive** | Optimized for mobile and desktop viewports |

## Tech Stack

| Layer | Tech |
|-------|------|
| Map rendering | MapLibre GL JS 5.24.0 (CDN, SRI-pinned) |
| Base tiles | CARTO Voyager / Dark Matter |
| Metro basemap | ESRI ArcGIS bounded raster tiles |
| Live feeds | LA Metro GTFS-RT WebSockets |
| Tests | Vitest (unit tests for ETA engine and snap logic) |
| Hosting | GitHub Pages (served from `main`) |

## Architecture

Pure client-side, no backend, no build step. Data flows from five WebSocket feeds:

```
vehicle_positions (rail + buses)
  → api.js                parse and normalize positions
  → markers.js            create/update/animate markers, GPS spike rejection,
                          bounded arc-glide, heading computation
  → snap.js               snap GPS to route polylines; arc-length precomputation

trip_updates (arrival predictions)
  → tripUpdates.js        build masterArrivalsData: stopId → arrivals[]
  → predictions.js        hybrid ETA: GTFS-RT → GPS-corrected schedule → fallback
  → stations.js           render station dots, populate arrival popups

service_alerts (REST, polled every 120 s)
  → alerts.js             fetch and aggregate active alerts per route
  → stations.js           show alert banners in station popups
  → ui.js                 badge affected routes in legend

bikeshare & microzones (REST)
  → bikeshare.js          fetch GBFS, render pie/dot markers
  → microzones.js         load and style zone polygons
```

## Module Map

| File | Responsibility |
|------|---------------|
| `js/main.js` | Entry point: parallel data fetch, map init, WebSocket setup |
| `js/api.js` | WebSocket connections (vehicle positions), reconnect backoff |
| `js/map.js` | MapLibre init, controls, ESRI overlay, dark mode, toggles |
| `js/markers.js` | Vehicle marker create/update/animate, heading, bounded arc-glide between GPS fixes, spike rejection |
| `js/snap.js` | GPS→polyline snapping, tangent bearing, arc-length progression |
| `js/stations.js` | Station dot rendering, arrival popups, boarding badges, stop group merging |
| `js/tripUpdates.js` | GTFS-RT trip_updates WebSocket, `window.masterArrivalsData` |
| `js/predictions.js` | Hybrid ETA engine: GTFS-RT → GPS-corrected schedule → distance fallback |
| `js/alerts.js` | REST-polled service alerts (120 s), `window.masterAlertsData`; station-name text-mining fallback for route-only alerts |
| `js/alertsPanel.js` | Slide-in alerts panel (Service + Accessibility tabs); focus-trap, ESC-to-close, keyboard tab navigation |
| `js/busBridges.js` | Detect `NO_SERVICE` gaps across consecutive stops; render bracket polyline 60 m off track with 🚌 glyph |
| `js/bikeshare.js` | Metro Bike Share GBFS fetch, SVG pie/dot markers, popups |
| `js/microzones.js` | Metro Micro zone GeoJSON fill+border, hover, app-store popups |
| `js/ui.js` | Legend panel, route filtering, mobile sheet, search bar |
| `js/freshness.js` | Shared freshness-tier logic (`getFreshnessTier`, `getFreshnessTierFromAge`); imported by `markers.js` and `ui.js` |
| `js/errorBoundary.js` | Global `window.onerror` + `unhandledrejection` capture; burst-threshold recovery banner; counts to `feedStats` |
| `js/config.js` | Route colors, direction labels, API endpoints, tuning constants |
| `js/feedStats.js` | Rolling feed-health counters (accept rate, drop reasons, marker drops, ghost arrivals); 60 s console report + 24 h `localStorage.feedStatsRing` |
| `js/serviceDate.js` | Pure helper for midnight rollover: `_preserveActiveTrips` keeps cross-midnight owl trips' static context across the GTFS data swap |
| `js/utils.js` | `planarMeters`, `computeBearing`, `cleanStationName`, `escHtml`, `normalizeTimestamp`, `splitRouteId`, misc helpers |

## Data Files

| File | Schema | Source |
|------|--------|--------|
| `data/rail-shapes.json` | `{ routeCode: [[lat, lng], ...] }` | `node scripts/build-shapes.cjs` (from GTFS shapes.txt) |
| `data/trips.json` | `{ tripId: { dest, rc, dir, total, stops[], scheduledTimes[], isLast? } }` | `node scripts/build-shapes.cjs` (from GTFS trips/stop_times) |
| `data/stops.json` | `{ stopId: { lat, lon, name } }` | `node scripts/build-shapes.cjs` (from GTFS stops.txt) |
| `data/bus-routes.json` | `{ routeCode: { name, agency, ... } }` | `node scripts/build-shapes.cjs` (from GTFS routes.txt) |
| `data/metro-micro-zones.json` | GeoJSON FeatureCollection (8 zones) | [ArcGIS Hub](https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas) |

**Rebuild after GTFS updates:**
```bash
# 1. Download GTFS from https://lacmta.github.io/GTFS_Documents/
# 2. Place rail GTFS in data/rail_gtfs/
# 3. Run:
node scripts/build-shapes.cjs
```

## Live Data Feeds

### WebSocket Feeds

| Feed | URL Pattern | Cadence |
|------|-------------|---------|
| Rail vehicle positions | `wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions` | ~2–5 s |
| G/J bus vehicle positions | `wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901` | ~2–5 s |
| Rail trip updates | `wss://api.metro.net/ws/LACMTA_Rail/trip_updates` | ~5–10 s |
| Bus trip updates | `wss://api.metro.net/ws/LACMTA/trip_updates` (unfiltered; populates all routes for arrival popups) | ~5–10 s |

### REST Endpoints

| Service | Config key | Cadence |
|---------|------------|---------|
| Rail service alerts | `RAIL_ALERTS_URL` | 120 s |
| Bus service alerts | `BUS_ALERTS_URL` | 120 s |
| Bike Share station info | `GBFS_INFO_URL` | once at startup |
| Bike Share availability | `GBFS_STATUS_URL` | 30 s |

## Global State

| Variable | Set by | Read by |
|----------|--------|---------|
| `window.map` | `map.js` | all modules needing map access |
| `window.masterStopsData` | `main.js` | markers, stations, predictions, alerts |
| `window.masterTripsData` | `main.js` | markers, stations, predictions |
| `window.masterBusRoutes` | `main.js` | stations, busBridges |
| `window.masterArrivalsData` | `tripUpdates.js` | stations, predictions |
| `window.vehicleMarkers` | `markers.js` | predictions, stations |
| `window.masterAlertsData` | `alerts.js` | stations, ui, busBridges |
| `window.masterStopAlertsData` | `alerts.js` | stations |
| `window.masterStopAccessibilityAlertsData` | `alerts.js` | stations |
| `window.masterBikeStations` | `bikeshare.js` | bikeshare (internal) |
| `window.stationGroups` | `stations.js` | stations (internal) |

Note: `tripTerminusByTripId` is a named export from `tripUpdates.js`, not a `window` global — production callers (`stations.js`, `predictions.js`) import it directly. The previous `window` mirror was removed in PR #151 to keep the access path single.

## File Organization

```
/ (repo root)
├── index.html                  → Entry point (no build step)
├── CNAME                       → GitHub Pages domain (livemap.metro.net — pending DNS)
├── js/
│   ├── main.js                 → Initialization, parallel data fetch, WebSocket setup
│   ├── api.js                  → WebSocket connections, reconnect backoff
│   ├── map.js                  → MapLibre init, ESRI overlay, controls, dark mode
│   ├── markers.js              → Vehicle markers: create/update/animate, heading, arc-glide, spike rejection
│   ├── snap.js                 → GPS→polyline snapping, tangent bearing, arc-length progression
│   ├── stations.js             → Station dots, arrival popups, boarding badges, stop merging
│   ├── tripUpdates.js          → GTFS-RT trip_updates WebSocket, masterArrivalsData
│   ├── predictions.js          → Hybrid ETA engine: GTFS-RT → schedule → distance fallback
│   ├── alerts.js               → REST service alerts (120 s), masterAlertsData; station text-mining fallback
│   ├── busBridges.js           → NO_SERVICE gap detection; bracket polyline 60 m off track
│   ├── bikeshare.js            → Metro Bike Share GBFS, SVG pie/dot markers, popups
│   ├── microzones.js           → Metro Micro zone polygons, hover, app-store popups
│   ├── ui.js                   → Legend, route filter, mobile sheet, search bar
│   ├── freshness.js            → Shared freshness-tier logic (live/stale/expired)
│   ├── config.js               → Route colors, direction labels, API endpoints, constants
│   ├── feedStats.js            → Rolling feed-health counters, 60 s report + 24 h localStorage ring
│   ├── serviceDate.js          → Midnight-rollover helper: preserve cross-midnight owl trips' static context
│   └── utils.js                → Shared helpers: geo math, string utils, escHtml, timestamp/route-id normalizers
├── styles/
│   └── index-style.css         → Responsive layout, dark mode, animations
├── data/
│   ├── rail-shapes.json        → Route polylines (built from GTFS)
│   ├── trips.json              → Trip metadata: dest, direction, stop sequence, schedule
│   ├── stops.json              → Stop locations: lat/lon, name
│   ├── bus-routes.json         → Bus route metadata (built from GTFS)
│   └── metro-micro-zones.json  → Metro Micro zone GeoJSON (8 zones)
├── images/
│   └── metro_logo_only_black.png
└── scripts/
    ├── build-shapes.cjs             → GTFS preprocessor (run locally after GTFS update; also runs in rebuild-gtfs.yml weekly)
    ├── audit-feeds.js               → Field-coverage + reliability audit (scheduled 2x/wk via feed-reliability.yml; manual: --duration=20m --out=path.json)
    ├── analyze-ring.js              → Offline summarizer for feedStats ring (raw localStorage JSON or harness JSONL tail row)
    ├── live-accuracy-harness.js     → Dev: capture and score live ETA accuracy (interactive)
    ├── live-accuracy-headless.js    → CI: Playwright-driven accuracy capture; appends feedStats ring to JSONL
    ├── blend-tuning.mjs             → Offline sweep of blend constants against captured accuracy artifacts
    └── perf-baseline.js             → Headless rendering-perf baseline harness
```

## Development

No build step — native ES modules served directly.

```bash
# Local dev server
npx serve . --listen 3000
```

Open `http://localhost:3000` and verify:
- Vehicle markers animate and snap to routes
- Click a station dot → popup shows live arrivals
- Click a vehicle → shows destination and next stop
- Search, filtering, and dark mode work
- Console shows `WebSocket opened` for both position feeds

### Setup

```bash
npm install   # one-time, installs dev tooling: vitest, jsdom, playwright
npx serve . --listen 3000   # or any static server; the app is no-build
```

Then open http://localhost:3000/. The map should load tiles, the WebSocket
indicator should turn green within a few seconds, and route markers should
appear once `data/trips.json` finishes loading (~3-5 s on first visit).

### Tests

```bash
npm test
```

Unit tests (Vitest) — 691 tests across 30 files — cover the ETA engine and prediction blend (including horizon-band and disagreement-decay boundary tests), polyline snapping, GPS spike rejection, marker lifecycle and stale-fade, vehicle popup HTML rendering + escaping, route-color contrast against WCAG 1.4.11, alerts panel focus-trap, heading computation, adherence offset, boarding-vehicle merging, trip updates (including CANCELED/SKIPPED gates), the WebSocket API layer (including future-timestamp rejection), alerts ingestion, bus-bridge detection on consecutive-stop runs, blend-boundary thresholds, accuracy aggregator + substitution-impact metric, feed-stats observability counters (`vehicleNoArrivalMatch`, ghost-arrival filtering, `globalErrors`, `unhandledRejections`), global error boundary, service-date rollover with cross-midnight trip preservation, and pure utility math (planar distance, bearing, stop-ID normalisation, escape helpers, ms-vs-seconds timestamp normalisation). No mocks where avoidable — most tests use real geometry and schedule data. **Dead-reckoning was retired in PR #257** — the marker now only ever moves between two GPS-confirmed positions via a polyline-arc glide; tests for the retired DR machinery (`dr-animation.test.js`, `intersection-lookup.test.js`) were deleted.

## CI

Five GitHub Actions workflows live under `.github/workflows/`:

- **`tests.yml`** — runs the Vitest suite on every push and PR.
- **`gtfs-drift-check.yml`** — Mon 08:00 UTC. Diffs current Metro GTFS against committed `data/trips.json` / `stops.json`; files an issue under label `gtfs-drift` when stale-trip drift exceeds 5%.
- **`rebuild-gtfs.yml`** — Mon 09:00 UTC (one hour after drift-check). Auto-runs `node scripts/build-shapes.cjs` against the latest Metro GTFS and opens a PR if data changed. If PR creation is blocked (e.g. the repo-level "Allow GitHub Actions to create and approve pull requests" setting is off), an `if: failure()` fallback files an issue under label `gtfs-rebuild-failure` so the failure is visible instead of silent.
- **`feed-reliability.yml`** — Wed 17:00 UTC + Fri 23:00 UTC. Runs `node scripts/audit-feeds.js --duration=20m` against the live Metro WS feeds and uploads the JSON report as a 30-day artifact. The top-line field-coverage table is also surfaced in `$GITHUB_STEP_SUMMARY`. **Source of truth for "does Metro actually populate field X?"** — consult before wiring up any optional GTFS-RT field. `workflow_dispatch` enabled for manual runs.
- **`live-accuracy.yml`** — captures live ETA accuracy via Playwright + the headless harness; produces JSONL artifacts for offline analysis with `scripts/blend-tuning.mjs`.

## Deployment

GitHub Pages serves from the root of `main`. Push to `main` → auto-deploy.

```bash
git push origin main
```

Custom domain `livemap.metro.net` is configured in `CNAME` (pending DNS delegation from Metro IT). Until then the live URL is `https://orenbj.github.io/metrolivemap/`.

**If main breaks in production:** see [`docs/ROLLBACK.md`](docs/ROLLBACK.md). The short version:

```bash
git revert <bad-sha>          # makes an inverse commit, no force-push
git push origin HEAD:revert-<bad-sha>
gh pr create ...              # then admin-merge to skip CI during outage
```

**Pre-launch checklist:** see [`docs/LAUNCH-READINESS.md`](docs/LAUNCH-READINESS.md) — single-document synthesis of the prod-readiness audit, what was shipped, what's deferred, and the manual smoke checks to run before pointing public traffic at this.

## Contributing with Claude Code

This project uses [Claude Code](https://claude.ai/claude-code) for AI-assisted development. Workflow rules are in [CLAUDE.md](CLAUDE.md) — read that first.

- Claude always works on a feature branch + git worktree, never `main`
- Every change goes through a Pull Request reviewed in GitHub Desktop
- Commits follow `feat:`, `fix:`, `polish:`, `refactor:` conventions, one logical sub-task per commit

## License

Released under the [MIT License](LICENSE). Powered by [LA Metro GTFS feeds](https://lacmta.github.io/GTFS_Documents/). Site design and real-time visualization © 2024–2026.

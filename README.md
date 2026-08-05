# Metro Live Map

Real-time map of LA Metro rail and rapid bus lines. Live at **[orenbj.github.io/metrolivemap](https://orenbj.github.io/metrolivemap)** (see [Deployment](#deployment) for the `livemap.metro.net` custom domain / LA Metro handoff status).

A **no-build, client-only** single-page app: vanilla ES modules, no bundler, no server, no framework, no runtime dependencies (MapLibre is vendored same-origin). Push to `main` → GitHub Pages auto-deploys in ~60 s.

> **Origin:** this project began as a fork of LA Metro's MIT-licensed live-map code ([`LACMTA/realtime-map`](https://github.com/LACMTA/realtime-map) / [`LACMTA/livemap`](https://github.com/LACMTA/livemap) — the same codebase, exact source repo indeterminate) and has been extended well beyond it. Upstream attribution is retained in [`LICENSE`](LICENSE) / [`NOTICE.md`](NOTICE.md).

## Documentation

| Doc | What it's for |
|-----|---------------|
| **[CLAUDE.md](CLAUDE.md)** | The durable contract — motion-model invariants, feed-data gates, freshness tiers, cross-module globals. **Read before changing marker/ETA/snap code.** |
| **[docs/HANDOFF.md](docs/HANDOFF.md)** | Operations & handoff guide: local dev, GTFS pipeline, first-time repo setup, external dependencies, incident response, and §12 **Transfer to a new owner**. |
| **[docs/STATUS.md](docs/STATUS.md)** | Point-in-time engineering snapshot: current motion model, recent landings, deferred decisions, observability counters. |
| **[docs/ROLLBACK.md](docs/ROLLBACK.md)** | "Production is broken" runbook — severity triage and `git revert`/restore steps. |
| **[CHANGELOG.md](CHANGELOG.md)** · **[NOTICE.md](NOTICE.md)** | Release history · third-party data/tile/font attribution & licenses. |
| **[docs/audits/](docs/audits/)** · **[docs/_archive/](docs/_archive/)** | Point-in-time review reports · retired-design specs & historical docs. |

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
| Map rendering | MapLibre GL JS 5.24.0 (vendored same-origin — `vendor/maplibre-gl/`) |
| Base tiles | CARTO Voyager / Dark Matter |
| Metro basemap | ESRI ArcGIS bounded raster tiles |
| Live feeds | LA Metro GTFS-RT WebSockets |
| Tests | Vitest (unit tests for ETA engine and snap logic) |
| Hosting | GitHub Pages (served from `main`) |

## Architecture

Pure client-side, no backend, no build step. Data flows from **four WebSocket feeds** (vehicle positions ×2, trip updates ×2), two polled REST sources (service alerts, bike share), and one static local GeoJSON load (Metro Micro zones, fetched once at startup):

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

bikeshare (GBFS REST, polled)
  → bikeshare.js          fetch GBFS, render pie/dot markers

microzones (static local GeoJSON, one-shot)
  → microzones.js         load data/metro-micro-zones.json once; style zone polygons
```

## Module Map

| File | Responsibility |
|------|---------------|
| `js/main.js` | Entry point: parallel data fetch, map init, WebSocket setup |
| `js/api.js` | WebSocket connections (vehicle positions), reconnect backoff |
| `js/map.js` | MapLibre init, controls, ESRI overlay, dark mode, toggles |
| `js/markers.js` | Vehicle marker create/update/animate, heading, bounded arc-glide between GPS fixes, spike rejection |
| `js/followVehicle.js` | Pin &amp; follow a vehicle — camera tracks it, highlight, survives backgrounding & reload |
| `js/snap.js` | GPS→polyline snapping, tangent bearing, arc-length progression |
| `js/stations.js` | Station dot rendering, arrival popups, boarding badges, stop group merging |
| `js/boardingBadges.js` | Boarding/departure badge geometry at origin stops (8-cardinal boarding-slot layout) |
| `js/tripUpdates.js` | GTFS-RT trip_updates WebSocket, `window.masterArrivalsData` |
| `js/predictions.js` | Hybrid ETA engine: GTFS-RT → GPS-corrected schedule → distance fallback |
| `js/alerts.js` | REST-polled service alerts (120 s), `window.masterAlertsData`; station-name text-mining fallback for route-only alerts |
| `js/alertsPanel.js` | Slide-in alerts panel (Service + Accessibility tabs); focus-trap, ESC-to-close, keyboard tab navigation |
| `js/busBridges.js` | Detect `NO_SERVICE` gaps across consecutive stops; render bracket polyline 60 m off track with 🚌 glyph |
| `js/bikeshare.js` | Metro Bike Share GBFS fetch, SVG pie/dot markers, popups |
| `js/microzones.js` | Metro Micro zone GeoJSON fill+border, hover, app-store popups |
| `js/restrooms.js` | Curated station restroom inventory (static lookup); surfaced in the station popup |
| `js/ui.js` | Legend panel, route filtering, mobile sheet, search bar |
| `js/freshness.js` | Shared freshness-tier logic (`getFreshnessTier`, `getFreshnessTierFromAge`); imported by `markers.js` and `ui.js` |
| `js/popups.js` | Single-active-popup registry (leaf module); enforces one open popup across vehicle/station/bike/micro/alerts owners |
| `js/pwaInstall.js` | PWA install prompt — dismissible "Add to home screen" banner (Chromium) and iOS Share hint; dismissal persisted in `localStorage.mlm_pwa_install_dismissed` |
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
| `data/bus-routes.json` | `{ routeCode: { short_name, long_name } }` | `node scripts/build-shapes.cjs` (from GTFS routes.txt) |
| `data/bus-destinations.json` | `{ dests[], byRouteDir{ "route\|dir": idx }, byTrip{ tripId: idx } }` | `node scripts/build-shapes.cjs` (rider-facing bus `destination_code`; ~17 KB gz) |
| `data/metro-micro-zones.json` | GeoJSON FeatureCollection (8 zones) | [ArcGIS Hub](https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas) |

**Rebuild after GTFS updates:**
```bash
node scripts/build-shapes.cjs   # auto-downloads latest Metro GTFS and regenerates data/*.json
```

## Live Data Feeds

### WebSocket Feeds

| Feed | URL Pattern | Cadence |
|------|-------------|---------|
| Rail vehicle positions | `wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions` | ~2–5 s |
| G/J/J Line San Pedro vehicle positions | `wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901,950` | ~2–5 s |
| Rail trip updates | `wss://api.metro.net/ws/LACMTA_Rail/trip_updates` | ~5–10 s |
| Bus trip updates | `wss://api.metro.net/ws/LACMTA/trip_updates` (unfiltered; populates all routes for arrival popups) | ~5–10 s |

Route 950 (J Line San Pedro) is subscribed for vehicle positions alongside routes 901 and 910, and snaps to the same busway shape data using BRT arc-glide physics. Its street-running sections in San Pedro and DTLA render clickable station dots only at zoom ≥ 14 (where the Metro basemap draws them), while dedicated busway stations (Harbor Transitway, El Monte Station, etc.) remain clickable from zoom 10 like rail.

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
| `window.map` | `map.js` (assigned to `window` in `main.js`) | all modules needing map access |
| `window.masterStopsData` | `main.js` | markers, stations, predictions, alerts |
| `window.masterTripsData` | `main.js` | markers, stations, predictions |
| `window.masterBusRoutes` | `main.js` | stations, busBridges |
| `window.masterBusDestinations` | `main.js` | predictions (`resolveBusDestination`) |
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
├── CNAME                       → GitHub Pages custom domain (livemap.metro.net — Metro handoff target; HANDOFF §12.3)
├── sw.js                       → Installability-only service worker (NO caching — see CLAUDE.md sw.js contract)
├── manifest.json               → PWA manifest (home-screen install)
├── 404.html                    → GitHub Pages fallback
├── vendor/maplibre-gl/         → Vendored MapLibre GL JS + CSS (same-origin, no CDN)
├── js/
│   ├── main.js                 → Initialization, parallel data fetch, WebSocket setup
│   ├── api.js                  → WebSocket connections, reconnect backoff
│   ├── map.js                  → MapLibre init, ESRI overlay, controls, dark mode
│   ├── markers.js              → Vehicle markers: create/update/animate, heading, arc-glide, spike rejection
│   ├── followVehicle.js        → Pin & follow: camera tracks a chosen vehicle; survives backgrounding & reload
│   ├── snap.js                 → GPS→polyline snapping, tangent bearing, arc-length progression
│   ├── stations.js             → Station dots, arrival popups, boarding badges, stop merging
│   ├── boardingBadges.js       → Boarding/departure badge geometry at origin stops (8-cardinal layout)
│   ├── tripUpdates.js          → GTFS-RT trip_updates WebSocket, masterArrivalsData
│   ├── predictions.js          → Hybrid ETA engine: GTFS-RT → schedule → distance fallback
│   ├── alerts.js               → REST service alerts (120 s), masterAlertsData; station text-mining fallback
│   ├── alertsPanel.js          → Slide-in alerts panel (Service + Accessibility tabs); focus-trap, ESC-to-close
│   ├── busBridges.js           → NO_SERVICE gap detection; bracket polyline 60 m off track
│   ├── bikeshare.js            → Metro Bike Share GBFS, SVG pie/dot markers, popups
│   ├── microzones.js           → Metro Micro zone polygons, hover, app-store popups
│   ├── restrooms.js            → Curated station restroom inventory (static lookup); shown in station popup
│   ├── popups.js               → Single-active-popup registry (leaf module); one open popup across owners
│   ├── ui.js                   → Legend, route filter, mobile sheet, search bar
│   ├── freshness.js            → Shared freshness-tier logic (live/stale/expired)
│   ├── config.js               → Route colors, direction labels, API endpoints, constants
│   ├── feedStats.js            → Rolling feed-health counters, 60 s report + 24 h localStorage ring
│   ├── errorBoundary.js        → Global onerror + unhandledrejection capture; recovery banner
│   ├── pwaInstall.js           → PWA install prompt (Chromium banner + iOS hint)
│   ├── serviceDate.js          → Midnight-rollover helper: preserve cross-midnight owl trips' static context
│   └── utils.js                → Shared helpers: geo math, string utils, escHtml, timestamp/route-id normalizers
├── styles/
│   └── index-style.css         → Responsive layout, dark mode, animations
├── data/
│   ├── rail-shapes.json        → Route polylines (built from GTFS)
│   ├── trips.json              → Trip metadata: dest, direction, stop sequence, schedule
│   ├── stops.json              → Stop locations: lat/lon, name
│   ├── bus-routes.json         → Bus route metadata (built from GTFS)
│   ├── bus-destinations.json   → Rider-facing bus destination_code labels (built from GTFS)
│   └── metro-micro-zones.json  → Metro Micro zone GeoJSON (8 zones)
├── images/
│   ├── metro_logo_only_black.png
│   └── metro_icon_*.png             → PWA home-screen icons (referenced by manifest.json)
├── scripts/
│   ├── build-shapes.cjs             → GTFS preprocessor (run locally after GTFS update; also runs in rebuild-gtfs.yml weekly)
│   ├── audit-feeds.js               → Field-coverage + reliability audit (scheduled 2x/wk via feed-reliability.yml; manual: --duration=20m --out=path.json)
│   ├── analyze-ring.js              → Offline summarizer for feedStats ring (raw localStorage JSON or harness JSONL tail row)
│   ├── live-accuracy-harness.js     → Dev: capture and score live ETA accuracy (interactive)
│   ├── live-accuracy-headless.js    → CI: Playwright-driven accuracy capture; appends feedStats ring to JSONL
│   ├── replay-taper.js              → Offline ADHERENCE_TAPER_K sweep against a captured accuracy artifact (replay-taper.yml)
│   ├── vendor-maplibre.sh           → Re-fetch/pin the vendored MapLibre dist into vendor/ (bump VERSION + index.html together)
│   └── perf-baseline.js             → Headless rendering-perf baseline harness
├── tests/                          → Vitest suite (59 files)
└── docs/                           → HANDOFF · STATUS · ROLLBACK · audits/ · _archive/
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

Use Node 24 for local dev (see `.nvmrc`) to match CI. Node 25+ runs the test
suite fine — `tests/setup.js` shims the in-memory `localStorage` that Node 25's
broken built-in accessor would otherwise collide with under jsdom — but 24 is
the version CI exercises.

Then open http://localhost:3000/. The map should load tiles, the WebSocket
indicator should turn green within a few seconds, and route markers should
appear once `data/trips.json` finishes loading (~3-5 s on first visit).

### Tests

```bash
npm test          # Vitest suite
npm run lint      # ESLint over js/, scripts/, tests/, sw.js, configs
```

Unit tests (Vitest) — 1173 tests across 59 files — cover the ETA engine (GTFS-RT when present, with a GPS-corrected schedule / distance calc fallback — no horizon-band blend or disagreement decay; that machinery was removed), polyline snapping, GPS spike rejection, marker lifecycle and stale-fade, vehicle popup HTML rendering + escaping, route-color contrast against WCAG 1.4.11, alerts panel focus-trap, station-popup placement + the on-screen correction (pinned-only camera pans, deferred retry after a flyTo, delegated expand listener), heading computation, adherence offset, boarding-vehicle merging, trip updates (including CANCELED/SKIPPED gates), the WebSocket API layer (including future-timestamp rejection), alerts ingestion, bus-bridge detection on consecutive-stop runs, the ETA tier-selection boundaries (GTFS-RT plausibility, staleness, origin-stop suppression), accuracy aggregator + substitution-impact metric, feed-stats observability counters (`vehicleNoArrivalMatch`, ghost-arrival filtering, `globalErrors`, `unhandledRejections`), global error boundary, service-date rollover with cross-midnight trip preservation, and pure utility math (planar distance, bearing, stop-ID normalisation, escape helpers, ms-vs-seconds timestamp normalisation). No mocks where avoidable — most tests use real geometry and schedule data. **Dead-reckoning was retired in PR #257** — the marker now only ever moves between two GPS-confirmed positions via a polyline-arc glide; tests for the retired DR machinery (`dr-animation.test.js`, `intersection-lookup.test.js`) were deleted.

## CI

Eight GitHub Actions workflows live under `.github/workflows/`:

- **`tests.yml`** — runs ESLint and the Vitest suite on every push and PR.
- **`uptime-check.yml`** — every 10 min. Pings the live GitHub Pages deploy; files an issue under label `uptime-failure` on sustained failure and auto-closes it on recovery.
- **`gtfs-drift-check.yml`** — on pushes touching `data/trips.json` / `data/stops.json` (i.e. just after a rebuild PR merges), plus manual dispatch. Diffs current Metro GTFS against the committed files and files an issue under label `gtfs-drift` when drift exceeds 5%. **No weekly cron and no auto-dispatch** — both removed in 2026-08: the cron ran an hour before the rebuild cron, and a 5% threshold against Metro's ~45% weekly trip_id churn made it fail every week (8 of the last 9 scheduled runs) while dispatching a rebuild the cron was about to run anyway, producing two identical rebuild PRs per week. Running only post-merge — against freshly rebuilt data, where drift should be ~0% — makes a red run mean "the rebuild didn't fix it" rather than "a week went by".
- **`rebuild-gtfs.yml`** — Mon 09:00 UTC, the **single** rebuild trigger. Auto-runs `node scripts/build-shapes.cjs` against the latest Metro GTFS and opens a PR if data changed. A `guard` job skips the run when a `gtfs-data`-labeled rebuild PR is already open, so a manual dispatch can't stack a duplicate on an unmerged one (workflow-level `concurrency` can't catch this — it only cancels runs still in flight). If PR creation is blocked (e.g. the repo-level "Allow GitHub Actions to create and approve pull requests" setting is off), an `if: failure()` fallback files an issue under label `gtfs-rebuild-failure` so the failure is visible instead of silent.
- **`feed-reliability.yml`** — Wed 17:00 UTC + Fri 23:00 UTC. Runs `node scripts/audit-feeds.js --duration=20m` against the live Metro WS feeds and uploads the JSON report as a 30-day artifact. The top-line field-coverage table is also surfaced in `$GITHUB_STEP_SUMMARY`. **Source of truth for "does Metro actually populate field X?"** — consult before wiring up any optional GTFS-RT field. `workflow_dispatch` enabled for manual runs.
- **`live-accuracy.yml`** — Tue 15:00 / Thu 20:00 / Sat 18:00 / Sun 21:00 UTC (4×/week, crons active). Captures live ETA accuracy via Playwright + the headless harness; produces JSONL artifacts for offline analysis.
- **`replay-taper.yml`** — manual (`workflow_dispatch`) offline `ADHERENCE_TAPER_K` sweep against a captured live-accuracy artifact; prints the K-sweep tables into the job log. Read-only — no repo writes, no issue/PR permissions.
- **`branch-cleanup.yml`** — Mon 10:00 UTC + manual. Deletes remote branches whose PR has already merged into `main` (the code is in `main`'s history, so removing the branch pointer is a no-op). Skips `main`, any branch still backing an open PR, and refs already gone; closed-but-**unmerged** PR branches are deliberately left for a human. Manual runs default to `dry_run: true` — set the input to `false` to actually delete.

## Deployment

GitHub Pages serves from the root of `main`. Push to `main` → auto-deploy.

```bash
git push origin main
```

The current live URL is `https://orenbj.github.io/metrolivemap/`. The `livemap.metro.net` custom domain in `CNAME` is the LA Metro handoff target (served from `LACMTA/livemap`, already live with a beta); the domain cutover is part of the migration — see [`docs/HANDOFF.md`](docs/HANDOFF.md) §12.3.

**If main breaks in production:** see [`docs/ROLLBACK.md`](docs/ROLLBACK.md). The short version:

```bash
git revert <bad-sha>          # makes an inverse commit, no force-push
git push origin HEAD:revert-<bad-sha>
gh pr create ...              # then admin-merge to skip CI during outage
```

**Launch history:** the pre-launch prod-readiness synthesis is archived at [`docs/_archive/LAUNCH-READINESS.md`](docs/_archive/LAUNCH-READINESS.md) (the launch gate has passed; kept for provenance).

**Operating / taking over the project:** see [`docs/HANDOFF.md`](docs/HANDOFF.md) — the operations & handoff guide (local dev, data pipeline, first-time repo setup, external dependencies, incident response, and §12 **Transfer to a new owner**). There is no build step: to host a copy, serve the repo root with any static file server (or fork it onto GitHub Pages).

## Contributing with Claude Code

This project uses [Claude Code](https://claude.ai/claude-code) for AI-assisted development. Workflow rules are in [CLAUDE.md](CLAUDE.md) — read that first.

- Claude always works on a feature branch + git worktree, never `main`
- Every change goes through a Pull Request reviewed in GitHub Desktop
- Commits follow `feat:`, `fix:`, `polish:`, `refactor:` conventions, one logical sub-task per commit

## License

Released under the [MIT License](LICENSE). Powered by [LA Metro GTFS feeds](https://lacmta.github.io/GTFS_Documents/). Site design and real-time visualization © 2024–2026.

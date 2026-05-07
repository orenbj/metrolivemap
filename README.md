# Metro Live Map

Real-time map of LA Metro rail and rapid bus lines. Live at **[orenbj.github.io/metrolivemap](https://orenbj.github.io/metrolivemap)** — custom domain `livemap.metro.net` pending DNS.

## Features

| Feature | Details |
|---------|---------|
| **Live vehicle positions** | Trains and buses streamed via WebSocket; GPS spike and teleport rejection |
| **Track-aligned heading** | Vehicle arrows follow route polyline tangent, not raw GPS bearing |
| **Dead-reckoning animation** | Markers glide smoothly between GPS fixes; decelerates near stops |
| **Station arrivals** | Next trains/buses per direction from GTFS-RT; closest vehicle per direction highlighted |
| **Boarding badges** | At terminus/origin stops: badge shows vehicles ready to board vs. in service |
| **Schedule calibration** | EWMA-based per-route offset learned from observed vs. scheduled arrivals |
| **Click interactions** | Vehicles: destination, next stop, progress bar; Stations: live arrival list |
| **Route filtering & search** | Hide/show lines, search station names, auto-locate |
| **Dark mode** | Toggle; persisted across sessions |
| **Metro Bike Share** | Real-time station availability; pie charts ≥ zoom 13, dot markers below |
| **Metro Micro zones** | Service area polygons; tap to open Metro Micro app or store links |
| **Service alerts** | GTFS-RT alert banners on affected station popups; legend badges |
| **Responsive** | Optimized for mobile and desktop viewports |

## Tech Stack

| Layer | Tech |
|-------|------|
| Map rendering | MapLibre GL JS 5.24.0 (CDN, SRI-pinned) |
| Base tiles | CARTO Voyager / Dark Matter |
| Rail overlay | ESRI ArcGIS TiledMapService |
| Live feeds | LA Metro GTFS-RT WebSockets |
| Tests | Vitest (unit tests for ETA engine and snap logic) |
| Hosting | GitHub Pages (served from `main`) |

## Architecture

Pure client-side, no backend, no build step. Data flows from five WebSocket feeds:

```
vehicle_positions (rail + buses)
  → api.js                parse and normalize positions
  → markers.js            create/update/animate markers, GPS spike rejection,
                          dead-reckoning, heading computation
  → snap.js               snap GPS to route polylines; arc-length precomputation

trip_updates (arrival predictions)
  → tripUpdates.js        build masterArrivalsData: stopId → arrivals[]
  → predictions.js        hybrid ETA: GTFS-RT → GPS-corrected schedule → fallback
  → scheduleCalibration.js learn per-route adherence offset via EWMA
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
| `js/markers.js` | Vehicle marker create/update/animate, heading, dead-reckoning, spike rejection |
| `js/snap.js` | GPS→polyline snapping, tangent bearing, arc-length progression |
| `js/stations.js` | Station dot rendering, arrival popups, boarding badges, stop group merging |
| `js/tripUpdates.js` | GTFS-RT trip_updates WebSocket, `window.masterArrivalsData` |
| `js/predictions.js` | Hybrid ETA engine: GTFS-RT → GPS-corrected schedule → DR fallback |
| `js/scheduleCalibration.js` | EWMA per-route adherence offset; persisted in localStorage |
| `js/alerts.js` | REST-polled service alerts (120 s), `window.masterAlertsData` |
| `js/bikeshare.js` | Metro Bike Share GBFS fetch, SVG pie/dot markers, popups |
| `js/microzones.js` | Metro Micro zone GeoJSON fill+border, hover, app-store popups |
| `js/ui.js` | Legend panel, route filtering, mobile sheet, search bar |
| `js/config.js` | Route colors, direction labels, API endpoints, tuning constants |
| `js/utils.js` | `planarMeters`, `computeBearing`, `cleanStationName`, `escHtml`, misc helpers |

## Data Files

| File | Schema | Source |
|------|--------|--------|
| `data/rail-shapes.json` | `{ routeCode: [[lat, lng], ...] }` | `node scripts/build-shapes.js` (from GTFS shapes.txt) |
| `data/trips.json` | `{ tripId: { dest, rc, dir, total, stops[], scheduledTimes[], isLast? } }` | `node scripts/build-shapes.js` (from GTFS trips/stop_times) |
| `data/stops.json` | `{ stopId: { lat, lon, name } }` | `node scripts/build-shapes.js` (from GTFS stops.txt) |
| `data/metro-micro-zones.json` | GeoJSON FeatureCollection (8 zones) | [ArcGIS Hub](https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas) |

**Rebuild after GTFS updates:**
```bash
# 1. Download GTFS from https://lacmta.github.io/GTFS_Documents/
# 2. Place rail GTFS in data/rail_gtfs/
# 3. Run:
node scripts/build-shapes.js
```

## Live Data Feeds

### WebSocket Feeds

| Feed | URL Pattern | Cadence |
|------|-------------|---------|
| Rail vehicle positions | `wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions` | ~2–5 s |
| G/J bus vehicle positions | `wss://api.metro.net/ws/LACMTA/vehicle_positions/901,910` | ~2–5 s |
| Rail trip updates | `wss://api.metro.net/ws/LACMTA_Rail/trip_updates` | ~5–10 s |
| Bus trip updates | `wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950` | ~5–10 s |

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
| `window.masterStopsData` | `main.js` | markers, stations, predictions |
| `window.masterTripsData` | `main.js` | markers, stations, predictions |
| `window.masterArrivalsData` | `tripUpdates.js` | stations, predictions |
| `window.vehicleMarkers` | `markers.js` | predictions, stations |
| `window.masterAlertsData` | `alerts.js` | stations, ui |
| `window.masterBikeStations` | `bikeshare.js` | bikeshare (internal) |

## File Organization

```
/ (repo root)
├── index.html                  → Entry point (no build step)
├── CNAME                       → GitHub Pages domain (livemap.metro.net — pending DNS)
├── js/
│   ├── main.js                 → Initialization, parallel data fetch, WebSocket setup
│   ├── api.js                  → WebSocket connections, reconnect backoff
│   ├── map.js                  → MapLibre init, ESRI overlay, controls, dark mode
│   ├── markers.js              → Vehicle markers: create/update/animate, heading, DR, spike rejection
│   ├── snap.js                 → GPS→polyline snapping, tangent bearing, arc-length progression
│   ├── stations.js             → Station dots, arrival popups, boarding badges, stop merging
│   ├── tripUpdates.js          → GTFS-RT trip_updates WebSocket, masterArrivalsData
│   ├── predictions.js          → Hybrid ETA engine: GTFS-RT → schedule → DR fallback
│   ├── scheduleCalibration.js  → EWMA adherence learning, localStorage persistence
│   ├── alerts.js               → REST service alerts (120 s), masterAlertsData
│   ├── bikeshare.js            → Metro Bike Share GBFS, SVG pie/dot markers, popups
│   ├── microzones.js           → Metro Micro zone polygons, hover, app-store popups
│   ├── ui.js                   → Legend, route filter, mobile sheet, search bar
│   ├── config.js               → Route colors, direction labels, API endpoints, constants
│   └── utils.js                → Shared helpers: geo math, string utils, escHtml
├── styles/
│   └── index-style.css         → Responsive layout, dark mode, animations
├── data/
│   ├── rail-shapes.json        → Route polylines (built from GTFS)
│   ├── trips.json              → Trip metadata: dest, direction, stop sequence, schedule
│   ├── stops.json              → Stop locations: lat/lon, name
│   └── metro-micro-zones.json  → Metro Micro zone GeoJSON (8 zones)
├── images/
│   └── metro_logo_only_black.png
└── scripts/
    ├── build-shapes.js         → GTFS preprocessor (run locally after GTFS update)
    ├── analyze-eta.js          → Dev: analyze captured ETA data
    ├── audit-feeds.js          → Dev: inspect live WebSocket feed contents
    ├── capture-eta.js          → Dev: record ETA stream for offline analysis
    └── diag.js                 → Dev: route/stop diagnostics
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

### Tests

```bash
npm test
```

Unit tests (Vitest) cover the ETA engine (`predictions.test.js`) and polyline snapping (`snap.test.js`). No mocks — tests use real geometry and schedule data.

## CI

A GitHub Actions workflow (`gtfs-drift.yml`) runs weekly to detect GTFS drift: it fetches the current Metro GTFS, rebuilds the data files, and opens an issue if the output differs from what's committed. This catches changes to stop IDs, trip shapes, or schedule timestamps before they affect live ETAs.

## Deployment

GitHub Pages serves from the root of `main`. Push to `main` → auto-deploy.

```bash
git push origin main
```

Custom domain `livemap.metro.net` is configured in `CNAME` (pending DNS delegation from Metro IT).

## Contributing with Claude Code

This project uses [Claude Code](https://claude.ai/claude-code) for AI-assisted development. Workflow rules are in [CLAUDE.md](CLAUDE.md) — read that first.

- Claude always works on a feature branch + git worktree, never `main`
- Every change goes through a Pull Request reviewed in GitHub Desktop
- Commits follow `feat:`, `fix:`, `polish:`, `refactor:` conventions, one logical sub-task per commit

## License

Powered by [LA Metro GTFS feeds](https://lacmta.github.io/GTFS_Documents/). Site design and real-time visualization © 2024–2026.

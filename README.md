# Metro Live Map

Real-time map of LA Metro rail lines and busways at [metrolivemap.net](https://metrolivemap.net).

## Features

- **Live vehicle positions** — Trains and buses streamed via WebSocket with GPS spike and teleport rejection
- **Track-aligned heading** — Vehicle arrows follow route polyline tangent, not a straight line to the next stop
- **Dead-reckoning animation** — Markers glide smoothly between GPS fixes; pauses automatically when speed = 0
- **Station arrivals** — Next trains/buses per direction from GTFS-RT feed; closest vehicle per direction highlighted on map
- **Click interactions** — Vehicles show destination, next stop, and progress; stations show upcoming arrivals
- **Filtering & search** — Hide lines, search stations, toggle dark mode, auto-locate
- **Responsive** — Optimized for mobile and desktop
- **Metro Bike Share** — Real-time station availability; pie charts at zoom ≥ 13, dot markers at lower zoom; tap any marker for popup
- **Metro Micro zones** — Service area polygons; tap to open the Metro Micro app (iOS/Android) or browse store links on desktop
- **Service alerts** — GTFS-RT alerts overlay on affected routes

## Stack

| Layer | Tech |
|-------|------|
| Map | MapLibre GL JS 5.24.0 (CDN, SRI-pinned) |
| Base tiles | CARTO Voyager / Dark Matter |
| Rail overlay | ESRI ArcGIS TiledMapService |
| Live feeds | LA Metro GTFS-RT WebSockets |
| Hosting | GitHub Pages (CNAME: metrolivemap.net) |

## Architecture

Pure client-side, no backend. Data flows from five WebSocket feeds:

```
vehicle_positions (rail + buses)
  → api.js              parse and normalize positions
  → markers.js          create/update/animate map markers, compute heading
  → snap.js             snap GPS to route polylines for smooth track-aligned display

trip_updates (arrival predictions)
  → tripUpdates.js      build masterArrivalsData: stopId → [{ routeId, directionId, vehicleId, arrivalUnix }]
  → stations.js         render station dots, populate arrival popups

service_alerts (REST, polled every 120 s)
  → alerts.js           fetch and aggregate active alerts per route
  → stations.js         show alert banners in station popups
  → ui.js               badge affected routes in legend

bikeshare & microzones (REST)
  → bikeshare.js        fetch GBFS, render pie/dot markers
  → microzones.js       load and style zone polygons
```

All data processing is client-side and lightweight: GPS spike rejection, route snapping, heading computation, dead-reckoning animation, and hybrid ETA blending.

## Module Map

| File | Responsibility |
|------|---------------|
| `js/main.js` | Entry point: parallel data fetch, map init, WS setup |
| `js/api.js` | WebSocket connections (vehicle positions), reconnect backoff |
| `js/map.js` | MapLibre init, controls, ESRI/3D layers, dark mode, toggles |
| `js/markers.js` | Vehicle marker create/update/animate, heading computation |
| `js/snap.js` | GPS→polyline snapping, tangent bearing, arc-progression |
| `js/stations.js` | Station dot rendering, arrival popups, stop group merging |
| `js/tripUpdates.js` | GTFS-RT trip_updates WS, `window.masterArrivalsData` |
| `js/predictions.js` | Hybrid ETA engine: GTFS-RT → GPS-corrected schedule → fallback |
| `js/alerts.js` | REST-polled service alerts (every 120 s), `window.masterAlertsData` |
| `js/bikeshare.js` | Metro Bike Share GBFS fetch, SVG pie/dot markers, popups |
| `js/microzones.js` | Metro Micro zone GeoJSON fill+border, hover, popups |
| `js/ui.js` | Legend panel, route filtering, mobile sheet, search |
| `js/config.js` | Route colors, direction labels, API keys, constants |
| `js/utils.js` | `planarMeters`, `computeBearing`, `cleanStationName`, `escHtml` |

## Data Files

| File | Schema | Source |
|------|--------|--------|
| `data/rail-shapes.json` | `{ routeCode: [[lat, lng], ...] }` | `node scripts/build-shapes.js` (from GTFS shapes.txt) |
| `data/trips.json` | `{ tripId: { dest, rc, dir, total, stops[], scheduledTimes[], isLast? } }` | `node scripts/build-shapes.js` (from GTFS trips/stop_times) |
| `data/stops.json` | `{ stopId: { lat, lon, name } }` | `node scripts/build-shapes.js` (from GTFS stops.txt) |
| `data/metro-micro-zones.json` | GeoJSON FeatureCollection (8 zones) | Downloaded from [ArcGIS Hub](https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas) |

**Rebuild data after GTFS updates:**
```bash
# 1. Download GTFS from LA Metro: https://lacmta.github.io/GTFS_Documents/
# 2. Place rail GTFS in data/rail_gtfs/
# 3. Run the build script:
node scripts/build-shapes.js
```

## Live Data Feeds

### WebSocket Feeds

| Feed | URL | Updates |
|------|-----|---------|
| Rail vehicle positions | `wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions` | ~2–5s |
| G/J BRT vehicle positions | `wss://api.metro.net/ws/LACMTA/vehicle_positions/901,910` | ~2–5s |
| Rail trip updates | `wss://api.metro.net/ws/LACMTA_Rail/trip_updates` | ~5–10s |
| Bus trip updates | `wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950` | ~5–10s |

### REST APIs

| Service | URL | Update Interval |
|---------|-----|-----------------|
| Rail service alerts | `https://alerts.metro.net/api/rail/alerts` | every 120s |
| Bus service alerts | `https://alerts.metro.net/api/bus/alerts` | every 120s |
| Metro Bike Share (station info) | `https://gbfs.bcycle.com/bcycle_lametro/station_information.json` | once at startup |
| Metro Bike Share (availability) | `https://gbfs.bcycle.com/bcycle_lametro/station_status.json` | every 30s |

## Global State

| Variable | Set by | Used by |
|----------|--------|---------|
| `window.map` | `map.js` | any module needing map access |
| `window.masterStopsData` | `main.js` | markers, stations, predictions |
| `window.masterTripsData` | `main.js` | markers, stations, predictions |
| `window.masterArrivalsData` | `tripUpdates.js` | stations, predictions (Tier 1 ETA) |
| `window.vehicleMarkers` | `markers.js` | predictions, markers |
| `window.masterAlertsData` | `alerts.js` | stations (alert banners), ui (legend badges) |
| `window.masterBikeStations` | `bikeshare.js` | bikeshare (internal) |

## File Organization

```
/ (repo root)
├── index.html              → Main entry point (no build step)
├── js/
│   ├── main.js             → Initialization and WebSocket setup
│   ├── api.js              → WebSocket connection and message parsing
│   ├── map.js              → MapLibre initialization and controls
│   ├── markers.js          → Vehicle marker create/update/animate, heading, DR, spike rejection
│   ├── snap.js             → GPS-to-polyline snapping, tangent bearing, arc-progression
│   ├── stations.js         → Station dot rendering, arrival popups, vehicle highlighting
│   ├── tripUpdates.js      → GTFS-RT trip_updates WS, masterArrivalsData
│   ├── predictions.js      → Hybrid ETA: GTFS-RT → GPS-corrected schedule → fallback
│   ├── alerts.js           → GTFS-RT service alerts WS, masterAlertsData
│   ├── bikeshare.js        → Metro Bike Share GBFS, SVG pie/dot markers, popups
│   ├── microzones.js       → Metro Micro zone GeoJSON fill+border, hover, app-store popups
│   ├── ui.js               → Legend, route filtering, mobile sheet, search
│   ├── config.js           → Route colors, direction labels, API keys, tuning constants
│   └── utils.js            → planarMeters, computeBearing, cleanStationName, escHtml
├── styles/
│   └── index-style.css     → Responsive design, dark mode, animations
├── data/
│   ├── rail-shapes.json    → Route polylines (built from GTFS; raw source gitignored)
│   ├── trips.json          → Trip metadata (dest, direction, stop sequence, schedule)
│   └── stops.json          → Stop locations (lat/lon, name)
├── images/
│   └── metro_logo_only_black.png
├── scripts/
│   ├── build-shapes.js     → GTFS preprocessing (Node.js, run locally after GTFS update)
│   ├── analyze-eta.js      → Dev utility: analyze captured ETA data
│   ├── audit-feeds.js      → Dev utility: inspect live WS feed contents
│   ├── capture-eta.js      → Dev utility: record ETA stream for offline analysis
│   └── diag.js             → Dev utility: route/stop diagnostics
└── CNAME                   → GitHub Pages custom domain (metrolivemap.net)
```

## Development

No build step — native ES modules served directly. Local dev:

```bash
npx serve . --listen 3000
```

Open http://localhost:3000 and verify:
- Vehicle markers animate and snap to routes
- Click a station dot → popup shows live arrivals
- Click a vehicle → shows destination and next stop
- Search, filtering, dark mode all work
- Console shows `WebSocket opened` for both position feeds

## Deployment

Hosted on GitHub Pages. GitHub Pages serves from the root of `main`.

```bash
git push origin main
```

Custom domain `metrolivemap.net` is configured via `CNAME` at repo root.

## Troubleshooting

**No vehicles showing?** Check browser console for WebSocket errors. Both feeds must connect:
- `[api] WebSocket opened: ...` (vehicle positions)
- `[tripUpdates] Connected: ...` (trip updates)

**Arrivals stuck?** Station popups refresh every 5 seconds. If still stale, the GTFS-RT feed may have no data for that stop.

**Route snapping broken?** Verify `rail-shapes.json` loaded: check Network tab for 404, or console for `[snap] Loaded shapes...` message.

## Contributing with Claude Code

This project uses [Claude Code](https://claude.ai/claude-code) for AI-assisted development. **All workflow rules are documented in [CLAUDE.md](CLAUDE.md)** — read that first.

Key points:
- Claude always works on a feature branch + git worktree, never `main`
- Every change goes through a Pull Request for review
- Commits follow `feat:`, `fix:`, `polish:`, `refactor:` conventions
- Each commit covers one logical sub-task

## License

Powered by [LA Metro GTFS feeds](https://lacmta.github.io/GTFS_Documents/). Site design and real-time visualization © 2024–2026.

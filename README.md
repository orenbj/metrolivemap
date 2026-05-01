# Metro Live Map

Real-time map of LA Metro rail lines and busways at [metrolivemap.net](https://metrolivemap.net).

## Features

- **Live vehicle positions** — Trains and buses streamed via WebSocket
- **Station arrivals** — Next trains/buses per direction from GTFS-RT feed
- **Click interactions** — Vehicles show destination, next stop, and progress; stations show upcoming arrivals
- **Filtering & search** — Hide lines, search stations, toggle dark mode, auto-locate
- **Responsive** — Optimized for mobile and desktop

## Architecture

Pure client-side, no backend. Two LA Metro WebSocket feeds power the app:

```
vehicle_positions (trains + buses)
  → api.js                parse and normalize positions
  → markers.js            create/update/animate map markers, compute heading
  → snap.js               snap GPS to route polylines for smooth track-aligned display

trip_updates (arrival predictions)
  → tripUpdates.js        build masterArrivalsData: stopId → [{ routeId, directionId, vehicleId, arrivalUnix }]
  → stations.js           render station dots, populate arrival popups from native feed data
```

No calculations — the app shows raw GTFS-RT feed data. All processing is lightweight: position updates, heading computation, and route snapping.

## Data Files

Build static data from LA Metro's GTFS feeds:

| File | Source | Purpose |
|------|--------|---------|
| `livemap-main/data/rail-shapes.json` | `node build-shapes.js` | Rail + busway polylines for GPS snapping and route geometry |
| `livemap-main/data/trips.json` | `node build-shapes.js` | Trip metadata (stops, destination labels, last-train flags) |
| `livemap-main/data/stops.json` | Manual GTFS export | Stop coordinates and names |

**Rebuild data**: Download GTFS and bus shapefiles from LA Metro, place them in `data/rail_gtfs/` and `data/`, then run:
```bash
node build-shapes.js
```

## File Organization

```
livemap-main/
├── index.html              → Main entry point (no build step)
├── js/
│   ├── main.js             → Initialization and WebSocket setup
│   ├── api.js              → WebSocket connection and message parsing
│   ├── map.js              → MapLibre initialization and controls
│   ├── markers.js          → Vehicle marker creation, animation, heading
│   ├── snap.js             → GPS-to-polyline snapping, route geometry
│   ├── stations.js         → Station dots, arrival popups, search
│   ├── tripUpdates.js      → GTFS-RT feed parsing, arrival data aggregation
│   ├── ui.js               → Legend, filtering, mobile sheet interactions
│   ├── config.js           → Constants (routes, colors, viewport breakpoints)
│   └── utils.js            → Helpers (geolocation, distance, formatting)
├── styles/
│   └── index-style.css     → Responsive design, dark mode, animations
├── data/
│   ├── rail-shapes.json    → Route polylines
│   ├── trips.json          → Trip metadata
│   └── stops.json          → Stop locations
├── images/
│   └── metro_logo_only_black.png
└── CNAME                   → GitHub Pages custom domain (metrolivemap.net)
```

## Development

No build step — ES modules load directly from `livemap-main/js/main.js`. Local testing:

```bash
cd livemap-main
npx serve  # or python -m http.server 8000
```

Open http://localhost:3000 and test:
- Vehicle markers animate and snap to routes
- Click a station dot → popup shows live arrivals
- Click a vehicle → shows destination and next stop
- Search, filtering, dark mode all work
- Console should show connection status for both WebSocket feeds

## Deployment

Hosted on GitHub Pages. Push to `main` branch — CI auto-deploys `livemap-main/` folder.

```bash
git push origin main
```

Custom domain `metrolivemap.net` is configured via `livemap-main/CNAME`.

## Troubleshooting

**No vehicles showing?** Check browser console for WebSocket errors. Both feeds must connect:
- `[api] WebSocket opened: ...` (vehicle positions)
- `[tripUpdates] Connected: ...` (trip updates)

**Arrivals stuck?** Station popups refresh every 5 seconds. If still stale, the GTFS-RT feed may have no data for that stop.

**Route snapping broken?** Verify `rail-shapes.json` loaded: check Network tab for 404, or console for `[snap] Loaded shapes...` message.

## License

Powered by [LA Metro GTFS feeds](https://lacmta.github.io/GTFS_Documents/). Site design and real-time visualization © 2024–2026.

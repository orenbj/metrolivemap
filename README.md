# Metro Live Map

A real-time web map of Los Angeles Metro rail and bus rapid transit vehicles, built with [MapLibre GL JS](https://maplibre.org).

Live at **[metrolivemap.net](https://metrolivemap.net)**

---

## Features

- **Real-time vehicle positions** — WebSocket feed from the LA Metro GTFS-RT API, updates every ~15 s
- **GTFS shape snapping** — GPS coordinates projected onto pre-built rail geometry for smooth, track-aligned positions
- **Next-stop heading** — arrow direction is anchored to the bearing toward the vehicle's next stop, oriented by the polyline tangent at the snapped position; walks forward through the trip sequence when the next stop is too close (degenerate bearing)
- **GPS glitch suppression** — predict-then-validate filter: implausible positions are rejected against a velocity-derived tolerance circle; next-stop proximity used as secondary validator
- **Transfer station popups** — clicking a shared station (e.g. 7th St/Metro Center, North Hollywood, Willowbrook/Rosa Parks) shows a single merged arrivals popup aggregating all lines and directions
- **Hover tooltips** — on desktop (mouse) devices, hovering a vehicle marker or station dot previews the popup; click to pin it open
- **Line filtering** — click any row in the legend to toggle a route; keyboard accessible
- **Dark mode** — toggle via the map control button; persists through style reloads
- **Metro rail overlay** — ESRI TiledMapService showing official route polylines and station dots
- **Popup details** — click any vehicle: direction label, next stop, GTFS-RT status, timestamp, vehicle ID
- **Stale marker cleanup** — vehicles inactive for >3 min removed automatically
- **Animated movement** — smooth cubic-eased position + shortest-arc heading interpolation
- **Security** — Content Security Policy, SRI hashes on all pinned CDN assets, XSS-safe popup HTML

---

## Heading Logic

Direction is computed by `computeHeading()` in `js/markers.js` as a stateless calculation each frame — no lock-and-protect dance, no sticky history that can get stuck wrong.

### Rail routes (shape data available)
1. **Next-stop bearing** *(primary)* — bearing from the vehicle's current position to the next stop (`props.stopId → masterStopsData`). The polyline tangent at the snapped point has two orientations (forward / +180°); the one closer to the next-stop bearing is chosen. If the next stop is degenerate (<50 m away), the walk-forward algorithm scans ahead through the trip's stop sequence to find the first usable bearing.
2. **Final destination bearing** *(backup)* — same orient-tangent logic using the trip's last stop, for when all forward stops are degenerate.
3. **Arc-progression** *(fallback, no trip data)* — sign of cumulative arc-distance change over recent history (ring buffer of 5 entries; requires ≥30 m of movement to trigger).
4. **`direction_id` prior** *(fallback)* — maps to increasing/decreasing arc-index via precomputed `dir0IncreasesArc` per route.

When the vehicle is stationary (speed < 0.5 m/s or `STOPPED_AT` status) **or** within 150 m of the trip's final stop, the previous heading is held to prevent noise-driven jitter.

### Bus routes (G/J Line, no shape data)
Same signal stack, but the tangent step is skipped — next-stop bearing is used directly as the heading. Falls back to final destination bearing → vector-mean of recent displacements (ring buffer 5, ≥50 m) → `direction_id` cardinal → `position_bearing` (only trusted when speed > 1 m/s and not stopped) → previous heading.

**Terminus turnaround**: when `trip_id` changes for the same `vehicle_id` near the same location, the old marker is removed and a fresh one created — heading derives cleanly from the new trip's stop sequence.

---

## GPS Glitch Filter

Each position update runs a predict-then-validate check before moving the marker:

1. **Implausible speed gate** — implied speed > 50 m/s (~110 mph) flags a spike
2. **Predict-then-validate** — if a prior velocity exists, the expected next position is predicted; the new fix is rejected if it falls outside `max(GPS_NOISE_FLOOR, speed × elapsed × 1.5)` metres of the prediction
3. **Stop proximity rescue** — a flagged update is let through if the new position is within 5 km of the reported next stop (handles legitimate feed gaps)

On a rejected update the timestamp still advances and the popup refreshes, but the marker holds position.

---

## Tech Stack

| Tool | Purpose |
|---|---|
| [MapLibre GL JS 5.24.0](https://maplibre.org) | Interactive map rendering (pinned + SRI) |
| [CartoCDN Voyager / Dark-Matter](https://carto.com/basemaps/) | Base map tiles |
| [ESRI TiledMapService](https://tiles.arcgis.com) | Metro rail overlay (polylines + stations) |
| [LA Metro GTFS-RT API](https://api.metro.net) | Real-time vehicle + trip-update WebSocket feeds |
| Vanilla JS ES Modules | No build step required |

---

## Project Structure

```
livemap-main/           ← the deployable web root (GitHub Pages)
├── index.html          # App shell, legend UI, CSP meta, SRI-pinned scripts
├── styles/
│   └── index-style.css # All styles — dark mode, popups, legend, responsive
├── js/
│   ├── main.js         # Entry point — wires all modules
│   ├── config.js       # Route colors, direction labels, zoom/size constants
│   ├── api.js          # WebSocket handler, GTFS-RT normalisation, backoff reconnect
│   ├── map.js          # MapLibre init, controls, ESRI overlay, dark mode
│   ├── markers.js      # Vehicle lifecycle, animation, heading logic, glitch filter
│   ├── snap.js         # GTFS shape snapping (projects GPS onto rail geometry)
│   ├── stations.js     # Clickable station dots + arrivals popups; transfer-station merging
│   ├── tripUpdates.js  # GTFS-RT trip_updates WebSocket → masterArrivalsData per stop
│   ├── ui.js           # Legend, popup HTML (XSS-safe), update time, panel counts
│   ├── utils.js        # Shared utilities: geodesic bearing, IS_HOVER_DEVICE
│   ├── stops.json      # Stop lookup table — fetched async at startup (~950 KB)
│   ├── trips.json      # Trip lookup table — dest, stop sequence (used for heading + arrivals)
│   ├── rail-shapes.json# Pre-processed rail shape geometry — output of build-shapes.js
│   ├── metrolink.js    # ⚠️  Shelved — Metrolink polling module (not active)
│   └── gtfs-realtime.proto  # (reference only — not loaded at runtime)
├── worker/
│   └── metrolink-proxy.js  # ⚠️  Shelved — Cloudflare Worker CORS proxy for Metrolink
├── images/
│   └── metro_logo_only_black.png
├── lightbulb.svg
├── CNAME               # metrolivemap.net → GitHub Pages
└── README.md

/livemap/               ← repo root (not deployed)
├── build-shapes.js     # Node script: GTFS shapes.txt → js/rail-shapes.json
└── data/               # Raw GTFS source files (gitignored — large)
    ├── rail_gtfs/      # Rail GTFS (shapes + trips for 801–807)
    ├── shapes.txt      # Bus GTFS shapes (for 901/910 G+J lines)
    ├── trips.txt       # Bus GTFS trips
    └── *.zip           # Original GTFS archives
```

---

## Rebuilding Rail Shapes

Run when Metro updates its GTFS feed and you want updated geometry:

```bash
# From /livemap root:
node build-shapes.js
# → overwrites livemap-main/js/rail-shapes.json
```

Source files expected in `data/`:
- `data/rail_gtfs/trips.txt` + `data/rail_gtfs/shapes.txt` — rail GTFS (from `gtfs_rail.zip`)
- `data/trips.txt` + `data/shapes.txt` — full bus GTFS (from `gtfs_bus.zip`, needed for G/J lines)

---

## Shelved: Metrolink Integration

Metrolink polling is **disabled** but fully preserved for future activation.
See `js/metrolink.js` and `worker/metrolink-proxy.js`.

**To re-enable:**
1. Set `METROLINK_API_KEY` as a Cloudflare Worker secret: `wrangler secret put METROLINK_API_KEY`
2. Build a Metrolink stop lookup table (from Metrolink GTFS `stops.txt`) and merge into `stops.json`
3. Uncomment the import + call in `js/main.js`
4. Uncomment the Metrolink legend row in `index.html`
5. Test during weekday peak hours (trains only run on schedule)

Cloudflare Worker deployed at `https://metrolink-proxy.orenbj.workers.dev`.

---

## Running Locally

No build step needed — serve the `livemap-main/` folder with any static file server:

```bash
# Python (built-in)
python -m http.server 8080 --directory livemap-main

# Node (npx)
npx serve livemap-main --listen 3000
```

Then open `http://localhost:8080` (or `:3000`).

> **Note:** The app fetches `stops.json` (~950 KB) and `rail-shapes.json` on startup. Both are cached by the browser after the first load.

---

## Deployment

Hosted on **GitHub Pages** via the `CNAME` file pointing to `metrolivemap.net`.
Push to `main` → Pages deploys automatically.

---

## Direction Labels Reference

| Route | direction_id 0 | direction_id 1 |
|---|---|---|
| 801 A Line | Northbound | Southbound |
| 802 B Line | Eastbound | Westbound |
| 803 C Line | Westbound | Eastbound |
| 804 E Line | Eastbound | Westbound |
| 805 D Line | Eastbound | Westbound |
| 806 L Line | Northbound | Southbound |
| 807 K Line | Northbound | Southbound |
| 901 G Line | Eastbound | Westbound |
| 910 J Line | Northbound | Southbound |

---

## License

MIT

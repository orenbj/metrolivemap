# Metro Live Map

A real-time web map of Los Angeles Metro rail and bus rapid transit vehicles, built with [MapLibre GL JS](https://maplibre.org).

Live at **[metrolivemap.net](https://metrolivemap.net)**

---

## Features

- **Real-time vehicle positions** — WebSocket feed from the LA Metro GTFS-RT API, updates every ~15 s
- **GTFS shape snapping** — GPS coordinates projected onto pre-built rail geometry for smooth, track-aligned positions
- **Sticky direction-aware markers** — 270° locking rule: arrows follow track curves freely but can never flip 180°
- **GPS glitch suppression** — positions implying >160 km/h are rejected; next-stop proximity used as secondary validator
- **Line filtering** — click any row in the legend to toggle a route; keyboard accessible
- **Dark mode** — toggle via the map control button; persists through style reloads
- **Metro rail overlay** — ESRI TiledMapService showing official route polylines and station dots
- **Popup details** — click any vehicle: direction label, next stop, GTFS-RT status, timestamp, vehicle ID
- **Stale marker cleanup** — vehicles inactive for >3 min removed automatically
- **Animated movement** — smooth eased interpolation between position updates
- **Security** — Content Security Policy, SRI hashes on all pinned CDN assets, XSS-safe popup HTML

---

## Heading Logic

Direction is computed by `computeHeading()` in `js/markers.js` using a priority stack.

### Cold start (new marker, no history)
1. **Movement trajectory** — GPS displacement between frames; most reliable but zero on the first frame
2. **GTFS `direction_id`** — maps to a cardinal bearing via `routeDirectionLabels` in `config.js`; always available
3. **API `position.bearing`** — noisy; `0` and `360` treated as missing
4. **Stop approach bearing** — geodesic bearing toward the reported next stop

### Warm state (existing marker)
`alignToReference(snapBearing, existingHeading)` is called each update — picks whichever of `snapBearing` or `snapBearing+180` is closer to the locked heading, so the arrow drifts smoothly with curves but never flips.

**Recalibration**: if movement exceeds ~50 m and disagrees with the locked heading by >90°, the lock resets using the movement vector as the new reference. This corrects a wrong cold-start without allowing random jitter to break a good lock.

**Terminus turnaround**: when `trip_id` changes for the same `vehicle_id` near the same location, the old marker is removed and a fresh one created — direction lock starts over cleanly.

---

## GPS Glitch Filter

Each position update in `updateExistingMarker()` runs two checks before moving the marker:

1. **Speed gate** — `distance / max(elapsed, 30 s) > 0.0005 deg/s` (~160 km/h) flags a spike
2. **Stop proximity** — if flagged, checks that the new position is within ~5 km of the reported next stop; if not (or no stop data), the update is held

On a held update the timestamp still advances (so next frame's elapsed is correct) and the popup refreshes, but the marker stays put.

---

## Tech Stack

| Tool | Purpose |
|---|---|
| [MapLibre GL JS 5.24.0](https://maplibre.org) | Interactive map rendering (pinned + SRI) |
| [CartoCDN Voyager / Dark-Matter](https://carto.com/basemaps/) | Base map tiles |
| [ESRI TiledMapService](https://tiles.arcgis.com) | Metro rail overlay (polylines + stations) |
| [LA Metro GTFS-RT API](https://api.metro.net) | Real-time vehicle WebSocket feed |
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
│   ├── ui.js           # Legend, popup HTML (XSS-safe), update time, panel counts
│   ├── utils.js        # Shared geodesic bearing calculation
│   ├── stops.json      # Stop lookup table — fetched async at startup (~950 KB)
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
| 802 B Line | Southbound / Eastbound | Northbound / Westbound |
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

# Metro Live Map

A real-time web map of Los Angeles Metro rail and bus rapid transit vehicles, built with [MapLibre GL JS](https://maplibre.org).

Live at **[metrolivemap.net](https://metrolivemap.net)**

---

## Features

- **Real-time vehicle positions** — WebSocket feed from the LA Metro GTFS-RT API, updates every ~15s
- **Sticky direction-aware markers** — arrow icons use shape-snapped bearings; direction is locked once established and never flips until end-of-line
- **Line filtering** — click any line row in the legend to show/hide that route
- **Dark mode** — toggle via the map control button
- **Popup details** — click any vehicle to see next stop with proper GTFS-RT status (At / Arriving at / Next stop), data timestamp, and vehicle ID
- **Stale marker cleanup** — vehicles inactive for over 3 minutes are removed automatically
- **Animated marker movement** — smooth eased interpolation between position updates

## Heading Logic

Direction is determined by a priority stack on first appearance:
1. **Movement trajectory** (current − previous position) — most reliable
2. **API `position.bearing`** — noisy but correct quadrant, good for cold start
3. **Stop approach bearing** — toward the reported next stop

Once a direction is established it is **locked** via `alignToReference(snap, existingHeading)`. The arrow can rotate smoothly with track curves but never flips 180°. Lock resets only when the trip ends (new `trip_id` → new marker).

## Tech Stack

| Tool | Purpose |
|---|---|
| [MapLibre GL JS](https://maplibre.org) | Interactive map rendering |
| [LA Metro GTFS-RT API](https://api.metro.net) | Real-time vehicle WebSocket feed |
| Vanilla JS (ES Modules) | No build step required |

## Project Structure

```
livemap-main/
├── index.html              # App shell + legend UI
├── styles/
│   └── index-style.css     # All styles (dark mode, popups, legend, responsive)
├── js/
│   ├── main.js             # Entry point — wires all modules together
│   ├── config.js           # Route colors, icons, direction labels, constants
│   ├── api.js              # WebSocket handler + GTFS-RT data normalization
│   ├── map.js              # MapLibre init, controls, dark mode toggle
│   ├── markers.js          # Vehicle marker lifecycle, animation, heading logic
│   ├── snap.js             # GTFS shape snapping (projects GPS onto rail geometry)
│   ├── ui.js               # Legend, popup HTML, update time, panel counts
│   ├── stops.js            # Compiled stop lookup table (masterStopsData)
│   ├── metrolink.js        # ⚠️  Shelved — Metrolink polling module (not active)
│   └── rail-shapes.json    # Pre-processed rail shape geometry for snapping
├── worker/
│   └── metrolink-proxy.js  # ⚠️  Shelved — Cloudflare Worker CORS proxy for Metrolink
├── images/
│   └── metro_logo_only_black.png
├── lightbulb.svg
├── CNAME                   # metrolivemap.net → GitHub Pages
└── README.md
```

## Shelved: Metrolink Integration

Metrolink polling is **disabled** but fully preserved for future activation.
See `js/metrolink.js` and `worker/metrolink-proxy.js`.

**To re-enable:**
1. Build a Metrolink stop lookup table (from Metrolink GTFS `stops.txt`)
2. Uncomment the import + call in `js/main.js`
3. Uncomment the legend row in `index.html`
4. Test during weekday peak hours (trains only run on schedule)

Cloudflare Worker deployed at `https://metrolink-proxy.orenbj.workers.dev`.

## Running Locally

No build step needed — serve the `livemap-main/` folder with any static file server:

```bash
# Python (built-in)
python -m http.server 8080

# Node (npx)
npx serve .
```

Then open `http://localhost:8080`.

## Deployment

Hosted on **GitHub Pages** via the `CNAME` file pointing to `metrolivemap.net`.
Push to `main` — Pages deploys automatically.

## License

MIT

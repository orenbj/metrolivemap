# Metro Live Map

A real-time web map of Los Angeles Metro rail and bus rapid transit vehicles, built with [MapLibre GL JS](https://maplibre.org).

Live at **[metrolivemap.net](https://metrolivemap.net)**

---

## Features

- **Real-time vehicle positions** — refreshes every 15 seconds via the Metro GTFS-RT API
- **Direction-aware markers** — arrow icons rotate using shape-snapped bearing, GTFS `direction_id` canonicals, and GPS trajectory fallback
- **Line filtering** — click any line row in the legend to show/hide that route
- **Dark mode** — toggle via the map control button
- **Popup details** — click any vehicle to see next stop, data timestamp, and vehicle ID
- **Stale marker cleanup** — vehicles inactive for over 90 seconds are removed automatically

## Tech Stack

| Tool | Purpose |
|---|---|
| [MapLibre GL JS](https://maplibre.org) | Interactive map rendering |
| [LA Metro GTFS-RT API](https://api.metro.net) | Real-time vehicle feed |
| [Open Sans](https://fonts.google.com/specimen/Open+Sans) | Typography |
| Vanilla JS (ES Modules) | No build step required |

## Project Structure

```
livemap-main/
├── index.html              # App shell + legend UI
├── styles/
│   └── index-style.css     # All styles (dark mode, popups, legend, responsive)
├── js/
│   ├── main.js             # Entry point
│   ├── config.js           # Route colors, icons, direction labels, constants
│   ├── api.js              # GTFS-RT polling + data normalization
│   ├── map.js              # MapLibre init, controls, dark mode
│   ├── markers.js          # Vehicle marker lifecycle, animation, heading logic
│   ├── snap.js             # Shape-snapping (geometry projection onto rail lines)
│   ├── ui.js               # Legend, popup HTML, update time, panel counts
│   ├── stops.js            # Compiled stop lookup table (masterStopsData)
│   └── rail-shapes.json    # Pre-processed rail shape geometry for snapping
├── images/
│   └── metro_logo_only_black.png
├── lightbulb.svg
├── CNAME                   # metrolivemap.net → GitHub Pages
└── README.md
```

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

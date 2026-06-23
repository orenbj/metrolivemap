# Third-Party Notices & Attribution

Metro Live Map (the "Project") is released under the [MIT License](LICENSE).
This file documents the third-party data sources, map tiles, libraries, and
fonts the Project uses, and the attribution each one requires. It is the
companion to `LICENSE` (which covers only the Project's own source code).

> **Where the required credit is shown in the running app:** the map renders a
> compact MapLibre **AttributionControl** (bottom-right ⓘ) that displays the
> OpenStreetMap, CARTO, Esri, and LA Metro credits collected from each tile
> source. This control is legally load-bearing — see `js/map.js`
> (`AttributionControl`). Do not remove it.

---

## Project origin

Metro Live Map began as a fork of **[`LACMTA/realtime-map`](https://github.com/LACMTA/realtime-map)**
— LA Metro's MIT-licensed "simple real-time map of Metro rail vehicles using
maplibre.gl" — and has been extended substantially since (multi-modal vehicles,
station arrivals, service alerts, accessibility, and CI/observability). Per the
upstream MIT license, that copyright and permission notice are retained in
[`LICENSE`](LICENSE). This Project is likewise MIT-licensed.

---

## Live data feeds

| Source | Used for | Terms / attribution |
|--------|----------|---------------------|
| **LA Metro GTFS (static)** | Routes, stops, trips, scheduled times (`data/*.json`, built by `scripts/build-shapes.cjs`) | LA Metro Developer License / Terms of Use — see <https://developer.metro.net/> and <https://lacmta.github.io/GTFS_Documents/>. Credit: "Powered by LA Metro GTFS feeds." |
| **LA Metro GTFS-Realtime** (`wss://api.metro.net/...`) | Live vehicle positions, trip updates, service alerts | LA Metro Developer License / Terms of Use (same as above). |
| **Metro Bike Share GBFS** (`gbfs.bcycle.com/bcycle_lametro`) | Bike-share station availability | GBFS feed published by LA Metro / BCycle. Per the [GBFS license](https://github.com/MobilityData/gbfs) and the feed's `license_url`. |

> **Action for LA Metro:** confirm the Project's use of the GTFS / GTFS-RT feeds
> satisfies LA Metro's current developer terms of use, and that the
> "Powered by LA Metro" credit wording is acceptable.

## Basemap tiles

| Source | Used for | Required attribution |
|--------|----------|----------------------|
| **OpenStreetMap** | Underlying data for the CARTO vector basemaps | **ODbL 1.0** — requires the visible credit "© OpenStreetMap contributors." <https://www.openstreetmap.org/copyright> |
| **CARTO** (`basemaps.cartocdn.com` — Voyager / Dark Matter) | Default + dark-mode vector basemap | CARTO basemap attribution — requires visible "© CARTO." <https://carto.com/attributions> |
| **Esri ArcGIS** (`tiles.arcgis.com` — bounded RGB vector-offset raster) | The Metro-styled basemap overlay within the LA service area | Esri / ArcGIS terms — credit "© LA Metro, Esri" (set on the raster source in `js/map.js`). |

All basemaps are reached via **keyless** tile URLs; the Project ships no API
key. (If a keyed tile service is ever added, its key would be client-visible and
must be restricted by referrer in that provider's dashboard.)

## Libraries (vendored, self-hosted)

| Library | Version | License |
|---------|---------|---------|
| **MapLibre GL JS** (`vendor/maplibre-gl/`) | 5.24.0 (pinned) | BSD-3-Clause — full text in `vendor/maplibre-gl/LICENSE.txt` |

MapLibre is vendored into the repo and served same-origin (#245) — refresh via
`scripts/vendor-maplibre.sh`. BSD-3-Clause requires the license be redistributed
alongside the binary, which `vendor/maplibre-gl/LICENSE.txt` satisfies.

The Project itself is a no-build static site; it bundles no other runtime
dependencies. Dev-only tooling (`vitest`, `jsdom`, `playwright`) is listed in
`package.json` and is not shipped to users.

## Fonts

| Source | Used for | License |
|--------|----------|---------|
| **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) | Open Sans typeface | SIL Open Font License / Apache 2.0. |

---

_Last reviewed: 2026-06-17 (handoff doc refresh; attributions re-verified — MapLibre vendored same-origin, basemaps keyless, no new runtime deps). If a data source, tile
provider, library, or font is added or changed, update this file and verify the
in-app AttributionControl still shows every required credit._

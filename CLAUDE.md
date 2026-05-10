# Metro Live Map — Developer Workflow

## Git Workflow Rules

These rules apply to **every Claude Code session**. They enforce safe, reviewable development.

1. **Never commit directly to `main`.** Always work on a feature branch. Claude Code creates a git worktree + branch automatically — use it.
2. **Commit after each logical sub-task** using the format `feat:`, `fix:`, `polish:`, or `refactor:` followed by a short description.
3. **Check `.gitignore` before staging.** Never track `.env`, `scripts/*.jsonl`, `*.log`, or GTFS `.txt` files.
4. **Scope control.** Only modify files directly relevant to the current task. If a change in another file is needed, flag it to the user before editing.
5. **All merges go through a Pull Request.** The user reviews each changed file in GitHub Desktop before approving. Do not ask to bypass this.
6. **No force pushes.** Never run `git push --force` or `git reset --hard` without explicit user approval.

---

## Key Constraints

- **No build step** — all imports are relative ES module paths. CDN libs loaded via `<script>` tags in `index.html`.
- **Always edit files in the active worktree**, not directly in the main branch if a worktree is open.
- **data/ files** — Built JSON files (rail-shapes.json, stops.json, trips.json, bus-routes.json, metro-micro-zones.json) are committed; raw GTFS source files (*.txt, *.zip) are gitignored.
- **GitHub Pages deployment** — serves from repo root. `index.html` must be at root. Push to `main` auto-deploys. Custom domain `livemap.metro.net` in CNAME is pending DNS.
- **API keys** in `config.js` are client-visible; restrict via referrer policies in ESRI/MapTiler dashboards.
- **Tests** — `npm test` runs the Vitest suite (15 test files, 243 tests covering predictions, snap, heading, spike rejection, DR animation, marker lifecycle, calibration, adherence, boarding merging, trip updates, the WS API, alerts ingestion, bus-bridge detection, and pure utility math). Run after any change to ETA, snapping, or marker logic.

---

## Cross-Module Globals (`window.*`)

The app deliberately exposes shared state on `window` instead of routing every read through explicit imports. This is a conscious choice for a no-build SPA — it keeps modules small and avoids circular-import gymnastics. Treat these as the public API surface between modules; **do not refactor them away without a plan.**

| Global                          | Owner module           | Shape                              |
|---------------------------------|------------------------|------------------------------------|
| `window.map`                    | map.js                 | MapLibre map instance              |
| `window.masterStopsData`        | main.js (loads)        | Object<stopId, {lat,lon,name,…}>   |
| `window.masterTripsData`        | main.js (loads)        | Object<tripId, {…}>                |
| `window.masterBusRoutes`        | main.js (loads)        | Object<routeId, {…}>               |
| `window.masterArrivalsData`     | tripUpdates.js         | Map<stopId, Arrival[]>             |
| `window.masterAlertsData`       | alerts.js              | Map<routeCode, Alert[]>            |
| `window.masterStopAlertsData`   | alerts.js              | Map<stopId, Alert[]>               |
| `window.masterBikeStations`     | bikeshare.js           | Map<stationId, {…}>                |
| `window.vehicleMarkers`         | markers.js             | Object<tripId, MapLibre marker>    |
| `window.stationGroups`          | stations.js            | Array<MergedGroup>                 |

---

## Helpful References

- **Architecture & modules** — see README.md
- **Live feeds & data sources** — see README.md
- **Stack & tech** — see README.md

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
- **Tests** — `npm test` runs the Vitest suite (~65 files, ~1245 tests covering predictions, snap, heading, spike rejection, marker lifecycle, calibration, adherence, boarding merging, trip updates, the WS API, alerts ingestion + normalization, bus-bridge detection, build-shapes logic, freshness tiers, pure utility math, and the Phase 5b blend-anchored animation pipeline). Run after any change to ETA, snapping, or marker logic.
- **Animation model** — `js/renderLoop.js` runs a single rAF that reads each tripId's entry from `js/animationStore.js` (a `Map<tripId, AnimationEntry>` singleton populated by `js/animationWiring.js` on every WS fix). Each entry's `trajectory` is back-computed by `js/animationBuilder.js` from the GTFS-RT-derived blend ETA at the vehicle's next stop, so the marker's animation arrival time equals the popup ETA by construction. Vehicle motion is intentionally **not** gated by `prefers-reduced-motion` — it is functional (mirrors real-world movement), not decorative animation. Full design in [`docs/phase-5b-anchor-animation.md`](docs/phase-5b-anchor-animation.md).
- **Stopped-vehicle handling** — when GPS reports `speed=0` with a fresh timestamp (within `GPS_STOPPED_FRESHNESS_S = 60 s`), `animationBuilder` emits a dwell at the current arc instead of back-computing cruise. This honors the vehicle's self-report (red-light / dwell / layover) over blend's prediction. Stale `speed=0` reports (likely GPS dropout in tunnels) revert to blend-anchored motion so the marker keeps moving through tunnels.
- **Vehicle freshness tiers** — `getFreshnessTier(marker, nowSec)` in `js/freshness.js` (shared by `markers.js` and `ui.js`) is the single source of truth for per-vehicle VISUAL state. Four tiers map to (marker opacity, popup-dot color):
  - `live`    (age < 30 s)  → 1.0  / green
  - `aging`   (age < 90 s)  → 1.0  / green (no rider-visible color change — see PR #141; Metro's normal 15–35 s broadcast lag would otherwise flip the dot amber on healthy feeds)
  - `stale`   (age < 300 s) → 0.5  / gray
  - `expired` (age ≥ 300 s) → fade-out & remove
  Constants: `FRESH_LIVE_S`, `FRESH_AGING_S`, `FRESH_EXPIRE_S`, `FRESH_CHECK_INTERVAL_MS`. Decoupled from `SPIKE_BYPASS_S` (120 s, spike-rejection), `DR_MAX_SECONDS` (motion watchdog), and `VEHICLE_MARKER_TTL_S` (180 s, ETA filter) — those are algorithmic gates, not visual. The `aging` tier still exists in the data model; only its color rendering was collapsed into `live`.
- **Translation** — page source is English; the app declares `<html lang="en">` and relies on each browser's built-in translate feature (Chrome / Edge / Safari built-in, iOS Safari AA menu, Android Chrome menu). A globe button in the left control group (`map.js` `CustomControls.translateBtn`, sits under the dark-mode toggle) makes the affordance discoverable: it can't *programmatically* trigger the native flow (there's no JS API), but its click handler sniffs `navigator.userAgent` and surfaces a toast with the exact gesture for that platform. The previous in-app en/es dictionary (`js/i18n.js`, `i18n/{en,es}.json`) was retired because (1) it only covered two languages, (2) it couldn't translate the LACMTA alerts feed (English-only with no `translations` field), and (3) browser-native translation handles ~100 languages AND translates alert prose alongside the rest of the page. Alert bodies are still wrapped `<p lang="en">` so screen readers and browser translators identify the source language explicitly; that wrapper is the only translation-related code remaining.

---

## Cross-Module Globals (`window.*`)

The app deliberately exposes shared state on `window` instead of routing every read through explicit imports. This is a conscious choice for a no-build SPA — it keeps modules small and avoids circular-import gymnastics. Treat these as the public API surface between modules; **do not refactor them away without a plan.**

| Global                                       | Owner module           | Shape                                  |
|----------------------------------------------|------------------------|----------------------------------------|
| `window.map`                                 | map.js                 | MapLibre map instance                  |
| `window.masterStopsData`                     | main.js (loads)        | Object<stopId, {lat,lon,name,…}>       |
| `window.masterTripsData`                     | main.js (loads)        | Object<tripId, {…}>                    |
| `window.masterBusRoutes`                     | main.js (loads)        | Object<routeId, {…}>                   |
| `window.masterArrivalsData`                  | tripUpdates.js         | Map<stopId, Arrival[]>                 |
| `window.masterAlertsData`                    | alerts.js              | Map<routeCode, Alert[]>                |
| `window.masterStopAlertsData`                | alerts.js              | Map<stopId, Alert[]>                   |
| `window.masterStopAccessibilityAlertsData`   | alerts.js              | Map<stopId, AccessibilityAlert[]>      |
| `window.masterBikeStations`                  | bikeshare.js           | Map<stationId, {…}>                    |
| `window.vehicleMarkers`                      | markers.js             | Object<tripId, MapLibre marker>        |
| `window.stationGroups`                       | stations.js            | Array<MergedGroup>                     |

`tripTerminusByTripId` used to live on `window` too; PR #151 removed the
mirror — production consumers (`stations.js`, `predictions.js`) now import
the named binding from `tripUpdates.js` directly. The single-access-path
invariant prevents future writers from leaving one site reading stale state.

**Debug-only hooks** (not part of the contract — present for console inspection, fine to omit when refactoring):
- `window.getCalibrationSnapshot()` and `window.getCalibrationRejectStats()` — exposed by `scheduleCalibration.js` for diagnosing per-route calibration state
- `window.__visRegistrySize` — exposed by `utils.js` for inspecting the `setVisibleInterval` registry size

### Cross-module callbacks (`window.__`)

In addition to the data globals above, `stations.js` exposes three function hooks on `window` so other modules can drive station-popup behavior **without importing `stations.js`** (which would create an init-order cycle through `main.js`). All three are set once at module load:

| Hook                                | Set by      | Called by      | Purpose                                                          |
|-------------------------------------|-------------|----------------|------------------------------------------------------------------|
| `window.__openStationByGroup`       | stations.js | bikeshare.js   | Open the station arrivals popup for a merged stop group          |
| `window.__hoverStationByGroup`      | stations.js | bikeshare.js   | Soft-preview hover (no pin) used when the user hovers a bike pin |
| `window.__closeStationIfUnpinned`   | stations.js | bikeshare.js   | Dismiss an unpinned hover-preview when the user leaves the pin   |

These are intentional inversion-of-control hooks — keep the `__` prefix and the optional-chained `?.()` call pattern so they fail silently if `stations.js` hasn't initialized yet.

---

## Helpful References

- **Architecture & modules** — see README.md
- **Live feeds & data sources** — see README.md
- **Stack & tech** — see README.md

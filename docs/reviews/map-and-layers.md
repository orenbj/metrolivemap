# Review: Map, Layers, Bootstrap

Reviewer: automated review batch 2026-05-06
Scope: js/map.js, js/main.js, js/bikeshare.js, js/microzones.js

## Summary
Bootstrap order in `main.js` is sound: UI is initialised synchronously, the map is created up-front so tile loading begins immediately, and static data files load in parallel while WebSocket setup waits on the parsed stops/trips/bus-routes. Map setup, control wiring, and the bikeshare/microzones layers are well-structured with explicit caching, viewport culling, and dot/pie SVG mode flips coalesced via rAF. A few small dead-code and documentation issues were fixed inline; the remaining notes are mostly low-severity defensive-coding and ordering observations.

## Findings — Bugs (highest priority)
- [LOW] Dark-mode handler in `microzones.js` runs `setPaintProperty` for layers that may have just been recreated by `reAddMicroZonesLayer` — js/microzones.js:245-250 — Both `main.js` and `map.js` register `toggleDarkMode` listeners that fire `style.load` callbacks, plus `microzones.js` itself binds an outer `toggleDarkMode` listener that immediately calls `setPaintProperty(FILL_LAYER, ...)`. After `setStyle()` the layers are gone until `style.load`; that outer call fires before the style swap completes and will throw "There is no layer with this ID" if MapLibre is mid-swap. In practice it is currently swallowed silently because the toggle handler in `map.js` triggers setStyle synchronously after the event dispatches — but ordering is fragile.
  - Recommendation: Guard with `map.getLayer(FILL_LAYER)` before each `setPaintProperty` call, or move the dark-mode listener inside `_addLayers` so it is re-bound per style.
  - Status: Recommended

- [LOW] `geojson.features.forEach((f, i) => { f.id = i; })` overwrites any pre-existing GeoJSON `id` — js/microzones.js:67 — If the upstream Hub data ships with stable string IDs, hover/feature-state would otherwise survive data updates. Not currently an issue (Hub GeoJSON has no IDs) but reassignment is destructive.
  - Recommendation: `f.id ??= i;`
  - Status: Recommended

- [LOW] `reAddMicroZonesLayer` calls `initMicroZones` without awaiting; rapid double-toggle of dark mode could race the second call before the first finishes — js/microzones.js:79-84 — `_addLayers` is guarded by `if (map.getSource(SOURCE_ID)) return;` so the second call is a no-op, but the cached path is fine. Worth noting but not actionable today.
  - Recommendation: None unless rapid toggle becomes a use case.
  - Status: Recommended

## Findings — Math / Statistics
- [INFO] Vehicle size linear interpolation between `VEHICLE_ZOOM_MIN`/`VEHICLE_ZOOM_MAX` and clamped at both ends is correct — js/map.js:214-227 — No off-by-one.
- [INFO] Viewport breakpoint logic (`<=768 → zoom 8, <=1280 → 9, else 10`) is a clean two-step ladder — js/map.js:22-24 — Boundary at exactly 768/1280 maps to the lower bucket, which is the conservative choice.

## Findings — Code Quality
- [LOW] Unused import `loadShapes` in `js/map.js` — js/map.js:2 — Imported but never referenced (only used in `main.js`).
  - Recommendation: Remove.
  - Status: Fixed inline

- [LOW] Dead `labelLayerId` discovery in `addCustomLayers` — js/map.js:166-173 — Loop computes `labelLayerId` but never uses it (the only added layer is `imagery-layer`, added without a `beforeId`).
  - Recommendation: Remove the loop, or pass `labelLayerId` to `map.addLayer` if the rail overlay is meant to sit beneath label glyphs.
  - Status: Fixed inline (loop removed; behavior unchanged because the value was never consumed)

- [LOW] Optional chain on a guaranteed-defined parameter — js/microzones.js:236 — `map?.getLayer(...)` inside the legend-row click handler; `map` is the closure parameter and is always non-null when this fires.
  - Recommendation: Drop the `?.`.
  - Status: Fixed inline

- [LOW] `reAddMicroZonesLayer` comment claims "Re-fetch and re-add" but the implementation reuses `_geojsonCache` — js/microzones.js:80-83 — Mildly misleading.
  - Recommendation: Update comment.
  - Status: Fixed inline

- [INFO] `isStyleChanging` flag in `map.js:199-212` correctly debounces back-to-back dark-mode toggles. Good defensive code.

- [INFO] `_buildAllMarkers` precomputes `nearGroup` per station instead of per-event scan — js/bikeshare.js:223-224 — Documented optimisation, well-commented.

## Findings — Performance
- [LOW] WebSocket connections are gated behind the static-data Promise — js/main.js:34-46 — `setupWebSocket(...)` does not start until `stops.json`/`trips.json`/`bus-routes.json` are parsed. The vehicle feed could open earlier and queue the first frames in memory until predictions are ready.
  - Recommendation: Open the WS sockets immediately after `initMap()`, buffer messages until predictions/stations init, then drain.
  - Status: Recommended

- [INFO] Bikeshare zoom listener correctly coalesces via `requestAnimationFrame` (js/bikeshare.js:70-76); `moveend` uses no debounce because it only fires on settle. Good rAF discipline.

- [INFO] `map.remove()` is never called in this app — there is no SPA route teardown — so there is no listener-cleanup leak path. Document this so future refactors don't assume cleanup exists.

- [LOW] `setVisibleInterval` in `bikeshare.js:82-88` re-issues GBFS fetch on every visibility transition. The `_visible` short-circuit keeps it cheap when toggled off, but if the tab background-foregrounds repeatedly during a single 30 s window, multiple fetches can fire.
  - Recommendation: Track `lastFetchAt` and skip if <5 s since last refresh.
  - Status: Recommended

## Findings — Security / Privacy
- [INFO] No client secrets visible in the four reviewed files. ESRI tile URL (`tiles.arcgis.com/.../Map_RGB_Vector_Offset_RC5/MapServer`) is a public service — js/map.js:178-180 — and the Carto and GBFS URLs are public, no API key required.
- [INFO] `config.js` API keys (out-of-scope) are intentionally client-visible per CLAUDE.md; no further keys leak through these modules.
- [INFO] `getUserLocation` uses `enableHighAccuracy: true` with a 60 s `maximumAge`. No PII leaves the client — js/map.js:240-251 — only used to drive `flyTo`.
- [INFO] App-store links in microzones popup are hardcoded `apps.apple.com` / `play.google.com` URLs and use `target="_blank" rel="noopener"`. Good.

## Findings — Documentation / JSDoc
- [LOW] `main.js` has a top-of-file module JSDoc but no inline comment explaining *why* the bootstrap order is what it is (UI before map render, map render before data parse, data parse before WS open).
  - Recommendation: One-line comment above each phase.
  - Status: Recommended

- [LOW] `addCustomLayers` has no JSDoc — js/map.js:165 — and its purpose (adding the ESRI rail overlay) is only obvious from the inline comment.
  - Recommendation: Add a one-line `@returns {void}` JSDoc noting it is re-entrant after `style.load`.
  - Status: Recommended

- [INFO] `bikeshare.js` and `microzones.js` are well-commented around the rAF coalescing and viewport buffer rationale.

## Suggestions (non-defect improvements)
- [LOW] Move all the inline `<style>`-equivalent string templates in `bikeshare.js:_buildPopupHTML` and `microzones.js` click handler into CSS classes; the dark/light branches are easier to maintain via class swap than via per-property string interpolation.
- [LOW] `bikeshare.js:_makeMarkerEl` walks `window.stationGroups` once per marker via `Array.find`. With ~500 stations × ~120 station groups that's 60k distance computations on init. Acceptable today; if station counts grow, build a spatial index (k-d tree or simple grid) once at module load.
- [LOW] `VIEWPORT_BREAKPOINT_MOBILE`/`_TABLET` and the resulting zoom levels are imported from config but the *zoom* values (8/9/10) are inline literals in `map.js:23`. Lift to config so all viewport tuning lives in one place.

## Findings out-of-lane (for other units)
- Unit (api/predictions): `initVisibilityHandler` is registered after the static-data Promise resolves (js/main.js:45). If the user backgrounds the tab during the ~3.8 MB trips.json fetch, the visibility handler is not active to suppress the WS buffer growth. Low impact.
- Unit (markers): No tests cover `js/markers.js` for memory cleanup of removed-vehicle marker DOM elements; worth confirming that `initMarkerCleanup` flushes element listeners and not just the `Map` entry.
- Unit (snap): `loadShapes()` is invoked from `main.js` and silently fails per its own try/catch; downstream snap-disabled behaviour is undocumented in this scope.

## Inline fixes applied in this PR
- map.js: remove unused `loadShapes` import and dead `labelLayerId` discovery loop.
- microzones.js: drop redundant optional chain on closure `map` reference.
- microzones.js: clarify `reAddMicroZonesLayer` comment to reflect cached-GeoJSON behaviour.

## Test impact
- npm test: 12 files, 173 passed before; 12 files, 173 passed after.
- New/changed tests: none — these modules have no Vitest coverage today (they rely on MapLibre/DOM and are exercised by the in-browser smoke flow only). Note: prompt mentions "174 tests" but the repository currently reports 173.

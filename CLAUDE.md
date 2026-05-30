# Metro Live Map — Developer Workflow

## Git Workflow Rules

These rules apply to **every Claude Code session**. They enforce safe, reviewable development.

1. **Never commit directly to `main`.** Always work on a feature branch. Claude Code creates a git worktree + branch automatically — use it.
2. **Commit after each logical sub-task** using the format `feat:`, `fix:`, `polish:`, or `refactor:` followed by a short description.
3. **Check `.gitignore` before staging.** Never track `.env`, `scripts/*.jsonl`, `*.log`, or GTFS `.txt` files.
4. **Scope control.** Only modify files directly relevant to the current task. If a change in another file is needed, flag it to the user before editing.
5. **All merges go through a Pull Request.** The user reviews each changed file in GitHub Desktop before approving. Do not ask to bypass this.
6. **No force pushes.** Never run `git push --force` or `git reset --hard` without explicit user approval.

> Recent history is in the git log; engineering-snapshot and launch context live in
> [`docs/STATUS.md`](docs/STATUS.md) and [`docs/LAUNCH-READINESS.md`](docs/LAUNCH-READINESS.md).
> This file is the **durable contract** — invariants, guardrails, and where things live.

---

## Key Constraints

### Build, data & deploy

- **No build step** — all imports are relative ES module paths. CDN libs loaded via `<script>` tags in `index.html`.
- **Always edit files in the active worktree**, not directly in the main branch if a worktree is open.
- **data/ files** — Built JSON (rail-shapes.json, stops.json, trips.json, bus-routes.json, metro-micro-zones.json) is committed; raw GTFS source files (`*.txt`, `*.zip`) are gitignored. Rebuild with `node scripts/build-shapes.cjs`.
- **GitHub Pages deployment** — serves from repo root, so `index.html` must be at root. Push to `main` auto-deploys (~60 s). The repo is **private** and the `livemap.metro.net` CNAME is pending DNS, so there is no public production site; the working deploy is the **password-protected** Bluehost mirror at `orenbj.com/livemap`.
- **API keys** in `config.js` are client-visible; restrict via referrer policies in the ESRI/MapTiler dashboards.
- **Tests** — `npm test` runs the Vitest suite (~28 files, ~605 tests). Run after any change to ETA, snapping, or marker logic. `tests/setup.js` installs an in-memory `localStorage` shim — Node 25+ has a broken built-in `globalThis.localStorage` accessor that collides with jsdom.

### Motion model — bounded arc-glide (PR #257)

- **Rail** (route with shape data): on every WS frame, `arcGlide(markerKey, fromArc, toArc, ...)` in `markers.js` glides the marker ALONG the polyline arc from its previous snapped position to the new snapped position. **Glide duration tracks the real inter-fix gap** (`(newTs - prevTs)*1000`, floored at `GLIDE_MIN_MS`, capped at `GLIDE_MAX_MS` = 60 s) so on-screen speed ≈ the vehicle's real average speed. A fixed duration caused the "zoom across the line" bug. (`GLIDE_MAX_MS` was 30 s; raised to 60 s because Metro's position cadence is often >30 s, so most updates teleported even for short moves — gap-matched duration means longer glides lag but never zoom.)
- **Re-anchor (teleport, no glide)** when the move can't be shown as plausible motion: straight-line jump > 5 km, stale reference (gap > `SPIKE_BYPASS_S`), gap > `GLIDE_MAX_MS`, or an implied speed > `RAIL_MAX_SPEED_MPS × 1.5` (rail) / `MAX_PLAUSIBLE_SPEED_MPS` (bus). **The implied speed is measured from the REAL inter-fix move (previous *snap* → new snap; previous *target* → new target for buses), NOT from the marker's current visual position.** The visual position lags while a glide is in flight, so measuring from it falsely teleported on quick refreshes (a fix arriving before the prior glide finished) — the delta was inflated by the un-traversed glide remainder. The glide still *starts* from the visual position (`_currentArc`) for a smooth handoff. A catch-up from a lagging position is **rate-limited by DISTANCE** (each cycle travels at most `re-anchor-speed × gap` toward the snap, **gap-matched duration**) so it closes the lag at a steady bounded speed. Do NOT instead stretch the glide *duration* to cap speed — `arcGlide` eases in cubically, so a long glide interrupted early by the next fix barely advances and the marker **crawls/sticks** (the bug that fix introduced and this replaced).
- **Rotation** is a lerp from `startHeading` (prior `marker.properties.Heading`) to `targetHeading` (this frame's `computeHeading()` result, already disambiguated against the next-station bearing).
- **Buses** (no shape data) use `animateMarker` straight-line lat/lng glide at the same gap-matched duration; re-anchor when implied straight-line speed exceeds `MAX_PLAUSIBLE_SPEED_MPS`.
- **Cold start** spawns the marker at its snapped GPS position with no glide. When a new WS frame arrives mid-glide, the in-flight glide is cancelled and a fresh one starts from the marker's current visual position via `_currentArc` (smooth handoff).
- **Critical invariant:** the marker is bound between two known GPS positions — it **NEVER moves past the latest GPS fix**, cannot extrapolate, cannot overshoot, cannot disagree with the popup label.
- **Vehicle motion is NOT gated by `prefers-reduced-motion`** (PR #267). It conveys real-world movement (WCAG-2.3.3-exempt "essential motion"). Gating it turned every vehicle into a teleport for OS-level Reduce-Motion users — do not re-add the gate. Decorative transitions (map `flyTo`, popup fades) may still honor reduced-motion.
- **DR is gone — do NOT bring it back.** DR and every extrapolation-compensating mitigation (declared-stop clamp, STOPPED_AT misfire detection, `stopIdLag` counter, `_effectiveNextStopId` override, station-popup past-target guard) were removed in PR #257. Do NOT re-introduce a `speedFactor`, a `_drCurrentArc`, or any code that projects the marker past its last GPS fix.
- **Trade-off accepted:** B/D tunnel markers freeze 3–5 min during tunnel transit (no GPS underground). If rider feedback makes this a real problem, the documented follow-up is a narrow heavy-rail-only schedule-speed fallback (`route_code ∈ {802, 805}` + `speed === 0` + `secs_since_last_fix > 30`), bounded by the next physical station so it never projects past a stop.
- **Spike re-anchor escape hatch (`SPIKE_REANCHOR_STREAK` = 3, PR #283)** — a tunnel-emergence fix lands far ahead of the frozen last-surface snap, so `isGpsSpike` rejects it as an arc/speed spike. Each rejection bumps `marker.timestamp = newTs`, so `isStaleRef` (measured from it) never trips the `SPIKE_BYPASS_S` bypass while the feed keeps sending → the marker stayed frozen until a page refresh (a fresh marker skips the spike check) — the "B Line vehicle jumps forward on refresh" report. Fix: `updateExistingMarker` counts consecutive rejections on `marker._consecutiveSpikes`; after `SPIKE_REANCHOR_STREAK` in a row it force-accepts the next fix (re-anchor) and resets the streak. A one-off spike never reaches the threshold (any accepted fix resets it), so genuine spike rejection is preserved; only a *sustained* "spike" (= the new reality) re-anchors. Bounds the stuck window to ~streak × feed-cadence instead of "until refresh."

### Feed-data correctness (silent gates — the only difference is the absence of wrong data)

- **Reject future timestamps** — `js/api.js` `processAndUpdate` drops frames timestamped more than `FUTURE_TS_GRACE_MS` (5 s) in the future. A future ts passes `Number.isFinite()` and collapses every downstream `now - ts` age check to 0 (= "fresh"). Tracked via the `futureTs` drop counter.
- **CANCELED trips / SKIPPED stops** — `js/tripUpdates.js` early-returns when `trip.scheduleRelationship === 'CANCELED'` (canceled trips never populate `masterArrivalsData`); per stop, `stu.scheduleRelationship === 'SKIPPED'` omits that single stop while siblings keep their pills.
- **`vehicleNoArrivalMatch` counter** — reverse of `ghostArrivals`. Fires in `getVehicleEtaSecs` when a live IN_TRANSIT_TO marker has a finite `stopId` and trip_updates has predictions at that stop but none matching THIS vehicle's `vehicle_id`/`trip_id` (popup falls back to schedule ETA). Episode-gated via `marker._noArrivalMatchRecorded`, cleared on stopId advance; STOPPED_AT excluded.
- **Cross-midnight trip preservation** — `js/serviceDate.js` `_preserveActiveTrips(oldTrips, newTrips, markers)` (called from `_reloadGtfsData` in `main.js`) merges any still-active tripId that exists in the OLD `masterTripsData` but not the freshly-fetched JSON, so owl trips keep their static context (terminus, stop sequence, `isLast`) until they terminate. Safe because Metro's tripIds are unique per service date (never recycled).
- **Synthetic schedule-based vehicleIds** — `scanGhostArrivals` skips vehicleIds ending in `_schedBasedVehicle` (Metro publishes schedule-derived predictions for not-yet-assigned trips; ~1,484 in one 20-min capture would otherwise swamp the genuine-ghost signal).
- **ID String-cast at the feed boundary** — `js/api.js` String-casts every feed-derived ID (`vehicle_id`, `trip_id`, `stopId`, `route_code`) before placing it on `feature.properties`; the trip_updates side casts too. Downstream does strict-equality lookups, and a number-vs-string mismatch silently drops cross-feed matches. Most visible failure mode: `isBusRoute('910')` — a numeric `910` would route the whole bus fleet through rail physics with no log. Cast new IDs at the api.js boundary, not at every reader.

### Observability & CI

- **localStorage feedStats ring** — each `_report()` tick with activity appends one snapshot to `localStorage.feedStatsRing` (max `FEED_STATS_RING_MAX` = 1440 = 24 h). Shape: `{ t, feeds: { [shortName]: { rcv, acc, drops, cadence } }, markers: {…}, ghosts }`. Inspect via `JSON.parse(localStorage.feedStatsRing)`. Helpers in `js/feedStats.js`: `readFeedStatsRing()`, `clearFeedStatsRing()`, `FEED_STATS_RING_KEY`. Best-effort — quota/parse errors are swallowed; silent intervals are skipped. The headless harness appends a tagged ring row (`row.__kind === 'feedStatsRing'`) at the tail of its JSONL artifact.
- **Scheduled feed-reliability audit** — `.github/workflows/feed-reliability.yml` runs `scripts/audit-feeds.js` against the live Metro WS feeds (crons currently **paused** through 2026-06-01, PR #256; manual `workflow_dispatch` still works). **Source of truth for "does Metro actually populate field X?"** — before wiring up any optional GTFS-RT field (`occupancyStatus`, `arrival.uncertainty`, `tripUpdate.delay`, `position.bearing`, …) consult the latest report's `vehicleFields`/`stuFields` block. Decision rule: ≥30 % nonNull → wire it up; 5–30 % → document partial coverage; <5 % → skip. Local: `node scripts/audit-feeds.js --duration=30m --out=/tmp/r.json`.
- **`rebuild-gtfs.yml`** — the weekly Mon 09:00 UTC auto-rebuild has an `if: failure()` fallback that files an issue under label `gtfs-rebuild-failure` when PR creation is blocked (repo setting "Allow GitHub Actions to create and approve pull requests" off → HTTP 403), so the rebuild requirement is never silently dropped.

### UI behavior & marker lifecycle

- **Vehicle freshness tiers** — `getFreshnessTier(marker, nowSec)` in `js/freshness.js` (shared by `markers.js` and `ui.js`) is the single source of truth for per-vehicle VISUAL state. Three tiers → (marker opacity, popup-dot color):
  - `live`    (age < 90 s)  → 1.0 / green
  - `stale`   (age < 300 s) → 0.5 / gray
  - `expired` (age ≥ 300 s) → fade-out & remove

  Constants: `FRESH_STALE_S` (90 s), `FRESH_EXPIRE_S` (300 s). Decoupled from `SPIKE_BYPASS_S` (120 s, spike-rejection) and `VEHICLE_MARKER_TTL_S` (180 s, ETA filter) — those are algorithmic gates, not visual. (`FRESH_LIVE_S` = 30 s in config.js is a separate predictions.js speed-freshness gate, unrelated to the tier model.)
- **`_openVehiclePopups` counter & marker-remove contract** — `markers.js` tracks open vehicle popups (incremented in `popup.on('open')`, decremented on `'close'`) so the per-second popup-age refresh ticks short-circuit on `=== 0`. **MapLibre's `marker.remove()` does not reliably fire `'close'`**, so every marker-removal call site MUST call `marker.getPopup()?.remove()` first or the counter drifts upward. The glide helpers use a callback (`marker._animateMarkerOnComplete`), not Promises — cancellation in `updateExistingMarker` deletes the flag so a cancelled glide can't fire `updateMarkerTimestamp` after the new GPS was applied.
- **Single active popup (`js/popups.js`)** — at most ONE popup is open at a time across the four independent owners: vehicle markers (`markers.js`), station arrivals (`stations.js`), Metro Bike Share (`bikeshare.js`), Metro Micro (`microzones.js`). Each owner, immediately after showing its popup, calls `setActivePopup(itsCanonicalCloseFn)`, which closes the previously-active popup **via that popup's own close fn** — NOT a bare `popup.remove()` — so per-type teardown runs (e.g. the station closer also clears vehicle highlights + restores focus). Each owner also calls `notifyPopupClosed(itsCloseFn)` from its `'close'` handler so the registry pointer drops on ×/map-click/Escape. The close fn must be a **stable reference** (a module-level fn like `closeStationPopup`/`_closeActivePopup`/`_closeMicroPopup`, or a per-popup closure reused in BOTH calls) so the identity guard works. **Any new popup type MUST register the same way** or it re-introduces the overlapping-tooltip bug. `popups.js` is a leaf module (no imports) to avoid the markers⇄stations cycle.
- **Startup auto-locate popup** — `autoLocate(isStartup=true)` must wait for BOTH `map.once('idle')` AND the `loadingDone` promise from `ui.js` (resolved by `removeLoadingScreen` on the 2nd WS connect or a 15 s fallback) before opening the nearest-station popup, or it renders over the still-visible loading splash. The locate-BUTTON path (`isStartup=false`) skips the splash gate.
- **ETA-source debug tag** — set `localStorage.mlm_debug_eta = '1'` (then reopen a vehicle popup) to render a `[RT]`/`[calc]` tag next to the next-stop ETA. `getVehicleEtaSecs` records the tier on `marker._etaSource` (`'gtfs-rt' | 'calc' | 'stopped' | 'none'`); `getPopupHTML` renders it only when the flag is set. Off by default, zero rider-facing effect.
- **Map is locked north-up (no rotation, no pitch)** — `initMap` (`map.js`) sets `dragRotate: false` + `touchPitch: false`, calls `map.touchZoomRotate.disableRotation()` (keeps pinch-zoom, drops the twist) and `map.keyboard.disableRotation()`, and adds the `NavigationControl` with `showCompass: false`. This is deliberate for a 2D transit OVERVIEW map: rotation on a phone is almost always accidental (a pinch that twists), disorients riders, and **misaligns every north-up overlay** — boarding/departure pills, directional arrows, the 8-cardinal boarding-slot geometry. Because bearing is always 0, no overlay needs `getBearing()` counter-rotation (there is none in the codebase — keep it that way). Do NOT re-add the compass or re-enable `dragRotate`/rotation without also making all those overlays bearing-aware.

### A11y, privacy & security

- **Non-text contrast for low-luminance route colors** — E (#fdb913), K (#e56db1), J (#adb8bf) fail WCAG 1.4.11 (3:1) on white; the brand palette is preserved. Mitigation: the **numeric vehicle count rendered as text** beside every legend bar carries the data, so the fill is a supplementary magnitude cue (the 1.4.11 "required to understand the content" exception) and the legend is never color-only. (A per-route `.bar-fill` outline was tried — #238 on every bar, #271 scoped to E/K/J — but removed: an outline on only some bars reads as inconsistent. Do NOT re-add a per-route outline; a uniform edge on ALL `.bar-fill` is the only acceptable form if one is ever wanted.) `.boarding-badge` gets a 2 px border + inset light outline in dark mode; `.pv2-dot` carries `role="img"` + `aria-label`. `tests/route-color-contrast.test.js` pins every route hex's contrast — if a route color or the KNOWN_FAILING set changes, update the test.
- **Focus trap + skip-link** — the alerts panel modal traps Tab/Shift+Tab at its boundaries (document-level keydown gated on `isAlertsPanelOpen()`); `openAlertsPanel` snapshots `document.activeElement` and `closeAlertsPanel` restores it. The skip-link targets `#station-search` (focusable), not the bare `#map`.
- **A11y landmarks + ARIA** — `<main id="map">` wraps the map; `<header role="search">` wraps the search bar. Search input has `aria-describedby`/`-controls`/`-expanded`; `#alerts-tab-announce` is a polite live-region written by `switchAlertsTab`; station popup name is `<h3>`.
- **No client analytics** — GTM/GA4 removed entirely (visitor IP to Google without consent = GDPR gap). Re-introducing analytics requires a proper consent flow AND re-adding `googletagmanager.com` + `google-analytics.com` to the CSP — see the CSP comment in `index.html`.
- **Clickjacking guard is a JS frame-buster, NOT `frame-ancestors`** — `frame-ancestors` is ignored when delivered via `<meta>` (needs an HTTP header GitHub Pages can't set). The guard is a synchronous inline frame-buster in `index.html` `<head>`. If the deployment ever moves behind a host that CAN set headers, prefer `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` as headers.

### Misc

- **Translation** — page is `<html lang="en">` and relies on each browser's built-in translate feature (~100 languages, translates alert prose too). The in-app en/es dictionary (`js/i18n.js`) was retired — **do NOT re-introduce a per-string translation table.** Alert bodies stay wrapped `<p lang="en">` so translators/screen-readers identify the source language.
- **Rollback runbook** — [`docs/ROLLBACK.md`](docs/ROLLBACK.md) is the canonical "main is broken in production" recovery doc: severity triage, immediate revert via `git revert` (no force-push, rule-6 compliant), fix-forward, and restore-from-known-good-SHA (gated on explicit user approval).

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

`tripTerminusByTripId` used to live on `window` too; PR #151 removed the mirror —
production consumers (`stations.js`, `predictions.js`) now import the named binding
from `tripUpdates.js` directly. The single-access-path invariant prevents future
writers from leaving one site reading stale state.

**Debug-only hooks** (not part of the contract — fine to omit when refactoring):
- `window.__visRegistrySize` — exposed by `utils.js` for inspecting the `setVisibleInterval` registry size.

### Cross-module callbacks (`window.__`)

`stations.js` exposes three function hooks on `window` so other modules can drive station-popup behavior **without importing `stations.js`** (which would create an init-order cycle through `main.js`). All three are set once at module load:

| Hook                                | Set by      | Called by      | Purpose                                                          |
|-------------------------------------|-------------|----------------|------------------------------------------------------------------|
| `window.__openStationByGroup`       | stations.js | bikeshare.js   | Open the station arrivals popup for a merged stop group          |
| `window.__hoverStationByGroup`      | stations.js | bikeshare.js   | Soft-preview hover (no pin) used when the user hovers a bike pin |
| `window.__closeStationIfUnpinned`   | stations.js | bikeshare.js   | Dismiss an unpinned hover-preview when the user leaves the pin   |

These are intentional inversion-of-control hooks — keep the `__` prefix and the optional-chained `?.()` call pattern so they fail silently if `stations.js` hasn't initialized yet.

---

## Helpful References

- **Architecture, modules, live feeds & data sources, stack** — see [README.md](README.md).
- **Engineering snapshot, deferred decisions, observability counters** — see [docs/STATUS.md](docs/STATUS.md).
- **Launch checklist & audit synthesis** — see [docs/LAUNCH-READINESS.md](docs/LAUNCH-READINESS.md).
- **Historical audits & retired-design specs** — see [docs/_archive/](docs/_archive/).

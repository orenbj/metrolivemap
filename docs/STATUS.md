# Project Status — Snapshot

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-05-27. Test count: **634/634 passing** (vitest, jsdom).

---

## Recent landings — overnight audit (PRs #219–#230)

The marker / ETA / alerts surfaces had a focused cleanup pass:

- **PR #219** — Alerts panel: Service + Accessibility tabs, blue-not-severity for accessibility surfaces inside the menu, alternative-stop filter for elevator alerts that tag suggested-detour stops alongside the affected one.
- **PR #220** — Sub-minute ETA label: `<1m` instead of `30s` (avoids the `30m` misread).
- **PR #221** — Bike Share + Metro Micro layers default OFF on first visit; toggle choice persisted in localStorage.
- **PR #222** — `_effectiveNextStopId` override: when a marker's snap arc has moved past its declared next stop's arc, the vehicle popup displays the next-ahead stop instead. ETA recomputed against the effective stop. Also extended the `FINAL_STOP_HOLD_M` heading hold to cover the trip's FIRST stop — closes the D Line "marker flips 180° pre-arrival at terminus" bug.
- **PR #223** — `tests/setup.js` installs an in-memory localStorage shim. Node 25+'s built-in `globalThis.localStorage` accessor collides with jsdom and breaks every `setItem` in tests; the shim restores in-memory semantics. Fixed 7 chronic test failures that every PR description had been flagging.
- **PR #224** — `getScheduledArrivals` past-target guard: drops a vehicle from station-popup arrivals when its snap arc has moved past the target stop. Closes the vehicle-popup-vs-station-popup mismatch that #222 introduced (both surfaces now use the same GPS-derived next stop).
- **PR #225** — Nearby-bus dedup no longer hides distinct buses when `tripId` is null (one missing tripId would dedup every subsequent null as a "duplicate"; falls back to `vid:<vehicleId>` instead).
- **PR #226** — **Bearing-DR retirement.** The bus / shape-less DR fallback was the highest-bug-surface and lowest-rider-value DR path (projected blindly along the last GPS heading, routinely cut corners through buildings on turning streets). Buses now use the per-WS-frame `animateMarker` glide (~1 s ease per fix; marker sits at last GPS between fixes). Net **−223 lines**, one whole bug class eliminated. Arc-DR for rail is unchanged.
- **PR #227** — Alerts "alternative station" filter now prefix-matches entrance-variant stop names (`Hollywood/Vine Station - Elevator` shares the `hollywoodvine` prefix with the base `Hollywood/Vine Station`), so entrance variants aren't silently dropped when an alert targets the base station.
- **PR #228** — CLAUDE.md sync for the bearing-DR retirement.
- **PR #229** — Speed gate on the `_effectiveNextStopId` override + `getScheduledArrivals` past-target guard. A stopped 3-car LA Metro train (~82 m long) reports GPS ~25-40 m past the platform centroid (mid-car antenna), clearing the 30 m threshold even at the platform. The gate (`smoothedSpeed >= STATIONARY_SPEED_MPS`) ensures both behaviors only fire when the train is genuinely moving past the stop.
- **PR #230** — **KISS simplification pass.** (1) Removed `js/scheduleCalibration.js` (233 LOC EWMA per-route adherence tuner) and its 3 multiplier call sites in `predictions.js`. The variance gate (`MAX_STDDEV = 0.18`) silently returned 1.0 for most routes; even when active, the ±10-15% nudge collapsed into the `Now / <1m / Xm` ETA buckets. Also dropped the `recordSegmentTime` call site in `markers.js` that fed it. (2) Collapsed the `aging` freshness tier into `live` — grep confirmed no behavioral consumer differentiated `aging` from `live` (both already rendered identical opacity, no spike/ETA filter branched on it). Now three tiers: `live` / `stale` / `expired`. (3) Added audit-trail comments to `DR_SPEED_FACTOR` and `DR_SPEED_GLIDE_TAU_S`. Net **−260 LOC**, one storage schema retired (`mlm:scheduleCalibration` localStorage key + V1→V2 migration), zero rider-visible regressions.

---

## Animation — current state (post-PR-#226)

**Rail** (any route with shape data) runs the **arc-DR** integrator (`_arcTick`) along its polyline:
- Continuous-loop rAF design — `startDeadReckoning` is an idempotent param-refresh, never cancels/restarts the loop
- Single source of truth for the next-stop cap (`_drStopArcCap`): scan of `predictions.routeStops[key].arcMeters`. Direction carried by `arcSign`, not by sorting the array
- `_heavyRailScheduleSpeed` — B/D Line schedule-cruise fallback when GPS reports speed=0 in tunnel
- `isNearIntersection` + `data/light-rail-intersections.json` — light-rail red-light vs tunnel-dropout disambiguation
- `_isStoppedAtMisfire(marker, vehicle)` — detects "feed says STOPPED_AT but observed motion proves otherwise"; thresholds in `STOPPED_AT_MISFIRE_*` constants
- Declared-stop clamp (`_applySnap`) for STOPPED_AT only — pulls the marker back to the declared stop's arc when GPS lands past

**Buses** (routes without shape data — G/J busway) **do not run a continuous integrator** as of PR #226. The retired `startBearingDeadReckoning` / `_bearingTick` projected blindly along the last GPS heading and routinely cut bus markers through buildings on turning streets. Bus motion is now the per-WS-frame `animateMarker` glide (~1 s ease from current visual position to new GPS). Marker sits at the last GPS position between fixes (typically 5-15 s) — honest about what we know rather than guessing.

**Marker-vs-popup consistency** (PRs #222 / #224 / #229): the marker visual is always GPS truth; the displayed "next stop" is GPS-derived (not the stale feed `stopId`) when the marker has moved past the declared stop AND the train is moving (speed gate). Both the vehicle popup and the station popup arrivals respect the same threshold so the two surfaces never disagree about the same vehicle.

DR constants in `config.js`: `DR_SPEED_FACTOR`, `DR_SPEED_ALPHA`, `DR_SPEED_GLIDE_TAU_S`, `DR_DECEL_ZONE_M`, `DR_DECEL_RATE_MPS2`, `DR_HEAVY_RAIL_FALLBACK_MPS`, `INTERSECTION_PROX_M`, `DR_MAX_SECONDS_RAIL`, `RAIL_SNAP_MAX_M`, `STOPPED_AT_MISFIRE_SPEED_MPS`, `STOPPED_AT_MISFIRE_AGE_S`, `STOPPED_AT_MISFIRE_ARC_DELTA_M`, `STOP_ID_LAG_MARGIN_M`, `STATIONARY_SPEED_MPS`.

---

## Open follow-ups

- **`DR_MAX_SECONDS_RAIL = 60 s` tuning.** The inline comment claims "~45 s on B Line" — factually wrong (Cahuenga Pass segment is ~4 min scheduled). The watchdog only fires on actual feed silence, not on tunnel transit, because GTFS-RT keeps emitting frames during tunnel runs (with `DR_HEAVY_RAIL_FALLBACK_MPS` taking over for speed=0). We have no telemetry confirming this; the `watchdogRail` counter from PR #202 is the signal that resolves it. **Wait for 24–48 h of telemetry before tuning.**
- **`intersectionPause` cache-invalidation on speed transition.** Up to 500 ms freeze after light-rail vehicle resumes from a red light. Deferred until `intersectionPause` counter shows non-trivial episode rate. (`startDeadReckoning:1510` already clears the cache on WS updates, so the remaining window is "speed lerps above threshold between WS frames" — likely tiny.)
- **`animateMarker` cold-start race** (`markers.js:932-940`). The 60-step glide on first-update can race against a subsequent WS update arriving inside that 1 s window, overwriting `_targetLng/_targetLat`. Instrumented as `animateMarkerRace` in PR #202; fix deferred pending real-incidence data.

---

## Alert tooltip copy normalization — shipped 2026-05-16

Audit at [`docs/alert-copy-audit-2026-05.md`](./alert-copy-audit-2026-05.md). Three stages shipped in PRs #184–#186; all live via `normalizeAlertProse()` + `formatActivePeriodLine()` in `js/alerts.js`.

| PR | Stage | What |
|---|---|---|
| #184 | 1 | Title-case ALL-CAPS headers, whitespace trim, am/pm canon, dup-prefix drop |
| #185 | 2 | Promote skipped-stops paragraph to top; strip `due to <reason>` boilerplate tails |
| #186 | 3 | Append `Active: <window>` (or `Active: ongoing`) to every tooltip — closes the "during this time" accessibility gap |

All normalization is at **render time**; `masterAlertsData` retains raw Metro-authored strings. 47 vitest cases in `tests/alert-prose-normalize.test.js` pin before/after against real 2026-05-16 corpus samples.

Deferred (Stage 4): visual "stale" tier for `end = null` alerts older than 30 days. One alert trips the rule today (`LINE 20, 210`, live since Nov 2025). Low urgency; spec is in the audit doc.

---

## Live-accuracy CI

The headless harness writes a three-way summary (calc / gtfs-rt / blend) per horizon × route. Cadence simplified 2026-05-17 (PR #194): the original 18 captures/week were sized for the Phase 5 → Phase 8 A/B validation cycle, which no longer exists. New cadence is regression monitoring only — four representative samples across weekday/weekend service profiles. Cron schedule in [`.github/workflows/live-accuracy.yml`](../.github/workflows/live-accuracy.yml):

| When | Tag prefix | Purpose |
|---|---|---|
| Tue 15:00 UTC (08:00 PDT) | `peak-am-` | Weekday AM peak |
| Thu 20:00 UTC (13:00 PDT) | `offpeak-` | Weekday mid-day |
| Sat 18:00 UTC (11:00 PDT) | `weekend-mid-` | Weekend mid-morning |
| Sun 21:00 UTC (14:00 PDT) | `weekend-pm-` | Weekend afternoon |

30-min capture each (still ~1500+ paired snapshots per run); artifacts retained **30 days**. Manual runs available via `workflow_dispatch` when a PR's blend/calc/snap change warrants a fresh capture.

CI log lines from each run include:
- per-horizon `calc.mae` / `gtfs.mae` / `blend.mae`
- 2-way `headToHead` between calc / gtfs (the post-#192 `blendEta` is structurally identical to one of its inputs, so a 3-way win-count is tautological — see `substitutionImpact` instead)
- `substitutionImpact`: among rows where `gtfsLooksPlausible` rejected GTFS-RT and substituted calc, helped% / hurt% / avgDeltaS — direct measurement of whether the gate is improving or degrading rider-visible accuracy

**Distribution-hygiene note:** weekend service is materially different from weekday (lighter headways, less rush-recovery operator pressure). Pool within the same group (weekday / weekend) only when computing headline accuracy stats. The aggregator's cluster-bootstrap CIs work fine either way; this is an analysis-hygiene point.

---

## Observability — feed-stats counters

`js/feedStats.js` prints a per-minute log line summarizing pipeline health. Categories (each counter resets per tick):

| Category | Counters | Wired in |
|---|---|---|
| Per-feed | `received` / `accepted` / drops `noPosition` / `nonFinite` / `noTripId` / `invalidTs` / `futureTs` / `jsonParse` | `api.js` |
| Marker ingest | drops `staleAge` / `olderTs` / `spike` / `coldStartSpike` / `preBootstrap` | `markers.js` |
| Freeze / visual episodes | `watchdogRail` / `offRoute` / `noSnap` / `intersectionPause` / `stoppedAtMisfire` / `animateMarkerRace` / `stopIdLag` / `declaredStopClamp` / `vehicleNoArrivalMatch` | `markers.js` (episode-gated, not per-frame). `watchdogBus` + `bearingBudgetExhausted` retired with bearing-DR (PR #226). |
| Ghost arrivals | count of trip_updates entries with no matching marker | `feedStats.scanGhostArrivals` |

---

## Deferred design decisions (worth a conversation before action)

### 1. Spike-rejected fixes bump `marker.timestamp`
**Location:** `js/markers.js` (after `recordMarkerDrop('spike')`)

A GPS fix flagged as a spike currently does
`marker.timestamp = newTs; el.setAttribute('data-timestamp', newTs)`. Treats
spike-rejected frames as "feed liveness, data quality unknown" and keeps the
marker fresh-looking. LATENT: a vehicle whose GPS is broken (every fix rejected
for ~120 s of `SPIKE_BYPASS_S`) shows green/live to the rider even though we're
not trusting any of the data.

**Status:** untouched. UX decision required before changing.

### 2. Two popup-refresh tickers (1s + 5s)
**Location:** `js/markers.js` (1 s age counter) + (5 s ETA rebuild)

For a single open vehicle popup, two `setVisibleInterval` callbacks fire.
Harmless churn but ugly. Revisit when popup is next touched.

### 3. `chooseBadgeSlots` cornerPlacement asymmetry
**Location:** `js/stations.js`

When the boarding badge is at `T` vs `B`, the `(alert, access)` pair flips
left/right order. Not a no-overlap violation (covered by the 32-combinations
test) but ARIA reading order across the 8 cases isn't uniform. NIT.

---

## Outstanding hygiene the audits noted but didn't change

These are *intentional* current choices the audits surfaced. Listed here so
a future "let's improve this" instinct sees the prior reasoning.

- **GTFS-RT timestamps pre-coerced via `Number(...)`** in
  `js/tripUpdates.js`. `normalizeTimestamp` accepts strings, but GTFS-RT
  spec'd numeric timestamps and a string-of-digits like `"1700000000"`
  would be misread as a year by the ISO-string path. Keep the wrapper.
- **No in-app i18n shim.** The previous `js/i18n.js` + `i18n/{en,es}.json`
  dictionary was retired (PR #161). Reasons in CLAUDE.md ("Translation"
  section) — two languages too few, alerts couldn't be translated, browser
  Translate handles ~100 languages. Future contributors: do NOT re-introduce
  a per-string translation table.
- **`getBoardingVehicles` Tier-2 keeps GTFS-only entries for ~30 s after
  predicted departure** (`js/predictions.js`). Bridges the GPS layover gap.
- **`marker.timestamp` advances on any WS arrival, including
  re-broadcasts** (CLAUDE.md "Vehicle freshness tiers"). Designed intent:
  feed liveness, not strictly-newer-fix clock. See deferred decision #1.

---

## Conventions reminders (the easy-to-forget ones)

- **Stop IDs** — pass through `normalizeStopId(s)` for any lookup that
  may have a `_N/_S` directional suffix. `masterStopsData` may key by
  either form; the dual-lookup pattern in `markers.js` (`x ?? normalize(x)`)
  is the canonical fallback.
- **Timestamps** — `normalizeTimestamp(v)` handles Unix seconds, Unix ms,
  ISO strings; returns NaN for negative or unparseable input. Callers
  must `Number.isFinite()`-guard the return.
- **Intervals that should pause when hidden** — use
  `setVisibleInterval(fn, ms, key)` not raw `setInterval`. The `key`
  parameter makes re-registration idempotent.
- **No build step** — keep imports as relative ES-module paths.
- **Window globals** — additions to the table in CLAUDE.md "Cross-Module
  Globals" require explicit justification. The trend is to remove mirrors,
  not add them.

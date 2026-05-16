# Project Status — Snapshot

Last refreshed at the close of a Phase-5 audit + hygiene pass.

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-05-15.

---

## Phase 5 trajectory-model overhaul — shipped, awaiting validation

The full plan lives in [`docs/trajectory-overhaul.md`](./trajectory-overhaul.md);
the seam map lives in [`docs/phase-5-wiring.md`](./phase-5-wiring.md).

**State of the world:**

| Sub-phase | What | PR | State |
|---|---|---|---|
| 5.1 | `VehicleStateStore` + `DwellModel` module singletons (`js/phase5State.js`) | #169 | ✅ merged |
| 5.2 | WS frame routing → state updaters; `js/phase5Wiring.js` + `js/trajectoryBuilder.js` | #170 | ✅ merged |
| 5.4 | Render rAF reads `state.trajectory.positionAt(t_now)`; `js/renderLoop.js` | #171 | ✅ merged |
| 5.5 | ETA reads via `state.trajectory.timeAtArc`; `_getTrajectoryArrivals` in `predictions.js` | #172 | ✅ merged |
| 5.6 | A/B instrumentation — paired `trajectoryEta` column in `getArrivalBreakdown`; unconditional state population | #173 | ✅ merged |
| 5.7 | Hygiene — state cleanup hook in `_fadeOutAndRemove`, GPS-spike cruise cap, observability counters | #175 | ✅ merged |
| 5.8 | Aggregator: `trajectory` column + paired `headToHeadTrajectoryVsBlend` summary | #176 | ✅ merged |

**`USE_TRAJECTORY_MODEL` flag** (in [`js/config.js`](../js/config.js)) defaults to **`false`** in production. The trajectory pipeline runs in the background (state populates on every WS frame, trajectories build, dwell observations record) but the user-visible code paths still use the legacy DR + blend. The live-accuracy harness captures `trajectoryEta` alongside `calcEta` / `gtfsEta` / `blendEta` in a single run so Phase 8's decision metric is read directly from the CI log (`headToHeadTrajectoryVsBlend`).

**What's still live (Phase 9 will delete):**
- `js/markers.js` — `_arcTick`, `_bearingTick`, `startDeadReckoning`, `startBearingDeadReckoning` and the `_dr*` state fields (~300 lines)
- `js/predictions.js` — `_blendArrivals`, horizon-band logic, replay guard (~500 lines)
- `js/scheduleCalibration.js` — entire module (~250 lines)
- `BLEND_*` constants in `js/config.js`

These remain production code paths until Phase 8 acceptance gates clear (10-day clean-win window comparing `trajectoryEta` vs `blendEta`).

**What's next:**
- **Phase 6 — variance learning.** Replace the placeholder per-source σ values in `stateUpdaters.js` with online-learned per-route σs. Gated on ≥5 days of paired captures. Weekend captures started 2026-05-16; baseline weekday captures resume Mon 2026-05-18.
- **Phase 7 — uncertainty in UI.** Surface σ as confidence bands ("3–5 min" instead of "4 min") in station popups. Depends on Phase 6.
- **Phase 8 — default flip + legacy delete.** Flip `USE_TRAJECTORY_MODEL = true` after 10 days of trajectory-beats-blend (or matches) in paired captures; delete legacy code in a follow-up after one quiet week.

---

## Live-accuracy CI

The headless harness writes a four-way summary (calc / gtfs-rt / blend / trajectory) per horizon × route. Cron schedule in [`.github/workflows/live-accuracy.yml`](../.github/workflows/live-accuracy.yml):

| When | Tag prefix | Purpose |
|---|---|---|
| Mon–Fri 15:00 UTC (08:00 PDT) | `peak-am-` | Weekday AM peak |
| Mon–Fri 20:00 UTC (13:00 PDT) | `offpeak-` | Weekday mid-day |
| Sat–Sun 15:00 UTC | `weekend-am-` | Weekend AM |
| Sat–Sun 18:00 UTC | `weekend-mid-` | Weekend mid-morning |
| Sat–Sun 21:00 UTC | `weekend-pm-` | Weekend afternoon |
| Sat/Sun 00:00 UTC | `weekend-eve-` | Weekend evening (17:00 PDT prior day) |

60-min capture each; artifacts retained **90 days** (bumped from 30 in PR #173 to cover the full Phase 8 validation window).

CI log lines from each run include:
- per-horizon `calc.mae` / `gtfs.mae` / `blend.mae` / `traj.mae`
- 3-way `headToHead` (existing)
- paired `headToHeadTrajectoryVsBlend` (Phase 8 decision metric)

**Distribution-hygiene note:** weekend service is materially different from weekday (lighter headways, less rush-recovery operator pressure). Pool within the same group (weekday / weekend) only when computing headline accuracy stats. The aggregator's cluster-bootstrap CIs work fine either way; this is an analysis-hygiene point.

---

## Observability — feed-stats counters

`js/feedStats.js` prints a per-minute log line summarizing pipeline health. Categories (each counter resets per tick):

| Category | Counters | Wired in |
|---|---|---|
| Per-feed | `received` / `accepted` / drops `noPosition` / `nonFinite` / `noTripId` / `invalidTs` | `api.js` |
| Markers | drops `staleAge` / `olderTs` / `spike` / `coldStartSpike` | `markers.js` |
| Trajectory builder (Phase 5.7) | drops `noCache` / `noNextStop` / `dirReversed` / `missingArc` | `trajectoryBuilder.js` |
| Render rAF (Phase 5.7) | skips `stale` / `noTraj` / `noShape` | `renderLoop.js` |
| Ghost arrivals (Phase 2 detector, observability only) | count of trip_updates entries with no matching marker | `feedStats.scanGhostArrivals` |

When Phase 8 captures show a particular route's `trajectoryEta` is bad, the
per-minute log line tells us whether the issue is "couldn't build a trajectory"
(trajectory counters non-zero) vs "built but ETA is wrong" (counters at zero).
Triages much faster than re-running with debug logs.

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

Options:
- Leave it (current behaviour — feed liveness is the signal).
- Don't bump `marker.timestamp` on spike-reject so the marker ages naturally.
- Introduce a separate "GPS quality" tier independent of feed liveness.

**Status:** untouched. UX decision required before changing.

### 2. Direction-reversed polyline trips have null trajectory
**Location:** `js/trajectoryBuilder.js`

Trips whose `direction_id` traverses the polyline in reverse produce decreasing
`cache.arcMeters` — `fromAnchor` requires monotonically-increasing arc and so
the builder returns `null`. Render loop falls back to "marker stays at last
WS lat/lng", which is a regression vs legacy DR for those specific trips.

**Fix sketch:** Phase 5.4b — signed-arc translation so `state.arc` always
increases in trip direction, decoupled from polyline arc. Out of scope until
A/B captures show the affected trip subset is material.

### 3. Two popup-refresh tickers (1s + 5s)
**Location:** `js/markers.js` (1 s age counter) + (5 s ETA rebuild)

For a single open vehicle popup, two `setVisibleInterval` callbacks fire.
Harmless churn but ugly. Phase 5 popup-ETA seam now goes through the trajectory
path (when flag flips), which will simplify this naturally. Revisit post-Phase
8 if it matters.

### 4. `chooseBadgeSlots` cornerPlacement asymmetry
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
  Translate handles ~100 languages. PR #168 also removed the in-app
  Google Translate widget after it didn't survive popup-tooltip churn.
  Future contributors: do NOT re-introduce a per-string translation table.
- **`getBoardingVehicles` Tier-2 keeps GTFS-only entries for ~30 s after
  predicted departure** (`js/predictions.js`). Bridges the GPS layover gap.
- **`marker.timestamp` advances on any WS arrival, including
  re-broadcasts** (CLAUDE.md "Vehicle freshness tiers"). Designed intent:
  feed liveness, not strictly-newer-fix clock. See deferred decision #1.
- **Per-tripId state keying.** `vehicleStateStore` uses `tripId` (not the
  Phase-2 default `vehicleId`) so the parallel state-store + marker-DOM
  structures stay in lockstep through terminus turnarounds. Metro
  frequently omits `vehicle.id` from GTFS-RT frames; tripId is more
  reliable in practice.
- **Cruise cap formula** in `trajectoryBuilder.js`:
  `cap = min(HARD_MAX, max(1.5 × schedule_cruise, TYPICAL_FAST))`. Bounds
  GPS-noise overshoot for the projection without touching the Kalman state.
  Rail TYPICAL_FAST=22 / HARD_MAX=30; bus 17 / 25.

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
  not add them. Phase 5 introduced the `vehicleStateStore` /
  `dwellModel` singletons via a dedicated `js/phase5State.js` module
  instead of new `window.*` entries.

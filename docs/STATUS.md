# Project Status — Snapshot

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-05-30. Test count: **689/689 passing** (vitest, jsdom).

For the always-current contract — motion model, feed-data gates, freshness
tiers, cross-module globals — see [`CLAUDE.md`](../CLAUDE.md). This file is a
point-in-time orientation snapshot, not the source of truth.

---

## Current motion model — bounded arc-glide (PR #257)

Dead-reckoning was retired entirely. The marker now only ever moves to
positions GPS confirms — it cannot overshoot, cannot "fly past" a stop, and
cannot disagree with the popup label.

- **Rail** (route with shape data): on every WS frame, `arcGlide()` in
  `markers.js` glides the marker ALONG the polyline arc from its previous
  snapped position to the new snapped position. Glide duration tracks the
  real inter-fix gap (PR #269) so on-screen speed ≈ the vehicle's real
  average speed. Re-anchors (teleports, no glide) when the move can't be
  shown as plausible motion: gap > 30 s, stale reference, > 5 km jump, or
  an implied speed > `RAIL_MAX_SPEED_MPS × 1.5`.
- **BRT (G/J Lines, routes 901/910/950)**: `arcGlide` along the busway polyline,
  same as rail. Shape data is in `data/rail-shapes.json`; snap threshold is
  `BRT_SNAP_MAX_M = 150 m` (vs generic bus 75 m). GPS > 150 m from polyline
  (detour) falls through to straight-line. `isBrtRoute()` identifies these routes.
- **Buses** (non-BRT, no shape data): `animateMarker` straight-line lat/lng glide at
  the same gap-matched duration; re-anchors when implied straight-line speed
  exceeds `MAX_PLAUSIBLE_SPEED_MPS`.
- **Rotation**: lerp from the prior heading to this frame's
  `computeHeading()` result.
- **Cold start**: marker spawns at its snapped GPS position, no glide.

Vehicle motion is intentionally **not** gated by `prefers-reduced-motion`
(PR #267) — it conveys real-world movement (WCAG 2.3.3-exempt). The one
material trade-off: B/D tunnel markers freeze for 3–5 min during tunnel
transit (no GPS underground to glide to).

The full removal (continuous DR integrator, declared-stop clamp, STOPPED_AT
misfire detection, GPS-inferred next-stop override, heavy-rail tunnel
fallback, the light-rail intersection module, and ~14 `DR_*` config
constants) landed in the same PR — net ~−1,500 LOC. **Future contributors:
do NOT re-introduce a `speedFactor`, a `_drCurrentArc`, or any code that
projects the marker past its last GPS fix.** The arc-glide design rules out
extrapolation by construction.

---

## Recent landings (headlines)

PR-by-PR detail lives in the git log; this is the orientation summary.

- **Arc-glide refactor (PR #257, follow-ups #259–#283)** — DR → bounded
  arc-glide (above). Follow-ups tuned glide duration (#269), rotation
  (#262), reduced-motion handling (#267), and startup auto-locate gating
  (#266/#268), a console-cleanup pass (#273) that removed the dead DR-era
  feedStats counters and the no-op `frame-ancestors` meta directive, and a
  consecutive-spike re-anchor (#283) so a B/D marker can't stay frozen after
  a tunnel transit until a refresh.
- **Station-alert polish (PRs #278–#288)** — removed the "Beta" badge
  and added old-browser hex fallbacks for the low-luminance alert badges
  (#281). Line-bullet chips on station service-alert banners showing which
  route(s) each alert affects, sorted by line and left of the ⚠ (#285–#288).
  Departure-badge "Now" capitalization (#284). (PRs #278–#280 set up a
  staging-mirror deploy that has since been retired — GitHub Pages is now
  the sole deployment target.)
- **Prod-readiness review (PRs #237–#247)** — global error boundary, a11y
  completeness (focus-trap, semantic landmarks, non-text contrast, freshness
  ARIA), GTM/GA4 removal, and the ROLLBACK runbook. Full launch synthesis in
  [`LAUNCH-READINESS.md`](./LAUNCH-READINESS.md).
- **Feed-data correctness gates (2026-05-26)** — future-timestamp drop
  (`FUTURE_TS_GRACE_MS`), CANCELED-trip and SKIPPED-stop suppression in
  `tripUpdates.js`, the `vehicleNoArrivalMatch` counter, cross-midnight trip
  preservation (`serviceDate.js`), and the scheduled feed-reliability audit
  (`scripts/audit-feeds.js`). Mechanics documented in CLAUDE.md.

---

## Alert tooltip copy normalization

All normalization is at **render time** via `normalizeAlertProse()` +
`formatActivePeriodLine()` in `js/alerts.js`; `masterAlertsData` retains the
raw Metro-authored strings. Behavior: title-case ALL-CAPS headers, canonical
am/pm, drop duplicate prefixes and `due to <reason>` boilerplate tails,
promote the skipped-stops paragraph, and append `Active: <window>`. 47
vitest cases in `tests/alert-prose-normalize.test.js` pin before/after
against a real 2026-05-16 corpus. Original audit:
[`_archive/alert-copy-audit-2026-05.md`](./_archive/alert-copy-audit-2026-05.md).

Deferred: a visual "stale" tier for `end = null` alerts older than 30 days
(one alert trips it today). Low urgency.

---

## Live-accuracy CI

> **Crons active** — `live-accuracy.yml` and `feed-reliability.yml` run on
> their full schedules (repo is public → unlimited Actions minutes).
> Manual `workflow_dispatch` runs also available.

The headless harness writes a three-way summary (calc / gtfs-rt / blend) per
horizon × route. When the crons are live the cadence is regression
monitoring only — four representative samples across weekday/weekend service
profiles (cron schedule in
[`.github/workflows/live-accuracy.yml`](../.github/workflows/live-accuracy.yml)):

| When | Tag prefix | Purpose |
|---|---|---|
| Tue 15:00 UTC (08:00 PDT) | `peak-am-` | Weekday AM peak |
| Thu 20:00 UTC (13:00 PDT) | `offpeak-` | Weekday mid-day |
| Sat 18:00 UTC (11:00 PDT) | `weekend-mid-` | Weekend mid-morning |
| Sun 21:00 UTC (14:00 PDT) | `weekend-pm-` | Weekend afternoon |

30-min capture each (~1500+ paired snapshots per run); artifacts retained
**30 days**. CI log lines from each run include:
- per-horizon `calc.mae` / `gtfs.mae` / `blend.mae`
- 2-way `headToHead` between calc / gtfs (the post-#192 `blendEta` is
  structurally identical to one of its inputs, so a 3-way win-count is
  tautological — see `substitutionImpact` instead)
- `substitutionImpact`: among rows where `gtfsLooksPlausible` rejected
  GTFS-RT and substituted calc, helped% / hurt% / avgDeltaS — direct
  measurement of whether the gate is improving rider-visible accuracy

**Distribution-hygiene note:** weekend service differs materially from
weekday (lighter headways, less rush-recovery pressure). Pool within the
same group (weekday / weekend) when computing headline accuracy stats.

---

## Observability — feed-stats counters

`js/feedStats.js` prints a per-minute log line summarizing pipeline health
and appends a snapshot to the 24 h `localStorage.feedStatsRing`. Counters
reset each tick:

| Category | Counters | Wired in |
|---|---|---|
| Per-feed | `received` / `accepted` / drops `noPosition` / `nonFinite` / `noTripId` / `invalidTs` / `futureTs` / `jsonParse` | `api.js` |
| Marker ingest | drops `staleAge` / `olderTs` / `spike` / `coldStartSpike` / `preBootstrap` | `markers.js` |
| Marker hygiene | `offRoute` / `noSnap` / `vehicleNoArrivalMatch` (episode-gated, not per-frame) | `markers.js` |
| Errors | `globalErrors` / `unhandledRejections` | `errorBoundary.js` |
| Ghost arrivals | count of trip_updates entries with no matching marker | `feedStats.scanGhostArrivals` |

The DR-era "freeze" counters (`watchdogRail`, `intersectionPause`,
`stoppedAtMisfire`, `animateMarkerRace`, `stopIdLag`, `declaredStopClamp`,
plus the bearing-DR `watchdogBus` / `bearingBudgetExhausted`) were removed
with dead-reckoning — do not re-add them to the log string.

---

## Deferred design decisions (worth a conversation before action)

### 1. ~~Spike-rejected fixes bump `marker.timestamp`~~ ✅ RESOLVED

`marker.timestamp` is still bumped on rejected fixes (required for `isStaleRef`),
but **visual freshness now reads `marker._lastAcceptedTs`** — a separate field that
only advances on accepted fixes. A frozen marker with bad GPS correctly goes gray
or expires rather than staying green. See `js/freshness.js` `getFreshnessTier` and
the `_lastAcceptedTs` note in CLAUDE.md "Vehicle freshness tiers".

### 2. Two popup-refresh tickers (1 s + 5 s)
**Location:** `js/markers.js` (1 s age counter) + (5 s ETA rebuild)

For a single open vehicle popup, two `setVisibleInterval` callbacks fire.
Harmless churn but ugly. Revisit when the popup is next touched.

### 3. `chooseBadgeSlots` cornerPlacement asymmetry
**Location:** `js/stations.js`

When the boarding badge is at `T` vs `B`, the `(alert, access)` pair flips
left/right order. Not a no-overlap violation (covered by the 32-combinations
test) but ARIA reading order across the 8 cases isn't uniform. NIT.

---

## Outstanding hygiene the audits noted but didn't change

These are *intentional* current choices the audits surfaced. Listed here so a
future "let's improve this" instinct sees the prior reasoning.

- **GTFS-RT timestamps pre-coerced via `Number(...)`** in `js/tripUpdates.js`.
  `normalizeTimestamp` accepts strings, but GTFS-RT spec'd numeric timestamps
  and a string-of-digits like `"1700000000"` would be misread as a year by
  the ISO-string path. Keep the wrapper.
- **No in-app i18n shim.** The previous `js/i18n.js` + `i18n/{en,es}.json`
  dictionary was retired (PR #161). Reasons in CLAUDE.md ("Translation"). Do
  NOT re-introduce a per-string translation table.
- **`getBoardingVehicles` Tier-2 keeps GTFS-only entries for ~30 s after
  predicted departure** (`js/predictions.js`). Bridges the GPS layover gap.
- **`marker.timestamp` advances on spike-rejected frames** (required so
  `isStaleRef` never fires during a streak). Visual freshness is driven by
  `marker._lastAcceptedTs` (only advances on accepted fixes). See CLAUDE.md
  "Vehicle freshness tiers" for the full contract.

---

## Conventions reminders (the easy-to-forget ones)

- **Stop IDs** — pass through `normalizeStopId(s)` for any lookup that may
  have a `_N/_S` directional suffix. The dual-lookup pattern in `markers.js`
  (`x ?? normalize(x)`) is the canonical fallback.
- **Timestamps** — `normalizeTimestamp(v)` handles Unix seconds, Unix ms, and
  ISO strings; returns NaN for negative or unparseable input. Callers must
  `Number.isFinite()`-guard the return.
- **Intervals that should pause when hidden** — use
  `setVisibleInterval(fn, ms, key)`, not raw `setInterval`. The `key` makes
  re-registration idempotent.
- **No build step** — keep imports as relative ES-module paths.
- **Window globals** — additions to the table in CLAUDE.md "Cross-Module
  Globals" require explicit justification. The trend is to remove mirrors,
  not add them.

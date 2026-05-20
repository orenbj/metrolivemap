# Project Status — Snapshot

Last refreshed at the close of the marker-accuracy audit (PR #202).

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-05-19.

---

## Animation: legacy DR + marker-accuracy audit (PR #202)

Phase 5b's blend-anchored animation rewrite (PRs #189, #190, #196, #197) was reverted in PR #198. PR #202 is the follow-up audit pass that fixed the two failure modes on the legacy DR system, without re-introducing the Phase 5b unification:

**First half — never animates past its stop:**
- `f4ab125` — rail STOPPED_AT snap projects onto the polyline (with a 150 m `RAIL_SNAP_MAX_M` off-by gate) so the marker aligns with the drawn route line. Bus published coords pass through unchanged. Closes the "marker visibly past platform icon" gap.
- `8cd9d7e` — collapse the 5-layer DR cap (`feedStillApproaching` gate + initial pull-back + trip-walk fallback + `alreadyPast` escape hatch + per-frame clamp) into one direction-uniform scan of `predictions.routeStops[key].arcMeters`. Structurally immune to `stopId` staleness. **Direction is carried by `arcSign`, not by sorting the array** — trip-sequence order preserved for both dir=0 and dir=1. This resolves the previously-deferred "direction-reversed polylines" item.

**Second half — never frozen while moving:**
- `3198b44` — telemetry for 11 previously-silent freeze paths (`watchdogRail`, `watchdogBus`, `offRoute`, `noSnap`, `intersectionPause`, `bearingBudgetExhausted`, `stoppedAtMisfire`, `animateMarkerRace`). Episode-gated (one record per pause-session), not per-frame.
- `0036a47` — drop the redundant cold-start speed gate. The per-frame pause-but-keep-alive at `_arcTick:1568` / `_bearingTick:1281` does the same job. Side effect: bus modems that report stale `speed=0` while moving now get a chance to advance as soon as `_applyVelocityCorrections` derives a non-zero `smoothedSpeed` from position delta.
- `4b9df60` — STOPPED_AT misfire override at BOTH `_applySnap` (the pin) and `startDeadReckoning` (the DR halt). AND-gated: `reportedSpeed > 1.0 m/s` OR (`statusChangedAt > 180 s` AND `|snap.arcMeters − lastSnap.arcMeters| > 50 m`). Conservative — 2–5 min legitimate terminus dwells do not flap.

**What runs now:**
- `js/markers.js` `_arcTick` / `_bearingTick` — per-marker rAF integrators, continuous-loop design (params refreshed each WS frame; rAF not cancelled/restarted)
- `startDeadReckoning(markerKey)` — rail/light-rail arc-based DR; cap derived per-call from `routeStops[rc|dir].arcMeters` via direction-uniform scan
- `startBearingDeadReckoning(markerKey)` — busway and shapeless-route bearing-based DR
- `_heavyRailScheduleSpeed` — B/D Line schedule-cruise fallback when GPS reports speed=0 in tunnel
- `isNearIntersection` from `js/intersections.js` + `data/light-rail-intersections.json` — light-rail red-light vs tunnel-dropout disambiguation
- `_isStoppedAtMisfire(marker, vehicle)` — used at both pin sites; thresholds in `STOPPED_AT_MISFIRE_*` constants
- DR constants in `config.js`: `DR_SPEED_FACTOR`, `DR_SPEED_ALPHA`, `DR_SPEED_GLIDE_TAU_S`, `DR_DECEL_ZONE_M`, `DR_DECEL_RATE_MPS2`, `DR_HEAVY_RAIL_FALLBACK_MPS`, `INTERSECTION_PROX_M`, `DR_MAX_SECONDS`, `DR_MAX_SECONDS_RAIL`, `RAIL_SNAP_MAX_M`, `STOPPED_AT_MISFIRE_SPEED_MPS`, `STOPPED_AT_MISFIRE_AGE_S`, `STOPPED_AT_MISFIRE_ARC_DELTA_M`

ETA path stays as the simplified blend (PR #192): GTFS-RT if present, else calc. Animation and popup are no longer guaranteed to agree numerically (each is correct on its own axis); the pre-Phase-5 visible drift between marker and popup returns. That's an acceptable trade vs the bugs the unified architecture introduced.

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
- 3-way `headToHead` between calc / gtfs / blend

**Distribution-hygiene note:** weekend service is materially different from weekday (lighter headways, less rush-recovery operator pressure). Pool within the same group (weekday / weekend) only when computing headline accuracy stats. The aggregator's cluster-bootstrap CIs work fine either way; this is an analysis-hygiene point.

---

## Observability — feed-stats counters

`js/feedStats.js` prints a per-minute log line summarizing pipeline health. Categories (each counter resets per tick):

| Category | Counters | Wired in |
|---|---|---|
| Per-feed | `received` / `accepted` / drops `noPosition` / `nonFinite` / `noTripId` / `invalidTs` | `api.js` |
| Marker ingest | drops `staleAge` / `olderTs` / `spike` / `coldStartSpike` | `markers.js` |
| Freeze episodes (PR #202) | `watchdogRail` / `watchdogBus` / `offRoute` / `noSnap` / `intersectionPause` / `bearingBudgetExhausted` / `stoppedAtMisfire` / `animateMarkerRace` | `markers.js` (episode-gated, not per-frame) |
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

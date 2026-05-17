# Project Status — Snapshot

Last refreshed at the close of the Phase-5b pivot.

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-05-17.

---

## Phase 5b — blend-anchored animation (shipped)

The full doc is [`docs/phase-5b-anchor-animation.md`](./phase-5b-anchor-animation.md). Predecessor (replaced): [`docs/_archive/trajectory-overhaul.md`](./_archive/trajectory-overhaul.md), [`docs/_archive/phase-5-wiring.md`](./_archive/phase-5-wiring.md).

**Premise:** Phase 5's Kalman-driven trajectory was supposed to replace both DR animation AND the blend ETA. 2026-05-16 weekend captures showed trajectory ETA was ~10× worse than blend on paired comparisons — the assumption that a physics model could beat GTFS-RT (which has dispatcher information physics cannot reproduce) was wrong. Pivot: use blend as the single source of truth and back-compute the animation from it.

**Architecture in one line:** `popup ETA = animationBuilder cruise input = renderLoop arrival time`. Animation and popup are the same number by construction.

**Modules:**
- `js/animationStore.js` — `Map<tripId, AnimationEntry>` singleton
- `js/animationBuilder.js` — `buildAnimationTrajectory({...})` back-computes cruise from blend ETA
- `js/animationWiring.js` — `updateAnimationFor({...})` called on every WS fix; 250 ms debounce
- `js/renderLoop.js` — single rAF reads `animations.values()`, evaluates `positionAt(now)`, updates marker DOM
- `js/predictions.js blendEtaForNextStop(marker, now)` — slim per-marker blend computation

**Runaway / overshoot protection (5 layers):** builder speed clamp → trajectory terminal-arc clamp → per-frame `stopArcCap` re-check in renderLoop → staleness gate → anchor refresh ≤ 5 s. Each independently sufficient; details in the phase-5b doc.

**No `USE_TRAJECTORY_MODEL` flag** — single architecture, no A/B branching.

---

## Open follow-ups

- **Cold-start glide.** Legacy DR's `animateMarker` smoothed the ~1 s jump from old marker position to new GPS. New model lets the renderLoop teleport at 60 fps. Pin in visual QA; add a small glide back if riders notice.
- **Direction-reversed polylines.** Same deferred gap as Phase 5 — `nextStopArc <= currentArc` returns a tiny dwell trajectory and marker stays at the GPS snap. Fix is signed-arc translation; orthogonal.
- **Intersections data.** `data/light-rail-intersections.json` + `js/intersections.js` are no longer consumed by production code. The new GPS-speed=0-fresh check in `animationBuilder` handles red-light freeze without crossing data. Decide whether to delete the data file + module in a cleanup PR.

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

The headless harness writes a three-way summary (calc / gtfs-rt / blend) per horizon × route. Trajectory column was removed in the Phase 5b pivot — the new animator consumes blend ETA rather than competing with it, so there is nothing to A/B. Cron schedule in [`.github/workflows/live-accuracy.yml`](../.github/workflows/live-accuracy.yml):

| When | Tag prefix | Purpose |
|---|---|---|
| Mon–Fri 15:00 UTC (08:00 PDT) | `peak-am-` | Weekday AM peak |
| Mon–Fri 20:00 UTC (13:00 PDT) | `offpeak-` | Weekday mid-day |
| Sat–Sun 15:00 UTC | `weekend-am-` | Weekend AM |
| Sat–Sun 18:00 UTC | `weekend-mid-` | Weekend mid-morning |
| Sat–Sun 21:00 UTC | `weekend-pm-` | Weekend afternoon |
| Sat/Sun 00:00 UTC | `weekend-eve-` | Weekend evening (17:00 PDT prior day) |

60-min capture each; artifacts retained **90 days**.

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
| Markers | drops `staleAge` / `olderTs` / `spike` / `coldStartSpike` | `markers.js` |
| Animation builder | drops `noCache` / `noNextStop` / `dirReversed` / `missingArc` / `noBlendAnchor` | `animationBuilder.js` |
| Render rAF | skips `stale` / `noTraj` / `noShape` / `stopArcCap` | `renderLoop.js` |
| Ghost arrivals | count of trip_updates entries with no matching marker | `feedStats.scanGhostArrivals` |

When the renderer is misbehaving on a particular route, the per-minute log line tells us whether the issue is "couldn't build a trajectory" (animation counters non-zero) vs "built but renderer clamped" (`stopArcCap` non-zero) vs "ETA stale" (`stale` non-zero). Triages much faster than re-running with debug logs.

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

### 2. Direction-reversed polyline trips
**Location:** `js/animationBuilder.js`

Trips whose `direction_id` traverses the polyline in reverse produce
`nextStopArc <= currentArc`, so the builder emits a tiny dwell and the marker
sits at the snapped GPS position without animating along the polyline. Same
deferred regression as Phase 5; fix is signed-arc translation independent of
the animation model.

### 3. Two popup-refresh tickers (1s + 5s)
**Location:** `js/markers.js` (1 s age counter) + (5 s ETA rebuild)

For a single open vehicle popup, two `setVisibleInterval` callbacks fire.
Harmless churn but ugly. Revisit when popup is next touched.

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
  not add them. Phase 5b's `animations` map is a module-singleton export
  from `js/animationStore.js`, not a `window.*` entry.

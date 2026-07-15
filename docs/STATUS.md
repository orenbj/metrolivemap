# Project Status — Snapshot

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-07-14. Test count: **1115/1115 passing** (vitest, jsdom).

For the always-current contract — motion model, feed-data gates, freshness
tiers, cross-module globals — see [`CLAUDE.md`](../CLAUDE.md). This file is a
point-in-time orientation snapshot, not the source of truth.

---

## Current motion model — bounded arc-glide (PR #257)

The full contract — glide rules, re-anchor thresholds, every gate, the key
constants at a glance — lives in CLAUDE.md's "Motion model" section; this
snapshot doesn't restate it (restating it here was the same facts drifting
independently in two places). Headline: dead-reckoning was retired entirely
(net ~−1,500 LOC); the marker only ever moves to positions GPS confirms.

> **Tunnel "freeze" — MEASURED, the old claim was wrong.** A 20-min live
> probe (feed-reliability run 2026-06-10, `tunnel-freeze-fixage-probe`, now
> instrumented in `scripts/audit-feeds.js`) shows the fully-underground B/D
> subway lines move on **78 % / 81 %** of consecutive fixes — essentially the
> same as the surface lines (A 85 %, C 76 %, E 77 %, K 73 %) — with ~55 m
> median steps. Positions **do advance underground**; the markers do not
> freeze for minutes. What IS elevated underground is fix **age at delivery**
> (B/D p90 ≈ 181–286 s vs surface ≈ 8–29 s) — the dot keeps moving but lags
> reality more. Rare multi-minute still-episodes exist (B/D max 305–736 s) but
> the still-episode p90 is only 24–37 s (normal dwell). Net: the mid-tunnel
> declared-stop anchor the motion audit floated is **moot** — there is no
> sustained freeze to fix, only data-source latency, which no client code can
> reduce without extrapolating.

What was removed (the full DR integrator + every extrapolation-compensating
mitigation) and the "do NOT re-introduce a `speedFactor`" warning to future
contributors are both in CLAUDE.md's "DR is gone" bullet — not repeated here.

---

## Recent landings (headlines)

PR-by-PR detail lives in the git log; this is the orientation summary.

- **Pre-meeting final review — correctness + a11y + hygiene (2026-07-14)** — a
  comprehensive five-lane review (motion core, feed pipeline, UI/a11y,
  security/deploy, docs/tests/CI) ahead of the web-team meeting. Findings fixed
  in three batches: **(A) correctness** — a follow-on to the #559 suspend/resume
  race (`api.js` keys `_activeSockets` by URL, so a stale suspended socket's
  deferred `onclose` firing after resume clobbered the replacement's registry
  entry; now identity-guarded), the hidden-tab suspend timer now arms when a tab
  *loads* already hidden (was only armed on `visibilitychange`), `getBoardingVehicles`
  now reads `departureUnix` (real pull-out) instead of `arrivalUnix` so a layover
  dwell no longer reads "Departs Now", an arc-space guard on `_stopLagFromDeclared`,
  an `r.ok` guard on the midnight GTFS reload, an `end > now` filter on bus-bridge
  detection, and a bounded self-heal retry for the micro-zones one-shot load.
  **(B) a11y/keyboard** — Escape-to-close for map popups (via a new
  `closeActivePopup()` on the single-popup coordinator), `visibility:hidden` on
  three invisible-but-tabbable states (closed alerts panel / desktop legend /
  collapsed rows), focus preservation across the station-popup refresh, iOS
  search auto-zoom suppression (16px on touch), and an accessible name on the
  boarding pill. **(C) hygiene** — removed the write-only `_lastFreshTs` marker
  state, trimmed the unused `lacmta.github.io` from `connect-src` (kept in
  `img-src`) + added `form-action 'none'`, and doc corrections. Deferred to the
  meeting: Google Fonts self-hosting and a few UX behavior calls. +13 tests.
- **Repo housekeeping — redundant nested manifest removed (PR #568,
  2026-07-09)** — `scripts/package.json` contained only `{"type": "module"}`,
  a no-op duplicate of the root `package.json`'s own `"type": "module"`
  (Node's module-type resolution walks up the directory tree to the nearest
  `package.json`). Confirmed no workflow `cd`s into `scripts/` before
  invoking `node` and nothing references the file by path; `build-shapes.cjs`
  is unaffected since `.cjs` always forces CommonJS regardless of any
  `package.json`'s `type` field.
- **Documentation housekeeping batch (PRs #560–#564, 2026-07-07)** — a full
  documentation review (accuracy + completeness + editorial + cross-doc
  consistency across all 7 markdown docs, done in one context so cross-file
  redundancy was actually visible) found the codebase itself clean but
  surfaced doc drift: this "Recent landings" section hadn't caught up to the
  #558–#559 audit fix above (#563 added that entry), and CLAUDE.md was
  missing two real production mechanisms — the arc-space guard and
  `correctJLineRouteTag()` — now documented with their `arcSpaceReanchor` /
  `jRouteRetag` counters. A companion code-level pass (#562) fixed 9 JSDoc
  blocks left glued above the wrong function after an unrelated helper was
  inserted directly above them (`computeHeading`, `_fadeOutAndRemove`,
  `initPredictions`, `lngLatAtArc`, `_accessFacilityLabel`,
  `initVisibilityHandler`, `scanGhostArrivals`, `processUpdate`,
  `initBikeShare` each got their doc moved back to the function it actually
  describes — pure comment relocation, no code moved). A test-coverage
  companion (#560) closed gaps the #559 race fix had shipped without: a
  `tripUpdates.js` mirror of `api.js`'s deferred-`onclose` suspend/resume
  regression test, bike-share startup-failure self-heal coverage, and the
  `updateUpdateTime()` epoch-second throttle (+7 tests). Mechanical cleanup
  (#561) refreshed the test count across 5 docs, added the missing
  `[Unreleased]` CHANGELOG entry for the #559 fix, and regenerated
  `package-lock.json`'s drifted root version field; #564 then caught the
  1095→1102 gap once #560's new tests landed on the same `main` the doc
  counts had been set against.
- **Whole-app audit + housekeeping (PRs #558–#559, 2026-07-06/07)** — a
  full-repo single-reviewer audit (following two earlier parallel-lane audits
  that found the codebase clean) caught a cross-module race the lane-scoped
  passes structurally couldn't: `suspendFeeds()` relied on the async `onclose`
  handler to empty the WS socket registry, so a fast tab-return after a
  hidden-tab suspend could run `resumeFeeds()` while every socket still looked
  "active," skip reopening them, and leave **all live feeds silently dead**
  (markers fading, popups emptying) while the connection dot stayed green —
  recoverable only by the next long backgrounding or a reload (#559, HIGH).
  Fixed in both `api.js` and `tripUpdates.js` by emptying the registry
  synchronously in `suspendFeeds()`; guarded by a deferred-`onclose`
  regression test a synchronous-mock test harness structurally couldn't have
  caught. Also: a per-frame `updateUpdateTime()` throttle, a bike-share
  startup-failure self-heal, and a stale localStorage threat-model comment
  fix. A prior housekeeping pass (#558) fixed a stale workflow PR-body line,
  two dead exports, and broken archived-doc links.
- **Nearby-bus rider-facing destinations + handover close-out (PRs #541–#551, 2026-06-26)** —
  the station popup's nearby-buses now show the **rider-facing destination** ("Santa
  Monica") instead of the live feed's terminus stop name (often an obscure
  intersection). Backed by a new committed `data/bus-destinations.json` (a compact
  `byRouteDir` dominant + `byTrip` minority-branch map built from the bus GTFS
  `destination_code`; `resolveBusDestination()` in `predictions.js`), with a
  build-time guard + contract test (#544). Also: tooltip de-dup, always-show
  cardinal direction, nearby-bus list scroll-position preservation, **next-stop
  ETA minutes switched from floor → round-to-nearest to match Metro's platform
  countdowns** (#549), and the upstream MIT provenance attribution to
  `LACMTA/realtime-map` / `LACMTA/livemap`. An adversarial code audit (clean) and
  a docs/organization readiness pass preceded the handover. Mechanics in CLAUDE.md.
- **Handoff-prep batch (PRs #519–#528, 2026-06-17)** — repo readied for transfer
  to a future maintainer. Added the owner-transfer guide (`HANDOFF.md` §12) and
  corrected the service-alert endpoints' provenance (the two `*.lambda-url.on.aws`
  URLs are undocumented — most likely Metro's alerts.metro.net backend, unverified;
  §12.2 has the JSON contract to rebuild them). Made the uptime-check probe URL
  owner-agnostic (#522). Shipped audit fixes: an "alerts unavailable" UI state so a
  feed outage isn't mistaken for "no disruptions" (#523, D2), and a Permissions-gated
  startup geolocation so the app no longer fires an unsolicited prompt on load
  (#524, D3). **Removed the dist/release packaging** (`package-release.cjs`,
  `release.yml`, `SELF-HOSTING.md`) — a no-build site's "dist" was only a filtered
  copy; the handoff is the git repo (#526). Archived the now-historical
  `LAUNCH-READINESS.md` (#527). A perf pass trimmed per-frame work on the marker/feed
  hot paths — the glide tick no longer computes an unused bearing every frame (#528).
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
  [`_archive/LAUNCH-READINESS.md`](./_archive/LAUNCH-READINESS.md) (historical).
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
promote the skipped-stops paragraph, and append `Active: <window>`. Pinned by
`tests/alert-prose-normalize.test.js` (before/after against a real 2026-05-16
corpus). Original audit:
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
| Marker corrections/events | `hardReanchor` / `streakForceAccept` / `declaredAnchor` / `backwardRelease` / `stopLagReanchor` (episode-gated) / `crossLineSpike` / `arcSpaceReanchor` / `jRouteRetag` | `markers.js` (`_markerStats`) |
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
but **visual freshness reads `marker._lastAcceptedWallMs`** — the wall-clock RECEIPT
time of the last accepted fix, which advances only on accepted fixes. A frozen
marker with bad GPS correctly goes gray or expires rather than staying green, while
a live train on a lagging feed stays green. (`_lastAcceptedTs`, the GPS-fix clock,
still drives predictions' data-staleness gate — a different question.) See
`js/freshness.js` `getFreshnessTier` and the freshness-tier note in CLAUDE.md.

### 3. `chooseBadgeSlots` cornerPlacement asymmetry
**Location:** `js/boardingBadges.js`

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
  `marker._lastAcceptedWallMs` (receipt clock; advances only on accepted fixes),
  while `_lastAcceptedTs` (GPS-fix clock) drives the predictions staleness gate.
  See CLAUDE.md "Vehicle freshness tiers" for the full contract.

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

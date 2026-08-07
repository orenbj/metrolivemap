# Project Status — Snapshot

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

**Refreshed:** 2026-08-05. Test count: **1216/1216 passing** (vitest, jsdom).

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

- **Station popup: opens below the dot; terminus rows show the real departure
  (PR #616 + #617, 2026-08-05)** — the popup is now pinned `anchor: 'top'` so
  the nearby-buses `<details>` unfolds DOWNWARD instead of shoving the station
  name and arrivals up the screen (measured −36 px at 1280×900; invisible on
  mobile, where the wrap is already at its 45vh cap). Fixing the anchor gives up
  MapLibre's auto-anchor, so `_keepPopupOnScreen` replaces that protection — and
  its four rules each exist because breaking one shipped a bug: pinned-only (a
  hover preview was dragging the map), defer-don't-drop on an easing camera (a
  `panBy` was cancelling the search `flyTo`, then dropping the correction
  entirely for that same path), a DELEGATED toggle listener (`toggle` doesn't
  bubble and the 5 s refresh `replaceWith`s the `<details>`, so it worked once
  then never again), and suppression of the refresh's own `open = true` restore
  (which queues a synthetic `toggle` and panned the rider's map back every
  5 s). Separately, terminus rows were measuring the wrong event: the origin
  branch overwrote each entry's `departureUnix` with `arrivalUnix`, i.e. when
  the train pulls IN to lay over rather than when it pulls OUT, and the
  10-minute boarding horizon then hid whatever was left — so Pomona North read
  "—" while La Verne one stop down showed the same train at 13m. An
  adversarial review of the first attempt killed a derived-departure estimator
  built on a premise the repo contradicts (see CLAUDE.md); the change set ended
  up smaller than it started. All popup behaviour is now pinned by
  `tests/station-popup-onscreen.test.js` and mutation-verified — one test
  initially passed for the wrong reason and was caught by that.

- **Merged-alert attribution made structural (PR #614 + follow-up, 2026-08-04)**
  — `dedupeAlertsByEffect` builds its merged entry with `{ ...a }`, which
  inherits only the FIRST alert's fields, so every PER-ALERT field had to be
  carried separately — and each one that wasn't produced the same
  mis-attribution bug in turn: `activePeriod` (a "Detour ×2" banner showing
  "– Jun 30" over a body saying "ends December 31"), then `routes` (a D Line
  detour merged after a B Line one rendering under the B logo, #614), then
  `header` (the badge tooltip titling every merged block with the first
  alert's headline). Three parallel index-aligned arrays meant a fourth field
  could silently miss one. Replaced them with a single `_members[]` array of
  `{ description, header, activePeriod, routes }` — adding a per-alert field is
  now one edit that cannot fall out of alignment. The station-popup service
  banner render path (`_renderServiceAlerts`) had NO test coverage while
  carrying all three bugs; it is now exported and pinned by 7 characterization
  tests written BEFORE the refactor, so the rewrite provably preserved the
  rendered HTML.
- **Alert tooltips lead with the affected line's logo (PR #607 + #608,
  2026-07-27/28)** — a station alert badge or bus-bridge glyph is often the
  rider's only cue for WHICH line an alert belongs to, so the tooltip's title
  row now opens with the official LACMTA line tile(s).
  `buildAlertTooltipBlock` returns a `routes` field; `_renderTooltipDom`
  stamps one 16px tile per route, filtered to `METRO_ROUTE_CODES`, deduped by
  line LETTER (J = 910 + 950 share a tile) and sorted by letter. **#607 shipped
  as a no-op and #608 fixed it** — `_alertRouteCodes` read
  `alert.informedEntities`, which exists only on the RAW feed alert;
  ingestion normalizes it away, and the normalized `entry` is the only object
  the tooltip layer ever sees, so `routes` always resolved to `[]`. The entry
  now persists its already-filtered `routeCodes`. Cautionary note for future
  work: the original tests passed against broken code because they hand-built
  alerts *with* `informedEntities` — a shape production never produces; the
  regression test drives the real `initAlerts` pipeline instead.
- **CI: branch cleanup workflow (PR #606, 2026-07-27)** — `branch-cleanup.yml`
  (Mon 10:00 UTC + manual, `dry_run: true` by default) deletes remote branches
  whose PR already merged into `main`. Cleared a 78-branch backlog; the repo
  now sits at `main` plus whatever is genuinely in flight. Skips `main`,
  branches still backing an open PR, and already-deleted refs; closed-but-
  unmerged PR branches are deliberately left for a human.
- **CI: one GTFS rebuild trigger, and drift-check stops crying wolf
  (2026-08-04)** — **partially reverses PR #598 (below).** The drift-check's
  weekly cron ran Monday 08:00, one hour before `rebuild-gtfs.yml`'s own 09:00
  cron, and its 5% threshold sits far below Metro's real weekly trip_id churn
  (~45% — issue #609 measured 4304 stale / 4259 new against ~9.5k committed
  trips). The scheduled run was therefore *mathematically guaranteed* to fail
  every week: **8 of the last 9 scheduled runs went red**, each filing a
  `gtfs-drift` issue and auto-dispatching a rebuild an hour before the cron
  would have rebuilt anyway — producing **two identical rebuild PRs per week**
  (#610 + #611) and a permanently-red workflow with no readable signal.
  Removed the drift-check's `schedule` trigger and its auto-dispatch step (and
  its now-unused `actions: write` permission); it keeps the `push` trigger, so
  it runs against freshly-merged data where drift should be ~0% and a red run
  means "the rebuild didn't fix the drift" rather than "a week went by" —
  those push-triggered runs stayed green throughout the period the scheduled
  ones were failing. `rebuild-gtfs.yml`'s Monday cron is now the single rebuild
  trigger, with a new `guard` job that skips when a `gtfs-data` PR is already
  open (workflow-level `concurrency` couldn't catch this — it only cancels runs
  still *in flight*, and #610 had already finished when #611 started).
- **Simplify sweep — whole-codebase dedup and dead-code pass (PR #593,
  2026-07-16)** — a pure quality pass, no behavior changes: deduped several
  reimplemented helpers (`feedStats.js`'s `isRenderedMarkerRoute` called
  `isBrtRoute()` inline instead of the shared `utils.js` helper of the same
  name; `busBridges.js`'s `_chordPerp` hand-recomputed the `planarMeters()`
  formula for chord length; a repeated suffix-aware stop-lookup pattern in
  `markers.js` extracted into `_lookupStop()`/`_resolveTripStops()`), removed
  dead code (`ui.js`'s no-op `updateFilterButtons()`, left over from the
  removed Show All/Hide All buttons), extracted a shared `isDomMarkerTarget()`
  DOM-ownership-guard helper (previously copy-pasted across `stations.js` and
  `microzones.js`), and pulled a shared `parseDuration()` into a new
  `tests/_lib/cli-utils.js` used by 4 CLI scripts (`audit-feeds.js`,
  `live-accuracy-harness.js`, `live-accuracy-headless.js`,
  `perf-baseline.js`).
- **Audit fixes — arc-space ETA guard, dark-mode layer loss, outage-time
  station info, and 20+ correctness fixes (PR #597, 2026-07-22)** — a large
  batch (~20 fixes) from a comprehensive correctness audit. Two HIGH:
  `computeTripAdherenceOffset`/`gtfsLooksPlausible` in `predictions.js`
  compared the marker's snap arc against the stop cache's arc without
  verifying they share a shape space — on split routes (`801|0`/`802|0`/
  `910|0`/`950|0`, built reversed vs. the bare shape) a dropped
  `direction_id` produced cross-space garbage that could silently reject
  good real-time arrivals as "impossibly soon"; now bails to
  schedule-only/trust-feed when `cache.shapeKey` disagrees with the marker's
  `_currentArcKey`. A rapid dark-mode double-toggle could drop the station
  and micro-zone map layers (`main.js` registered a `once('style.load')` per
  toggle event, so only the first survived); replaced with one persistent
  `on('style.load')` handler. Rider-visible mediums: the station popup no
  longer goes blank during a service outage (it used to early-return on zero
  arrivals, suppressing alerts/stale-feed-banner/nearby-buses exactly when
  riders need them most), a vehicle-popup car-number "#null" flicker fixed
  (the popup rendered the raw frame's `vehicle_id`, null on ~47% of frames,
  instead of the marker's adopted id), a duplicate-train ping-pong-teleport
  bug fixed (`_supersedeDuplicateTrip` now only fades a twin OLDER than the
  incoming fix), a legend alert badge that deduped by effect instead of
  alert id (dropping distinct simultaneous same-effect alerts), an ETA that
  got stuck showing "Now" for a late train (the adherence taper was zeroing
  a legitimate overrun offset), and a couple of geolocation/follow-restore
  race fixes (a failed follow-restore no longer fires an unsolicited
  geolocation prompt; auto-locate no longer hijacks a live follow). Plus
  assorted low-severity hardening (GTFS-builder BOM/empty-direction
  robustness, an episode-gated `jRouteRetag` counter, bikeshare/PWA
  self-heal fixes).
- **CI: auto-dispatch the GTFS rebuild when drift is detected (PR #598,
  2026-07-22)** — ⚠️ **superseded 2026-08-04 (see the top entry)**: the
  auto-dispatch and the drift-check's weekly cron were both removed after the
  dispatch proved to fire every week and duplicate the rebuild cron. Original
  intent: the weekly drift-check workflow automatically
  dispatches `rebuild-gtfs.yml` when it detects significant drift, instead
  of only filing an issue for someone to act on manually — self-healing
  into a ready-to-review rebuild PR (a human still reviews/merges it). A
  duplicate-PR guard skips the dispatch when a gtfs-data rebuild PR is
  already open, so drift-check runs can't pile up rebuild PRs.
- **Review-findings batch — motion edge cases, popup eviction, CI hardening
  (PR #588, 2026-07-16)** — three fix lanes closing out issues surfaced by the
  #580 review. **(A) motion model** — `STOPPED_AT` off-polyline stops (Union
  Station B/D, G Line Canoga) now actually render on the platform: the glide
  target was set correctly but the rail render still used `lastSnap.arcMeters`
  (the sideways projection), so the documented platform behavior never
  materialized — those cases now divert to the bounded straight-line branch.
  `isOnDifferentLine` measured own-line distance against only the canonical-
  direction shape, so a vehicle on the non-canonical side of a one-way couplet
  read as off its own line every frame; it now takes the min over the bare and
  per-direction splits. `updateExistingMarker` now adopts a non-empty feed
  `vehicle_id` on an existing marker instead of leaving it permanently null
  (Metro omits `vehicle.id` on ~47% of frames), which had been quietly
  defeating duplicate-supersede, the ETA join, and ghost accounting for
  affected trips. **(B) popup eviction** — the single-popup coordinator now
  tracks a lazy pinned-predicate (`isActivePopupPinned()`) that every hover-
  preview path (vehicle/station/bike) checks first, so grazing a station dot
  no longer evicts a pinned vehicle popup and vice versa; plus an Escape-key
  propagation fix, a micro-zone double-open guard extended to J Line street
  stops and DOM markers, and an alert-badge tooltip orphan fix
  (`hideAlertTooltipForAnchor()` runs before badge-marker removal). **(C) CI
  observability** — `live-accuracy-headless.js`'s `summarize()` spread was
  clobbering the hand-built run metadata (tag/runStarted/snapshotsTotal);
  fixed the merge order. `gtfs-drift-check.yml` now fails loudly on a bad
  upstream download (`curl --fail` + retries) instead of silently diffing an
  HTML error page, and `rebuild-gtfs.yml` gained a second failure fallback for
  a build crash (the existing one only covered a blocked PR). `feedStats.js`'s
  ring key omitted feed type, so an operator's vehicle-positions and
  trip-updates stats collided in `localStorage.feedStatsRing` and the VP side
  (the primary pipeline the ring exists to audit) was silently dropped; keys
  now carry a vp/tu suffix. +doc-drift fixes across CLAUDE/README/STATUS/HANDOFF.
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
| Marker hygiene | `offRoute` / `vehicleNoArrivalMatch` (both episode-gated, not per-frame) / `popupDOMOrphan` (popup-counter vs DOM divergence) / `midnightTripIdMiss` (batch: vehicles rendering with degraded static context across a service-date rollover) | `markers.js` / `main.js` |
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

- **The suite is shuffle-enforced in CI** (`tests.yml` runs a second
  `--sequence.shuffle` pass with a random seed). Five order-dependence bugs
  were found and fixed once shuffling was tried: un-awaited alerts fetch
  chains clobbering a later test's maps (fixed with generation fencing in
  `_fetchAlerts`), the alerts-panel `_activeTab` leaking across tests, two
  tests silently depending on an EMPTY predictions route cache (the ⅔
  route-wide badge suppression fired once a tiny fixture route was cached),
  `feedStats._markerStats` not being covered by `_resetFeedStatsForTest`,
  and a `mockReturnValue` surviving `vi.clearAllMocks()` in search tests.
  On a CI shuffle failure, vitest prints the seed — reproduce with
  `npx vitest run --sequence.shuffle --sequence.seed=<seed>`.
- **`_buildStationRouteMap` deliberately does NOT seed origin/terminal rows**
  (`js/stations.js`). It skips any route+dir where `isOriginStop` or
  `isTerminalStop` holds, on the reasoning that origins are covered by
  `boardingAtOrigin` and terminals are suppressed by `renderRow` anyway. The
  consequence is worth knowing before debugging a blank terminus: when the feed
  has NO arrivals for a route at that station group in EITHER direction, no row
  renders at all — not even an em-dash — so anything hung off `_renderRowPills`
  is unreachable in exactly that scenario. This is what made a derived
  terminus-departure tier dead code (PR #617).
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

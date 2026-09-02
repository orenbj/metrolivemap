# Full-App Review — 2026-09-02

A point-in-time review of the whole application: rider-facing UX and mobile, data correctness and
motion, security and privacy, accessibility, performance and resilience, secondary features, CI and
the data pipeline, test quality, and documentation. Weighted toward the first three at the owner's
request; nothing was left uncovered.

Per `docs/audits/README.md` this file is a snapshot and is **not** rewritten later. Findings fixed
after this date stay listed here as they were found.

## What was done

Ten reviewers each owned a slice of the codebase, split by concern rather than by file so that no
two people filed the same defect from different angles (the few that still overlapped are recorded
as duplicate groups below — independent rediscovery is a useful signal, not noise). Every reviewer
read `CLAUDE.md` first and was told that a finding contradicting a documented decision must engage
with the stated rationale rather than re-litigate it.

Then a separate set of verifiers tried to **reproduce or refute** each finding without trusting the
reporter's evidence. Nothing reaches the confirmed list on an argument alone:

| Tier | Standard | Confirmed at this tier |
|---|---|---|
| **T1** Executable | a test that fails on today's code for exactly the claimed reason | 39 |
| **T2** Observed | the verifier's own capture, plus the DOM node and CSS rule responsible | 19 |
| **T3** Measured | ≥3 runs with spread reported | 0 |
| **T4** Reasoned | traced code path only — capped at medium, barred from fix PRs | 5 |

## Results

**93 findings → 86 after folding 6 duplicate groups and 1 already-known item → 63 confirmed,
2 plausible, 21 unverified, 0 refuted.**

Confirmed: **7 high, 38 medium, 18 low.** No critical. Where a fix was cheap, verifiers prototyped
it and confirmed the probe turned green with the existing suites still passing.

### The seven high-severity findings

1. **Short-turn trips are labelled with the wrong terminus** (R3a-01). A G Line bus turning at
   Canoga renders as "Chatsworth". Measured on committed data: **88 of 350 westbound G Line trips,
   25%.** The correct headsign is already in `masterTripsData` and is discarded. This is the
   clearest "wrong information shown to riders" defect found.
2. **The iOS install hint covers the legend handle and the map attribution** (R5-01, found
   independently three times). On iPhone it appears automatically 4 s after every non-dismissed
   load, so it is the default first-run state — and while it is up, the legend cannot be opened at
   all. It also covers the basemap credit the tile licences require.
3. **A vehicle popup steals keyboard focus every ~5 s** (R6-01). While any vehicle popup is open
   anywhere on the map, focus is yanked back into it, which makes search, the legend and the alerts
   panel unusable by keyboard. Cause is MapLibre's `setDOMContent` calling `_focusFirstElement` on
   every refresh; `js/stations.js` already has the save/restore pattern that fixes it.
4. **Markers are keyboard-focusable but named "Map marker"** (R6-02) — and the VPAT-facing claim in
   `docs/HANDOFF.md` that they are pointer-only is false, so the documented remediation plan targets
   the wrong problem.
5. **An empty `stops.json` silently blanks the entire fleet** (R9-01). A successfully-parsed but
   empty file passes every check, then `preBootstrap` drops every vehicle frame for the rest of the
   session. Reproduced end-to-end: splash clears normally, no banner, 440 frames received, 0
   rendered. The failure banner that does exist says only that data "may be limited".
6. **and 7. Two mutation-confirmed test gaps** (R9-04, R9-05) — the bus-destination compaction
   algorithm has zero tests despite being exported "for tests", and the `_lastKnownDir` arc-space
   fallback that `CLAUDE.md` marks **"do NOT simplify"** can be deleted entirely with all 1,226
   tests still green.

### A pattern worth naming

Three separate reviewers found the same thing independently: **a guard the documentation calls
"pinned" or "mutation-verified" that is not.** `_restoringDetails` (R9-06), `_lastKnownDir`
(R9-05), and the vehicle-search landing order (R10-05) each survive mutation with the suite green.
In the last case the claim was written in this repo's own voice and is only partly true — one of
the three ordering constraints is genuinely pinned, two are not.

That is worth more than any single bug on this list. The repo's strongest habit is pinning
behaviour with tests and recording the rationale; where the pin silently does not hold, the
documentation actively misleads the next engineer. **Recommendation: treat "claims to be pinned" as
a category and sweep it** — every `CLAUDE.md` sentence of the form "pinned by `tests/x.test.js`"
deserves the mutation applied once.

### What was checked and found sound

Recorded so the report is not only bad news, and so nobody re-audits it next quarter:

- **No XSS.** Every HTML sink (20 `innerHTML`, 6 `setHTML`, zero `eval`/`document.write`) was
  traced to its source and driven with live payloads planted in stop names, destinations,
  `vehicle_id`, alert bodies and GBFS names. All escaped, in text and attribute positions alike.
- **The vendored MapLibre is byte-identical to npm `maplibre-gl@5.24.0`** after the documented
  source-map strip; no advisories.
- **The single-active-popup registry holds.** All five owners satisfy the full contract; no
  two-popups-open or unclosable-popup sequence could be constructed.
- **No memory or DOM leak** over ~320 s with forced GC across dark-mode toggles and popup cycles.
- **Committed `data/*.json` is structurally sound** — no orphan references, no non-monotonic times,
  100% bus-destination coverage.
- **Workflow permissions and injection handling are correct** — least-privilege throughout,
  untrusted inputs routed through `env:` rather than inline `${{ }}`.
- **No secrets, tokens or personal data** in tracked files; geolocation is never stored, logged or
  transmitted; the localStorage inventory holds no rider identity.
- The `window.*` cross-module contract in `CLAUDE.md` is **100% accurate today** — though nothing
  enforces it (R10-07).

## Honest limits of this review

- **No live capture ran.** The sandbox cannot open WebSockets, and the CI harness that would have
  captured the deployed site with real feeds and real basemap tiles
  (`scripts/review-live-snapshot.js`, PR #628) was not merged in time. Everything here rests on
  static reading plus a local replay harness with synthetic vehicles and flat grey tiles. Each
  finding carries a `fidelity` field saying which. Consequences: no claim about contrast against
  the real basemap, nothing about iOS-specific rendering, and **every frequency estimate is
  unverified** — how often the feed omits `direction_id`, how often `SKIPPED` is published, whether
  cross-line-ambiguous fixes persist long enough to matter.
- **`data/trips.json` was ~3 weeks stale** during the review (the weekly rebuild was broken from
  Aug 24 until #627 landed). Reviewers were pre-seeded with the symptoms so they were not re-filed
  as bugs, but a rebuild should land before the next capture.
- **21 low and cosmetic findings were never verified** — the budget went to the high and medium
  items. They are listed at the end as leads.
- No real screen-reader pass (VoiceOver/TalkBack) and no Windows High Contrast session; those
  findings rest on Chromium emulation and static CSS analysis.

## Suggested order of work

Sequencing that respects the dependencies the verifiers found:

1. **A + B first** — wrong information and the mobile/a11y blockers are what riders actually hit.
   Several are one-line CSS or a save/restore around an existing call.
2. **R1-03 and R1-05 must ship together.** Today a failed shape load never recovers, so there is no
   rejoin moment; adding the retry without the stale-arc fix turns a silent degradation into a
   visible fleet-wide backward jump.
3. **R2-02 and R3a-02 are the same two lines** in `js/predictions.js` — one edit.
4. **R2-01 and R3a-02 interact**: fixing either alone leaves the vehicle popup and the station row
   disagreeing about a terminus departure, in opposite directions.
5. **F (test gaps) alongside whatever it guards**, not as a separate pass — a pin written months
   after the fix tends to encode the fix rather than the behaviour.
6. Findings marked *touches a documented invariant* need the owner in the loop before work starts;
   they change something `CLAUDE.md` deliberately fixed in place. **14 of the 63 confirmed findings
   are in that category**, including four of the seven highs.

**Most of this is small.** 49 of the 63 confirmed findings are S-effort — a line or two plus a test.
14 are M. None are L. The high-severity list in particular is mostly one-line CSS, a save/restore
around an existing call, or using a field the code already has in hand.



---

## Confirmed findings, grouped as fix PRs

Ordered by severity within each group. "Tier" is how it was verified: **T1** a failing test, **T2** an observed capture, **T3** measured over ≥3 runs, **T4** traced only (capped at medium and excluded from fix PRs until upgraded).


### A. Wrong information shown to riders

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R3a-01 | high | T1 | M | Short-turn trips are labelled with the route's full terminus — a Canoga-turning G Line bus renders as "Chatsworth" (25% of G Line… | `js/predictions.js:976`, `js/predictions.js:957` +4 |
| R1-02 | medium | T1 | S | The 5 s popup ETA rebuild is gated on the GPS-fix clock (marker.timestamp) while every other visual gate uses the receipt clock, … | `js/markers.js:105`, `js/markers.js:2498` +2 |
| R2-01 | medium | T1 | S | Vehicle popup's boarding countdown reads arrivalUnix, not departureUnix — the exact bug fixed in getBoardingVehicles was never fi… | `js/markers.js:2062`, `js/markers.js:2051` +5 |
| R2-02 | medium | T1 | S | The J Line 910→950 retag is silently undone for every trip that has a live marker — getScheduledArrivals re-stamps the row with t… | `js/predictions.js:704`, `js/predictions.js:711` +5 |
| R2-03 | medium | T1 | M | SKIPPED-stop suppression is defeated two ways: the calc tier ignores SKIPPED entirely, and a stop re-flagged SKIPPED keeps its al… | `js/tripUpdates.js:291`, `js/tripUpdates.js:262` +3 |
| R3a-02 | medium | T1 | S | Origin/terminus departure rows still show the layover ARRIVAL for any train a marker is tracking — getScheduledArrivals drops dep… | `js/predictions.js:704`, `js/predictions.js:711` +4 |
| R3a-06 | medium | T1 | M | At all 11 end-of-line stations the popup drops BOTH the service-alert section and the stale-feed banner when there are zero arriv… | `js/stations.js:1082`, `js/stations.js:1092` +4 |
| R3b-03 | medium | T1 | M | A bus-bridge bracket + 🚌 glyph is drawn as soon as the ALERT is published, not when the closure starts — on the captured 2026-09… | `js/busBridges.js:100`, `js/busBridges.js:106` +1 |
| R8-02 | medium | T1 | S | Alert tier-2 period selection picks the array-order-FIRST unexpired future period, not the chronologically SOONEST one, when Metr… | `js/alerts.js:665`, `js/alerts.js:669` +1 |
| R8-05 | medium | T1 | S | Bikeshare popup shows raw bike/dock counts even for a station GBFS reports as not currently renting/returning — never reads `is_r… | `js/bikeshare.js:248`, `js/bikeshare.js:258` +1 |
| R3a-07 | low | T1 | S | Vehicle popup renders "Train Car #null" / "Bus ID null" for a marker that has not yet adopted a vehicle_id | `js/ui.js:1098`, `js/ui.js:1101` +2 |
| R3a-09 | low | T1 | M | A row's destination label is taken from its FIRST arrival only, so the second pill can belong to a trip going somewhere else | `js/stations.js:1353`, `js/stations.js:1442` +2 |

### B. Mobile & accessibility blockers

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R5-01 | high | T2 | S | The iOS "Add to Home Screen" hint sits on top of the legend bottom-sheet handle and the legally-required basemap attribution — th… | `styles/index-style.css:3155`, `styles/index-style.css:3157` +3 |
| R6-01 | high | T2 | S | Opening a vehicle popup lets MapLibre's setDOMContent() steal keyboard focus back into it on every live update, hijacking focus a… | `js/markers.js:1911`, `js/markers.js:1984` +3 |
| R6-02 | high | T2 | S | Every vehicle marker is keyboard-focusable with the generic accessible name "Map marker" — and the code/docs claiming vehicle mar… | `js/markers.js:953`, `js/markers.js:969` +3 |
| R3a-05 | medium | T1 | S | Station popup restores focus to its trigger on ANY close, including eviction by another popup owner — tapping a vehicle after a s… | `js/stations.js:654`, `js/stations.js:663` +3 |
| R5-02 | medium | T2 | S | `.pwa-install-banner` and `.toast` never reach their declared max-width on a phone — `position:fixed; left:50%` with `right:auto`… | `styles/index-style.css:3154`, `styles/index-style.css:3161` +2 |
| R5-03 | medium | T2 | M | First load on a phone is a look-but-don't-touch map: it boots at zoom ~8.1 where station dots are drawn but not tappable (STATION… | `js/map.js:41`, `js/config.js:345` +3 |
| R5-04 | medium | T2 | S | Vehicle markers are 12.75-15.5 CSS px and overlap each other at the default phone zoom — median nearest-neighbour spacing 12.4 px… | `js/config.js:468`, `js/config.js:470` +2 |
| R5-05 | medium | T2 | S | The legend's only interaction cue — "Click a row to toggle" — is `display: none` on every ≤1280 px viewport, so phone riders neve… | `styles/index-style.css:2314`, `index.html:243` +1 |
| R6-03 | medium | T2 | M | axe nested-interactive (serious, 14 nodes on both phone and desktop): legend rows and station alert/access badge map markers both… | `js/ui.js:441`, `js/alerts.js:1395` +3 |
| R5-07 | low | T2 | S | The loading splash is a wordless logo for up to 15 s — no text, no progress, no "still connecting" state | `index.html:104`, `styles/index-style.css:1720` +1 |
| R5-08 | low | T2 | S | `.station-popup-wrap.modern { max-height: 45vh }` on ≤1280 px lacks the `dvh` fallback the file uses everywhere else, so on iOS S… | `styles/index-style.css:2337`, `styles/index-style.css:2210` +1 |
| R6-06 | low | T2 | S | axe 'region' (moderate): the page <h1> and the entire legend/route-filter UI sit outside any ARIA landmark | `index.html:102`, `index.html:203` |
| R6-07 | low | T2 | S | axe 'aria-allowed-role' (minor): <header role="search"> is not a valid ARIA-in-HTML role for <header> | `index.html:122` |
| R6-08 | low | T2 | S | Vehicle markers have no custom :focus-visible style and no forced-colors support anywhere in the stylesheet | `styles/index-style.css:733`, `js/ui.js:441` |

### C. Silent-failure & resilience

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R9-01 | high | T2 | M | Boot-time data fetch has no schema/size validation — a successfully-parsed-but-empty stops.json permanently blanks every vehicle … | `js/main.js:38`, `js/main.js:46` +3 |
| R1-03 | medium | T1 | S | A single transient failure of rail-shapes.json permanently disables snapping, arc-glide, the cross-line guard and the cold-start … | `js/snap.js:67`, `js/snap.js:68` +3 |
| R1-04 | medium | T1 | S | A device clock running FAST by more than FRESH_EXPIRE_S drops 100 % of frames as `staleAge` with no alarm; at 120 s fast it selec… | `js/markers.js:660`, `js/markers.js:661` +2 |
| R2-04 | medium | T1 | S | trip_updates feed-health clock is stamped BEFORE the size gate and the parse, so a corrupt feed never trips the "Live feed delaye… | `js/tripUpdates.js:171`, `js/tripUpdates.js:183` +4 |
| R3b-01 | medium | T1 | S | busBridges still uses the per-toggle map.once('style.load') pattern main.js abandoned in #597 — a rapid dark-mode double-toggle s… | `js/busBridges.js:475`, `js/busBridges.js:476` +3 |
| R7-01 | medium | T1 | S | installErrorBoundary() does not actually run "first" — ESM import hoisting means every imported module's top-level code executes … | `js/main.js:8`, `js/main.js:11` +2 |
| R7-03 | medium | T1 | S | Neither WebSocket feed module listens for the browser's `online` event — after a real network drop+restore (tunnel, elevator, dea… | `js/api.js:279`, `js/api.js:321` +4 |
| R8-03 | medium | T1 | M | followVehicle.js never re-acquires a followed vehicle after Metro reassigns its trip_id mid-run — it declares the vehicle 'no lon… | `js/followVehicle.js:64`, `js/followVehicle.js:215` +4 |
| R9-02 | medium | T4 | M | uptime-check.yml can only detect a total outage or a corrupted HTML shell — it cannot detect a broken JS deploy, which is the mor… | `.github/workflows/uptime-check.yml:60`, `.github/workflows/uptime-check.yml:63` +2 |
| R2-08 | low | T1 | M | trip_updates ingest has no frame-ordering check — a re-broadcast or out-of-order frame overwrites a newer prediction | `js/tripUpdates.js:340`, `js/tripUpdates.js:343` |
| R3a-10 | low | T1 | S | Busway station dots are discovered by regexing the free-text trip headsign, not the route code — a Metro headsign rewording silen… | `js/stations.js:28`, `js/stations.js:561` |
| R4-07 | low | T4 | S | The alerts HTTP fetch has a timeout but no response-size bound, unlike the WS feed's oversize gate | `js/alerts.js:531`, `js/api.js:358` +1 |

### D. Feature correctness

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R8-04 | medium | T2 | S | Filtering the legend to a different route does not close an already-open popup for the now-hidden vehicle — it keeps floating and… | `js/ui.js:315`, `js/ui.js:447` +1 |

### E. Security & privacy hardening

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R4-01 | medium | T1 | S | Nothing pins the CSP inline-script hash to the frame-buster, so a one-character edit silently disables the app's only clickjackin… | `index.html:31`, `index.html:39` +1 |
| R4-02 | low | T2 | S | Frame-buster's hide fallback only runs if the top-navigation assignment THROWS; hiding first would not depend on that | `index.html:38`, `index.html:39` +1 |

### F. Test gaps & pipeline

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R9-04 | high | T1 | M | build-shapes.cjs's buildBusDestinationsJson (the "zero mislabels" bus-destination compaction algorithm) is exported "for tests" b… | `scripts/build-shapes.cjs:419`, `scripts/build-shapes.cjs:481` +1 |
| R9-05 | high | T1 | S | The _lastKnownDir arc-space-memory fallback (PR #597, explicitly "do NOT simplify" in CLAUDE.md) has zero test coverage — removin… | `js/markers.js:226`, `js/markers.js:217` |
| R10-05 | medium | T1 | S | CLAUDE.md claims the vehicle-search landing order ("togglePopup(), then toggleFollow") is "mutation-tested" in tests/search.test.… | `CLAUDE.md:114`, `js/ui.js:286` +3 |
| R3b-04 | medium | T1 | M | Every LIFECYCLE function in boardingBadges.js and busBridges.js is untested — 72 tests cover only the pure helpers, so the marker… | `js/boardingBadges.js:472`, `js/boardingBadges.js:651` +5 |
| R9-03 | medium | T4 | S | gtfs-drift-check.yml's filed issue tells the maintainer "a rebuild has been auto-triggered" — that auto-dispatch was removed in 2… | `.github/workflows/gtfs-drift-check.yml:233`, `.github/workflows/gtfs-drift-check.yml:235` +1 |
| R9-06 | medium | T1 | S | CLAUDE.md/the test file both claim station-popup-onscreen.test.js is "mutation-verified" for all four guards, but removing the _r… | `js/stations.js:734`, `js/stations.js:289` +2 |
| R9-07 | medium | T1 | S | Two deliberately-duplicated cross-file "mirror" values (feed URLs in audit-feeds.js vs config.js; the adherence-taper formula in … | `scripts/audit-feeds.js:71`, `js/config.js:388` +4 |
| R9-08 | low | T4 | S | build-shapes.cjs's scheduledTimes hole-fill (t.scheduledTimes[i] = 0) is the only silent-data-loss path in the file with no build… | `scripts/build-shapes.cjs:644`, `js/predictions.js:551` +1 |

### G. Documentation drift

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R10-01 | medium | T1 | S | "Vehicle markers are pointer-only, no keyboard focus or role" is false and traceable to MapLibre's own Marker.setPopup() behavior… | `docs/HANDOFF.md:144`, `docs/HANDOFF.md:145` +4 |
| R10-04 | medium | T2 | S | HANDOFF's external-dependency table calls lacmta.github.io "build-time only" / "doesn't affect the live site" — it is actually fe… | `docs/HANDOFF.md:264`, `js/config.js:531` +5 |
| R4-04 | medium | T4 | S | HANDOFF §12.2's 2-minute recipe for verifying the alerts-Lambda provenance no longer works — but the provenance is now verifiable… | `docs/HANDOFF.md:409`, `docs/HANDOFF.md:418` +2 |

### H. Motion & geometry

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R1-01 | medium | T1 | S | Cross-line guard has no separation margin, so a heavy-rail tunnel fix can be re-attributed to the parallel non-interlined A/E ali… | `js/markers.js:546`, `js/markers.js:536` +3 |
| R1-11 | medium | T1 | S | _stopLagFromDeclared resolves the route cache from the RAW frame direction_id, so the stop-lag GPS-refresh override AND the STOPP… | `js/markers.js:1291`, `js/markers.js:1301` +5 |
| R1-05 | low | T1 | S | _applySnap does not clear _currentArc when shape data is unavailable, so the first rail glide after the midnight shape-cache relo… | `js/markers.js:1110`, `js/markers.js:1159` +3 |
| R1-06 | low | T1 | S | _supersedeDuplicateTrip's timestamp tiebreak is strict, so an EQUAL-timestamp re-broadcast of the superseded trip still fades the… | `js/markers.js:2386`, `js/markers.js:2389` +2 |

### I. Popup & badge behaviour

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R3a-03 | medium | T1 | S | The ~5 s station-popup refresh replaces the whole content subtree on EVERY tick whenever any <details> is expanded — the "only re… | `js/stations.js:795`, `js/stations.js:791` +2 |
| R3a-04 | medium | T1 | M | Browser page-translation — the app's entire i18n strategy — is thrown away and re-run on every popup refresh: station popup every… | `js/stations.js:795`, `js/stations.js:854` +3 |
| R3b-02 | medium | T2 | S | Clicking a vehicle marker whose popup is already open from hover CLOSES the popup instead of pinning it — the marker click handle… | `js/markers.js:1071`, `js/markers.js:1072` +3 |
| R3a-08 | low | T1 | S | _keepPopupOnScreen only fires for the nearby-bus <details> — expanding a service alert, a growing refresh, and a viewport resize/… | `js/stations.js:733`, `js/stations.js:854` +2 |
| R3b-06 | low | T2 | S | One Escape press dismisses a pinned alert tooltip AND the active map popup at once — the two document-level keydown handlers are … | `js/main.js:143`, `js/main.js:144` +1 |
| R3b-07 | low | T1 | S | The 5 s badge refresh rewrites `dataset.alertText` / `_alertBlocks` under an OPEN pinned tooltip without re-rendering it — the to… | `js/boardingBadges.js:604`, `js/boardingBadges.js:620` +3 |

### J. ETA & feed data

| ID | Sev | Tier | Effort | What is wrong | Where |
|---|---|---|---|---|---|
| R2-06 | low | T1 | S | Service-date rollover keys off the DEVICE-local date while alerts pin America/Los_Angeles — an out-of-zone device rebuilds every … | `js/utils.js:91`, `js/main.js:372` +4 |

---

## Detail — every confirmed finding


### A. Wrong information shown to riders

#### R3a-01 — Short-turn trips are labelled with the route's full terminus — a Canoga-turning G Line bus renders as "Chatsworth" (25% of G Line westbound trips)

**high** · verified T1 · effort M · reported by R3a · **touches a documented invariant**

- **Where:** `js/predictions.js:976`, `js/predictions.js:957`, `js/stations.js:1306`, `js/stations.js:1355`, `js/stations.js:1444`, `js/ui.js:1003`
- **What happens:** A rider at Reseda Station opens the G Line station popup during a normal weekday. 88 of 350 westbound G Line trips terminate at Canoga, three stops short of Chatsworth. Their row renders `Chatsworth · W  4m 12m` — both the station row (stations.js:1355 / 1444) and, if they tap the bus, the vehicle popup header (ui.js:1003). They board and are put off at Canoga.
- **Rider impact:** Rider boards a vehicle for a destination it never reaches and is turned out short of their stop. On the C Line the mislabelled destination is "LAX / Metro TC" — the single most consequential destination in the system — for the 14 trips that actually end at Aviation/Century.
- **Proposed fix:** Make step 1 trip-aware: when `tripInfo?.stops` exists and its last stop differs from `getTerminalStopId(routeCode, directionId)`, resolve the name from the TRIP's own last stop (still routed through TERMINUS_DISPLAY_OVERRIDES by stopId where one applies), and only fall back to the route-level terminus when the trip is unknown to static GTFS. That keeps the display overrides and the unified station/vehicle cascade (the stated purpose of the helper) while stopping a short-turn from inheriting the long pattern's terminus.
- **Pin it with:** New tests/short-turn-destination.test.js: seed masterTripsData with two 901\|1 trips (17-stop Chatsworth pattern + 13-stop Canoga pattern), run the real initPredictions, and assert resolveTripDestination('901', 1, canogaTripId, canogaTrip, cleanDestination(dest)) === 'Canoga' while the Chatsworth trip still resolves 'Chatsworth'. Add an end-to-end assertion in tests/stations.test.js that the rendered .sp-dest for a short-turn arrival is not the route terminus, and in tests/popup-html.test.js for the vehicle popup header.
- **Documented decision:** js/predictions.js:937-945 resolveTripDestination JSDoc — "1. Schedule-derived terminus (getTerminalName) — authoritative; covers every static-GTFS trip and folds in TERMINUS_DISPLAY_OVERRIDES" (the documented decision unified the ORDERING across ui.js and stations.js; it does not argue that a route terminus should beat a trip's own last stop)
- **Verifier note:** Three things the fixer needs. (1) TERMINUS_DISPLAY_OVERRIDES must survive: 950\|1's real last stop is 'Pacific / 21st Layover' and 803\|0's is 'LAX / Metro Transit Center' — the override only applies when the trip ends at the route's own terminal stop, which the `tripLast !== routeLast` guard preserves. (2) A cheaper source already exists for the BRT half: data/bus-destinations.json byTrip ALREADY holds 'Canoga Station G Line' for that exact tripId, and stations.js already imports resolveBusDestination — so 901/910/950 could route through it instead of a new last-stop lookup (rail 801/803 still needs the trip's last stop). (3) The JSDoc at predictions.js:937-945 documents the ORDERING (a cr…

#### R1-02 — The 5 s popup ETA rebuild is gated on the GPS-fix clock (marker.timestamp) while every other visual gate uses the receipt clock, so an open popup on a feed-lagged tunnel train silently stops counting down while its dot stays green

**medium** · verified T1 · effort S · reported by R1 · **touches a documented invariant**

- **Where:** `js/markers.js:105`, `js/markers.js:2498`, `js/freshness.js:61`, `js/markers.js:1966`
- **What happens:** The reporter's arithmetic is right but the entry condition is worth stating precisely for the fixer: `nowSec - marker.timestamp` can only exceed 300 for a live marker because the frame that set it was ALREADY near the 300 s staleAge ceiling at receipt. docs/STATUS.md measures B/D fix age at delivery at p90 181-286 s (max 305-736 s), so a 286 s frame crosses the gate ~14 s after acceptance. The frozen-ETA window is bounded by the marker's own visual life: while frames keep arriving every ~6 s the accepted-frame path calls updatePopup anyway, so the ticker gate only bites during a per-vehicle silence — during which the popup reads green for the first 90 s and gray thereafter, with a stopped countdown throughout (up to ~285 s before cleanup removes the marker).
- **Rider impact:** A frozen ETA presented next to a green 'live, 12s ago' badge — the popup asserts freshness while showing a countdown that has stopped. Wrong information, on the lines where riders most need it (underground, where they cannot see the train).
- **Proposed fix:** Gate on the same clock the marker's own existence is gated on: `if (getFreshnessTier(marker, nowSec) === 'expired') continue;` (getFreshnessTier is already imported at js/markers.js:24). This is a strict improvement — an expired marker is about to be deleted by cleanup anyway, so the skip still does its job, and a live marker on a lagging feed keeps ticking.
- **Pin it with:** tests/popup-ticker.test.js — add a case that sets marker.timestamp to nowSec-400 while _lastAcceptedWallMs is Date.now(), advances 5 ticks, and asserts getPopupHTML WAS called again (today it is not). The existing tests only cover the 1 s / 5 s cadence split and never set a lagging GPS timestamp.
- **Documented decision:** CLAUDE.md 'Vehicle freshness tiers' (getFreshnessTier reads _lastAcceptedWallMs; do NOT drive visual state from marker.timestamp)
- **Verifier note:** This is the cleanest fix in the batch: it moves the last remaining visual gate onto the receipt clock, which is exactly what CLAUDE.md's 'Vehicle freshness tiers' bullet mandates ('Do NOT drive the visual tier from marker.timestamp'). Note the gate is not merely a different clock — marker.timestamp is ALSO bumped on spike-rejected frames (js/markers.js:1769), so it is neither the visual clock nor the trusted-position clock, and no other reader treats it as either.

#### R2-01 — Vehicle popup's boarding countdown reads arrivalUnix, not departureUnix — the exact bug fixed in getBoardingVehicles was never fixed in getBoardingDepSecs

**medium** · verified T1 · effort S · reported by R2

- **Where:** `js/markers.js:2062`, `js/markers.js:2051`, `js/markers.js:2061`, `js/markers.js:1954`, `js/predictions.js:1221`, `js/tripUpdates.js:317`, `js/ui.js:1042`
- **What happens:** Sub-claim (b) deserves to lead, and the reporter buried it. (a) and (c) are MISSING/flickering information; (b) is WRONG information — with no lastIngestUnix gate, a trip_updates entry that stopped refreshing minutes ago still drives a confident 'Departs Nm' countdown in the vehicle popup, while every other consumer of masterArrivalsData (predictions.js:1220, :683) gates on GTFS_ENTRY_STALENESS_S = 90 s. Under the rubric (wrong > missing) that is what pins this at medium rather than low.
- **Rider impact:** Standing at a terminus with the train in front of them, the rider gets no departure countdown from the vehicle popup — and a different answer from the station popup for the same train. On direction-less frames the popup's status label flickers between Boarding and At stop.
- **Proposed fix:** In getBoardingDepSecs use `dep.departureUnix ?? dep.arrivalUnix`, gate on `now - (dep.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S`, and resolve dir via `window.masterTripsData?.[trip_id]?.dir ?? (direction_id != null ? Number(direction_id) : null)` to match every other path. Better still: have it delegate to getBoardingVehicles([String(stopId)]) so there is one implementation.
- **Pin it with:** New tests/boarding-dep-secs.test.js (getBoardingDepSecs must be exported, or asserted through updatePopup): with an entry {arrivalUnix: now-180, departureUnix: now+420} at an origin stop and a STOPPED_AT marker, assert the value is ~420 not 0; assert a stale-lastIngestUnix entry yields 0/null; assert the value survives a frame with direction_id === null when masterTripsData knows the trip's dir.
- **Documented decision:** CLAUDE.md "Origin/terminus departure rows measure the DEPARTURE, not the arrival (_renderRowPills, PR #617)"; STATUS.md 2026-07-14 batch ("getBoardingVehicles now reads departureUnix (real pull-out) instead of arrivalUnix so a layover dwell no longer reads 'Departs Now'")
- **Verifier note:** The reporter's better suggestion — delegate to getBoardingVehicles([String(stopId)]) so there is ONE implementation — is worth taking: getBoardingDepSecs is a 12-line hand-rolled copy of predictions.js's Tier 1 that has now drifted from it in three independent ways, and the station popup and the vehicle popup giving different answers for the same train is the visible cost. If the fixer keeps two implementations, add the direction cascade in the same shape as predictions.js:1194 (`tripMeta?.dir ?? marker.properties.direction_id`) so the next drift is at least a one-line diff. Interacts with R2-07: if getBoardingDepSecs is fixed but getScheduledArrivals still drops departureUnix, the two surf…

#### R2-02 — The J Line 910→950 retag is silently undone for every trip that has a live marker — getScheduledArrivals re-stamps the row with the vehicle feed's uncorrected route_code

**medium** · verified T1 · effort S · reported by R2

- **Where:** `js/predictions.js:704`, `js/predictions.js:711`, `js/predictions.js:1226`, `js/tripUpdates.js:227`, `js/tripUpdates.js:269`, `js/predictions.js:958`, `js/stations.js:1051`
- **What happens:** Add the precondition the reporter left implicit and that a fixer will otherwise fail to reproduce: the retag is only lost at stops that are in the 910 direction cache. South of Harbor Gateway routeStops['910\|dir'] has no entry for the stop, the marker loop skips, and the GTFS-only path preserves '950' — which is also where _reattributeOffRouteArrivals could catch it anyway. So the defect is confined to the shared 910/950 corridor, which is where CLAUDE.md says the correction is needed precisely because nothing else can catch it there.
- **Rider impact:** The exact symptom CLAUDE.md says correctJLineRouteTag exists to prevent — a San-Pedro-bound bus rendered under "Harbor Gateway TC" at stops north of Harbor Gateway — still occurs whenever the trip has a live marker, which is the normal case for BRT.
- **Proposed fix:** At the marker join, prefer the corrected route over the raw feed tag: `const emitRoute = correctJLineRouteTag(route_code, trip_id)` (import from tripUpdates.js, or reuse `window.masterTripsData?.[trip_id]?.rc` for the 910/950 pair only) and push that as `routeId` at predictions.js:704/711/1226. Scope it to the J pair exactly as the ingest-side helper does, so no other route is touched. Note the cache lookup must stay on the FEED route_code (the marker's arc/stop cache is keyed by it) — only the emitted `routeId` changes.
- **Pin it with:** Extend tests/tripUpdates.test.js's J-retag block (or a new tests/jline-retag-endtoend.test.js): install a 950 trip in masterTripsData, a masterArrivalsData entry already retagged to '950', and a marker with route_code '910' on the same trip_id; assert getScheduledArrivals(stop).routeId === '950' and getBoardingVehicles Tier 1 likewise. Add the no-marker control so the GTFS-only path stays pinned.
- **Documented decision:** CLAUDE.md "J Line route-tag correction"
- **Verifier note:** Scope the correction to the J pair exactly as the ingest-side helper does — a general 'trust static GTFS over the feed tag' rule is a much bigger behaviour change. The route CACHE lookup must stay on the feed's route_code (the marker's arc/stop cache is keyed by it); only the emitted `routeId` changes. tripMeta is already in scope at that point in the loop (predictions.js:612), so no new import or window read is needed. The same literal is the R2-07 site — fix both in one edit.

#### R2-03 — SKIPPED-stop suppression is defeated two ways: the calc tier ignores SKIPPED entirely, and a stop re-flagged SKIPPED keeps its already-ingested arrival

**medium** · verified T1 · effort M · reported by R2

- **Where:** `js/tripUpdates.js:291`, `js/tripUpdates.js:262`, `js/tripUpdates.js:363`, `js/predictions.js:709`, `js/predictions.js:711`
- **What happens:** Sub-claim (b) is the dominant one and the reporter's ordering understates it: the calc tier fires precisely WHEN there is no GTFS-RT entry for the trip at that stop, which is exactly the state a SKIPPED declaration produces. So the ingest gate does not merely fail to help — it routes every skipped stop into the calc tier for any trip with a live marker, which is the normal case. Sub-claim (a) is bounded at GTFS_ENTRY_STALENESS_S (90 s), since the SKIPPED frame does not refresh lastIngestUnix. I could NOT establish how often Metro publishes SKIPPED (feeds unreachable) — CLAUDE.md quantifies CANCELED at 2-5 % of trip-update volume but says nothing about SKIPPED, so the rate is unknown.
- **Rider impact:** A rider waits on a platform for a train the feed has already said will pass them by — worse than showing nothing, because the pill looks like normal live data.
- **Proposed fix:** (1) On SKIPPED, purge that (tripId, stopId) instead of merely skipping it — reuse the `_purgeTripArrivals` filter for the single stop before returning. (2) Track skipped (tripId, stopId) pairs for the trip's current frame and have getScheduledArrivals suppress the calc tier for a target stop the latest frame marked SKIPPED (a small Map<tripId, Set<stopId>> refreshed per frame and aged with the same GTFS_ENTRY_STALENESS_S clock keeps it bounded).
- **Pin it with:** Extend tests/tripUpdates.test.js's existing SKIPPED case with a second frame that flips a previously-SCHEDULED stop to SKIPPED and asserts the entry is removed; add a case in tests/predictions.test.js asserting getScheduledArrivals returns no row for a stop the latest frame marked SKIPPED even when a live marker upstream would otherwise produce a calc ETA.
- **Documented decision:** CLAUDE.md "CANCELED trips / SKIPPED stops" ("per stop, stu.scheduleRelationship === 'SKIPPED' omits that single stop while siblings keep their pills")
- **Verifier note:** Before building (b), instrument: a counter on the SKIPPED branch would give the real rate in one feed-reliability run and settle whether the M-sized half is worth it. If SKIPPED turns out to be rare, shipping (a) alone still closes the wrong-info half that lasts 90 s, and is S-sized. Note the asymmetry the fixer should preserve: CANCELED purges because a canceled trip serves NO stop, while SKIPPED must purge exactly one (tripId, stopId) pair — reusing _purgeTripArrivals wholesale with the frame's full stopTimeUpdate list would wrongly delete the trip's SCHEDULED siblings in the same frame.

#### R3a-02 — Origin/terminus departure rows still show the layover ARRIVAL for any train a marker is tracking — getScheduledArrivals drops departureUnix, so _withDeparture's `?? arrivalUnix` fallback is the normal path, not the legacy one

**medium** · verified T1 · effort S · reported by R3a · also found independently as R2-07 · **touches a documented invariant**

- **Where:** `js/predictions.js:704`, `js/predictions.js:711`, `js/stations.js:1126`, `js/stations.js:1163`, `js/stations.js:1177`, `js/tripUpdates.js:341`
- **What happens:** The reporter's own scenario (approaching within BOARDING_MAX_HORIZON_S at Pomona North with a live marker) does NOT reproduce: getBoardingVehicles Tier 2 (predictions.js:1238-1268) independently picks that trip out of masterArrivalsData, carries `departureUnix ?? arrivalUnix`, and _renderRowPills' `approaching` filter excludes boarding tripIds — my CONTROL case renders the correct '15m'. Two paths DO reproduce: (a) the beyond-horizon fallback (stations.js:1177) — a train pulling in at 12 min, departing at 15, renders '12m'; (b) the within-horizon case when the trip is missing from data/trips.json, because Tier 2 does `if (!tripMeta) continue` — with the seeded KNOWN stale-trips.json condition (~35-60 % of live trips unknown) this is the common state at a terminus today, and the row renders '2m' for a train that leaves in 15.
- **Rider impact:** At every terminus the departure row understates the wait by the whole layover (typically 5–15 min on rail). A rider reads "2m", walks to the platform expecting to leave, and waits a quarter of an hour — the exact defect PR #617 was opened to fix, still live on the tier that covers trains with a live position.
- **Proposed fix:** Carry the field through in getScheduledArrivals: add `departureUnix: gtfsEntry?.departureUnix ?? null` to both pushes (predictions.js:704 and :711 — the calc tier has no GTFS entry, so it stays null and _withDeparture legitimately falls back). No change needed in stations.js.
- **Pin it with:** tests/origin-departure-horizon.test.js — replace the hand-built arrival fixtures in the 'departure time, not the layover arrival' block with ones produced by the REAL getScheduledArrivals (a live marker + a masterArrivalsData entry whose departureUnix is 13 min after arrivalUnix) and assert the pill reads the departure. Mutation check: reverting the predictions.js change must turn it red.
- **Documented decision:** CLAUDE.md "Origin/terminus departure rows measure the DEPARTURE, not the arrival (_renderRowPills, PR #617)"
- **Verifier note:** PAIRED with R2-07 (same one-line defect seen from the compute side; VT1a verified it CONFIRMED/T1 and graded it low as 'latent'). Reconciliation: the DATA claim in the title is literally true (100 % of marker-matched rows lack the field), but the RENDER consequence is masked by getBoardingVehicles Tier 2 in the healthy case — hence medium, not high, and not low: my render probe shows two paths that produce a wrong pill on current code, one of which (missing tripMeta) is the normal state while trips.json is stale. One fix serves both findings; land it with R2-02's retag push. tests/origin-departure-horizon.test.js hand-builds arrivals WITH departureUnix — a shape production never emits on th…

#### R3a-06 — At all 11 end-of-line stations the popup drops BOTH the service-alert section and the stale-feed banner when there are zero arrivals — no explanation at exactly the moment there is nothing to show

**medium** · verified T1 · effort M · reported by R3a · **touches a documented invariant**

- **Where:** `js/stations.js:1082`, `js/stations.js:1092`, `js/stations.js:992`, `js/stations.js:1819`, `js/stations.js:1964`, `js/stations.js:941`
- **What happens:** The B Line is suspended (NO_SERVICE alert, zero trip_updates) or the rail trip_updates socket dies. A rider at North Hollywood — a B Line terminus — opens the station popup. routeMap is empty, so the popup renders "No upcoming arrivals" alone: no ⚠ service banner explaining the suspension, and no "⚠ Live rail feed delayed (10m)" banner. One stop down at Universal City both banners render normally.
- **Rider impact:** At the ten busiest terminus stations, during a closure or a feed outage, the rider cannot tell "the line is shut down" from "our data died" from "you just missed the last train" — the popup is silent in exactly the state the banners were built for.
- **Proposed fix:** Separate "which routes SERVE this station" from "which rows to render". Build a `servedRoutes` Set in _buildStationRouteMap (every METRO route whose cache contains a stopId, origin/terminal included) and pass it to _renderStaleFeedBanner and _renderStationAlertsSection, leaving routeMap and the row-suppression rules untouched (renderRow already drops terminal and near-terminal-empty rows).
- **Pin it with:** New tests/terminal-station-alerts.test.js: seed the real route caches from a two-station fixture where the group is the terminal for both directions, no arrivals, one active service alert on that route and a stale rail feed; assert the popup contains both .sp-banner--service and .sp-feed-stale. Mutation check: reverting the servedRoutes plumbing must turn it red.
- **Documented decision:** docs/STATUS.md "Outstanding hygiene" — "_buildStationRouteMap deliberately does NOT seed origin/terminal rows" (that entry documents the blank-terminus ROW consequence; the alert/banner suppression is not covered)
- **Verifier note:** Category is really 'missing info', not 'wrong info' — but it is missing at exactly the moment a rider most needs it (suspension or dead feed at a terminus), so medium stands. The alerts half is already acknowledged in a code comment (stations.js:941, 'still need a served-routes index that doesn't exist yet'); the stale-feed-banner half is not acknowledged anywhere and is the part that also fires when nothing is wrong with service at all. docs/STATUS.md's 'Outstanding hygiene' entry documents the blank-terminus ROW consequence of the same skip, not this one.

#### R3b-03 — A bus-bridge bracket + 🚌 glyph is drawn as soon as the ALERT is published, not when the closure starts — on the captured 2026-09-01 live alert set the C Line Willowbrook↔Harbor Fwy bracket renders on Sep 2 for a closure that begins Sep 4

**medium** · verified T1 · effort M · reported by R3b

- **Where:** `js/busBridges.js:100`, `js/busBridges.js:106`, `js/busBridges.js:53`
- **What happens:** Metro publishes a planned-closure alert several days ahead with activePeriod.start = publication time (standard practice — 4 of the 8 rail alerts in the 2026-09-01 capture describe future-dated work). detectBusBridges sees an active alert with ≥2 consecutive affected stops and bridge language, so the orange bracket and 🚌 glyph render at once. Between Sep 1 and Sep 4 the C Line runs normally through Willowbrook / Avalon / Harbor Fwy while the map shows a replacement-bus bracket over that segment, and the tooltip's own 'Active: Tue, Sep 1 …' line asserts it is in effect today.
- **Rider impact:** A rider at Willowbrook/Rosa Parks on Sep 2 sees the map claim trains do not run to Harbor Fwy and a shuttle does. The bracket carries no 'upcoming' styling and the tooltip's Active line agrees with it, so the only contradicting information is buried in the third sentence of the description. Worst case they walk to a shuttle stop that isn't operating, or take a different route for no reason.
- **Proposed fix:** Add an effective-window check to detectBusBridges rather than trusting activePeriod alone: parse a leading 'From <weekday>, <Month> <day>[, at <time>]' / 'Starting <Month> <day>' phrase out of the description (the same corpus normalizeAlertProse already parses) into an effectiveStart, and skip the bridge while `now < effectiveStart`; fall back to activePeriod.start when no phrase is found. Fails safe in both directions — an unparseable alert behaves exactly as today. If the owner prefers not to parse prose, the minimum is a distinct 'upcoming' render (dashed bracket + muted glyph) driven by the same signal, so the map never makes an unqualified in-effect claim.
- **Pin it with:** tests/busBridges.test.js — new `describe('detectBusBridges — future-dated closures')` using the real 2026-09-01 C Line alert shape: with `now` = Sep 2 assert `detectBusBridges()` returns [] (or side/upcoming flag), with `now` = Sep 5 assert one bridge 80309→80311, and with a description carrying no date phrase assert today's behaviour is unchanged.
- **Verifier note:** Wider than bus bridges, and worth flagging to whoever owns alerts.js: the tooltip's own 'Active: Tue, Sep 1, 12 pm – Sun, Sep 13, 10 am' line comes from the same publication-window activePeriod, so the one piece of UI that could contradict the bracket AGREES with it. If prose-parsing is rejected, the minimum acceptable outcome is a distinct 'upcoming' render (dashed bracket + muted glyph) so the map never makes an unqualified in-effect claim. In the captured set only this one alert produces a bracket, so today's blast radius is one corridor for three days.

#### R8-02 — Alert tier-2 period selection picks the array-order-FIRST unexpired future period, not the chronologically SOONEST one, when Metro lists multiple future activePeriods out of order

**medium** · verified T1 · effort S · reported by R8

- **Where:** `js/alerts.js:665`, `js/alerts.js:669`, `js/alerts.js:1141`
- **What happens:** Metro publishes a weekend maintenance alert with two future windows and lists the Saturday-night window before the Friday-night one in the raw feed JSON (both currently in the future, array order not chronological — the same kind of out-of-order publishing the surrounding comment already documents for the active-vs-future case). `_ingest` picks the Saturday window as the alert's `activePeriod`, so every UI surface (panel row, legend tooltip, station banner) shows 'Active from Sat ...' when the disruption actually starts Friday night.
- **Rider impact:** A rider checking Thursday sees the alert says service changes start Saturday and plans a Friday trip accordingly — but the real disruption already begins Friday night, so they hit it unwarned.
- **Proposed fix:** In the tier-2 fallback, select the period with the MINIMUM `start` among all not-yet-expired periods (`reduce`/`sort` instead of `find`), not the first one in array order.
- **Pin it with:** tests/alerts.test.js — add a case alongside the existing 'three-tier activePeriods selection' describe block (next to the tier-2 test at line 1893): two future periods with the later one listed first; assert `entry.activePeriod.start` equals the SOONER start, not the array-order-first one.
- **Verifier note:** Prototyped the proposed fix in the worktree (replaced the tier-2 `.find()` with a `.filter().reduce()` selecting the minimum `start` among not-yet-expired periods) and reran both the new probe AND the full existing tests/alerts.test.js suite: probe went GREEN, and all 119 existing alerts tests (including the tier-1/tier-2/tier-3 describe block) still pass -- the fix is a drop-in replacement with no observed regression. Fix reverted before exiting the worktree (worktree since removed).

#### R8-05 — Bikeshare popup shows raw bike/dock counts even for a station GBFS reports as not currently renting/returning — never reads `is_renting`/`is_returning`

**medium** · verified T1 · effort S · reported by R8

- **Where:** `js/bikeshare.js:248`, `js/bikeshare.js:258`, `js/bikeshare.js:585`
- **What happens:** A station goes into maintenance/rebalancing (`is_renting: 0`) while its bike-count fields still report a nonzero inventory (as this real production snapshot shows for 3 of 223 stations at once). The map's pie/dot marker and popup show it as a normal available station with bikes/docks.
- **Rider impact:** A rider walks to a Metro Bike Share station the map shows has bikes available, only to find the kiosk won't dispense (or won't accept a return, for `is_returning:0`) because the station is offline for service — the map gave them wrong information about what they could actually do there.
- **Proposed fix:** Read `is_renting`/`is_returning`/`is_installed` per station; when `is_renting===0` (or `is_installed===0`), either zero out the displayed bike/e-bike counts or render an explicit 'Station temporarily unavailable' state in `_buildPopupHTML` and the marker fill (js/bikeshare.js `_dotSVG`/`_pieSVG`), instead of showing raw counts as if rentable.
- **Pin it with:** New case in tests/bikeshare.test.js: feed a station_status stub with `is_renting: 0` and nonzero `num_bikes_available_types`; assert the popup/marker reflects unavailability rather than the raw counts.
- **Verifier note:** Prototyped the minimal fix in the worktree (added `info.isRenting = st.is_renting !== 0;` alongside the existing bikes/ebikes/docks assignment in _refreshStatus). Reran the new probe AND the full existing tests/bikeshare.test.js suite: probe went GREEN, all 8 existing bikeshare tests still pass. Fix reverted before exiting the worktree. This flag alone doesn't finish the fix (the popup/marker rendering also needs to consult it, per the finding's proposed_fix), but it proves the missing data IS available on the GBFS response and trivially pluggable.

#### R3a-07 — Vehicle popup renders "Train Car #null" / "Bus ID null" for a marker that has not yet adopted a vehicle_id

**low** · verified T1 · effort S · reported by R3a

- **Where:** `js/ui.js:1098`, `js/ui.js:1101`, `js/markers.js:1977`, `js/markers.js:1890`
- **What happens:** A marker cold-starts from one of the ~47% of frames with no vehicle.id and the rider taps it before the next id-bearing frame lands (≥1 feed cycle, 5–6 s typical, longer in the D Line tunnel). The footer reads "Train Car #null", and the same string is the element's title attribute.
- **Rider impact:** Debug junk in a rider-facing surface; the car number is also the value riders are told to search on (matchSearch skips null-id markers), so the popup advertises an identifier that cannot be searched.
- **Proposed fix:** In getPopupHTML, omit the identifier when it is absent: `const idText = vehicleId == null \|\| vehicleId === '' ? '' : `${vehicleLabel}${vehicleId}`;` and render the .pv2-vehicle span only when idText is non-empty (or fall back to the trip's line/direction). One expression plus a conditional.
- **Pin it with:** tests/popup-html.test.js — add a case asserting getPopupHTML({ vehicleId: null }) contains neither 'null' nor an empty 'Train Car #' suffix, and that a real id still renders verbatim (the hyphen-joined consist roster stays as-is, per the seeded known item).
- **Verifier note:** Reachable window is one feed cycle after a cold start from one of the ~47 % id-less frames (markers.js:1890) — longer in the D Line tunnel. Also worth fixing because matchSearch skips null-id markers, so the popup currently advertises an identifier that search cannot find.

#### R3a-09 — A row's destination label is taken from its FIRST arrival only, so the second pill can belong to a trip going somewhere else

**low** · verified T1 · effort M · reported by R3a

- **Where:** `js/stations.js:1353`, `js/stations.js:1442`, `js/stations.js:1145`, `js/stations.js:1752`
- **What happens:** At a stop served by route 111, the soonest bus is an LAX trip and the next is an Inglewood short-turn (a byTrip minority branch). The row renders "Los Angeles Intl Airport · W  3m 11m"; the 11m bus does not go to LAX.
- **Rider impact:** The rider plans around the second pill for a destination that trip does not serve. Bounded impact because the soonest pill — the one most riders act on — is always correct.
- **Proposed fix:** Group a route+direction's arrivals by resolved destination before rendering (the merged-J block already groups by destination) and emit one row per distinct destination; or, minimally, drop the second pill when its resolved destination differs from the first and render it as its own row.
- **Pin it with:** tests/nearby-bus-section.test.js — add a route with two arrivals whose byTrip destinations differ and assert two rows (or one row with only the matching pill), never one row carrying both. Mirror in tests/station-row-geometry.test.js for the rail branch once R3a-01 makes rail labels trip-aware.
- **Documented decision:** CLAUDE.md "Nearby-bus destination labels" — byTrip exists precisely because ~12% of trips branch
- **Verifier note:** Bounded by construction: the SOONEST pill — the one most riders act on — is always correct, which is why low is right. The bus half is live today (byTrip exists precisely because ~12 % of trips branch); the rail half is currently MASKED by R3a-01 (every rail label is route-level, so both pills are equally wrong rather than inconsistently wrong) and will become visible the moment R3a-01 is fixed — sequence the two fixes accordingly.


### B. Mobile & accessibility blockers

#### R5-01 — The iOS "Add to Home Screen" hint sits on top of the legend bottom-sheet handle and the legally-required basemap attribution — the legend cannot be opened on a phone or iPad until the hint is dismissed

**high** · verified T2 · effort S · reported by R5 · also found independently as R6-05, R8-01 · **touches a documented invariant**

- **Where:** `styles/index-style.css:3155`, `styles/index-style.css:3157`, `styles/index-style.css:2290`, `js/pwaInstall.js:188`, `js/pwaInstall.js:122`
- **What happens:** First visit on iPhone Safari (or iPad Safari). 4 s after load `initPwaInstall` shows the Share→Add-to-Home-Screen hint (pwaInstall.js:188-192). It is persistent — nothing auto-hides it. The rider taps the drag pill at the bottom of the screen to open the route legend: the tap is swallowed by the banner and the sheet does not move. The rider taps the ⓘ / credit line to read the attribution: also swallowed. Both stay dead until the rider notices and hits the small × inside the hint.
- **Rider impact:** On a first visit — the only visit where the hint exists — the route legend (vehicle counts per line, the alert-severity key, and the only route-filter control) appears broken: the handle is visible, the tap does nothing. The required OpenStreetMap/CARTO/Esri/Metro credit is half-covered and unclickable at the same time.
- **Proposed fix:** Make the banner sheet-aware inside the existing `@media (max-width: 1280px)` block, reusing the variable the attribution rule already uses: `.pwa-install-banner { bottom: calc(env(safe-area-inset-bottom,0px) + var(--sheet-lift, 44px) + 12px); }`. That clears both the 44 px peek handle and the open sheet, and rides with `--sheet-lift` exactly as `.maplibregl-ctrl-bottom-right` (css:2290-2293) does. Also give the banner `bottom`/`right` room away from the attribution or move it to `top: calc(search-bar bottom + 8px)` on phones; and clamp its lifetime (auto-hide after ~15 s, remembering nothing) so a missed × never permanently blocks chrome.
- **Pin it with:** Extend `tests/pwaInstall.test.js` with a CSS-source assertion in the style of `tests/search.test.js:346` — read `styles/index-style.css` and assert the `.pwa-install-banner` bottom offset references `--sheet-lift`. Stronger: a Playwright-harness assertion in the review replay script — with the banner visible on `--device=phone`, `document.elementFromPoint(handleCx, handleCy)` must resolve to `#sheet-handle` (not the banner) and tapping it must clear `#legend-container.hidden`.
- **Documented decision:** CLAUDE.md "sw.js is installability-only" (install affordances: dismissible Chromium banner + one-off iOS Safari hint); styles/index-style.css:2284-2289 (attribution 'is never covered')
- **Verifier note:** DUPLICATE GROUP: same verdict/evidence applies to R8-01 and R6-05 (see their entries, each pointing back here). This capture ALSO independently confirms R8-01's refuted sub-claim ('legend tap on touch hides nothing') was caused entirely by this banner overlap: with the banner up the identical tap on #sheet-handle is a no-op; after dismissing it the same tap opens the sheet and a row-tap correctly sets hide-route-* classes. Fix should reuse the existing --sheet-lift CSS variable (styles/index-style.css:2290) already used by .maplibregl-ctrl-bottom-right for the identical class of overlap.

#### R6-01 — Opening a vehicle popup lets MapLibre's setDOMContent() steal keyboard focus back into it on every live update, hijacking focus anywhere else on the page

**high** · verified T2 · effort S · reported by R6

- **Where:** `js/markers.js:1911`, `js/markers.js:1984`, `js/markers.js:106`, `js/markers.js:907`, `vendor/maplibre-gl/maplibre-gl.js:1`
- **What happens:** Reproduced scenario is slightly WORSE than reported: in this capture the flip happens almost immediately (by 500ms, not ~5s) and is PERMANENT for the remainder of the sample window (focus does not oscillate back to search) -- because once refocused into the popup, the rider's typing/interaction is now happening inside the vehicle popup's DOM, so #station-search never regains focus without the rider manually reclicking it. Root cause and rider impact as reported: search, legend, and any other keyboard/SR task is unusable for as long as any vehicle popup stays open anywhere on the map.
- **Rider impact:** Search, legend filtering, and the alerts panel become unusable by keyboard for as long as any vehicle popup is open anywhere on the map (it does not need to be visible or the popup the user is looking at) — the interaction they were doing is silently interrupted roughly every 5 seconds. A sighted mouse user typing a search query can have a stray Space/Enter keystroke toggle 'Follow' on an unrelated vehicle instead of reaching the search field.
- **Proposed fix:** In updatePopup() (js/markers.js:1938), before calling popup.setHTML(), capture `document.activeElement`; after setHTML() (and decorateFollowButton), if the captured element is still in the document and is NOT inside the popup's own element, call `.focus({preventScroll:true})` on it to undo MapLibre's _focusFirstElement() side effect. This is the same save/restore pattern already used for the station popup's refresh path (js/stations.js:834-855, 'Preserve keyboard focus across the subtree swap') — that code exists precisely because the team already discovered setHTML's focus side effect once (for the station popup) and engineered around it there, but the identical fix was never applied to the vehicle popup's own setHTML call site.
- **Pin it with:** New test using the real vendored MapLibre (jsdom mocks in tests/marker-lifecycle.test.js etc. replace maplibregl.Marker/Popup with simplified stand-ins that don't reproduce setDOMContent's _focusFirstElement call, which is why this was never caught) — e.g. a Playwright test against the app similar to this review's replay harness: open a vehicle popup, move focus to #station-search, wait through two popup-refresh cycles, assert document.activeElement.id remains 'station-search'.
- **Verifier note:** This is the single most consequential a11y finding in the batch -- verified rigorously per the assignment's specific instruction. The proposed fix (capture/restore document.activeElement around updatePopup's popup.setHTML call, mirroring js/stations.js's existing 'Preserve keyboard focus across the subtree swap' pattern for the station popup) is architecturally sound and low-risk since it's a save/restore, not a behavior change to the popup content itself. Existing marker-lifecycle tests use simplified Marker/Popup stand-ins that don't reproduce setDOMContent's _focusFirstElement call, which is exactly why this shipped uncaught -- any regression test for this MUST either use the real vendor…

#### R6-02 — Every vehicle marker is keyboard-focusable with the generic accessible name "Map marker" — and the code/docs claiming vehicle markers are pointer-only are stale

**high** · verified T2 · effort S · reported by R6

- **Where:** `js/markers.js:953`, `js/markers.js:969`, `js/markers.js:970`, `js/markers.js:901`, `docs/HANDOFF.md:143`
- **What happens:** A screen-reader or keyboard-only rider tabs across the map. Every vehicle (there can be dozens system-wide) announces identically as "Map marker, button" with zero identifying information — no line, no destination, no vehicle id. The only way to learn what a given stop represents is to activate it (Enter) and read the resulting popup, i.e. trial-and-error through every vehicle on screen. Because MapLibre already makes these fully operable (tabbable, keypress-activatable), the code comment and VPAT text describing them as non-focusable/no-role are simply wrong about the app's actual behavior, and the VPAT's planned remediation (an off-canvas list, because dots are supposedly unreachable) does not address the real, fixable problem: the dots ARE reachable, they're just unlabeled.
- **Rider impact:** A rider using a screen reader cannot tell one vehicle from another while tabbing the map, and cannot skip past vehicles efficiently to reach other controls, without opening each one's popup individually. The organization's own accessibility documentation (used for a VPAT / Section 508 conformance statement) misdescribes the actual, shippped behavior.
- **Proposed fix:** Set a descriptive `el.setAttribute('aria-label', ...)` (e.g. "${routeLetter} Line train to ${destination}" / "Bus ${route} to ${destination}") on the marker element in createNewMarker (js/markers.js, before line 970's addTo) and refresh it in updateExistingMarker alongside updatePopup() when direction/destination changes — MapLibre only fills in its own default when the attribute is absent, so any explicit label wins. Separately, correct the stale comment at js/markers.js:901 and the VPAT note in docs/HANDOFF.md:143 to describe the real gap (focusable-but-unlabeled) rather than the outdated one (non-focusable), which also changes what the honest remediation is.
- **Pin it with:** New assertion in tests/marker-lifecycle.test.js (or a new tests/marker-a11y.test.js) against createNewMarker's element construction: aria-label is non-generic and contains the route/destination; a companion replay-based check (see R6-01) that the keyboard walk no longer surfaces bare 'Map marker' labels.
- **Documented decision:** docs/HANDOFF.md#accessibility-wcag-2.1-aa--section-508--vpat-note
- **Verifier note:** Confirms both halves of the claim: (1) the technical behavior (focusable, operable, generically labeled) and (2) the documentation drift (docs/HANDOFF.md and the js/markers.js:901 comment describe an outdated non-focusable state). The fix is straightforward (set a descriptive aria-label before addTo() in createNewMarker, refresh in updateExistingMarker) and should be paired with correcting the stale comment/VPAT text so the org's own accessibility documentation matches shipped behavior -- a real Section 508/VPAT accuracy concern beyond just the UX gap.

#### R3a-05 — Station popup restores focus to its trigger on ANY close, including eviction by another popup owner — tapping a vehicle after a search sends focus (and the mobile keyboard) back to the search box

**medium** · verified T1 · effort S · reported by R3a

- **Where:** `js/stations.js:654`, `js/stations.js:663`, `js/stations.js:890`, `js/ui.js:629`, `js/popups.js:52`
- **What happens:** Rider searches "Willowbrook", taps the result (popup opens, container focused), then taps a train marker. markers.js's popup.on('open') calls setActivePopup, which invokes closeStationPopup, which calls searchInput.focus(). On iOS/Android that focus lands on a text input during a user gesture, so the virtual keyboard opens over the map and the vehicle popup that was just opened. The same happens when the rider taps a second station dot (showArrivalsPopup's own leading closeStationPopup() fires the restore before re-assigning _popupTriggerEl).
- **Rider impact:** On phones the keyboard covers the map and the newly-opened popup on a tap that had nothing to do with search; for keyboard/screen-reader users focus jumps backwards out of the dialog that is now on screen, contrary to the WAI-ARIA dialog pattern (restore focus on DISMISS, not on replacement).
- **Proposed fix:** Only restore focus when focus is still inside the popup being closed: in closeStationPopup and the 'close' handler, guard with `if (_popupTriggerEl && popupEl?.contains(document.activeElement))` before calling focus(), and always null _popupTriggerEl afterwards. Eviction by another owner (focus already moved, or on <body> after a map tap) then leaves focus alone.
- **Pin it with:** Extend tests/station-popup-onscreen.test.js (or a new tests/station-popup-focus.test.js): open a pinned popup with a focused stub input as the trigger, then call the registry eviction path (setActivePopup with a different closeFn) and assert document.activeElement is NOT the trigger input; assert it IS restored when the popup is closed by its × / Escape while focus is inside the dialog.
- **Verifier note:** Mobile impact is the sharp end: the restore lands on a text input during a user gesture, so the virtual keyboard opens over the map and over the vehicle popup the rider just tapped. Two other paths hit the same code: showArrivalsPopup's own leading closeStationPopup() (stations.js:663-665 captures triggerEl BEFORE the close specifically to survive it) and the MapLibre 'close' handler at stations.js:890 — whatever signal is chosen must cover both closeStationPopup and that handler.

#### R5-02 — `.pwa-install-banner` and `.toast` never reach their declared max-width on a phone — `position:fixed; left:50%` with `right:auto` caps shrink-to-fit at half the viewport, so both render at 195 px and stack up 4-5 lines tall

**medium** · verified T2 · effort S · reported by R5

- **Where:** `styles/index-style.css:3154`, `styles/index-style.css:3161`, `styles/index-style.css:3120`, `styles/index-style.css:3123`
- **What happens:** Any phone. (a) The iOS install hint renders as a 195 px column reading 'Install Metro Live / Map: tap Share, then / "Add to Home / Screen."' instead of the intended ≤358 px two-line pill — and the extra height is what pushes it over the sheet handle and the attribution (R5-01). (b) Tap Locate with location permission denied: `showToast('Location access was denied. Enable it in your browser settings to use this feature.', {severity:'error'})` (js/main.js:304) renders as a 5-line, 92 px-tall block instead of the designed 2-3 lines.
- **Rider impact:** Status and install messaging is squeezed into a narrow column that is harder to read at a glance and occupies far more of a small screen than intended, obscuring the map and the chrome beneath it.
- **Proposed fix:** Give both boxes a real width instead of relying on shrink-to-fit. Minimal: `.pwa-install-banner { left: 0; right: 0; margin-inline: auto; width: max-content; max-width: min(92vw, 420px); transform: translateY(140%); }` and `.pwa-install-banner--visible { transform: translateY(0); }`; `.toast { left: 0; right: 0; margin-inline: auto; width: max-content; max-width: min(90vw, 360px); transform: none; }` (the toast's transform carries no animation, so it can simply go).
- **Pin it with:** New `tests/chrome-centering.test.js` (CSS-source assertion, pattern of `tests/search.test.js:346`): assert neither `.toast` nor `.pwa-install-banner` combines `left: 50%` with an absent `right`/`width`. Harness assertion for the real geometry: on `--device=phone`, `document.querySelector('.toast').getBoundingClientRect().width` must be > 300.
- **Verifier note:** This measured layout bug is also the mechanism that makes R5-01's overlap worse than it would otherwise be: the banner's extra height from wrapping to 4 lines (94.75px tall instead of a 2-line pill) is what extends its bottom edge down over the sheet handle/attribution band. Fixing R5-02 (giving the banner a real width) would shrink its height and reduce, but not eliminate, the R5-01 overlap -- the two fixes are complementary, not substitutes.

#### R5-03 — First load on a phone is a look-but-don't-touch map: it boots at zoom ~8.1 where station dots are drawn but not tappable (STATION_CLICK_MINZOOM = 10), and nothing on screen tells the rider to zoom

**medium** · verified T2 · effort M · reported by R5

- **Where:** `js/map.js:41`, `js/config.js:345`, `js/stations.js:421`, `js/stations.js:434`, `js/main.js:264`
- **What happens:** First-time rider opens the site on a phone on a platform. They see the whole LA network. They tap the station dot they are standing at. Nothing happens — no popup, no ripple, no message. They tap again, harder. Still nothing. There is no visible cue that two zoom levels stand between them and their arrival times.
- **Rider impact:** The app's primary answer ('when is my train?') is unreachable on the first screen, and the failure is silent — a dead tap reads as 'broken', not as 'zoom in'.
- **Proposed fix:** Do not change the initial fitBounds (it is deliberate — map.js:37-44). Instead make the low-zoom tap productive: in the map's `click` handler, when `map.getZoom() < STATION_CLICK_MINZOOM` and the tap hit no marker, `map.easeTo({ center: e.lngLat, zoom: STATION_CLICK_MINZOOM + 0.5 })` — a tap on the network zooms toward it. Optionally pair with a one-shot dismissible hint pill ('Zoom in to tap a station') rendered while `zoom < STATION_CLICK_MINZOOM`, hidden once the rider passes it; reuse the existing `.toast` recipe, remembered in localStorage like `mlm_pwa_install_dismissed`.
- **Pin it with:** New `tests/low-zoom-tap.test.js` (jsdom, mirroring `tests/map-init.test.js`'s fake-map pattern): assert the map click handler calls `easeTo` with `zoom >= STATION_CLICK_MINZOOM` when the current zoom is below it and no marker was hit, and does not when at/above it. Harness assertion: on `--device=phone` at boot, tapping a projected station group must end with `map.getZoom() >= STATION_CLICK_MINZOOM`.
- **Documented decision:** js/config.js:340-346 (JLINE/STATION_CLICK_MINZOOM rationale); js/map.js:37-44 (fitBounds initial view rationale)
- **Verifier note:** touches_documented_invariant is correctly false per the reporter -- the proposed fix (tap-to-zoom on a dead tap, leaving the initial fitBounds untouched) does not contradict the documented fitBounds rationale in js/map.js, it only makes the otherwise-dead gap productive. Confirmed real and reproducible; effort M is reasonable (needs a new click-handler branch plus a test).

#### R5-04 — Vehicle markers are 12.75-15.5 CSS px and overlap each other at the default phone zoom — median nearest-neighbour spacing 12.4 px, 27 of 40 markers under 20 px apart, so tapping a specific train is a lottery

**medium** · verified T2 · effort S · reported by R5 · also found independently as R6-04

- **Where:** `js/config.js:468`, `js/config.js:470`, `js/map.js:399`, `js/markers.js:836`
- **What happens:** Phone, default/Home view. The rider sees a cluster of coloured arrows near downtown and taps the one they think is their train. Because markers are 12.75-15.5 px with a median 12.4 px centre spacing, the tap lands on whichever of the 3-5 overlapping markers is topmost in DOM order (rail is z-index 2 over bus, markers.js/css:747-750) — frequently not the one under the fingertip. The vehicle popup that opens names a different line.
- **Rider impact:** At the zoom the app opens at, individual vehicles are neither legible nor reliably selectable; a rider who taps a train gets a different train's popup, which reads as wrong data rather than a mis-tap.
- **Proposed fix:** Two parts, both small. (1) Floor the rendered size on touch: `@media (pointer: coarse) { :root { --vehicle-size-floor: 20px } }` and use `max(var(--vehicle-size), var(--vehicle-size-floor, 0px))` in the markers.js size expression — or simply raise `VEHICLE_SIZE_MIN_PX` to 20 (visual change only below zoom ~10.5). (2) Do NOT add a transparent `::before` hit expander here — with 12.4 px median spacing a larger invisible target increases mis-taps. Instead let R5-03's low-zoom tap-to-zoom take precedence: below `STATION_CLICK_MINZOOM` a tap on the blob should zoom in rather than resolve to an arbitrary marker.
- **Pin it with:** `tests/map-init.test.js` — extend the existing vehicle-size test to assert the computed size at zoom ≤ VEHICLE_ZOOM_MIN is ≥ 20 px. Harness assertion: on `--device=phone` at boot, `min(marker.getBoundingClientRect().width)` ≥ 20.
- **Documented decision:** docs/audits/app-chrome-ux-audit-2026-06-16.md §3 R1/R2 (documented WCAG 2.5.5 compact-control exception, css:2261)
- **Verifier note:** Consistent with R6-04 (no touch-target accommodation for these same markers) -- the two findings compound: markers are both visually tiny AND densely packed AND untouched by any pointer:coarse hit-area rule.

#### R5-05 — The legend's only interaction cue — "Click a row to toggle" — is `display: none` on every ≤1280 px viewport, so phone riders never learn the route rows filter the map

**medium** · verified T2 · effort S · reported by R5

- **Where:** `styles/index-style.css:2314`, `index.html:243`, `js/ui.js:448`
- **What happens:** Phone rider opens the bottom sheet (after clearing R5-01), sees eight route rows with vehicle counts, reads them as a static colour key, and closes the sheet. The single most useful control for the crowded overview map described in R5-04 — isolate one line — is never found.
- **Rider impact:** Riders on the device class with the worst marker crowding are the only ones not told they can filter the map down to their line.
- **Proposed fix:** Show the hint on mobile with device-neutral, behaviour-accurate copy. Drop the `display: none` at css:2314 and instead append the hint to the mobile total row (`#mobile-total-row`, css:2316) as a small muted line reading 'Tap a line to show only that line'. Keep it a single 11 px line so the sheet's vertical budget is unchanged.
- **Pin it with:** `tests/ui.test.js` — assert `#legend-toggle-hint` is not display:none under the mobile breakpoint (CSS-source assertion in the style of `tests/search.test.js:346`: the `@media (max-width: 1280px)` block must not contain `#legend-toggle-hint { display: none }`), plus a jsdom assertion that the hint text is present in the rendered legend.
- **Documented decision:** docs/audits/app-chrome-ux-audit-2026-06-16.md §3 R2 (legend row geometry left alone — this finding changes copy only, not geometry)
- **Verifier note:** Low-risk, well-scoped fix (copy-only, no geometry change) as the reporter notes.

#### R6-03 — axe nested-interactive (serious, 14 nodes on both phone and desktop): legend rows and station alert/access badge map markers both nest a focusable control inside another interactive element

**medium** · verified T2 · effort M · reported by R6

- **Where:** `js/ui.js:441`, `js/alerts.js:1395`, `js/alerts.js:1583`, `js/boardingBadges.js:320`, `js/boardingBadges.js:688`
- **What happens:** A screen-reader user tabs to a legend route row and hears 'checkbox, A Line' then, moving one step further, a separately-focusable 'button, Service alert: ...' nested at the same visual location — the ARIA tree contradicts the flat visual row, and on the map, an alert badge's outer wrapper announces the meaningless 'Map marker, button' immediately before/around its real 'Elevator outage: ...' child, since both carry role=button.
- **Rider impact:** Confusing, doubled announcements around every legend row and station badge that currently has an active alert — a rider may not realize the two controls (row toggle vs. alert detail) are functionally distinct, or may be announced the meaningless outer 'Map marker' label instead of the real alert text depending on how their AT resolves the nested roles.
- **Proposed fix:** For (1): move the alert badge out of the checkbox row's accessible-name/role tree — e.g. keep the badge visually inside the row but give the row `aria-label` that already includes alert state, and drop `role=button`/`tabindex` from `.alert-badge` when it is nested inside a `role=checkbox` ancestor (or, simpler, render the badge as a non-interactive `<span role="img" aria-label="...">` in the legend context, keeping the interactive tooltip-pin behavior only for the standalone map/station badges where it isn't nested). For (2): set an explicit `wrap.setAttribute('aria-label', '')` or, better, `wrap.setAttribute('role','presentation')`/give it the SAME accessible name as the child before `.addTo()` in js/boardingBadges.js, so MapLibre's addTo() default never fires on the wrap.
- **Pin it with:** New axe-core assertion (or a plain DOM assertion mirroring outcomes.json's legendNesting/badgeMarkerNesting checks used here) in tests/ui.test.js and tests/boardingBadges.test.js: no element with role=checkbox or a MapLibre-marker wrapper contains a nested [role] or [tabindex] descendant.
- **Verifier note:** Strong corroboration -- both the manual DOM-nesting check and an independent axe-core run agree on the exact node count (14). The reporter's note that phone vs desktop counts are identical (data-driven by active alerts, not viewport) is consistent with what I observed.

#### R5-07 — The loading splash is a wordless logo for up to 15 s — no text, no progress, no "still connecting" state

**low** · verified T2 · effort S · reported by R5

- **Where:** `index.html:104`, `styles/index-style.css:1720`, `js/api.js:60`
- **What happens:** Rider on weak LTE underground opens the app. For up to 15 s the entire screen is a white rectangle with a small Metro logo. There is no word on screen — not 'Loading', not 'Connecting to live feed'. If the feed is down, the splash then vanishes into a map with no vehicles, and the offline toast (api.js:312) is the first text they ever see.
- **Rider impact:** A slow start is indistinguishable from a hung app; riders reload or leave rather than wait.
- **Proposed fix:** Add a single line of text under the ring inside `.loader-content` — 'Loading live Metro map…' — and swap it to 'Still connecting to the live feed…' on a ~6 s timer, so the splash always says something and says something different when it is slow. Pure markup + one `setTimeout`; the existing `role="status" aria-live="polite"` wrapper announces both.
- **Pin it with:** `tests/ui.test.js` — assert `#loading` contains a non-empty visible text node, and that `removeLoadingScreen()` still resolves `loadingDone` exactly once.
- **Documented decision:** docs/audits/app-chrome-ux-audit-2026-06-16.md §6 ("Loading splash — role=status aria-live=polite, 15 s fallback, fade-out gated" listed as verified-good; the a11y wiring is good, the visible copy is the gap)
- **Verifier note:** Straightforward, low-risk copy-only fix as proposed. No further capture needed -- the claim is purely about static markup content, fully verifiable by reading.

#### R5-08 — `.station-popup-wrap.modern { max-height: 45vh }` on ≤1280 px lacks the `dvh` fallback the file uses everywhere else, so on iOS Safari the popup is sized against the URL-bar-hidden viewport

**low** · verified T2 · effort S · reported by R5

- **Where:** `styles/index-style.css:2337`, `styles/index-style.css:2210`, `styles/index-style.css:248`
- **What happens:** iPhone Safari with the URL bar visible, a busy station (Union Station, 4 lines + alert banners). The station popup's internal scroller is allowed to grow ~36 px taller than 45 % of the visible map, so the bottom of the popup can sit under the browser toolbar until `_keepPopupOnScreen` pans the camera to correct it — a camera move the rider did not ask for.
- **Rider impact:** Occasional unnecessary map pan on opening a tall station popup, and slightly more of the popup pushed toward the browser toolbar than the design intends.
- **Proposed fix:** One-line consistency fix: add `max-height: 45dvh;` directly after css:2337 (and `60dvh` after css:1208), matching the pattern at css:248-249 / 2210-2211. `dvh` is supported across the stated browser floor (iOS Safari 15.4+, Chrome 108+, Firefox 101+) and the duplicated `vh` line is the fallback.
- **Pin it with:** `tests/station-popup-onscreen.test.js` — CSS-source assertion (pattern of `tests/search.test.js:346`) that every `max-height: Nvh` on `.station-popup-wrap.modern` and `#legend-container` is followed by an equivalent `dvh` declaration.
- **Documented decision:** CLAUDE.md "Station popup placement & the on-screen correction (showArrivalsPopup / _keepPopupOnScreen)"
- **Verifier note:** One-line-per-site consistency fix, exactly as proposed. dvh support matches the documented browser floor (iOS Safari 16.4+ in CLAUDE.md exceeds the 15.4+ dvh requirement).

#### R6-06 — axe 'region' (moderate): the page <h1> and the entire legend/route-filter UI sit outside any ARIA landmark

**low** · verified T2 · effort S · reported by R6

- **Where:** `index.html:102`, `index.html:203`
- **What happens:** A screen-reader user switches to landmark/region navigation (a common strategy for skimming a complex page) to jump straight to the route filters; the legend content is invisible to that navigation mode entirely, and must instead be found by linear Tab traversal or a heading search that also won't surface it (it has no heading of its own inside `#legend-icons`).
- **Rider impact:** Slower, linear-only discovery of the route-filter legend for screen-reader users who rely on landmark navigation, though the content remains reachable via Tab.
- **Proposed fix:** Wrap the legend content in a landmark, e.g. `<nav id="legend-positioner" aria-label="Route filters">` or `<aside aria-label="Map legend">`; leave `<h1>` where it is (a visually-hidden top-level h1 outside landmarks is common and lower-impact) or fold it under `<main>`.
- **Pin it with:** New axe-core assertion in a page-level test (or extend the replay harness's own axe check) that 'region' violations are absent once the legend gets a landmark role.
- **Verifier note:** Independently corroborated with an exact node-count match via a real axe-core run, strengthening confidence beyond the reporter's own capture.

#### R6-07 — axe 'aria-allowed-role' (minor): <header role="search"> is not a valid ARIA-in-HTML role for <header>

**low** · verified T2 · effort S · reported by R6

- **Where:** `index.html:122`
- **What happens:** A strictly-spec-conformant assistive technology may reject the non-permitted role and fall back to `<header>`'s implicit role (banner) instead of exposing the intended 'search' landmark — most current browsers/ATs are lenient and honor the explicit role anyway, so this is a latent rather than actively-observed break.
- **Rider impact:** In the worst case (a stricter AT), the search bar loses its 'search' landmark label and is announced as a generic banner region instead — low real-world likelihood given current AT leniency, but a technically invalid pattern the review found nowhere flagged as intentional.
- **Proposed fix:** Change the element to `<div role="search" ...>` (or wrap a `<div role="search">` inside the existing `<header>`), matching common accessibility guidance that recommends `role="search"` on a div/form rather than header.
- **Pin it with:** Extend the existing axe pass (this review's replay harness, or a project CI a11y check if one is added) to assert zero aria-allowed-role violations.

#### R6-08 — Vehicle markers have no custom :focus-visible style and no forced-colors support anywhere in the stylesheet

**low** · verified T2 · effort S · reported by R6

- **Where:** `styles/index-style.css:733`, `js/ui.js:441`
- **What happens:** A low-vision keyboard user tabbing across the map in dark mode, or against a dark basemap tile, sees a barely-visible 1px near-black focus ring around a 12-38px icon. A Windows High-Contrast-Mode user opens the legend: the custom checkbox rows' only visual state cue (background/opacity) is not guaranteed any system-color substitute the way a native checkbox would get.
- **Rider impact:** Keyboard focus position on the map is hard to track for low-vision users; the legend's selected/deselected route state may become indistinguishable under forced colors.
- **Proposed fix:** Add an explicit `.marker:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }` rule (matching the pattern used everywhere else, e.g. styles/index-style.css:782/791/964); add a `@media (forced-colors: active)` block giving `.legend-row[aria-checked="true"]` a `forced-color-adjust: none` background or an explicit border so its selected state survives.
- **Pin it with:** New CSS assertion or replay screenshot diff under `page.emulateMedia({forcedColors:'active'})` and a focused `.marker`, confirming a visible, app-controlled outline/border in both cases.
- **Documented decision:** docs/audits/app-chrome-ux-audit-2026-06-16.md#6-verified-good-checked-leave-alone
- **Verifier note:** Straightforward addition of an explicit :focus-visible rule and a forced-colors fallback, matching patterns already used elsewhere in the stylesheet for other interactive elements.


### C. Silent-failure & resilience

#### R9-01 — Boot-time data fetch has no schema/size validation — a successfully-parsed-but-empty stops.json permanently blanks every vehicle with no rider-facing signal

**high** · verified T2 · effort M · reported by R9 · also found independently as R7-02

- **Where:** `js/main.js:38`, `js/main.js:46`, `js/main.js:84`, `js/markers.js:633`, `js/markers.js:640`
- **What happens:** A bad deploy (or a build-script regression producing `{}`/a truncated-but-valid JSON body, or a CDN edge caching a stale zero-byte-turned-empty-object placeholder with HTTP 200) serves `data/stops.json` as `{}`. `_loadJson` resolves successfully with `{}`, `window.masterStopsData` is permanently `{}`, `processVehicleData` drops every incoming vehicle-positions frame via the `preBootstrap` branch for the lifetime of the page, and the loading splash still clears normally (splash removal is driven by the 2nd WS connect, unrelated to stops-load success).
- **Rider impact:** The map loads, the basemap and UI look fully functional, but zero vehicles ever appear — indistinguishable from "no service" rather than "the app is broken". No banner, no console signal a rider or on-call engineer would see without opening devtools and knowing to check `feedStatsRing.markers.preBootstrap`.
- **Proposed fix:** After `dataPromise` resolves, add a minimum-count sanity check (e.g. `Object.keys(stops).length < 1000` — current committed file has 12k+ entries) and treat a below-floor result the same as a fetch failure: push to `_loadFailures` and show the existing load-failure banner. Do the same for `trips` after `_tripsPromise` resolves. As defense in depth, add an equivalent floor check in `rebuild-gtfs.yml`'s "Check for data changes" step (fail the build if the new trip/stop count collapses by more than e.g. 50% vs the previous commit) so a catastrophic build regression can't slip past manual PR review either.
- **Pin it with:** New test (no existing main.js test file) simulating `fetch` resolving `{ ok: true, json: () => ({}) }` for stops.json and asserting `_loadFailures`/banner fires; a markers.js test asserting `processVehicleData` doesn't drop frames forever once `masterStopsData` is non-empty vs. permanently-empty.
- **Verifier note:** This was verified via an observed browser capture against the real app (stronger than a T1 unit mock in terms of end-to-end realism) rather than a vitest red/green pin, so tier is T2 per VERIFY.md's guidance for this specific finding ('T2 screenshot + console evidence is fine'). The proposed fix (a minimum-count sanity check treated like a fetch failure) is straightforward to reason about as fix-sensitive: it would push 'stops' into _loadFailures and fire the banner in exactly this scenario, which the capture above shows does not currently happen.

#### R1-03 — A single transient failure of rail-shapes.json permanently disables snapping, arc-glide, the cross-line guard and the cold-start off-route gate for the whole session — loadShapes() caches the FAILED promise and never retries

**medium** · verified T1 · effort S · reported by R1

- **Where:** `js/snap.js:67`, `js/snap.js:68`, `js/snap.js:78`, `js/main.js:92`, `js/main.js:447`
- **What happens:** Page load on a phone on a flaky connection at 08:05. The startup Promise.all at js/main.js:92 calls loadShapes(); the 327 KB fetch stalls and fetchWithTimeout aborts at 15 s. The catch fires, the toast shows, and `loadPromise` is left resolved. The connection recovers 20 s later. Every subsequent loadShapes() call — including the one at js/main.js:447 on the next service-date rollover only, not before — returns the cached resolved promise. For the remainder of the session every rail marker moves by straight-line lat/lng between fixes (visibly cutting across city blocks instead of following the track), no fix is ever snapped to the alignment, a mis-tagged vehicle can render on any line's geography unchecked, and a corrupt cold-start fix paints a marker anywhere.
- **Rider impact:** Trains visibly leave the tracks — a D Line dot drifting across Koreatown rooftops rather than down Wilshire — plus loss of every geometric safety gate, for the whole session, recoverable only by a manual page reload the toast does not ask for.
- **Proposed fix:** In the `.catch`, reset the memo so the next caller retries: `.catch(err => { loadPromise = null; console.warn(...); showToast(...); })`. Callers already `await`/`.catch()` the returned promise, so a null-reset is safe. Optionally have main.js schedule one bounded retry after the startup failure rather than waiting for a caller.
- **Pin it with:** tests/snap.test.js — add 'loadShapes retries after a failed fetch': mock fetch to reject once then resolve, call loadShapes() twice, assert fetch was called twice and hasShapeData('801') is true after the second. Today the second call resolves instantly from the cached failed promise and fetch is called once.
- **Verifier note:** Interaction the fixer must handle TOGETHER with R1-05: today a failed load never recovers, so there is no 'rejoin' moment. Adding the retry CREATES one — shape data returns mid-session while markers have been moving straight-line with a stale `_currentArc` — which is precisely the R1-05 rewind. Land R1-05's `_currentArc = null` clear in the same PR, or the retry converts a permanent degradation into a visible fleet-wide backward jump. Also worth fixing the toast copy while there: 'train headings may be less accurate' understates a state in which snapping, arc-glide, the cross-line guard and the cold-start off-route gate are ALL off.

#### R1-04 — A device clock running FAST by more than FRESH_EXPIRE_S drops 100 % of frames as `staleAge` with no alarm; at 120 s fast it selectively erases the B/D subway — the documented clock-skew alarm covers only the opposite (slow) direction

**medium** · verified T1 · effort S · reported by R1 · also found independently as R2-05

- **Where:** `js/markers.js:660`, `js/markers.js:661`, `js/feedStats.js:349`, `js/api.js:147`
- **What happens:** Case 1 (total): a device whose clock is 6 minutes fast (manual time, dead RTC, a VM without NTP). Every frame arrives with `nowSec - ts` ≈ 360 > 300, so processVehicleData returns before any marker is created or updated. api.js's futureTs gate never fires (a fast clock makes Date.now() larger, so nothing looks future-stamped), the connection dot is green, the alerts panel and station arrivals render normally — and the map has zero vehicles with no message. feedStats prints `staleAge=` at the received rate and nothing warns. Case 2 (partial, more insidious): a device whose clock is ~2.5 minutes fast. Surface fixes (age 8-29 s) give `nowSec - ts` ≈ 160-180 -> pass. B/D tunnel fixes (age p90 181-286 s) give ≈ 330-435 -> dropped. A, C, E, K trains render normally; the B and D Lines have no vehicles at all.
- **Rider impact:** Case 1: an apparently-working live map with no trains on it and no explanation. Case 2 is worse because it is believable — the rider reads 'no B/D trains are running' as service information.
- **Proposed fix:** Extend the existing once-per-session alarm in feedStats.js `_report` to the fast direction: aggregate `_markerStats.staleAge` against total received and `console.warn` once when the fraction is >= 0.5 on >= 20 received, with a message naming a fast device clock as the likely cause (the mirror of the existing futureTs warning). Purely diagnostic — leave the gate itself alone, as with the futureTs case.
- **Pin it with:** tests/feedStats.test.js — mirror the existing clock-skew test: record 30 received with 25 staleAge drops, run the report tick, assert a single console.warn naming clock skew, and assert it fires only once per session (`_clockSkewWarned`-style latch).
- **Documented decision:** CLAUDE.md 'Clock-skew blank-map alarm (feedStats.js _report)'
- **Verifier note:** DUPLICATE PAIR: R1-04 and R2-05 are the same defect reported from the marker side and the feedStats side. Verified ONCE with one probe; both ids carry the same evidence. Fix once — the fixer should treat R2-05 as the same work item. Two things the fixer should keep: (1) sharing the single `_clockSkewWarned` latch is right (a device clock is skewed in only one direction, so only one message can ever apply); (2) the fraction must be computed against RECEIVED frames aggregated across feeds, because `staleAge` lives in `_markerStats` (global) while `received` lives per-feed — that asymmetry is why the existing code could not simply be extended in place. R1-04's Case-2 'partial failure selective…

#### R2-04 — trip_updates feed-health clock is stamped BEFORE the size gate and the parse, so a corrupt feed never trips the "Live feed delayed" banner

**medium** · verified T1 · effort S · reported by R2

- **Where:** `js/tripUpdates.js:171`, `js/tripUpdates.js:183`, `js/tripUpdates.js:189`, `js/tripUpdates.js:196`, `js/tripUpdates.js:63`, `js/stations.js:1818`
- **What happens:** Metro's trip_updates endpoint (or a captive portal / proxy in front of it) starts returning non-JSON — an HTML error page, a truncated blob, or plain keepalive text. Every frame increments `jsonParse` (or `oversizeFrame`) and returns, so masterArrivalsData receives nothing and pruneStaleArrivals empties it within PAST_ARRIVAL_GRACE_S + one 30 s prune tick (~90 s). Meanwhile `_feedLastFrameUnix` is refreshed on every one of those bad frames, so `now - _feedHealth.rail` never exceeds 60 s and the banner NEVER renders. Every station popup silently shows an em-dash for every route with no explanation, indefinitely — the socket is open so the watchdog never force-reconnects either.
- **Rider impact:** Station boards go blank across the whole network with a green connection indicator and no 'feed delayed' warning; the rider concludes there is no service rather than that the data is broken.
- **Proposed fix:** Move the `_feedLastFrameUnix[_feedKey] = ...` assignment to sit next to `recordAccepted(url)` inside the try, i.e. stamp health only on a frame that actually parsed. Keep `ws._lastMessageAt` where it is (that is the socket-liveness watchdog, a different question).
- **Pin it with:** New case in tests/tripUpdates.test.js: drive `ws.onmessage` (via the existing socket harness used by tripUpdates.suspend.test.js) with a non-JSON payload and assert getTripUpdatesFeedHealth().rail does NOT advance; assert a valid frame does advance it. Mutation check: reverting the line move must turn the test red.
- **Verifier note:** Keep `ws._lastMessageAt = Date.now();` where it is — that is the socket-liveness watchdog answering a different question ('is the connection alive'), and moving it would make a garbage-emitting-but-open socket trigger a reconnect storm rather than a banner. The one behaviour change to be aware of: js/tripUpdates.js's `currentAttempt = 0` backoff reset also lives before the parse; a feed that only ever emits garbage will now show the banner AND keep its backoff reset, which is correct (the socket genuinely is connected) but means the banner is the only signal. tests/tripUpdates.suspend.test.js's staleness-clock describe block is the natural home for the regression test, and its resumeFeeds()…

#### R3b-01 — busBridges still uses the per-toggle map.once('style.load') pattern main.js abandoned in #597 — a rapid dark-mode double-toggle silently drops the bus-bridge layer AND source for up to 120 s, leaving an orphan 🚌 glyph with no bracket

**medium** · verified T1 · effort S · reported by R3b

- **Where:** `js/busBridges.js:475`, `js/busBridges.js:476`, `js/busBridges.js:468`, `js/main.js:324`, `js/main.js:330`
- **What happens:** Rider taps the dark-mode control twice in quick succession (a common 'let me see both' gesture, and the exact case map.js's `pendingDark` deferral exists to support). Toggle #1 calls setStyle and registers once-handler B1; toggle #2 is deferred by map.js's isStyleChanging guard but busBridges registers a SECOND once-handler B2. The first style.load fires B1 and B2 (both re-add the layer) and also triggers map.js's deferred second setStyle, which wipes every custom source/layer again. The second style.load finds no busBridges handler left, so `bus-bridges` source and `bus-bridges-line` layer stay gone. Recovery only happens on the next `alertsUpdated` (ALERTS_POLL_MS = 120 s, js/config.js:487) via the `if (!_map.getSource(SOURCE_ID)) _addLayer(_map)` self-heal at js/busBridges.js:471.
- **Rider impact:** For up to two minutes after a dark-mode double-toggle, the orange bus-bridge bracket disappears while the 🚌 glyph stays on the map. A rider at a closed station sees a lone bus emoji floating ~500 m off the track with no indication of which segment is bridged — the one piece of the graphic that tells them WHERE the shuttle runs is missing.
- **Proposed fix:** Replace the per-toggle `_map.once('style.load', …)` at js/busBridges.js:475-480 with one persistent `_map.on('style.load', () => { _addLayer(_map); _refreshBusBridges(_map); })` registered once inside `initBusBridges` (both calls are already idempotent via the getSource/getLayer guards), and drop the `toggleDarkMode` listener. Alternatively add `reAddBusBridgeLayer(map)` to main.js:330's existing persistent handler so all custom layers re-add from one place.
- **Pin it with:** tests/busBridges.test.js — new `describe('initBusBridges — style reload')`: mock a map whose `.on`/`.once` record handlers and whose getSource/getLayer are backed by a set that a `setStyle()` stub clears; call initBusBridges, fire two `toggleDarkMode` events, then fire `style.load` twice (clearing layers before the second) and assert `map.getLayer('bus-bridges-line')` and `map.getSource('bus-bridges')` are present after the LAST style.load. Reverting to `.once` must turn it red.
- **Documented decision:** docs/STATUS.md 'Audit fixes … PR #597' — 'A rapid dark-mode double-toggle could drop the station and micro-zone map layers (main.js registered a once('style.load') per toggle event, so only the first survived); replaced with one persistent on('style.load') handler.'
- **Verifier note:** One correction to the reporter's recovery window: recovery is NOT only the 120 s alertsUpdated self-heal — my harness shows the NEXT dark-mode toggle also restores it (a fresh once-handler is registered and consumed by that swap). So the exposure is 'until the next alerts poll or the next toggle, whichever comes first', still up to ~120 s. The reporter's alternative fix (add reAddBusBridgeLayer to main.js:330's existing persistent handler) is equally valid and puts all custom-layer re-adds in one place; either way both calls are already idempotent via the getSource/getLayer guards.

#### R7-01 — installErrorBoundary() does not actually run "first" — ESM import hoisting means every imported module's top-level code executes before it, contrary to the file's own comment

**medium** · verified T1 · effort S · reported by R7

- **Where:** `js/main.js:8`, `js/main.js:11`, `js/main.js:12`, `index.html:336`
- **What happens:** Today none of main.js's imported modules throw synchronously at their own top level (verified by grep across all of them for top-level `document.getElementById`, unguarded `document.*`/`window.*` access, etc. — all such module-scope side effects found, e.g. js/tripUpdates.js:497 `document.addEventListener('visibilitychange', ...)` at module scope, are safe). So this is a latent contract violation, not a currently-observed symptom: it does, when any future edit adds a module-scope statement to one of those ~20 modules that can throw (a DOM query assuming an element exists, a bad regex literal evaluated at load time, a `JSON.parse` of an inline constant, etc.). At that point the throw aborts the ENTIRE module-graph evaluation before main.js's own body — including `installErrorBoundary()`, `initMap()`, and the try/catch around it that calls `_showFatalBootError()` — ever runs. The rider is stuck on the loading spinner forever with no actionable message (worse than the WebGL-failure case main.js:98-112 explicitly guards, since that catch never executes either), and the error is invisible to feedStats' `globalErrors` counter and the local ring, defeating the exact telemetry/recovery-banner purpose this module documents.
- **Rider impact:** In the specific failure mode this enables (a top-level throw introduced in any of ~20 dependency modules), every rider gets a permanently stuck loading splash with zero explanation and zero error telemetry — the single worst boot outcome the codebase otherwise takes care to avoid (see the WebGL-unavailable and 15s-splash-fallback handling this same file provides for other failure classes).
- **Proposed fix:** Either (a) install the error boundary from a tiny classic (non-module) inline `<script>` placed before the `type="module"` main.js tag in index.html, so it registers before any module evaluation begins — the same pattern already used for the frame-buster script at index.html:38-43; or (b) split errorBoundary.js's install call into its own standalone entry script tag with no imports, verified by a test that actually parses/evaluates the module graph rather than asserting the function's own idempotency.
- **Pin it with:** New test (e.g. tests/bootOrder.test.js) that dynamically imports a fixture mirroring main.js's import list, where one fixture module throws at top level, and asserts `window._errorBoundaryInstalled` is true and the `error` event was captured — i.e. reproduces the empirical repro above against the real import graph instead of unit-testing installErrorBoundary() in isolation (which is what tests/errorBoundary.test.js already does, and why this was not caught).
- **Verifier note:** Severity as reported (medium) is right: it's a latent contract violation, not a currently observed symptom -- I confirmed via grep (mirroring the reporter's own check) that none of main.js's ~20 imported modules currently throw at their own top level, so today's boot is unaffected. The bug is real and will bite silently the next time someone adds an unguarded module-scope DOM/JSON statement to any of those modules. Fix option (a) in the finding (classic inline <script> before the module tag) is the more robust fix of the two — a separate <script type=module> (option b, what I prototyped) is still theoretically reorderable if someone moves the tags, whereas a classic script's execution is sy…

#### R7-03 — Neither WebSocket feed module listens for the browser's `online` event — after a real network drop+restore (tunnel, elevator, dead zone) while the tab stays visible, reconnection waits out whatever exponential-backoff delay was already in flight, up to ~5 minutes, instead of retrying immediately

**medium** · verified T1 · effort S · reported by R7

- **Where:** `js/api.js:279`, `js/api.js:321`, `js/api.js:324`, `js/tripUpdates.js:140`, `js/tripUpdates.js:156`, `js/utils.js:345`
- **What happens:** A rider's phone loses signal for ~3-4 minutes (a long tunnel segment, an elevator, a dead zone) with the map tab in the foreground the whole time. Each WS onclose during the outage schedules a longer backoff (5s, 10s, 20s, 40s, 80s, 160s, capped ~240-360s with jitter); after several failed attempts the in-flight reconnect timer is sitting at or near the 5-minute cap. The instant the phone's radio reconnects to a tower, `navigator.onLine` flips true and the OS/browser both know the network is back — but this app has no listener for that event, so the already-scheduled `setTimeout` from api.js:326-335 (and the mirrored one in tripUpdates.js) must still elapse before the next connection attempt is even made.
- **Rider impact:** After connectivity is objectively restored, the rider can be looking at a map already showing the 'Live feed offline — reconnecting…' toast/status dot (api.js:307-312) for up to several more minutes with no visible progress, even though their phone shows full signal — a transit app whose entire value proposition is live positions staying stale exactly when a rider re-emerges from a dead zone and most wants a fresh fix.
- **Proposed fix:** Add a single `window.addEventListener('online', () => { ... })` in api.js (and the mirrored one in tripUpdates.js) that, for every URL with no currently-OPEN socket, cancels any pending `_pendingReconnects` timer for that URL and immediately calls `setupWebSocket(url, map, 0)` (resetting the attempt counter) — mirroring the existing `reconnectSockets(force, reason)` helper's pattern (api.js:529-539) but keyed off the `online` event instead of visibility.
- **Pin it with:** Extend tests/api.reconnect.test.js (or a new tests/api.online-event.test.js) to dispatch a `window` 'online' event while a socket is mid-backoff and assert a fresh `setupWebSocket` call fires immediately (attempt reset to 0) rather than waiting for the previously-scheduled backoff timer.
- **Verifier note:** The finding's 'up to ~5 minutes' figure is the worst case (WS_MAX_RECONNECT_MS cap); my test used a representative 40s in-flight backoff to keep the fake-timer arithmetic simple, but the mechanism (no listener => no short-circuit, full remaining delay always elapses) is scale-invariant and the test would show the identical RED/GREEN split at any attempt count. Did not re-verify js/tripUpdates.js with its own executable test (time-boxed); a fixer implementing this should add the mirrored `online` listener to both modules in the same PR, per CLAUDE.md's documented D1 pattern of independent-but-mirrored WS lifecycles.

#### R8-03 — followVehicle.js never re-acquires a followed vehicle after Metro reassigns its trip_id mid-run — it declares the vehicle 'no longer in the live feed' and drops follow even though the same vehicle_id is live under a new marker key at that instant

**medium** · verified T1 · effort M · reported by R8

- **Where:** `js/followVehicle.js:64`, `js/followVehicle.js:215`, `js/followVehicle.js:279`, `js/followVehicle.js:290`, `js/markers.js:2373`, `js/markers.js:2396`
- **What happens:** A rider taps Follow on a D Line train and rides along with it into the downtown Regional Connector tunnel. CLAUDE.md documents this exact scenario as a real, non-rare occurrence ('Metro reassigns trip_ids mid-run, e.g. a D Line train in the tunnel'). The instant the reassignment happens, the follow camera freezes at the train's last known position (chip reads 'Reconnecting…'), the actual train marker keeps moving under a fresh trip_id elsewhere on screen, and 35 seconds later the rider gets 'That vehicle is no longer in the live feed' and follow silently ends — even though the same vehicle_id is visibly still on the map the whole time.
- **Rider impact:** The camera stops tracking their train for up to 35 seconds during exactly the disorienting tunnel segment they most wanted a hands-free follow for, then shows a factually wrong 'gone from the feed' message about a vehicle that never left the feed; the rider has to notice their own train elsewhere on the map and manually re-tap Follow.
- **Proposed fix:** Have `_tick()`'s missing-marker branch also scan `window.vehicleMarkers` for a marker whose `properties.vehicle_id` matches the last-known vehicle_id of the followed marker (captured at `startFollow`/on each successful tick) and route_code matches, and re-key `_key` to it if found — mirroring `findMarkerByVehicleId` in ui.js. This keeps the vehicle_id-is-the-stable-identity principle CLAUDE.md already establishes for search consistent across the follow feature.
- **Pin it with:** tests/followVehicle.test.js — add a case alongside 'followVehicle — vehicle vanishes' (line 113): delete the followed key from `window.vehicleMarkers` and simultaneously add a NEW key whose `properties.vehicle_id` matches; tick, then advance past `REACQUIRE_GRACE_MS`; assert follow is still active (re-keyed to the new marker) rather than ended with the 'gone' toast.
- **Verifier note:** Prototyped the proposed fix in the worktree: added a module-level `_lastVehicleId` (seeded in startFollow from the marker's properties.vehicle_id, refreshed on every successful tick) and a `_reacquireByVehicleId()` scan invoked in `_tick()`'s missing-marker branch before counting toward the reacquire grace. Reran the new probe AND the full existing tests/followVehicle.test.js suite: probe went GREEN, all 24 existing followVehicle tests still pass. Fix reverted before exiting the worktree. The reporter's severity (medium) and effort (M) both look right given the fix requires a small but real new code path, not a one-liner.

#### R9-02 — uptime-check.yml can only detect a total outage or a corrupted HTML shell — it cannot detect a broken JS deploy, which is the more likely real-world "prod is broken" scenario for this app

**medium** · verified T4 · effort M · reported by R9

- **Where:** `.github/workflows/uptime-check.yml:60`, `.github/workflows/uptime-check.yml:63`, `.github/workflows/uptime-check.yml:70`, `index.html:49`
- **What happens:** A deploy ships a JS syntax error in `main.js`, a CSP regression that blocks a script tag, or a broken/missing `vendor/maplibre-gl/maplibre-gl.js` (e.g. a partial git push, or a future vendor-refresh mistake) — the static HTML shell (including the `<title>`) still serves fine over HTTP 200, so `uptime-check.yml` reports healthy every 10 minutes while the map is blank/non-functional for every visitor. `docs/ROLLBACK.md`'s runbook is only ever triggered by this workflow filing an issue or a human noticing manually — neither fires here.
- **Rider impact:** Every visitor sees a blank or non-functional map (worst case: the app is entirely unusable) for as long as it takes a human to notice by eye, since the one automated safety net for "is prod actually broken" structurally cannot see this class of failure.
- **Proposed fix:** Add a lightweight render check: either (a) a Playwright-based smoke job (the repo already has a Playwright container pattern in live-accuracy.yml) that loads the page and asserts a real DOM signal — e.g. the MapLibre canvas element exists and `window.map` is defined — or (b) at minimum, also `curl` `vendor/maplibre-gl/maplibre-gl.js` and one `data/*.json` file directly and check they 200 + are non-trivial size, which would catch the "missing vendored asset" and "corrupted data file" sub-cases cheaply without a browser.
- **Pin it with:** N/A (CI workflow, not unit-testable) — the fix itself is the coverage improvement; validate manually by temporarily breaking a script tag on a preview deploy and confirming the new check goes red where the old one stayed green.
- **Verifier note:** Per the assignment's guidance this finding could have been left at pure trace/T4 with high confidence; I additionally executed a minimal local repro (a corrupted main.js served over HTTP, probed with the workflow's exact shell logic) that confirms the trace beyond doubt without needing GitHub Actions itself. tier remains T4 since no vitest/replay-harness assertion was used (a raw curl+http.server demo, not a CI-executable test).

#### R2-08 — trip_updates ingest has no frame-ordering check — a re-broadcast or out-of-order frame overwrites a newer prediction

**low** · verified T1 · effort M · reported by R2

- **Where:** `js/tripUpdates.js:340`, `js/tripUpdates.js:343`
- **What happens:** The CODE FACT — no ordering check, and no frame clock stored to enable one — is confirmed. The TRIGGER is not: I could not establish that Metro's WS actually delivers out-of-order frames (feeds unreachable), and the reporter's periodic-reconnect mechanism is a hypothesis rather than an observation. Treat this as 'a guard the vehicle-positions side has and this side does not', with an unmeasured rate.
- **Rider impact:** A transient ETA that jumps backwards then forwards again, or a stale ETA held for up to 90 s on a trip whose updates stop right after the bad frame.
- **Proposed fix:** Carry the frame's own clock into the entry (`msg.header?.timestamp` or `tripUpdate.timestamp`, normalized) and skip the overwrite when it is strictly older than the stored one; record a `tuOlderFrame` counter so the real rate becomes measurable before deciding whether more is warranted. Note the audit-feeds decision rule applies: check `tripUpdate.timestamp` coverage in the latest feed-reliability report before wiring it (I could not — the feeds are unreachable from here).
- **Pin it with:** New case in tests/tripUpdates.test.js: ingest frame A (ts T+10, arrival now+900), then frame B (ts T, arrival now+300); assert masterArrivalsData still holds now+900 and the drop counter incremented.
- **Verifier note:** CLAUDE.md's audit-feeds decision rule applies verbatim here ('before wiring up any optional GTFS-RT field ... consult the latest report's vehicleFields/stuFields block; >=30 % nonNull -> wire it up; <5 % -> skip'). The fixer MUST check `tripUpdate.timestamp` coverage before building this. Important trap: do NOT implement the ordering check as 'reject an arrival that moved backwards' — a legitimately revised-earlier prediction (train sped up) is indistinguishable from a stale frame by arrival time alone, so a value-based heuristic would suppress real updates. Only a frame-level clock comparison is sound. The reporter's suggestion to land a `tuOlderFrame` counter FIRST and measure is the righ…

#### R3a-10 — Busway station dots are discovered by regexing the free-text trip headsign, not the route code — a Metro headsign rewording silently removes G/J station dots from the map

**low** · verified T1 · effort S · reported by R3a

- **Where:** `js/stations.js:28`, `js/stations.js:561`
- **What happens:** No live defect today — this is a latent robustness gap, not a current wrong-info bug. The failure only materialises if Metro rewords a G/J headsign in a way that drops 'G Line' / 'J Line' / 'El Monte' / 'Harbor Gateway', at which point that pattern's stops never reach addToRegistry and no test fails.
- **Rider impact:** G/J stations silently become unclickable and invisible as station dots; riders lose the arrivals popup for a whole corridor.
- **Proposed fix:** Gate on the route code that is already in hand: `if (!['901','910','950'].includes(String(trip.rc))) return;` (or reuse isBrtRoute from utils.js), and delete GJ_DEST_RE. Add a floor assertion to the build/test so a future drop is loud.
- **Pin it with:** New assertion in tests/stations.test.js (or build-shapes.test.js): after _rebuildStationGroups against the committed data, assert the number of groups carrying a 901/910/950 route is >= 55 (currently 59) — a headsign-driven regression drops it to near zero.
- **Verifier note:** The count floor is worth having independently of the regex swap: no existing test asserts the busway station count, so the current 98-stop / 59-group coverage is unguarded against ANY regression in that phase, not just a headsign one. Metro's weekly trip_id churn (~35-45 %) means the headsign text is re-imported every week.

#### R4-07 — The alerts HTTP fetch has a timeout but no response-size bound, unlike the WS feed's oversize gate

**low** · verified T4 · effort S · reported by R4

- **Where:** `js/alerts.js:531`, `js/api.js:358`, `js/config.js:401`
- **What happens:** An upstream regression (or a replaced/mis-deployed endpoint after the handoff) returns a very large body; the 120 s poll then blocks the main thread on JSON.parse with the map frozen, repeating every poll. Not observed in production.
- **Rider impact:** Map freezes for the duration of the parse, once per poll, until the upstream is fixed.
- **Proposed fix:** Mirror the WS gate: in `_fetchAlertsFeed`, reject when `Number(r.headers.get('content-length')) > ALERTS_MAX_BYTES` (a new config constant, e.g. 2 MB — the live bus feed is 36 KB, rail 5 KB) before calling `r.json()`; when Content-Length is absent, leave as-is. The existing `Promise.allSettled` + failure-threshold UI already handles the resulting rejection correctly.
- **Pin it with:** tests/alerts.test.js — stub a response with an oversize `content-length` and assert the feed is treated as failed (health `failing` after the threshold) rather than parsed.
- **Documented decision:** CLAUDE.md "Feed-data correctness" (WS `oversizeFrame` gate precedent)
- **Verifier note:** The measurement was a single run (not the n>=3-with-spread T3 standard), and this is a resilience/missing-gate finding rather than a performance claim per se, so T4 (as the assignment explicitly permits for this finding) is the tier recorded; the executed probe test (verify/R4-07/probe.test.js) is supplementary corroboration beyond what was required.


### D. Feature correctness

#### R8-04 — Filtering the legend to a different route does not close an already-open popup for the now-hidden vehicle — it keeps floating and tracking the live (invisible) marker with no dot beneath it

**medium** · verified T2 · effort S · reported by R8

- **Where:** `js/ui.js:315`, `js/ui.js:447`, `styles/index-style.css:1147`
- **What happens:** A rider opens a train's popup, then opens the legend to filter down to just the line they actually want to ride. The train they were just looking at disappears as a dot but its info card keeps floating and sliding across the map with no visible anchor, directly contradicting the filter action they just took.
- **Rider impact:** A confusing, unexplained floating popup for a route the rider explicitly asked to hide; if they tap the popup's Follow button, followVehicle.js immediately re-shows 'Stopped following — that route is now hidden', compounding the confusion.
- **Proposed fix:** In `_applyRowVisible`/`toggleRow`, when a route transitions from visible→hidden, close any open vehicle popup belonging to that route (check `window.vehicleMarkers` for an open popup with matching `route_code`/`legendRouteFor`, call its canonical close path per the single-active-popup registry in js/popups.js).
- **Pin it with:** New case in tests/search.test.js or a new tests/legend-filter.test.js: open a vehicle popup, invoke the legend row toggle logic to hide its route, assert the popup is closed (removed from the single-active-popup registry) rather than left open.
- **Verifier note:** Clean reproduction; note the app's bottom-sheet legend is present at ALL viewport widths up to and including 1280px (the @media max-width:1280px block), not just 'mobile' in the narrow sense -- worth keeping in mind for any fix that assumes a desktop-only always-visible legend layout.


### E. Security & privacy hardening

#### R4-01 — Nothing pins the CSP inline-script hash to the frame-buster, so a one-character edit silently disables the app's only clickjacking defense

**medium** · verified T1 · effort S · reported by R4

- **Where:** `index.html:31`, `index.html:39`, `tests/pwaInstall.test.js:98`
- **What happens:** A contributor edits the frame-buster (e.g. to apply R4-02's hardening, to add a comment, or a formatter reflows it) and does not recompute the sha256. CSP then blocks the inline script; the page looks and behaves identically in every test and in normal use, and the documented structural clickjacking defense (CLAUDE.md: "The structural defense is the inline frame-buster script below instead") is gone from that commit onward.
- **Rider impact:** The Metro-branded live map can be framed invisibly by a third-party page (UI-redress / brand-abuse: a scam site overlays its own controls on a real-looking Metro map). No rider data is at risk — there is no auth, no forms, no payment — so the harm is misattribution and trust, not account compromise.
- **Proposed fix:** Add `tests/csp-policy.test.js` that reads index.html, extracts the inline `<script>` body and the CSP meta, computes sha256 of the body and asserts the digest appears in `script-src`. While there, assert every external host used at runtime (js/config.js WS + alerts + GBFS URLs, the CARTO/ESRI hosts in js/map.js, lacmta.github.io in js/config.js routeIcons) is present in the matching directive — the same file-reading pattern tests/pwaInstall.test.js:98 already uses for manifest.json.
- **Pin it with:** NEW tests/csp-policy.test.js — asserts (a) sha256 of the index.html inline script is listed in script-src, (b) each runtime host appears in the directive it needs. Mutation check: inserting a space in the inline script must turn it red.
- **Documented decision:** CLAUDE.md "A11y, privacy & security" → "Clickjacking guard is a JS frame-buster, NOT frame-ancestors"
- **Verifier note:** The proposed test in verify/R4-01/csp-policy.test.js is ready to land as-is at tests/csp-policy.test.js. R4-02's proposed_fix note (recompute the hash in the same commit as the unconditional-hide edit) is correctly sequenced against this finding — landing this test first would immediately catch a hash-forgetting mistake in that follow-up edit.

#### R4-02 — Frame-buster's hide fallback only runs if the top-navigation assignment THROWS; hiding first would not depend on that

**low** · verified T2 · effort S · reported by R4

- **Where:** `index.html:38`, `index.html:39`, `index.html:41`
- **What happens:** On any engine where the blocked top-navigation is a silent no-op rather than a SecurityError, the framed document stays visible: the guard runs, throws nothing, hides nothing. Not observed in Chromium 147; unverified on WebKit/Gecko.
- **Rider impact:** Same as R4-01 — a Metro-branded map rendered inside someone else's page. No rider data exposure.
- **Proposed fix:** Make the hide unconditional and independent of the throw: `if (window.self !== window.top) { document.documentElement.style.display='none'; try { window.top.location = window.self.location; } catch (_) {} }`. If the bust succeeds the document is replaced anyway, so nothing is lost; if it is refused (throw or silent), the page is already hidden. NOTE: this edit changes the inline script, so the sha256 in the CSP must be recomputed in the same commit — see R4-01, which is why that test should land first.
- **Pin it with:** tests/csp-policy.test.js (from R4-01) pins the hash; add a jsdom case asserting `documentElement.style.display === 'none'` when `window.top !== window.self` and the assignment throws AND when it silently no-ops.
- **Documented decision:** CLAUDE.md "A11y, privacy & security" → "Clickjacking guard is a JS frame-buster, NOT frame-ancestors"
- **Verifier note:** Chromium-side evidence is now T2-grade (a real exception name captured, not just an inferred side effect); the WebKit/Gecko gap is a genuinely untestable-here unknown for both reporter and verifier — flagged, not glossed over. The proposed fix (unconditional hide before the navigation attempt) is cheap, correct regardless of which engines are actually affected, and its regression_test correctly notes it must land alongside R4-01's hash-recompute.


### F. Test gaps & pipeline

#### R9-04 — build-shapes.cjs's buildBusDestinationsJson (the "zero mislabels" bus-destination compaction algorithm) is exported "for tests" but has NO test coverage — a mutation that completely inverts the byTrip minority-branch logic passes the full 1226-test suite

**high** · verified T1 · effort M · reported by R9

- **Where:** `scripts/build-shapes.cjs:419`, `scripts/build-shapes.cjs:481`, `scripts/build-shapes.cjs:825`
- **What happens:** This exact class of bug — the minority-branch (byTrip) selection logic getting inverted, off-by-one'd, or otherwise broken during a future refactor of the bus-destinations builder — ships silently through the weekly `rebuild-gtfs.yml` PR (which only asks a human to eyeball trip/route COUNTS, not per-trip destination correctness) and through CI (green, since nothing tests this function). The mutated version above would make every branch/short-turn bus trip (e.g. the CLAUDE.md-cited "a 111 short-turning to Inglewood among mostly-LAX trips") show its route's DOMINANT destination instead of its true one — i.e. it reconstructs the exact rider-facing mislabel bug this feature was built to eliminate.
- **Rider impact:** A bus rider waiting for a specific destination (e.g. Inglewood) sees the wrong destination label (LAX) on the nearby-buses list for every short-turn/branch trip on that route+direction, exactly the original UX complaint CLAUDE.md documents as motivating this feature, with zero indication anything is wrong.
- **Proposed fix:** Add a `buildBusDestinationsJson`-focused unit test in tests/build-shapes.test.js: write small fixture trips.txt/stop_times.txt-shaped row arrays (or refactor the function to accept row iterables directly, mirroring how `buildCanonicalShapes` takes a `shapeToRoute` map), and assert: (1) the dominant destination is chosen correctly by tally, (2) a minority-destination trip lands in `byTrip` with the right index and is NOT present when its destination matches the dominant one, (3) the non-bare-route-code and dropped-empty-dir warnings fire on the fixture cases designed to trigger them.
- **Pin it with:** New: tests/build-shapes.test.js — `describe('buildBusDestinationsJson')` block driving the function against fixture CSV rows (via temp files or by extracting the pure tally logic into a directly-testable helper).
- **Verifier note:** The fixture-based probe in verify/R9-04/probe.md is a ready template for the proposed test — it already asserts the exact byTrip shape a correct implementation must produce; a fixer can drop it into tests/build-shapes.test.js largely as-is (adjusted to use temp files or a refactored row-iterable signature, per the finding's own proposed_fix).

#### R9-05 — The _lastKnownDir arc-space-memory fallback (PR #597, explicitly "do NOT simplify" in CLAUDE.md) has zero test coverage — removing it entirely passes the full test suite

**high** · verified T1 · effort S · reported by R9 · **touches a documented invariant**

- **Where:** `js/markers.js:226`, `js/markers.js:217`
- **What happens:** A future contributor reads `_markerShapeKey`, sees the fallback as redundant-looking (`vehicle?.properties?.direction_id` is usually populated) and "simplifies" it away, exactly the scenario CLAUDE.md's comment anticipates. Per that same comment, ≥2 consecutive null-direction frames (which the codebase deliberately produces per-frame elsewhere — the `direction_id` field is nulled on every direction-less frame) then resolve the bare/unsplit shape key instead of the marker's true per-direction shape, flipping the arc space on a split route (801\|0, 802\|0, 901\|0, 910\|0, 950\|0) and causing the glide to sweep most of the line (the historical "fly" bug) — with CI staying fully green.
- **Rider impact:** A vehicle marker on any per-direction-split route (A/B lines, G/J BRT) visually teleport-glides across most of the line on a run of direction-less frames, exactly the bug class CLAUDE.md's "arc-space guard" section is otherwise carefully engineered to prevent, reintroduced with no automated warning.
- **Proposed fix:** Add a test that: seeds a marker with `_lastKnownDir` set (e.g. `0`) and `_currentArcKey` on the per-direction shape, feeds it 1-2 consecutive frames with `vehicle.properties.direction_id == null`, and asserts `_markerShapeKey` (or the resulting glide target) still resolves the per-direction shape key rather than falling back to the bare/generic one.
- **Pin it with:** New: add to tests/arc-space-guard.test.js — a case specifically named for the null-direction-frame fallback (distinct from the existing shape-key-MISMATCH re-anchor cases already there), asserting `_lastKnownDir` is used and the arc space does not flip.
- **Documented decision:** CLAUDE.md — Motion model, "Arc-space guard" / "`_markerShapeKey`'s direction fallback (PR #597)"
- **Verifier note:** The probe test file (verify/R9-05/probe.test.js) is directly usable as the missing regression test in tests/arc-space-guard.test.js — it reuses that file's exact fixtures/harness and needs no new scaffolding.

#### R10-05 — CLAUDE.md claims the vehicle-search landing order ("togglePopup(), then toggleFollow") is "mutation-tested" in tests/search.test.js — verified false by direct mutation: swapping the two calls still passes all 24 tests

**medium** · verified T1 · effort S · reported by R10 · **touches a documented invariant**

- **Where:** `CLAUDE.md:114`, `js/ui.js:286`, `js/ui.js:287`, `tests/search.test.js:13`, `tests/search.test.js:247`
- **What happens:** A future refactor of the moveend handler in js/ui.js (e.g. reordering for a perceived optimization, or a merge conflict resolution that flips the two lines) fires `toggleFollow` before `togglePopup` opens the vehicle popup — the full test suite, including the file CLAUDE.md specifically names as pinning this order, stays green.
- **Rider impact:** Low on its own (both actions still happen within the same moveend callback either way), but CLAUDE.md's own stated rationale for the order (`togglePopup()` is the sanctioned open path that registers single-active-popup state and rebuilds the ETA; doing it after follow rather than before is not shown to matter functionally today) means a future change relying on this ordering guarantee — e.g. a bug fix that assumes the popup is already open and registered before follow-tracking begins — could ship silently broken.
- **Proposed fix:** Extend the existing `order` array assertion in tests/search.test.js (near line 247) to also assert `expect(order.indexOf('togglePopup')).toBeLessThan(order.indexOf('toggleFollow'))`, matching what the mock instrumentation already tracks but never checks. Alternatively, if the relative order of these two calls genuinely doesn't matter, soften CLAUDE.md:114's claim to name only the three orderings the test actually verifies, so the "mutation-tested" label stops overclaiming.
- **Pin it with:** tests/search.test.js — add the `togglePopup`-before-`toggleFollow` order assertion described above; verified by mutation (see evidence) that this assertion is currently absent and its absence lets a swapped-order bug through.
- **Documented decision:** CLAUDE.md "Search matches stations AND live vehicles" — "Landing order is load-bearing and mutation-tested in tests/search.test.js"
- **Verifier note:** CLAUDE.md's 'Search matches stations AND live vehicles' section states the landing order is 'mutation-tested in tests/search.test.js' for four constraints (camera-takeover-before-follow, route-visible-before-fly, popup+follow-wait-for-moveend, re-resolve-after-flight). Only the takeover-before-follow ordering is actually caught by an existing assertion; the route-visibility-before-fly ordering is additionally NOT PINNABLE by any synchronous-assertion test as currently structured (both `ensureRouteVisible` and `map.flyTo` run synchronously in the same callback with no yield point the test could observe between them — a genuinely different test strategy, e.g. asserting from inside a flyTo moc…

#### R3b-04 — Every LIFECYCLE function in boardingBadges.js and busBridges.js is untested — 72 tests cover only the pure helpers, so the marker-reconcile, tooltip-orphan and style-reload paths (where R3b-01 lives) have no coverage at all

**medium** · verified T1 · effort M · reported by R3b · **touches a documented invariant**

- **Where:** `js/boardingBadges.js:472`, `js/boardingBadges.js:651`, `js/boardingBadges.js:760`, `js/busBridges.js:375`, `js/busBridges.js:455`, `tests/boardingBadges.test.js:1`, `tests/busBridges.test.js:1`
- **What happens:** R3b-01 is the proof: a known-broken pattern (documented in main.js:324 and STATUS.md as already fixed once elsewhere) was written into busBridges.js and shipped, because no test drives initBusBridges at all. The same blind spot covers the CLAUDE.md alert-badge-removal contract — deleting `hideAlertTooltipForAnchor(...)` from boardingBadges.js:639/657/678 or busBridges.js:392/415 leaves the whole suite green.
- **Rider impact:** Indirect: the badge/bridge subsystem's two documented invariants (orphaned pinned tooltip re-anchoring to the viewport corner; layers surviving a style swap) can regress silently, and both are rider-visible on the map.
- **Proposed fix:** Add a shared `tests/_lib/fake-maplibre.js` (Marker/Popup/Map doubles that record element, anchor, offset, lngLat, remove() and fire listeners) and cover, at minimum: (a) initBusBridges style-reload after a double toggle (R3b-01); (b) `_refreshBusBridges` calls hideAlertTooltipForAnchor before remove on both the obsolete-key and side-changed paths; (c) `_renderStationBadges` removes a badge whose alert expired and calls hideAlertTooltipForAnchor first; (d) `_syncBadgeMarker` reuses the marker when the slot is unchanged and rebuilds it when the slot changes. Export `_renderStationBadges` for the test the way `_collectBoardingState` already is (js/boardingBadges.js:362 sets the precedent and states the rationale).
- **Pin it with:** New tests/boardingBadges-render.test.js and the initBusBridges block added to tests/busBridges.test.js, per the fix. Each assertion must be mutation-verified (delete the guard → suite red).
- **Documented decision:** CLAUDE.md 'Alert-badge marker removal & the pinned tooltip (hideAlertTooltipForAnchor, js/alerts.js)'
- **Verifier note:** R3b-01 is the demonstrated cost of this gap: a pattern main.js:324 documents in prose as already-broken-and-fixed was written into busBridges.js and shipped. My mutation run raises the stakes beyond the reporter's claim — deleting the guards ONE at a time is not needed, deleting ALL SIX at once is still green. Start the shared tests/_lib/fake-maplibre.js with (a) initBusBridges style-reload and (b) hideAlertTooltipForAnchor-before-remove on both modules; _collectBoardingState (boardingBadges.js:362) is the precedent for exporting _renderStationBadges for test.

#### R9-03 — gtfs-drift-check.yml's filed issue tells the maintainer "a rebuild has been auto-triggered" — that auto-dispatch was removed in 2026-08, so the issue's own instructions are false and could delay the human action actually required

**medium** · verified T4 · effort S · reported by R9

- **Where:** `.github/workflows/gtfs-drift-check.yml:233`, `.github/workflows/gtfs-drift-check.yml:235`, `.github/workflows/gtfs-drift-check.yml:9`
- **What happens:** gtfs-drift-check.yml fires (e.g. a post-rebuild-merge drift check finds >5% coverage drift because the merged rebuild PR was itself built against transiently-bad upstream data). The filed `gtfs-drift` issue tells whoever reads it to simply wait for an auto-triggered PR. No such PR ever appears (there is no dispatch), and the maintainer — trusting the issue's own text — waits instead of manually re-running `rebuild-gtfs.yml` or investigating, extending the window where `data/trips.json`/`stops.json` stay drifted.
- **Rider impact:** Extends exactly the em-dash-terminus / blank-destination staleness symptom already seeded as a known issue, because the response the maintainer is told to take (wait) is not the response the system actually needs (manually dispatch or investigate).
- **Proposed fix:** Update the issue body to match current behavior, e.g.: "This does NOT auto-trigger a rebuild (that dispatch was removed 2026-08). Either wait for next Monday's scheduled rebuild-gtfs.yml run, or manually run it now via `gh workflow run rebuild-gtfs.yml` / the Actions tab."
- **Pin it with:** New test in tests/ (no CI-workflow test framework exists for issue-body text specifically) — at minimum, grep-based repo consistency check asserting the drift-check workflow's issue body doesn't contain the string "auto-triggered" now that the header comment says no auto-dispatch exists; could be folded into a doc-drift lint.
- **Verifier note:** Pure prose contradiction within a single file, fully verifiable by reading — no code path to execute (the bug IS the text). T4 is the correct and sufficient tier per VERIFY.md; execution would add nothing beyond the direct quotes already reproduced verbatim.

#### R9-06 — CLAUDE.md/the test file both claim station-popup-onscreen.test.js is "mutation-verified" for all four guards, but removing the _restoringDetails synthetic-toggle suppression guard passes the full suite

**medium** · verified T1 · effort S · reported by R9 · **touches a documented invariant**

- **Where:** `js/stations.js:734`, `js/stations.js:289`, `js/stations.js:858`, `tests/station-popup-onscreen.test.js:18`
- **What happens:** A future edit to the popup-refresh code path (the ~5s nearby-bus refresh that sets `freshBus.open = true` to restore prior state) that drops or breaks the `_restoringDetails` suppression would reintroduce the documented bug — the delegated `toggle` listener firing on the refresh's own state restore and panning the rider's map back every 5 seconds for as long as the bus list stays open — with the test suite, including the very file whose docstring claims to mutation-guard this exact case, staying fully green.
- **Rider impact:** A rider who expanded the nearby-buses list and then dragged/panned the map away from the station popup would have their map silently panned back to the popup every ~5 seconds for as long as the list stays open, undoing their own navigation with no visible cause.
- **Proposed fix:** Add a test case to tests/station-popup-onscreen.test.js that simulates the ~5s refresh path setting `.open = true` on the restored `<details>` element (dispatching or triggering the synthetic `toggle` this causes) and asserts `panBy`/`_keepPopupOnScreen` is NOT invoked for that synthetic restore, distinguishing it from a genuine rider-initiated `<details>` toggle (which the existing tests do cover). Also correct the CLAUDE.md/test-header claim that "every case is mutation-verified" until this gap is closed.
- **Pin it with:** New case in tests/station-popup-onscreen.test.js, e.g. "does not pan when the ~5s refresh restores the details' open state" — sets `_restoringDetails`-triggering conditions and asserts zero `panBy` calls.
- **Documented decision:** CLAUDE.md — "Station popup placement & the on-screen correction" (PR #616 + #617)
- **Verifier note:** Did NOT write the missing pin test (marked optional/cheap by VERIFY.md, and it is not cheap here): it requires driving showArrivalsPopup's real setVisibleInterval refresh tick with masterArrivalsData populated with nearby-bus rows so buildArrivalsHTML emits a `.sp-bus-details` block that differs enough between ticks to trigger currentWrap.replaceWith(fresh) — substantially more fixture setup than any existing test in this file, which all sidestep the refresh machinery via direct dispatch. Flagging this setup cost for whoever picks up the fix; the finding's own proposed_fix already describes the needed scenario correctly.

#### R9-07 — Two deliberately-duplicated cross-file "mirror" values (feed URLs in audit-feeds.js vs config.js; the adherence-taper formula in replay-taper.js vs predictions.js) have no automated lockstep check — only a code comment enforces the invariant

**medium** · verified T1 · effort S · reported by R9

- **Where:** `scripts/audit-feeds.js:71`, `js/config.js:388`, `js/config.js:485`, `scripts/replay-taper.js:75`, `scripts/replay-taper.js:76`, `js/predictions.js:186`
- **What happens:** The taper-formula mirror (taperedCalcEta in scripts/replay-taper.js) has ALREADY silently diverged from production (_applyTaperedOffset in js/predictions.js) at the schedule-overrun boundary (remainingTime === 0) — taperedCalcEta lacks the overrun branch production added, so a K-sweep row reconstructed at exactly r=0 with a positive adherence offset is under-estimated (floored to `now` instead of `schedEta + offset`). This is demonstrable today via direct comparison, not only a risk of future drift. The METRO_WS_FEEDS mirror (audit-feeds.js vs config.js) remains genuinely in sync as filed — only the taper-formula half of the evidence needs correction.
- **Rider impact:** Indirect — a stale audit-feeds.js mirror could mask a genuine feed-subscription regression (fewer routes actually monitored than intended) from the scheduled reliability audit, delaying detection of a real coverage gap; a stale replay-taper.js formula could lead to a wrong ETA-taper constant being shipped based on an analysis of a formula that no longer matches production.
- **Proposed fix:** Add a lightweight lockstep test for each: (1) a Node test that reads the `METRO_WS_FEEDS`/`RAIL_ALERTS_URL`/`BUS_ALERTS_URL` literals out of both `js/config.js` (via import) and a small regex extraction of `scripts/audit-feeds.js`'s source text, asserting the sets of URLs match — this checks equality without making the runtime auditor import config.js (preserving its "zero production imports" independence); (2) a property-based/table-driven test that calls both `js/predictions.js`'s `_applyTaperedOffset` and `scripts/replay-taper.js`'s `taperedCalcEta` with the same random (schedEta, offset, now, k) tuples and asserts identical outputs.
- **Pin it with:** New: tests/audit-feeds-mirror.test.js (URL-set equality) and an added case in tests/replay-taper.test.js cross-checking `taperedCalcEta` against `_applyTaperedOffset` for matching inputs.
- **Verifier note:** This is a genuinely useful incidental discovery beyond simply confirming the test-gap: the lockstep test R9-07 proposes for the taper formulas would fail immediately on current code (not just guard a hypothetical future edit), which makes closing this gap more urgent than 'nice to have'. Recommend the fixer prioritize porting _applyTaperedOffset's remainingTime===0 overrun branch into replay-taper.js's taperedCalcEta alongside adding the lockstep test.

#### R9-08 — build-shapes.cjs's scheduledTimes hole-fill (t.scheduledTimes[i] = 0) is the only silent-data-loss path in the file with no build-time warning, and a mid-trip 0 can pass predictions.js's gap<0 guard as a large POSITIVE (wrong, not just missing) gap

**low** · verified T4 · effort S · reported by R9

- **Where:** `scripts/build-shapes.cjs:644`, `js/predictions.js:551`, `js/predictions.js:386`
- **What happens:** A future GTFS feed from Metro has a genuinely malformed or missing `stop_times.txt` row for one stop of the LONGEST trip selected as the (route,direction) canonical schedule cache (only the single longest trip per route+direction is cached in `routeStops`, per `js/predictions.js:69`) — e.g. a duplicate/skipped `stop_sequence`. The hole silently becomes `scheduledTimes[i] = 0`, and every calc-ETA computation crossing that stop index, for every trip on that route+direction (not just the one with the hole), either returns a wildly-inflated positive gap (wrong ETA, not caught) or `null` (degrades to missing, if the hole lands the other way).
- **Rider impact:** A wrong (much-too-late) calc ETA displayed for a whole segment of a route, or a missing ETA — depending on which side of the hole the gap lands — with no build-time signal that anything unusual happened in that week's GTFS.
- **Proposed fix:** Emit a `console.warn` in the hole-fill loop (mirroring the style of the other guards in this same file) when any `scheduledTimes[i]` is filled from a hole, naming the tripId/stop index so the weekly-rebuild PR diff surfaces it. Optionally also have `initPredictions()` in predictions.js skip/deprioritize a canonical trip candidate whose `scheduledTimes` contains a non-monotonic or implausible (e.g. exact-zero mid-array) entry rather than caching it as the route's canonical schedule.
- **Pin it with:** New: tests/build-shapes.test.js case feeding a fixture stop_times.txt with a missing row mid-trip through `buildTripsJson`-equivalent logic (would require exporting/refactoring `buildTripsJson` similarly to R9-04) and asserting a warning is logged.
- **Verifier note:** T1 execution would require refactoring buildTripsJson's ingestion to be independently fixture-testable (as the finding's own regression_test field acknowledges) — a production code change out of scope for a read-only verification pass. Trace + a direct data scan (confirming the reporter's 0-trips-affected claim precisely) is sufficient per VERIFY.md's T4 allowance for this finding.


### G. Documentation drift

#### R10-01 — "Vehicle markers are pointer-only, no keyboard focus or role" is false and traceable to MapLibre's own Marker.setPopup() behavior — the VPAT-cited claim in HANDOFF.md and the code comment it quotes are both wrong

**medium** · verified T1 · effort S · reported by R10

- **Where:** `docs/HANDOFF.md:144`, `docs/HANDOFF.md:145`, `js/markers.js:900`, `js/markers.js:901`, `js/markers.js:967`, `vendor/maplibre-gl/maplibre-gl.js:1`
- **What happens:** A new LA Metro engineer or accessibility reviewer reads HANDOFF.md §5 (a VPAT-facing section) or the in-code comment it cross-references, concludes vehicle markers have zero keyboard path by design, and files a VPAT/ACR claiming a 2.1.1/4.1.2 partial-support exception that is factually inaccurate — the markers ARE in the tab order today (with a useless generic "Map marker" name and no visible focus ring per R6-08), they just aren't a GOOD keyboard experience. The doc's own proposed remediation ('the planned fix is an off-canvas nearby/active vehicles list') is scoped to a problem ('no keyboard focus or role') that doesn't describe what's actually broken (focus exists but is useless/duplicated across ~50-200 markers with an unhelpful name, and R6-01 shows opening one hijacks focus).
- **Rider impact:** No direct rider-facing symptom from the doc text itself, but the compliance artifact it feeds (VPAT/ACR) would misdescribe the app's actual keyboard behavior to disability-services procurement reviewers at Metro — the exact audience §5 is written for.
- **Proposed fix:** Rewrite HANDOFF.md §5's callout and the js/markers.js:900-906 comment to state the true mechanism: vehicle markers ARE in the tab order (MapLibre's Marker.setPopup() default) with role=button and the generic name "Map marker", Enter opens the popup, but (a) the accessible name never identifies WHICH vehicle/route, (b) there is no custom :focus-visible style (R6-08), and (c) opening the popup re-steals focus on every live update (R6-01) — so the realistic VPAT framing is a 4.1.2 (Name, Role, Value) partial-support item (bad name, focus-steal) layered on a 2.1.1 pass, not a full keyboard-inaccessible surface. Keep the existing 'accessible equivalent path via station search' remediation language — it is still true and still the right interim citation.
- **Pin it with:** Add a jsdom assertion in tests/ (e.g. a new case in an a11y-focused test file) that creates a vehicle marker via createNewMarker and asserts `el.closest('.maplibregl-marker')?.getAttribute('tabindex') === '0'` and `aria-label !== 'Map marker'` once fixed with a per-vehicle label — this pins the CURRENT (buggy) state today and should be updated alongside R6-01/02's fix, not filed as a separate no-op assertion.
- **Documented decision:** docs/HANDOFF.md §5 Accessibility (WCAG 2.1 AA / Section 508 — VPAT note)
- **Verifier note:** Cross-references VT2's R6-02 verdict (CONFIRMED, T2, see ../verified/VT2.json): VT2 independently confirmed the SAME underlying fact via a live replay-harness capture (role=button/tabindex=0/aria-label='Map marker' on 8 sampled live markers, a focused-marker Enter-opens-popup test, and a 15-stop keyboard-Tab walk showing markers ARE in the tab order with a useless generic name). VT2's evidence is the observational (browser-DOM) confirmation that this behavior actually ships; this entry's T1 test is the mechanism-level confirmation (grepped vendored source + a controlled jsdom construction of the real Marker class) that traces WHY it happens and pins it as a regression-detectable fact, plus …

#### R10-04 — HANDOFF's external-dependency table calls lacmta.github.io "build-time only" / "doesn't affect the live site" — it is actually fetched live in the browser on every station popup, search result, and alert tooltip render (route icon SVGs)

**medium** · verified T2 · effort S · reported by R10

- **Where:** `docs/HANDOFF.md:264`, `js/config.js:531`, `js/config.js:533`, `js/stations.js:1372`, `js/ui.js:199`, `index.html:11`, `index.html:31`
- **What happens:** The reporter's rider_impact framing ('falling back to whatever alt/placeholder rendering exists') undersold what actually renders: there is no `onerror` handler anywhere in the codebase (grepped js/*.js and styles/index-style.css — zero hits on route-icon `<img>` elements) and no CSS that hides a failed `<img>` load, so a 404'd icon is not a clean text-only fallback — it is the browser's default broken-image glyph occupying the icon's normal box (20px station-popup icon, 28px vehicle-popup icon, 16px alert-tooltip icon) in every station popup row, vehicle popup header, search result, and alert tooltip. The `alt` text IS present and correct (confirmed 'A'/'B'/'D' single-letter alts in the capture), so screen-reader users are unaffected — this is a sighted-rider-only visual regression, not an information-loss one.
- **Rider impact:** If lacmta.github.io becomes unreachable in production (outage, or a firewall change made on the mistaken belief it's build-time-only), riders would lose the branded line-letter icon glyphs in every station popup, search result, and alert tooltip — falling back to whatever alt/placeholder rendering exists, a real but non-blocking visual degradation.
- **Proposed fix:** Split the single lacmta.github.io row in HANDOFF.md §7 into two: one for `lacmta.github.io/GTFS_Documents` (build-time only, breaks the manual/CI rebuild) and one for `lacmta.github.io/metro-iconography` (live runtime `<img>` dependency for route icon SVGs across station popups, search, and alert tooltips — failure degrades to missing/alt-text icons, not a functional break). Given the #245 precedent (MapLibre vendored same-origin specifically to remove a CDN single-point-of-failure and simplify the CSP), also record vendoring these ~9 small SVGs same-origin as a candidate follow-up — same rationale, much smaller payload.
- **Pin it with:** None existing; optionally add a CSP-string test (e.g. tests/csp.test.js) asserting index.html's `img-src` still contains `lacmta.github.io` — currently nothing pins the CSP string at all, so an accidental removal of that origin would silently break every route icon with no test failure.
- **Verifier note:** This is a docs-drift finding about docs/HANDOFF.md's dependency table, not a code bug — no code fix is being verified for fix-sensitivity. The live repro also surfaces an adjacent, un-filed code-quality gap worth flagging to whoever picks this up: adding a same-origin fallback (e.g. an `onerror` handler swapping to a colored-letter chip, mirroring the `_searchRouteBadge` two-tier pattern already used for bus routes with no icon asset) would convert this from a visible breakage into the graceful degrade the original HANDOFF.md entry incorrectly implies already exists. R4-08 (per the reporter's own cross-reference) independently found the same live <img> fetch from a privacy angle; this verif…

#### R4-04 — HANDOFF §12.2's 2-minute recipe for verifying the alerts-Lambda provenance no longer works — but the provenance is now verifiable another way (evidence included)

**medium** · verified T4 · effort S · reported by R4

- **Where:** `docs/HANDOFF.md:409`, `docs/HANDOFF.md:418`, `js/config.js:485`, `js/config.js:486`
- **What happens:** LA Metro's engineer follows §12.2 during the migration into LACMTA/livemap, sees no `on.aws` request on alerts.metro.net, and either (a) treats the endpoints as a personal proxy that must be re-homed before cutover — work that may be unnecessary — or (b) stalls on the one dependency the doc flags as needing the most attention.
- **Rider impact:** None directly. If the wrong conclusion leads to a hurried endpoint swap at cutover, the service-alert banners, station alert badges and bus bridges all go blank until it is fixed.
- **Proposed fix:** Rewrite §12.2's verification step: (1) the alerts.metro.net DevTools recipe is dead — say so; (2) record the content-equality evidence above as the current best provenance signal, and the Lambda's extra `userEmail`/`userFullname` fields as a second signal that it is an internal Metro backend rather than a scrape; (3) name `https://go.metro.net/api/alerts?stopId=&routeId=<codes>` as the Metro-hosted fallback, noting it needs route scoping and omits `id` (js/alerts.js uses `alert.id` for dedupe and for the popup's `data-alert-id`), so it is not a drop-in. Add a one-line caution next to js/config.js:485 that the raw payload carries staff PII and must never be spread into a stored entry.
- **Pin it with:** None (docs). Optionally extend tests/alerts.test.js with a case asserting the normalized entry has no `userEmail`/`userFullname` key, so a future `{...alert}` refactor cannot start persisting them.
- **Documented decision:** docs/HANDOFF.md §12.2 "The alerts data endpoints (the one real unknown)"
- **Verifier note:** Per instructions, did NOT reproduce or retain any personal-data VALUES from the Lambda payload — only field names were inspected and recorded, and the temp file holding the actual payload was deleted immediately after. Every factual claim in the finding checked out exactly against a fresh, independent live capture.


### H. Motion & geometry

#### R1-01 — Cross-line guard has no separation margin, so a heavy-rail tunnel fix can be re-attributed to the parallel non-interlined A/E alignment — the fix is held and the marker eventually expires

**medium** · verified T1 · effort S · reported by R1 · **touches a documented invariant**

- **Where:** `js/markers.js:546`, `js/markers.js:536`, `js/markers.js:485`, `js/markers.js:1756`, `js/config.js:93`
- **What happens:** The reporter's D-Line-tunnel scenario is NOT the reachable one and should be replaced. For a heavy-rail vehicle (own tol 250 m) re-attributed to a light-rail line (tol 150 m) the tolerance asymmetry bakes in an implicit >=100 m margin, and my directional-scatter simulation over the real 805 polyline produced 0.0 % rejects at 300 m scatter and 1.7 % at 400 m. The reachable case is the MIRROR: a LIGHT-rail vehicle (804 E / 801 A, tol 150) whose fix lands 150-250 m off its own alignment and marginally closer to the non-interlined heavy-rail 802/805 tunnel alignment (tol 250) — there `d` may sit anywhere in (150, 250] and be 'clean' on the other line, so the margin can be arbitrarily small. Exposure (any-of-36-bearings scatter sweep, verify/R1-01/geometry-sweep.txt): 804 is vulnerable at 6.1 % of sampled vertices at only 200 m scatter and 13.4 % at 300 m; 801 at 1.8 % / 5.0 %. A SINGLE reject is harmless (position held one frame); the greying/vanishing outcome needs a sustained run (~15 consecutive rejects to reach the 90 s stale tier, ~50 to reach expiry), which a persistent downtown urban-canyon multipath bias could produce but which I could NOT observe (feeds unreachable).
- **Rider impact:** A running B or D Line train greys out and then vanishes from the map mid-tunnel — the map shows no subway service on a line that is running. This is the failure mode the guard's own hold-without-advancing-timestamps design is built to produce for a genuinely mis-tagged vehicle, applied to a correctly-tagged one.
- **Proposed fix:** Require an unambiguous margin instead of a bare ordering test: replace `d < dOwn` at js/markers.js:546 with `dOwn - d > CROSS_LINE_MARGIN_M` (a new config constant; 150 m is the natural value — it is the light-rail snap tolerance, so the other line must be a full tolerance-width closer). The guard's stated purpose ('a fix on a DIFFERENT line's track') is unaffected: a genuinely mis-tagged vehicle sits on the other line's centreline, hundreds of metres from its own. Optionally also add 802/805 <-> 801/804 to a separate 'physically adjacent, not interlined' exemption set for the downtown corridor.
- **Pin it with:** tests/cross-line-spike.test.js — its fixtures are synthetic straight-line shapes placed far apart, so no near-tie case exists today. Add: 'does NOT reject when the other line is only marginally closer' (own 280 m / other 200 m -> false) alongside the existing 'returns true when A(801) is off its own line but clean on C(803)' (own 280 m / other 20 m -> still true), and a marker-lifecycle assertion that N consecutive crossLineSpike rejections do not advance _lastAcceptedWallMs.
- **Documented decision:** CLAUDE.md 'Cross-line spike guard (isOnDifferentLine)'
- **Verifier note:** Touches the documented 'Cross-line spike guard' invariant, but does NOT re-litigate it: the guard's stated rationale is 'a fix on a DIFFERENT line's track', and a 3 cm ordering difference is not evidence of that. A margin makes the guard strictly less trigger-happy, which is the direction the code's own comment ('can only make this hard reject LESS trigger-happy — the safe direction') already argues for elsewhere in the same function. Second asymmetry the fixer should know about, which I found while verifying and the reporter did not name: the OWN-line distance is a min over [rc, rc\|0, rc\|1] but the OTHER-line distance uses only the BARE key `snapToRoute(other, ...)`. Today only 801\|0 an…

#### R1-11 — _stopLagFromDeclared resolves the route cache from the RAW frame direction_id, so the stop-lag GPS-refresh override AND the STOPPED_AT declared-stop forward anchor are both silently disabled on every direction-less frame — the frames CLAUDE.md says are the expected input

**medium** · verified T1 · effort S · reported by R1 · **touches a documented invariant**

- **Where:** `js/markers.js:1291`, `js/markers.js:1301`, `js/markers.js:226`, `js/markers.js:1739`, `js/markers.js:1745`, `js/markers.js:1843`, `js/predictions.js:30`
- **What happens:** The code deviation is unambiguous; the FREQUENCY term in the reporter's scenario is not established. CLAUDE.md's _markerShapeKey comment asserts that multi-frame null-direction runs are 'the expected input this memory exists for', but I could not measure how often Metro's vehicle-positions feed actually omits trip.directionId (feeds unreachable; no direction_id coverage figure exists in docs/ or the feed-reliability material available to me). Severity therefore rests on the deviation-from-documented-design plus the reachability of the failure, not on a measured rate. If the rate turns out to be near zero this drops to low; the fix is two lines either way.
- **Rider impact:** On the frames where Metro omits direction_id, a rail dot can sit stations behind its own NEXT STOP label with no correction, and a train declared 'At Wilshire/Vermont' never renders at the platform — it jumps from before the station to after it. Wrong position shown against a correct label, on the underground lines where the rider cannot check reality out the window.
- **Proposed fix:** Resolve direction the same way every other arc consumer in the file does. In _stopLagFromDeclared, compute `const dir = vehicle.properties.direction_id ?? marker._lastKnownDir;` once and use it for BOTH `getRouteCache(rc, dir)` (:1291) and `resolveShapeKey(rc, dir)` (:1301). Direction is constant per trip, so the last-known value is the correct one, and the existing `marker._currentArcKey !== shapeKey` guard at :1302 still catches a genuine flip. Two-line change, no new state. (While there: the comment at :1296-1297 claims the guard covers 'direction_id appears/flips'; after this fix it genuinely does, whereas today the 'appears' half is unreachable because :1291 bails first.)
- **Pin it with:** tests/stop-lag-reanchor.test.js — add 'stop-lag override survives a run of direction-less frames': seed a marker with _lastKnownDir = 0 and a route cache under `805\|0`, then feed a frame with `direction_id: null` and a declared stop 2 stops ahead, and assert `_stopLagFromDeclared(...).stopsAhead === 2` (today it returns null). Mirror it in tests/stopped-at-fly-guard.test.js for the `_declaredStopAnchorArc` path. Both files exist and today only exercise non-null-direction frames.
- **Documented decision:** CLAUDE.md '_markerShapeKey's direction fallback (PR #597)' + 'Stop-lag GPS-refresh override (STOP_LAG_REANCHOR_STOPS = 2)'
- **Verifier note:** This is the only reader in markers.js that resolves direction from the raw frame; _applySnap (:1104) and _applyVelocityCorrections (:1459) both go through _markerShapeKey, whose comment states the reason. So the fix restores consistency rather than introducing a new policy. Two traps for the fixer: (1) `_lastKnownDir` is set to null on cold start when the first frame has no direction, so the helper must still bail when BOTH are null — the `getRouteCache(rc, null) === undefined` path does that for free, do not add a `?? 0`; (2) the arc-space guard at :1302 must keep using the SAME resolved `dir`, otherwise the cache and the shape key are read from different directions and the guard compares …

#### R1-05 — _applySnap does not clear _currentArc when shape data is unavailable, so the first rail glide after the midnight shape-cache reload starts from a stale fromArc and the dot visibly rewinds

**low** · verified T1 · effort S · reported by R1 · **touches a documented invariant**

- **Where:** `js/markers.js:1110`, `js/markers.js:1159`, `js/markers.js:1466`, `js/markers.js:1471`, `js/main.js:433`
- **What happens:** Service-date rollover. Frame A at t: an A Line train at arc 40 000 m, _currentArc = 40 000, gliding normally. `gtfsDataReloaded` fires; `_clearShapeCache()` empties shapeData. Frames B..D at t+6/12/18 s: hasShapeData('801') is false, so _applySnap leaves _currentArc at 40 000 and _applyVelocityCorrections straight-line-glides the marker to the raw GPS positions — the train covers ~350 m. `loadShapes()` resolves at t+20 s. Frame E at t+24 s: lastSnap.arcMeters = 40 350; fromArc = _currentArc = 40 000; _arcSpaceMismatch false ('801' === '801'); _glideSpanM ≈ 0. arcGlide runs, and its first tick sets the marker to lngLatAtArcPos('801', 40 000) — the dot jumps 350 m BACKWARD, then glides forward over the gap-matched 6 s.
- **Rider impact:** Every rail dot on screen rewinds by however far its vehicle travelled during the shape re-fetch, then re-advances. Contained to the once-a-day rollover and to whatever owl service is running, which is why this is low rather than medium.
- **Proposed fix:** Mirror the off-route branch: in _applySnap, when `hasShapeData(...)` is false, clear the arc state — `marker._currentArc = null; marker.lastSnap = null; marker.lastSnapDeviationM = null;` — so the rejoin glide's `fromArc` chain falls through to the fresh snap arc and produces a clean no-op placement at the rejoin point, exactly as the off-route case does.
- **Pin it with:** tests/arc-space-guard.test.js (or a new tests/shape-reload-rejoin.test.js) — drive a marker to a known _currentArc, call _clearShapeCache(), push two straight-line frames that move it 300 m, reload shapes, push one more frame, and assert the first arcGlide tick does not place the marker behind the last accepted fix (i.e. fromArc === toArc, a no-op glide).
- **Documented decision:** CLAUDE.md 'Critical invariant: the marker is bound between two known GPS positions'
- **Verifier note:** I confirmed the reporter's claim that neither existing backstop can catch this: `_arcSpaceMismatch` compares `_currentArcKey` against `_shapeKey`, which are the same string across the outage, and both `hardReanchor` and `_glideSpanM` measure the marker's CURRENT position against the TARGET arc — it is `fromArc` that is stale. MUST SHIP WITH R1-03: today a failed shape load never recovers, so the rejoin moment does not exist and this is confined to the once-a-day rollover (owl service only, hence low). R1-03's retry fix creates a mid-session rejoin for every marker, which would promote this to a visible fleet-wide backward jump. Ordering matters more than either fix alone.

#### R1-06 — _supersedeDuplicateTrip's timestamp tiebreak is strict, so an EQUAL-timestamp re-broadcast of the superseded trip still fades the fresher twin — the ping-pong PR #597 fixed survives on ties

**low** · verified T1 · effort S · reported by R1 · **touches a documented invariant**

- **Where:** `js/markers.js:2386`, `js/markers.js:2389`, `js/markers.js:2390`, `js/markers.js:724`
- **What happens:** Case (c) is slightly worse than the reporter described and is worth carrying into the fix: the `break` does not merely 'linger' a twin, it makes the function return `true` on a frame it should have rejected, so processVehicleData creates an additional marker. That is a duplicate-dot outcome, not just a missed cleanup. Frequency is unestablished — I could not measure how often Metro broadcasts the same physical fix under two trip_ids with an identical vehicle timestamp (feeds unreachable), and that is the whole trigger for case (a).
- **Rider impact:** The same train alternately vanishes and reappears at two positions, and a rider following it or holding its popup open loses the follow/popup on each swap — the exact symptom the tiebreak was added to kill.
- **Proposed fix:** Use `twinTs >= incomingTs` so a tie leaves the incumbent alone (the twin is already rendered; there is nothing to gain by replacing it with an identically-stamped copy). Separately, drop the `break` and scan all matching twins, or select the twin with the max `_lastAcceptedTs` before deciding.
- **Pin it with:** tests/marker-dedup.test.js — add 'does not fade a twin whose accepted fix has the SAME timestamp' next to the existing strictly-newer case, and a three-trip_id case asserting all superseded twins are faded.
- **Documented decision:** CLAUDE.md 'Duplicate-trip supersede has a timestamp tiebreak (_supersedeDuplicateTrip, PR #597)'
- **Verifier note:** Touches the documented '_supersedeDuplicateTrip has a timestamp tiebreak (PR #597)' invariant but does not contradict it — it completes it. The documented rationale is 'only fade a twin whose last accepted fix is OLDER than the incoming frame'; a tie is not older, so `>=` is what the prose already says. If the fixer restructures the loop, keep the early `vid == null \|\| vid === ''` bail (tests/marker-dedup.test.js pins that an id-less frame never fuses markers) and keep the same-route_code condition (cross-mode id collision is a real case — rail and BRT vehicle_ids are only unique within a mode).


### I. Popup & badge behaviour

#### R3a-03 — The ~5 s station-popup refresh replaces the whole content subtree on EVERY tick whenever any <details> is expanded — the "only re-render when changed" guard is defeated by the open attribute

**medium** · verified T1 · effort S · reported by R3a

- **Where:** `js/stations.js:795`, `js/stations.js:791`, `js/stations.js:854`, `js/config.js:348`
- **What happens:** A rider expands NEARBY BUSES at 7th St/Metro and starts reading. Every 5 s, with or without any change in the data, .station-popup-wrap is replaced: a text selection they made to copy a route number disappears, the "Now" pulse restarts mid-cycle, and a tap that lands between the replaceWith and the browser's click dispatch hits a detached node. The same holds for an expanded service-alert banner.
- **Rider impact:** The popup visibly churns while being read; selection and in-progress interactions are lost on a 5 s cadence at exactly the stations where the bus list is worth expanding.
- **Proposed fix:** Apply the preserved <details> open state to `fresh` BEFORE the comparison (move the `wasBusOpen`/`.sp-banner[open]` restore above line 795), then compare — identical data then produces byte-identical HTML and the tick becomes a genuine no-op. Cheaper and more robust: compare a data signature instead of innerHTML (e.g. hash the generated string once and stash it on the wrap as a dataset value, comparing generated-to-generated rather than generated-to-live-DOM).
- **Pin it with:** New tests/station-popup-refresh-noop.test.js: open a pinned popup with a nearby-bus section, set .sp-bus-details.open = true, capture the wrap node, advance timers past STATION_POPUP_REFRESH_MS with unchanged masterArrivalsData, and assert the wrap node identity is UNCHANGED (and that it still changes when an arrival time moves).
- **Verifier note:** The same defect covers `.sp-banner[open]` service alerts (their restore is at stations.js:812, also AFTER the comparison). Note for the fixer: this minimal fix does NOT also fix R3a-04 — I prototyped it and the translated-page case still replaces every tick, because the comparison is still generated-HTML vs LIVE DOM. The signature variant the reporter offers as the 'cheaper and more robust' option (hash the generated string, stash it on the wrap, compare generated-to-generated) fixes both at once and is the one to take.

#### R3a-04 — Browser page-translation — the app's entire i18n strategy — is thrown away and re-run on every popup refresh: station popup every ~5 s, vehicle popup every frame, and the vehicle age text every 1 s

**medium** · verified T1 · effort M · reported by R3a

- **Where:** `js/stations.js:795`, `js/stations.js:854`, `js/markers.js:1984`, `js/markers.js:93`, `js/stations.js:273`
- **What happens:** A Spanish-speaking rider uses Chrome's "Translate to Spanish" and opens a station popup at Wilshire/Vermont. Every 5 s the popup's translated text is replaced by the English source and re-translated a moment later; with a service alert expanded, the ~90-word advisory body flips between English and Spanish on that cadence. In the vehicle popup, the freshness line reverts to "45s ago" every second.
- **Rider impact:** For every non-English-reading rider — the population the browser-translate bet exists to serve — the two primary information surfaces flicker between languages continuously and are hard to read; the alert body, the one piece of prose that most needs translating, is the worst affected.
- **Proposed fix:** Stop replacing nodes whose text has not changed: (1) land R3a-03 so an unchanged station popup is a true no-op; (2) go further and diff at the field level — update only the .arr-time-pill / .sp-secs text nodes that actually changed rather than rebuilding the wrap; (3) in the vehicle popup, drive the per-second age from a numeric-only node and avoid the full setHTML when only the ETA/age changed. A cheap partial mitigation for the age counter alone is `translate="no"` on .pv2-secs (it is a number plus a unit and needs no translation), which stops the per-second re-translation without touching layout.
- **Pin it with:** New tests/popup-translation-churn.test.js (jsdom proxy, since a real translator cannot run in CI): simulate translation by rewriting the popup's text nodes through a wrapper element, then advance timers by STATION_POPUP_REFRESH_MS with unchanged data and assert the simulated-translated nodes are still present (i.e. the refresh did not replace them). Pair with a manual check on a real Chrome with translate enabled before shipping.
- **Documented decision:** CLAUDE.md "Translation" — page relies on browser built-in translate; no per-string table
- **Verifier note:** This is the strongest argument for the signature variant of the R3a-03 fix rather than the minimal one — one change fixes both. `translate="no"` on .pv2-secs is a genuinely free partial mitigation for the per-second age counter (a number plus a unit). The station popup's `<p lang="en">` alert bodies (stations.js:273) are inside the churn, so the single longest piece of prose is the worst affected — that is the surface CLAUDE.md's Translation decision exists to serve. A real-Chrome manual check should still precede shipping; jsdom can only proxy the translator.

#### R3b-02 — Clicking a vehicle marker whose popup is already open from hover CLOSES the popup instead of pinning it — the marker click handler sets `openedByHover = false` but never stops the click reaching MapLibre's marker `togglePopup()`

**medium** · verified T2 · effort S · reported by R3b

- **Where:** `js/markers.js:1071`, `js/markers.js:1072`, `js/markers.js:1050`, `js/markers.js:1063`, `js/bikeshare.js:409`
- **What happens:** Desktop rider hovers a train marker; after the 180 ms delay the popup opens as a preview. They click the marker to keep it open (the gesture the code comment names, and the universal 'keep it' gesture per docs/audits/tooltip-surfaces-ux-audit-2026-06-12.md §3). MapLibre's Marker._onMapClick fires on that same click and toggles the popup closed. The rider must click a SECOND time to actually pin it. Touch is unaffected (no hover ⇒ the cold-click path).
- **Rider impact:** On desktop the vehicle popup vanishes on the exact click meant to hold it open — the rider loses the ETA / next-stop / Follow button they were reaching for, and it reads as the app dismissing them. It also makes the Follow button effectively unreachable from a hover preview without a double click.
- **Proposed fix:** Mirror bikeshare.js:409 — make the marker element own the click:     el.addEventListener('click', (e) => {         e.stopPropagation();               // MapLibre's Marker._onMapClick must not toggle         if (!popup.isOpen()) marker.togglePopup();         openedByHover = false;             // pin: mouseleave no longer closes it     }); (stopPropagation on the marker element also keeps the popup's own closeOnClick map handler from firing for this click, which is correct — the marker owns it.)
- **Pin it with:** tests/popup-ticker.test.js or a new tests/vehicle-popup-pin.test.js: build a marker via createNewMarker with a fake maplibregl whose Marker records the element and whose map dispatches a 'click' to registered map listeners; dispatch mouseenter → advance the 180 ms timer → assert popup open; dispatch a click on the element and then the map-level click → assert the popup is STILL open and that a later mouseleave does not close it. Removing the stopPropagation must turn it red.
- **Verifier note:** Desktop-only (touch has no hover, so it takes the working cold-click path). Note that MapLibre's Popup also registers `map.on('click', this._onClose)` (closeOnClick defaults true), so the marker element must own the click for BOTH reasons — the reporter's stopPropagation covers both. Since a popup opened from hover is what the code calls 'pinning', the Follow button in that popup is currently unreachable without a second click.

#### R3a-08 — _keepPopupOnScreen only fires for the nearby-bus <details> — expanding a service alert, a growing refresh, and a viewport resize/rotation all leave the popup overflowing with no correction

**low** · verified T1 · effort S · reported by R3a · **touches a documented invariant**

- **Where:** `js/stations.js:733`, `js/stations.js:854`, `js/stations.js:597`, `tests/station-popup-onscreen.test.js:291`
- **What happens:** Rider taps a station dot in the lower third of the screen; _keepPopupOnScreen pans it fully into view. They then expand a ⚠ Service alert whose body is the ~90-word World Cup parking advisory. The wrap grows to its 45vh cap and the bottom of the popup — including the arrivals table below the banner — goes under the viewport edge with no pan. Rotating the phone to landscape from a fitted portrait popup produces the same state.
- **Rider impact:** The rider must drag the map to read content the popup just revealed, on the tap that asked for it — the precise regression PR #616/#617 fixed for the bus list, still present for alerts and for viewport changes.
- **Proposed fix:** Widen the toggle filter to any <details> inside the popup (`e.target?.tagName === 'DETAILS'` or `.closest('details')`), which the _restoringDetails flag already covers for the refresh's synthetic toggles; and add a debounced `window.addEventListener('resize', ...)` (removed on close) that re-runs _keepPopupOnScreen for a pinned popup. Optionally call it once after a refresh that changed the wrap height.
- **Pin it with:** tests/station-popup-onscreen.test.js — replace the 'ignores toggles from elements that are not the bus section' case with one asserting a .sp-banner toggle DOES pan (and that a toggle from an element outside the popup does not), plus a resize case asserting one pan after a debounce.
- **Documented decision:** CLAUDE.md "Station popup placement & the on-screen correction" — the four rules are about pinned-only / defer / delegation / restore-suppression; none states that alert banners are deliberately excluded
- **Verifier note:** tests/station-popup-onscreen.test.js:291 currently PINS the exclusion ('ignores toggles from elements that are not the bus section') with no stated rationale — that case must be rewritten as part of the fix, replaced by 'a .sp-banner toggle DOES pan' plus 'a toggle from outside the popup does not'. The wrap's max-height is 60vh desktop (styles/index-style.css:1208) / 45vh mobile (:2337), so on mobile the box is already at its cap and scrolls internally; the visible defect is desktop-first, which matches the reporter's framing.

#### R3b-06 — One Escape press dismisses a pinned alert tooltip AND the active map popup at once — the two document-level keydown handlers are independent and only the alerts-panel case is excluded

**low** · verified T2 · effort S · reported by R3b

- **Where:** `js/main.js:143`, `js/main.js:144`, `js/alerts.js:1356`
- **What happens:** In my capture the popup underneath was a VEHICLE popup rather than the station popup the reporter describes; the behaviour is identical either way since main.js's handler goes through closeActivePopup() and closes whatever is registered. The station variant additionally triggers closeStationPopup's focus restore (see R3a-05).
- **Rider impact:** Keyboard and screen-reader users lose the layer they were reading and their place in it; a second layered surface can never be dismissed one level at a time.
- **Proposed fix:** Give the tooltip handler first refusal: have `_hideAlertTooltip()` return whether it actually closed something, export a small `isAlertTooltipOpen()` from alerts.js, and extend main.js:144's guard to `if (e.key !== 'Escape' \|\| isAlertsPanelOpen() \|\| isAlertTooltipOpen()) return;` — the tooltip's own listener then handles that press and the next Escape reaches the popup.
- **Pin it with:** tests/alerts.test.js or tests/popups.test.js: with a pinned tooltip and a registered active popup, dispatch one Escape and assert the popup's close fn was NOT called and the tooltip is hidden; dispatch a second Escape and assert the popup closes.
- **Verifier note:** Sequence this with R3a-05: if the popup close is suppressed for the first Escape, the station popup's focus restore is suppressed with it, which is the desired outcome in both findings. Escape-dismiss ordering is a keyboard/SR concern (layered surfaces should dismiss one level at a time), so the two fixes belong in the same change.

#### R3b-07 — The 5 s badge refresh rewrites `dataset.alertText` / `_alertBlocks` under an OPEN pinned tooltip without re-rendering it — the tooltip keeps showing the previous alert until the next map move, then swaps content mid-read

**low** · verified T1 · effort S · reported by R3b

- **Where:** `js/boardingBadges.js:604`, `js/boardingBadges.js:620`, `js/busBridges.js:412`, `js/alerts.js:1289`, `js/alerts.js:1380`
- **What happens:** A rider pins the '!' tooltip on a station badge and reads it. Within 5 s `_renderStationBadges` re-runs; if Metro has updated, added or expired an alert at that stop, the badge's data changes but the open tooltip still shows the old text. The instant the rider pans or zooms even slightly, the whole tooltip body is replaced (`bodyEl.replaceChildren()`) with the new content under their cursor.
- **Rider impact:** Stale alert prose for up to as long as the tooltip stays pinned on a still map, then an unannounced content swap. Worst case the tooltip is still describing an alert that has ended.
- **Proposed fix:** In the alert/access `updateEl` callbacks (js/boardingBadges.js:604, :620) and `_applyBridgeTooltip` (js/busBridges.js:187), after writing the new fields, re-render an already-open tooltip anchored to that wrap — e.g. export a `refreshAlertTooltipForAnchor(wrap)` from alerts.js that no-ops unless `_activeTooltip.wrap === wrap` and otherwise calls `_showAlertTooltip(wrap, { pinned: _activeTooltip.pinned })`. Same shape and call sites as the existing `hideAlertTooltipForAnchor`.
- **Pin it with:** tests/alerts.test.js: pin a tooltip on a wrap, mutate `wrap.dataset.alertText` + `wrap._alertBlocks` and call the new refresh helper, assert the rendered `.alert-tooltip-body` text changed and `is-pinned` survived; assert it is a no-op for a wrap that is not the active anchor.
- **Verifier note:** One harness caveat for whoever writes the regression test: the scroll/resize reflow listeners are bound lazily by _bindAlertTooltipGlobals, which is only reached from updateAlertBadges (alerts.js:1534) — a unit test must call updateAlertBadges() (or trigger a map move) first or the reflow half silently never fires. The map-move reflow fires very often (the reporter measured 7 rebuilds in a 900 ms panBy), so in practice the stale window closes on the rider's first pan — which is also what makes the swap-mid-read behaviour visible.


### J. ETA & feed data

#### R2-06 — Service-date rollover keys off the DEVICE-local date while alerts pin America/Los_Angeles — an out-of-zone device rebuilds every GTFS-derived cache at an arbitrary hour

**low** · verified T1 · effort S · reported by R2

- **Where:** `js/utils.js:91`, `js/main.js:372`, `js/main.js:373`, `js/main.js:417`, `js/main.js:428`, `js/alerts.js:1146`
- **What happens:** The rider impact is narrower than reported and the reporter's 'every station popup renders an em-dash for every rail row' overstates it. I traced the window: _reloadGtfsData clears routeStops + shapeData and awaits loadShapes(), during which (i) getScheduledArrivals's marker/calc tiers are dead (no routeStops) but the GTFS-only append still runs off masterArrivalsData, so live-fed rail rows DO still render; (ii) what actually disappears is calc-tier rows, adherence offsets, the boarding-badge origin seeding, and rail snapping/arc-glide. So: degraded ETAs and unsnapped markers for a few seconds, not a blank board. Low is correct.
- **Rider impact:** For a rider whose device is not on Pacific time, a several-second window each day — potentially during peak — where the map has no ETAs, no station-popup times, and unsnapped rail markers. Nothing on screen explains it.
- **Proposed fix:** Make localISODate zone-aware and pin it to Pacific for the service-date watcher, matching alerts.js: `new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(d)` returns 'YYYY-MM-DD' directly. Intl with a named zone is supported well above the stated browser floor. Keep the existing local-accessor helper if any other caller genuinely wants device-local.
- **Pin it with:** Extend tests/utils.test.js (localISODate) and tests/serviceDate.test.js: with the process TZ set to Europe/London, assert the service-date key for 2026-09-01T23:30Z is '2026-09-01' (Pacific date), not '2026-09-02'; assert the key flips exactly at 07:00Z / 08:00Z across the PDT/PST boundary.
- **Documented decision:** CLAUDE.md — no anchor for the service-date TZ; main.js:366-371 documents only the 03:00-vs-midnight choice, not the zone.
- **Verifier note:** js/utils.js:78-88's JSDoc explicitly defends the local-accessor choice against a UTC key ('a UTC-day boundary would fire at local 17:00 PDT') — the fix must not read as reverting that reasoning; pinning to America/Los_Angeles satisfies the same intent for ALL devices, and matches what js/alerts.js:1146 already does for the rendered clock. Check for other callers of localISODate before changing it in place (a device-local variant may still be wanted somewhere). The reporter's DST spring-forward corollary about owl trips straddling 02:00 is UNVERIFIED — I could not confirm how Metro encodes those seconds-since-midnight rows without the raw GTFS, and it should not be bundled into this fix.


---

## Plausible — traced but not reproduced

Capped at medium severity and excluded from fix PRs until someone can reproduce them. Listed so they are not lost.

| ID | Sev | Why it could not be confirmed | Where |
|---|---|---|---|
| R4-03 | medium | Per assignment instructions this finding is capped at PLAUSIBLE/T4 regardless of factual depth achieved — the outstanding question (whether/when to a… | `index.html:88`, `index.html:45` +3 |
| R5-06 | medium | T4-capped per the VERIFY.md rubric ("A T4-only verdict is capped at PLAUSIBLE and severity <= medium"). The reporter's own severity (medium) already … | `index.html:68`, `index.html:58` +1 |

---

## Not verified

Low-severity and cosmetic items the verification budget deliberately skipped — reported by a reviewer, never independently reproduced. Treat as leads, not facts.

| ID | Sev | Title | Where |
|---|---|---|---|
| R1-07 | low | _isColdStartSpike snaps to the BARE route code instead of resolveShapeKey — the same canonical-direction asymmetry PR #… | `js/markers.js:771`, `js/markers.js:868` +2 |
| R1-08 | low | _markerShapeKey takes the frame's direction_id whenever it is non-null, so a direction_id flip-flop teleports the marke… | `js/markers.js:226`, `js/markers.js:212` +2 |
| R1-10 | low | isOnDifferentLine runs 1-3 full polyline scans on EVERY rail frame and discards the result, then _applySnap immediately… | `js/markers.js:527`, `js/markers.js:1756` +3 |
| R10-02 | low | main.js's own comment claims installErrorBoundary() runs "FIRST" — ES module instantiation order means every later-impo… | `js/main.js:8`, `js/main.js:11` +2 |
| R10-07 | low | The window.* cross-module contract table in CLAUDE.md is CURRENTLY accurate (verified) but nothing automated enforces i… | `CLAUDE.md:168`, `js/main.js:113` +4 |
| R10-08 | low | The three >1,500-line files each have one clean, low-risk extraction seam worth naming (not a refactor proposal) — and … | `js/markers.js:62`, `js/markers.js:2146` +4 |
| R3b-05 | low | A physical station split across two stationGroups (El Monte 910/950) gets its boarding pill proximity-merged but its al… | `js/boardingBadges.js:386`, `js/boardingBadges.js:394` +4 |
| R3b-09 | low | Bus-bridge detection reads `alert.stopIds`, which for an alert with NO feed stop entities is the TEXT-MINED station set… | `js/busBridges.js:109`, `js/busBridges.js:111` +2 |
| R4-06 | low | Import cycle makes js/alerts.js unusable as a graph entry point — it throws a TDZ ReferenceError at load | `js/stations.js:1857`, `js/stations.js:17` +3 |
| R5-09 | low | Legend route rows are 28 px and stacked map controls 29 px tall on touch — below the 44 px target the rest of the coars… | `styles/index-style.css:2261`, `styles/index-style.css:2320` +1 |
| R7-04 | low | Measured: styles/index-style.css ships 103,979 bytes but only 42,404 (40.8%) were exercised by a representative desktop… | `styles/index-style.css:1`, `vendor/maplibre-gl/maplibre-gl.css:1` +2 |
| R1-09 | nit | The 901 (G Line) per-direction split shape exists in rail-shapes.json but every enumeration of split routes in code com… | `js/markers.js:223`, `js/markers.js:1297` +1 |
| R10-03 | nit | Test-count claim ("62 files, 1216 tests") is stale in 5 places across 4 docs — actual is 63 files / 1226 tests | `CLAUDE.md:33`, `README.md:221` +4 |
| R10-06 | nit | Three dead function parameters survive because the project's eslint config deliberately disables unused-argument checki… | `js/predictions.js:533`, `js/predictions.js:537` +6 |
| R2-09 | nit | Two stale comments in the feed pipeline: 950 is claimed to have no markers (it is in BUS_VP), and tripId recycling is a… | `js/feedStats.js:309`, `js/config.js:390` +2 |
| R3a-11 | nit | "Pacific / 21st Layover" renders as a clickable J Line station dot — an operational layover point, not a passenger stop | `js/stations.js:556`, `js/config.js:527` |
| R3b-08 | nit | The bus-bridge 🚌 glyph sits outside the chooseBadgeSlots placement system, so it overlaps station alert badges at low … | `js/busBridges.js:441`, `js/boardingBadges.js:261` |
| R4-08 | nit | No rider-facing statement of what a page load discloses to whom; lacmta.github.io becomes a genuine third party at the … | `NOTICE.md:72`, `index.html:250` +2 |
| R4-09 | nit | RESOLVED, not an app bug: the `Refused to connect to fonts.googleapis.com` console error is axe-core's own stylesheet X… | `index.html:31`, `index.html:88` |
| R5-10 | nit | Toasts still have no manual dismiss or Escape handler, and a toast renders over the install banner | `js/ui.js:839`, `styles/index-style.css:3122` |
| R9-09 | nit | GitHub Pages config has no .nojekyll — safe today (no front-matter-like markdown, no underscore-prefixed served assets)… | `index.html:1`, `docs/_archive:1` |

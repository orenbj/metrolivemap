# Public-Launch Readiness Checklist

**Last review:** 2026-06-02 (final A-to-Z pre-handoff review for LA Metro).
**Verdict: GO — conditional on the pre-launch action checklist below.** The live-data
engine is production-sound; the only true blocker found was a compliance-packaging
issue (invisible basemap attribution), fixed in PR #376. The app is **public** on
GitHub Pages at `https://orenbj.github.io/metrolivemap/`.

> Operational handoff guide for the receiving team: [`docs/HANDOFF.md`](HANDOFF.md).

---

## Update — 2026-06-02 · Final pre-handoff review

A 7-lens, read-only audit (security, correctness, accessibility, performance,
reliability, code-quality, operational-handoff) was run top-to-bottom before
handing off to LA Metro. **Headline: the code that moves trains is sound** — all
9 documented motion/feed invariants were verified holding in code, zero memory
leaks, clean security posture, suite green at **753/753** (now **894/894**). What blocked launch was
compliance/handoff *packaging*, not the real-time path.

### Per-lens verdicts

| Lens | Verdict | Notes |
|------|---------|-------|
| Security & Privacy | ✅ READY | Tight CSP (`default-src 'none'`, no `unsafe-eval`), every feed string escaped, zero secrets, geolocation never leaves the device, no analytics. |
| Performance & Resources | ✅ READY | No leaks; every marker/timer/listener lifecycle contract verified holding. trips.json off-thread defer is sound. |
| Correctness & Data Integrity | ✅ READY (1 fix) | All feed gates + motion invariants hold. One boarding-ETA join-guard fixed (#377). |
| Accessibility | ✅ READY (1 fix) | Strong invisible-a11y layer (ARIA/keyboard/focus/contrast). `role="combobox"` added (#377). Compact-touch-target tradeoff judged acceptable. |
| Reliability & Observability | ✅ READY | Error boundary, WS reconnect/watchdog, graceful outage degradation, 6 CI workflows all verified working. Hardening items noted below. |
| Code Quality / Tests / Docs | ✅ READY (docs fixed) | 753/753 at handoff (894/894 current), no dead code, gitignore clean, globals table accurate. Stale doc counts + removed-blend descriptions corrected. |
| Operational Handoff | ✅ READY (blocker fixed) | Attribution blocker fixed (#376); `NOTICE.md` + `HANDOFF.md` added. Process items below. |

### Findings register

**🔴 BLOCKER (fixed)**
- Basemap attribution was suppressed (`js/map.js` `attributionControl:false`, no replacement) → no visible OSM/CARTO/Esri/Metro credit. OSM's ODbL requires it visible *on the map*. **Fixed: PR #376** (compact `AttributionControl` + `NOTICE.md`).

**🟠 HIGH (fixed)**
- Search input had combobox ARIA *state* but no `role="combobox"`. **Fixed: PR #377.**
- `getBoardingDepSecs` missing the empty-`vehicle_id` join guard → could show a wrong train's boarding ETA. **Fixed: PR #377.**
- Stale docs: test counts (692/738 → actual 753/32) and README/test descriptions of the *removed* ETA-blend model. **Fixed: doc-accuracy PR.**
- No `engines`/`.nvmrc` despite the documented Node-25+ jsdom/localStorage quirk. **Fixed: doc-accuracy PR.**

**🟡 MEDIUM / ⚪ LOW — tracked, non-blocking (post-launch backlog)**
- `feedStats` ring records nothing during a *total* feed outage (gap vs. explicit "0 received" marker is ambiguous to an operator).
- No server-side error telemetry — counters live only on the user's tab. Acceptable for launch; flagged to Metro (see HANDOFF "Observability").
- `gtfsLooksPlausible` reads `marker.timestamp` (bumped on spike-rejection) instead of `_lastAcceptedTs` for its speed-freshness window — minor proximity-bound skew.
- Loading splash removal sends no "map ready" to the SR live region (brief silence).
- Collapsed (0-vehicle) legend rows remain keyboard-focusable while invisible.
- `arcGlide` easing tick + `processVehicleData` cold-start are only indirectly tested (rAF timing is hard to unit-test).

### Pre-launch action checklist (owner: repo admin / Metro)

These are **settings/process/verification** items — not code — that should be
cleared before or at handoff:

- [x] **Merge** PR #376 (attribution blocker), #377 (a11y/correctness), and the doc-accuracy PR (#379). *(Done 2026-06-03.)*
- [ ] **Visually verify** on the deploy that the map's bottom-right ⓘ expands to show OpenStreetMap + CARTO + Esri + LA Metro credits.
- [ ] **Branch protection:** confirm `tests` is a *required* status check on `main` (so a red suite blocks merge).
- [ ] **Pre-create the 5 issue labels** the workflows file/auto-close against: `uptime-failure`, `gtfs-drift`, `gtfs-rebuild-failure`, `feed-reliability-failure`, `live-accuracy-failure`.
- [ ] **Incident notification routing:** the auto-filed issues are label-only. Decide who watches the repo (or add assignees / a notification webhook) so outages are seen — see HANDOFF "Incident response".
- [ ] **DNS:** `livemap.metro.net` CNAME is committed; Metro IT must complete DNS delegation. No code change needed.
- [ ] **Confirm** the Project's GTFS / GTFS-RT use satisfies LA Metro's current developer terms (see `NOTICE.md`).

---

## Update — 2026-05-31

Post-audit polish wave. All changes are behavior-preserving UI refinements or
code hygiene; no new blockers introduced. Tests remain **692/692**.

**Shipped since 2026-05-30:**

- **Unused import cleanup (#327)** — removed three dead imports from `markers.js` (`findIdx`, `getTripStops`, `M_PER_DEG_LNG_LA`).
- **WS constant centralization (#329)** — four WebSocket tunables (`WS_INBOUND_TIMEOUT_MS`, `WS_WATCHDOG_INTERVAL_MS`, `WS_VISIBILITY_STALE_MS`, `WS_FAST_RECONNECT_MS`) duplicated across `api.js` and `tripUpdates.js` moved to `config.js`; fixed `PENDING_VEHICLE_CAP` import-ordering nit in `api.js`.
- **Popup theme centralization (#330)** — dark/light popup theme colors duplicated in `bikeshare.js` and `microzones.js` consolidated into a `POPUP_THEME` export in `config.js`.
- **Stale doc/comment fixes (#328, #331)** — dropped dead `scripts/analyze-eta.js` reference in `accuracy-aggregator.js` JSDoc; corrected test count (689 → 692) and re-anchor threshold ("30 s" → "`GLIDE_MAX_MS` 60 s") in `LAUNCH-READINESS.md` and `STATUS.md`.
- **Bus bridge polish (#322–#325)** — solid Metro-bus orange (#ff8200) line, 500 m bracket legs, 3 px width, halo layer removed.
- **Alerts panel closes other popups (#326)** — `openAlertsPanel` now calls `setActivePopup(closeAlertsPanel)` so opening the alerts panel closes any open vehicle/station/bike/micro popup.
- **Mobile legend ordering (#325)** — route rows appear above the alert-indicator key in the bottom-sheet layout.
- **Show All button removed (#325)** — simplified legend filter; Hide All remains.
- **Cardinal direction in vehicle popup (#332)** — `· N`/`· S`/`· E`/`· W` suffix after destination for all rail and BRT routes.
- **Cardinal direction in station popup (#333)** — same suffix on each rail/BRT direction row in station arrival popups.
- **Bus station label polish (#334)** — removed `"to "` prefix from bus destination labels; nearby-bus routes now sorted by route number (stable) rather than soonest arrival.
- **Rail direction sort (#335)** — rail direction rows sorted by NESW cardinal order instead of left/right geographic heuristic.
- **Console log hygiene (this PR)** — `console.log` → `console.info` in `feedStats.js` debug counter; added `[api]` prefix to WebSocket error in `api.js`.

---

## Update — 2026-05-30

Since the 2026-05-27 public-launch audit, the ETA pipeline and motion model were
materially hardened.

**Shipped since 2026-05-27:**

- **ETA arc-direction fix (#302) — major correctness bug.** Each route had one
  polyline, so the reverse-travel direction's arc *decreased* with stop index —
  which silently disabled GPS schedule-adherence and made GTFS-RT get rejected as
  "past the stop" for ~half the fleet (they fell back to schedule-only ETAs). Fix:
  rebuilt rail shapes as one clean canonical directional polyline per route, and
  added per-direction arc orientation. Both directions of every line now get live
  GTFS-RT + GPS-adherence ETAs. Guarded by a data-driven shape-monotonicity test.
- **ETA audit cleanup (#303)** — join-key fix (no longer cross-matches a foreign
  arrival on an empty `vehicle_id`), honest `_etaSource` debug tag, and
  station-board ↔ vehicle-popup "Now" parity.
- **GPS-jitter denoise (#305)** — vehicles no longer shuffle in place or step
  backward at stops (a fixed position deadband on the snapped arc, widened when
  the feed reports stationary).
- **ETA labels (#301)** — "Now" reserved for an arrived vehicle; "<1m" covers the
  whole final minute (kills the "1m → Now" skip).
- **Basemap (#300)** — bounded the Esri raster to its cached zoom + LA extent
  (stops a 404 flood).
- **Polish (#304, #306)** — review-pass consistency fixes; removed the
  inconsistent per-route legend bar outlines.

**Tests:** now **692/692** (was 596) — the ETA/jitter work added the
shape-monotonicity guard plus orientation, join-key, label, and jitter coverage;
BRT arc-glide and `_lastAcceptedTs` freshness improvements added 15 more.

**Operational note (current):** the repo is **public**, so GitHub Actions
minutes are unlimited — tests, the scheduled audits, and the live-accuracy /
feed-reliability crons all run on their normal schedules (the earlier
private-repo budget cap no longer applies).

---

*The original 2026-05-27 public-launch audit follows as the historical record.*

Headline update: dead-reckoning was retired in PR #257. The marker now
only moves between two GPS-confirmed positions via a polyline-arc glide.
The bug class that motivated several prior mitigation PRs ("train shown
past the platform while popup says At Stop X") is gone by design — the
new model literally cannot extrapolate. See `docs/STATUS.md` for the
full PR #257 rundown.

This document is the single-stakeholder summary of the multi-perspective
production-readiness review run on 2026-05-27. Source: 14 audit passes (7
perspectives × 2 — inventory + adversarial) across security, accessibility,
performance, code-quality, devops, documentation, and privacy. Synthesised
into Tier 1 launch-blockers (all shipped), Tier 2 polish (all shipped or
deferred to issues with rationale), and Tier 3 tech debt (filed as issues).

This is meant to be read by someone who hasn't been in the codebase tonight
and needs to decide "is it safe to point traffic at this?". The answer is
yes; the audit-and-fix work that made it so is summarised below.

---

## 1. What we audited

Seven perspectives, two passes each. Each pass produced a written finding;
this checklist is the synthesis.

| Perspective | Inventory pass | Adversarial pass | Headline finding |
|---|---|---|---|
| Security | ✓ | ✓ | One real issue: CSP missing `frame-ancestors` (clickjacking). Rest clean. |
| A11y + Mobile UX | ✓ | ✓ | Three brand colors fail 3:1 on white; modal had no focus-trap; skip-link landed on empty container; no JS-layer `prefers-reduced-motion` check. |
| Performance + Reliability | ✓ | ✓ | Critical: no global error handler. Lesser: `trips.json` parse blocks for 300-500 ms on mobile; MapLibre CDN single-point-of-failure since resolved by vendoring (#245). |
| Code Quality | ✓ | ✓ | Two oversized modules (markers.js 2360 LOC, stations.js 1795 LOC); arc-direction logic duplicated 5×; 11- and 10-param functions. Otherwise: zero TODO/FIXME debt, 100% JSDoc on alerts.js, 0 dead exports. |
| DevOps | ✓ | ✓ | No rollback documentation; no external uptime check; one workflow (rebuild-gtfs) silently failed two weeks running before the issue-fallback landed. |
| Documentation | ✓ | ✓ | Module map missing alertsPanel.js + errorBoundary.js; stale "schedule calibration" claim; data files table missing intersections; no Setup section. |
| Privacy / Analytics | ✓ | ✓ | GTM/GA4 transmitted visitor IP to Google without consent (GDPR gap for EU riders); no DNT support; no privacy policy link. |

---

## 2. What we shipped

**9 PRs across 2 waves, 1 incident runbook, 11 follow-up issues.**

### Wave A — Tier 1 launch blockers (all merged 2026-05-27)

| PR | Title | What it closes |
|---|---|---|
| **#237** | feat(reliability): global error boundary + recovery banner | Uncaught exceptions no longer leave the map silently frozen. `globalErrors` / `unhandledRejections` counters surface error rate in feedStats ring; banner appears on 3+ errors in 30 s. |
| **#238** | fix(a11y): non-text contrast for low-luminance brand colors + ARIA freshness dot | E/K/J brand colors get a structural mitigation (inset outline on `.bar-fill`, 2 px border on `.boarding-badge`) so WCAG 1.4.11 is satisfied without re-tuning the palette. `.pv2-dot` gets `role="img"` + `aria-label`. Contrast pinned in `tests/route-color-contrast.test.js`. |
| **#239** | fix(a11y): focus-trap on alerts panel modal + skip-link to search | Tab/Shift+Tab cycle within the alerts panel; focus restores to opener on close. Skip-link points at `#station-search` instead of the empty `#map` container. |
| **#240** | feat(privacy,security): remove GTM/GA4 + clickjacking guard | GTM and GA4 removed entirely along with their CSP allowlist entries. No more visitor IP transmitted to Google. The clickjacking guard is now a JS frame-buster in `index.html` — PR #273 replaced the original `frame-ancestors 'self'` meta directive, which browsers ignore when delivered via `<meta>` (it needs an HTTP header GitHub Pages can't set). |
| **#241** | docs: README drift fixes | Module map covers every shipping module. Data files table covers every committed JSON. Test count refreshed. "Schedule calibration" claim removed. Setup section added. |

### Wave B — Tier 2 polish (all merged 2026-05-27)

| PR | Title | What it closes |
|---|---|---|
| **#242** | fix(a11y): semantic landmarks + search aria + tab announce + popup headings | `<main>`/`<header role="search">` landmarks; search input gets aria-describedby/-controls/-expanded; alerts tab switch is announced via live-region; station popup name is `<h3>` for heading navigation. |
| **#243** | fix(a11y): honor prefers-reduced-motion in animateMarker | Cold-start marker glide snapped to position under reduced-motion. **Later reversed by PR #267** — gating vehicle motion caused a teleport regression; vehicle glide is WCAG-2.3.3-exempt functional motion and is no longer gated. |
| **#247** | docs: ROLLBACK runbook | `docs/ROLLBACK.md` covers severity triage, immediate-revert sequence, fix-forward, and post-revert verification. Linked from README. |

### Earlier today (PRs #230–#234)

| PR | Notes |
|---|---|
| **#230** | KISS simplification: removed `js/scheduleCalibration.js` (233 LOC EWMA) + collapsed `aging` freshness tier into `live`. −260 LOC, zero rider-visible regressions. |
| **#231–#234** | KISS docs sync, `substitutionImpact` metric in accuracy aggregator, `feed-reliability` issue-file fallback, popup HTML test coverage + dir=1 reverse-DR canary strengthening. |

### Wave C — Tier 3 backlog (11 issues filed)

| # | Title |
|---|---|
| #244 | perf: defer or shard trips.json load |
| #245 | perf,reliability: service worker for static-asset caching |
| #246 | reliability: bound the service-date midnight WS-frame race |
| #248 | a11y: keyboard-accessible vehicle search + 44 × 44 touch targets |
| #249 | refactor: split markers.js + stations.js, dedup arc-direction |
| #250 | api: collapse getPopupHTML / animateMarker into options-object form |
| #251 | docs: alertsPanel.js JSDoc coverage gap |
| #252 | ops: external uptime monitoring for livemap.metro.net |
| #253 | defense: WS frame size gate + popup-DOM-leak harness |
| #254 | perf: feedStats ring efficiency (the `_arcTick` viewport-culling half is moot post-#257 DR removal) |
| #235, #236 | feed-reliability vs gtfs-drift-check divergence; ETA_DEPARTURE_LAG_S is not the right knob — calc bias is horizon-dependent |

None of the Tier 3 items are launch blockers. Each is a real finding with a
written rationale for deferral.

---

## 3. Tests

- **692/692 passing** (vitest, jsdom).
- The prod-readiness sprint added ~25 tests (`errorBoundary.test.js`, `route-color-contrast.test.js`, `alerts-panel-focus.test.js`, `popup-html.test.js` freshness ARIA); PR #257's DR removal then deleted ~40 DR/intersection tests.
- **Test workflow** runs on every PR + push to main (`tests.yml`)
- **Test environment**: in-memory localStorage shim in `tests/setup.js` (Node 25+ has a broken built-in `globalThis.localStorage` accessor that collides with jsdom)

---

## 4. Production observability

| Signal | Source | What it tells you |
|---|---|---|
| `globalErrors` / `unhandledRejections` | feedStats ring (localStorage) | Uncaught exceptions in production. 0 is healthy. Per-tab; aggregated by the offline analyzer. |
| Recovery banner appears | DOM (visible) | 3+ errors within 30 s — site is in degraded state for THIS user. |
| `feed-reliability` workflow | GitHub Actions (Wed 17:00, Fri 23:00 UTC) | Live Metro WS feed coverage / field presence. FAILs file an issue under label `feed-reliability-failure`. |
| `gtfs-drift-check` workflow | GitHub Actions (Mon 08:00 UTC) | Static `data/trips.json` vs Metro's published GTFS. Files an issue under label `gtfs-drift` at >5% drift. |
| `rebuild-gtfs` workflow | GitHub Actions (Mon 09:00 UTC) | Auto-rebuilds static data from latest GTFS, opens PR. Files an issue under label `gtfs-rebuild-failure` if PR creation is blocked. |
| `live-accuracy` workflow | GitHub Actions (Tue, Thu, Sat, Sun) | Playwright headless captures of live ETA accuracy. Artifacts include `substitutionImpact` metric for gate tuning. |

**No external uptime check** — filed as #252. Manual page-load verification is the only proactive signal until that ships.

---

## 5. Rollback story

**Documented in `docs/ROLLBACK.md`.** Summary:

```bash
# Severity 1 — site is hard-broken (blank page / no markers):
git revert <bad-sha>                          # inverse commit, no force-push
git push origin HEAD:revert-<bad-sha>
gh pr create --title "revert: ..." ...
gh pr merge <pr> --squash --admin --delete-branch
# GH Pages picks up the revert in ~60 s
```

The error-recovery banner (PR #237) is the first user-facing signal that
something is wrong; the localStorage ring is the second.

---

## 6. Privacy posture

- **No client-side analytics.** GTM/GA4 removed in PR #240.
- **No first-party cookies set by the app.** localStorage holds only UI prefs (`darkMode`, `bikeshareVisible`, `microzonesVisible`) and the internal feedStats ring (no PII).
- **Visitor IP exposure**: still transmitted to Metro WS, Carto basemaps, ESRI tiles, the alerts Lambda URLs, GBFS bikeshare, and Google Fonts CDN. (MapLibre is now vendored same-origin — #245 — so unpkg is no longer contacted.) This is unavoidable for a real-time transit map; documented in the privacy audit notes.
- **No privacy policy link in UI**: deliberate non-decision. The site has no user accounts, no behavioral tracking, and no off-domain analytics. If Metro Legal wants a notice, it would be a small addition to the footer linking to Metro's corporate privacy page.

---

## 7. Browser compatibility

- **Target**: Chrome 80+, Safari 13.1+, Firefox 75+, Edge 80+ (modern ES2020+).
- **Hard fail**: IE 11, Safari < 13.1, Android < 8. The app uses optional chaining (`?.`) and nullish coalescing (`??`) without polyfills.
- **Installability-only service worker** (`sw.js`) — caches nothing and serves nothing from cache; it exists solely so Chromium fires `beforeinstallprompt` and the in-app "Add to home screen" banner (`js/pwaInstall.js`) can appear. There is still **no offline support** (data is live; an offline shell with no live data would be more confusing than the current behavior). Do not bolt a cache onto `sw.js` — real offline caching would be a separate, deliberate decision.

---

## 8. Outstanding non-blockers

These are real findings that didn't make the launch cut, with the explicit
deferral rationale. Tracked as issues so they don't get lost.

| Finding | Why deferred | Issue |
|---|---|---|
| trips.json 300-500 ms parse block on mobile | Narrow device class; existing 5 s loading screen masks it for most users | #244 |
| ~~No CDN fallback for MapLibre (unpkg single point of failure)~~ | **Resolved** — vendored same-origin into `vendor/maplibre-gl/` (the SW approach the issue floated was contract-barred; vendoring kills the SPOF with no SW). unpkg dropped from the CSP. | #245 |
| Midnight WS-frame race | Bounded impact (few dropped frames at 00:00 for net-new trips) | #246 |
| Vehicle markers not keyboard-focusable; touch targets < 44 px | Search-based workaround is the more useful intervention; full hit-box requires DOM restructuring of every marker | #248 |
| markers.js + stations.js are oversized | Pure maintainability; no functional bug | #249 |
| `getPopupHTML` / `animateMarker` are 11- and 10-param signatures | Ergonomic refactor; non-blocking | #250 |
| alertsPanel.js JSDoc coverage 57% | Pure docs; easy follow-up | #251 |
| No external uptime monitoring | Recovery banner + feed-reliability artifacts cover most cases | #252 |
| WS frame size unbounded; popup DOM leak unverified | Theoretical until observed | #253 |
| feedStats ring re-serialization cost | Mobile device class; not measured to be pathological | #254 |
| gtfs-drift-check vs feed-reliability threshold divergence | Awaiting Wed 17:00 UTC data | #235 |
| Calc bias is horizon-dependent | Investigation complete; tuning experiments deferred until `substitutionImpact` metric has a CI baseline | #236 |

---

## 9. Pre-launch verification checklist

Run through this before announcing publicly. Most items are one-shot; the
"continuous" items run automatically.

### One-shot (do once)

- [ ] **Hard refresh** `https://orenbj.github.io/metrolivemap/` (and `https://livemap.metro.net/` once DNS resolves) in an incognito window. Verify the page loads, the loading spinner disappears, route markers appear within ~5 s.
- [ ] **Open DevTools → Console.** Verify zero `[errorBoundary] uncaught:` lines on a clean session.
- [ ] **Open DevTools → Network.** Verify zero requests to `googletagmanager.com` / `google-analytics.com` (GTM removal verification).
- [ ] **Open a station popup**, click a vehicle marker, open the alerts panel. Verify all three render and close cleanly.
- [ ] **Tab keyboard navigation**: from page load, Tab once → skip-nav link. Enter → focus moves to search input. Tab through the rest of the UI; verify no focus traps or dead-ends. Open alerts panel; Tab to last element, Tab again → wraps to first.
- [ ] **Reduced-motion**: enable OS-level "Reduce motion"; reload. Verify new markers snap into position instead of gliding.
- [ ] **Mobile**: load on a phone (iOS Safari + Android Chrome both). Verify the bottom-sheet drag works; verify search is reachable; verify legend toggle works.

### Continuous (already running)

- [x] `tests.yml` runs on every push + PR (1059/1059 passing)
- [x] `live-accuracy.yml` Tue/Thu/Sat/Sun captures — crons active (public repo, unlimited minutes)
- [x] `feed-reliability.yml` Wed + Fri captures — crons active
- [x] `gtfs-drift-check.yml` Mon
- [x] `rebuild-gtfs.yml` Mon with issue-file fallback
- [x] `uptime-check.yml` every 10 min — pings live site, auto-files/closes `uptime-failure` issue
- [x] All six scheduled/CI workflows file issues on failure (no silent failures; the manual-only `replay-taper.yml` is read-only and exempt)

---

## 10. What changed structurally, what didn't

**Changed:**
- Motion model: dead-reckoning replaced by bounded arc-glide (PR #257)
- One new shipped module (`js/errorBoundary.js`)
- Two new docs (`docs/ROLLBACK.md`, `docs/LAUNCH-READINESS.md`)
- CSS structural a11y mitigations (route-color outlines, dark-mode badge borders)
- ARIA wiring across search, alerts panel, station popup, vehicle popup
- HTML landmarks (`<main>`, `<header role="search">`)
- GTM/GA4 deleted; clickjacking guard (JS frame-buster, PR #273)
- 4 new test files (errorBoundary, route-color-contrast, alerts-panel-focus, popup-html)

**Intentionally NOT changed:**
- The post-PR-#192 tier policy (`gtfsEtaS ?? calcEtaS`) — see issue #236 for the calc-bias deferral
- Brand colors in `routeHexColors` — preserved Metro identity, mitigated structurally
- Module structure (markers.js, stations.js sizes) — splits filed as #249
- Service worker — offline-caching variant still deferred per #245; a minimal installability-only `sw.js` (no caching) was later added to enable the PWA install prompt

---

## Update — 2026-06-07 · Post-launch polish (J Line / route 950)

Tests: **894/894** (39 files).

- **#419** — J Line street-running stops made clickable (proximity merge fix)
- **#420** — DTLA J Line one-way popup row suppression
- **#421** — Two-tier MapLibre click layers for J Line zoom gating
- **#422** — Route 950 added to vehicle_positions WebSocket subscription
- **#423/#424** — J Line BRT busway stations ungated (`buswayStation` flag); street stops at zoom 14

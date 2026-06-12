# Station Popup — UI/UX Design Audit

**Date:** 2026-06-12 · **Status:** report only, nothing implemented · **Scope:** the station
arrivals popup (`js/stations.js`) plus a consistency pass across every other popup/tooltip
surface (vehicle, bikeshare, Metro Micro, legend alert tooltip).

---

## 1. Executive summary

The station popup is in **good structural shape**: the section order (alerts → rail → buses →
amenities) matches rider priority, the progressive-disclosure choices are mostly right, and the
hard engineering (scroll/`<details>` state preservation across the 5 s refresh, terminal-row
suppression, one shared ETA vocabulary across all surfaces) is genuinely strong. The audit found
**no structural reorganization worth doing** — the wins are in *scent* (what collapsed things
tell you before you tap), *trust* (which numbers are live), and one real **bug**.

**Top 3 by rider impact:**

1. **F1 — A rider cannot tell a live ETA from a schedule guess.** Every pill renders
   identically whether it came from GTFS-RT or the static-schedule fallback. (Effort: M)
2. **F2 — BUG: the nearby-bus 6-route cap keeps the *lowest-numbered* routes, not the
   soonest.** The code comment says "rank by soonest upcoming arrival"; the comparator never
   uses the `soonest` value it computes. At a >6-route hub the most useful buses can be the
   ones dropped. (Effort: S)
3. **F4 + F3 — The two collapsed sections have weak information scent.** "NEARBY BUSES (5)"
   doesn't say *which* routes; "⚠ Service alert ×2" doesn't say *what about*. Both force a
   tap to learn whether the contents matter. (Effort: S–M each)

Total estimated effort for everything recommended below: **roughly 2–3 working days**, almost
all of it independent S/M items that can ship piecemeal.

## 2. Method

- **Scoring:** Severity (1 cosmetic → 4 can cause a missed train / wrong decision) ×
  Frequency (1 edge case → 3 every popup open). Ties broken by the agreed lens order:
  glanceability > information architecture > visual polish.
- **Evidence:** code citations into `js/stations.js` / `styles/index-style.css` (line numbers
  verified against the current branch), a numeric fold-budget model derived from the CSS (no
  pixel screenshots — Playwright browser binaries are uninstallable in this sandbox), the
  owner's Wilshire/Vermont phone screenshots, and the passing test suite (1003/1003,
  including `popup-html.test.js` and `station-row-geometry.test.js` which pin pill/row markup).
- Claims that genuinely need a live device are labeled **needs live verification** with a
  repro step; none are silently asserted.

## 3. The 5-second test (what a hurried rider actually sees)

Phone, 360×640, Wilshire/Vermont, one collapsed alert banner. The popup's internal height
budget is `45vh` = **288 px** (`index-style.css:2062`). Estimated section heights from the CSS:

| Section | Height | Running total |
|---|---:|---:|
| Sticky title (13px/800 + 10/8px padding, css:1139–53) | ~35 px | 35 |
| Alerts section, 1 collapsed banner (css:2138–60) | ~37 px | 72 |
| Rail table padding (css:1156–59) | 8 px | 80 |
| B Line block — 2 rows à ~26 px (css:1173–79) | 52 px | 132 |
| Separator + D Line block | 57 px | 189 |
| NEARBY BUSES collapsed summary (css:1410–23) | ~23 px | 212 |
| Bike row (css:1313–22) | ~26 px | 238 |
| Restroom row (css:1375–84) | ~26 px | 264 |

**Verdict: at 640 px tall everything just fits (264 < 288)** — confirmed by the owner's
screenshot. The first ETA pill sits at ~y 95 px and stays above the fold even with three
stacked alert banners (~150 px of header+alerts). Fold pressure is real but lands on the
**amenity rows and bus section**, not the headline ETAs: a 3-banner day, a 4-line station
(Union Station, table ≈ 223 px), or a 568 px-tall phone each push bike/restroom below the
fold. That shapes F7 below — the fix target is the bottom of the popup, not the top.

The first-glance reading order is correct: station name → is something wrong (alerts) → when
is my train (pills). The main glance-cost findings are about what the collapsed surfaces *say*,
not where they are.

## 4. Ranked findings

### F1 — No live-vs-schedule distinction on ETA pills · **Sev 4 × Freq 3 = 12** · Effort M

A pill reading "7m" renders identically whether it came from a GTFS-RT trip_updates
prediction or the static-schedule fallback (`getScheduledArrivals` merges both upstream;
the pill markup at `stations.js:910–923` carries no source information). The vehicle popup
has this signal twice — the freshness dot (`ui.js:763`) and the debug-gated `[RT]/[calc]`
tag (`ui.js:720–726`, `css:1727–43`) — the station popup has neither. The feed-stale banner
(`stations.js:1498–1518`) only covers *total feed silence* >60 s, not the per-arrival case
where one trip simply has no live prediction. A schedule "7m" on a disrupted line is the
single most expensive wrong number this popup can show.

**Fix:** thread an `isRealtime` flag onto each arrival where the tiers already diverge (in
`predictions.js`'s arrival assembly), and render schedule-derived pills visually
distinct — recommended: tilde prefix **"~7m"** plus a muted/outlined pill style, with an
`aria-label` ("about 7 minutes, scheduled"). Tilde is language-neutral and matches transit
conventions. Risk: touches `_formatArrivalPill` consumers (3 call sites) and the pill
assertions in `popup-html.test.js` / `station-row-geometry.test.js`.

### F2 — BUG: nearby-bus cap selects by route number, not soonest arrival · **Sev 3 × Freq 2 = 6** · Effort S

`stations.js:1363–68` (comment): *"Rank routes by soonest upcoming arrival … so when the
cap truncates a major hub the surviving routes are the ones most useful right now."* The
code computes `soonest` (`:1376–79`) **but the comparator never reads it** —
`:1381–83` sorts by numeric route id, then string. So at a station with more than
`NEARBY_BUS_MAX_ROUTES = 6` bus routes, the popup keeps routes 2, 4, 10, 14, 16, 18 and
silently drops route 720 even if it arrives in 1 minute.

**Fix:** select the top 6 by `soonest`, **then re-sort the survivors by route number for
display** — selection by usefulness, presentation stable across the 5 s refresh (sorting the
display by `soonest` would make rows jump every tick). Two lines plus a test.

### F4 — Collapsed "NEARBY BUSES (5)" has weak information scent · **Sev 2 × Freq 3 = 6** · Effort S

The summary row (`stations.js:1474–78`) shows only a label and a count. A rider waiting for
the 204 can't tell whether it's among the 5 without expanding. The route numbers are short
and already styled — the existing `.sp-bus-badge` chips (css:1465–80) would fit inline.

**Fix:** render up to ~5 mini route-number chips in the summary
(`NEARBY BUSES  18 20 204 206 … (6 of 12)`), reusing `.sp-bus-badge` at reduced size.
Pure addition inside `_renderNearbyBusSection`; the `<details>` open-state preservation
(`stations.js:645–48`) is untouched.

### F3 — Generic "⚠ Service alert ×2" label; active window hidden until expanded · **Sev 2 × Freq 3 = 6** · Effort M

Two compounding scent problems on the service banner:
1. Any effect outside the known set falls back to the label "Service alert"
   (`stations.js:1640–42`). Metro publishes a lot of `OTHER_EFFECT` (e.g. the World Cup
   parking advisories), so the most generic label is also a common one — and a ×2 merge of
   two *different* advisories shows nothing but "Service alert ×2".
2. The "Active: …" period span is `display:none` until the banner is expanded
   (css:2242–52), so urgency ("starts tonight" vs "all month") is invisible at a glance.

**Fix:** (a) for `OTHER_EFFECT`/`UNKNOWN_EFFECT`, derive the summary label from the alert
header's leading words (truncated, escaped) instead of the static fallback — e.g.
"⚠ Union Station parking…"; for merged groups with distinct headers, show the first +
"×2". (b) Show a compact period hint collapsed when the window is *imminent or short*
(e.g. starts/ends within 48 h), keep it hidden for long-running windows to avoid noise.
Risk: `_mergedPeriodLines` contract and `tests/` alert assertions; the per-body
window attribution (#469 lineage) must not change.

### F5 — Alert body prose renders at 10 px · **Sev 2 × Freq 3 = 6** · Effort S

`.sp-banner { font-size: 10px }` (css:2158) and `.sp-banner p` sets no size of its own
(css:2197–2202), so multi-paragraph advisories — the World Cup parking text in the owner's
Pershing Square screenshot is ~90 words — render at 10 px. That's headline-chip sizing
applied to body prose; it's the smallest sustained-reading text anywhere in the app
(destinations are 11 px, alert-panel/tooltip prose is larger). **Fix:** keep the 10 px
summary line, bump the expanded body (`.sp-banner p`, `.sp-body-period`) to 11.5–12 px.
One CSS rule; secondary a11y benefit for low-vision riders.

### F6 — ETA pill columns carry no explicit "next two arrivals" semantics · **Sev 2 × Freq 3 = 6** · Effort S

Each row shows up to two pills, soonest first (`stations.js:917–18`), with no unit or
label — "7m 15m" relies entirely on transit-board convention. Sighted riders mostly infer
it; screen-reader users hear "7 m 15 m" with no structure (pills are bare spans,
`stations.js:922`). A column header would cost vertical space and is not recommended.
**Fix:** semantic, not visual — `aria-label="next arrivals: 7 and 15 minutes"` on
`.sp-pills` (or per-pill labels), plus `title="arrives in 7 min"` for mouse users. Zero
layout change.

### F7 — Fold pressure lands on the amenity rows · **Sev 2 × Freq 2 = 4** · Effort S–M

From the §3 model: bike (~26 px) + restroom (~26 px) are the first casualties on busy
stations, short phones, or multi-alert days — and they're the two rows with no collapsed
fallback. They are also visually identical twins (same padding, border, 11 px muted text,
css:1313–22 vs 1375–84). **Fix:** merge them into ONE compact amenity row
(`🚲 1 e-bike · 4 bikes · 3 docks  |  🚻 Restroom`) saving ~26 px on every equipped
station. Both renderers are tiny (`_renderBikeSection` :1248–65,
`_renderRestroomSection` :1279–86). Alternative considered and rejected: collapsing
amenities into a `<details>` — a third disclosure widget for two short rows is more
interaction cost than it saves.

### F8 — Popup anchor sits tight on the station dot · **Sev 2 × Freq 2 = 4** · Effort S

Station popup `offset: 8` (`stations.js:562`) vs vehicle popup `offset: 15`
(`markers.js:851`). On the owner's screenshots the tail abuts the tapped dot and the popup
shades the adjacent station label. **Fix:** raise to ~12–15 for parity. **Needs live
verification** that 8 was not chosen to keep the popup inside small viewports — test on a
phone before/after.

### F9 — Consistency: bike counts ordered/labeled differently in two surfaces · **Sev 1 × Freq 2 = 2** · Effort S

Station amenity row: **e-bike → bike → dock**, singular labels (`stations.js:1257–60`).
Standalone bikeshare popup: **bikes → e-bikes → open docks**, plural
(`bikeshare.js:556–62`). Same colors, opposite order, different nouns. Pick one ordering
(recommend the standalone's bikes-first, pluralized) and apply to both.

### F10 — Vehicle popup width contradiction (JS vs CSS) · **Sev 1 × Freq 2 = 2** · Effort S

`markers.js:851` passes `maxWidth: '300px'` to MapLibre; `.vehicle-popup { max-width:
240px }` (css:1634–36) clamps it to 240. The CSS wins; the JS value is misleading dead
config. Align the JS to `'240px'` (or drop the CSS and commit to 300 — decide once).

### F11 — Bikeshare + Micro popups bypass the design system (inline styles) · **Sev 2 × Freq 2 = 4** · Effort M

Both build their HTML with hardcoded inline styles and a JS theme lookup
(`bikeshare.js:524–67` `POPUP_THEME[isDark ? …]`, `microzones.js:235–41`). Consequences:
they're outside the CSS-variable dark-mode system (toggling dark mode with a popup open
leaves it in the old theme until a data refresh re-renders it), outside the shared type
scale, and their titles are styled `<div>`s while the station popup upgraded to `<h3>` for
a11y (`stations.js` history at css:1135–38). **Fix:** port both to classes on the existing
`--popup-*` token recipe (the container CSS already exists at css:1287–1308 — only the
*content* is inline). Not urgent; do it the next time either popup is touched.

## 5. Popup system consistency matrix

| Attribute | Station | Vehicle | Bikeshare | Metro Micro | Legend alert tooltip |
|---|---|---|---|---|---|
| Chrome (bg/blur/radius/shadow) | ✅ shared vars | ✅ shared | ✅ container only — content inline-styled (F11) | same as bikeshare (F11) | ✅ shared **by construction** (css:2606–11) |
| Max width | 300px | JS 300 / CSS 240 ⚠ (F10) | 220px | 240px | JS-positioned |
| Title | `<h3>` 13px/800 centered sticky | `<div>` 13px/700 + route accent bar | inline `<div>` 12px/800 | inline `<div>` 12px/800 | prefix `<strong>` blocks |
| ETA vocabulary | Now / <1m / Xm | identical — deliberately unified (ui.js:686–703) ✅ | n/a | n/a | n/a |
| Cardinal suffix | `.sp-bus-cardinal` | `.pv2-cardinal`, same recipe ✅ | n/a | n/a | n/a |
| Dark mode | CSS vars ✅ | CSS vars ✅ | JS theme at render time ⚠ | JS theme ⚠ | CSS vars ✅ |
| Freshness signal | feed-level banner only (→F1) | per-vehicle tier dot + ARIA ✅ | n/a | n/a | n/a |
| Single-popup registry | ✅ | ✅ | ✅ | ✅ | separate (legend-scoped, by design) |
| Alert presentation | `.sp-banner` chips+stripe+×N | n/a | n/a | n/a | "Detour:" prefix blocks — second language, acceptable (different surface/job) |

The system is more coherent than most: chrome, ETA vocabulary, cardinal styling, and the
close/registry contract are genuinely unified. The drift is concentrated in F9/F10/F11.

## 6. Non-findings (checked, deliberately good — don't churn these)

- **Alphabetical route-block order** (`stations.js:1013–14`): considered proposing
  soonest-first; **rejected** — alphabetical is stable across the 5 s refresh (no row
  jumping), matches the legend and Metro brand order. Keep.
- **Refresh-state preservation** (`stations.js:637–668`): scroll position and every
  `<details>` open state survive the 5 s re-render. Exemplary; protect with care in any
  fix above.
- **Row suppression logic** (terminal, near-terminal, off-route, duplicate-destination —
  `stations.js:1056–1106`): each rule earns its place; the popup never shows a destination
  the rider is already at or a direction the stop doesn't serve.
- **Unknown-direction bus arrivals rendered in both columns** (`:1334–40`) and the
  staleness gate on direct `masterArrivalsData` reads (`:1330`) — both prevent
  rider-visible wrong data.
- **One ETA vocabulary across all surfaces** ("Now" gated on STOPPED_AT, "<1m" never
  "30s") — `stations.js:48–67` + `ui.js:686–703`.
- **Cardinal suffixes**: kept (per #332–335 history); genuinely needed at J Line splits.
- **44 px close target on touch** (css:2106–09) and the documented compact-row exception.
- **"Now" pill is not color-only** — the text itself says "Now"; green+pulse is
  reinforcement. (Minor cosmetic note: the wrap-replacement resets the 2 s pulse phase
  each changed tick, `stations.js:666` — visible only as a phase skip, not worth a fix on
  its own.)
- **Tiny cleanup for any next pass:** `.arr-time-pill.boarding` (css:1253–62 + dark-mode
  block) is dead — no JS ever applies a `boarding` class (only `now` is appended;
  verified by repo grep).

## 7. Strategic question (not a ranked finding): mobile bottom sheet

The anchored 300 px popup at 45vh works *today* because content is aggressively curated.
But three findings (F4, F5, F7) all fight the same constraint: a phone popup that can't
grow. The industry pattern for this exact surface (Google/Apple/Transit-app stop cards) is
a **bottom sheet** — half-height by default, swipe to expand, map stays visible above. It
would dissolve the fold problem, give alert prose room, and make the bus list a real list.
Cost: **L–XL** — a second presentation mode for one popup type, interaction with the
single-active-popup registry (`popups.js`), the refresh-preservation path, and focus
management all need rework, and it diverges from the other three popups. Not recommended
now; recommended as the *next structural investment* if station-popup content keeps
growing (e.g. if parking, Metro Micro, or fare info ever land in it).

## 8. Suggested implementation order (if/when approved)

1. **F2** (bug, S) — alone, immediately.
2. **F5 + F6 + F9 + F10** (S, CSS/copy/aria only) — one small "popup polish" PR.
3. **F4 then F3** (scent, S/M) — one PR each, they touch the same summaries.
4. **F1** (M) — its own PR; needs the `isRealtime` flag plumbed through predictions.js.
5. **F7 + F8** (S–M) — one PR, both change popup geometry; verify on a real phone.
6. **F11** (M) — opportunistic, next time bikeshare/micro popups are touched.

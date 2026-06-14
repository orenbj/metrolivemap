# Simplicity Audit — "Keep It Stupid Simple"

**Date:** 2026-06-14 · **Status:** report only, nothing changed · **Scope:** whole `js/`
codebase + `styles/index-style.css`, via three parallel passes (motion core, UI layer,
cross-cutting plumbing). Every finding below was re-verified in the code by hand; agent
overreach was dropped (e.g. the "180 ms hover delay duplicated" claim — it's a single
site; and the earlier "expired vehicle leaves an orphan popup" claim from the tooltip
audit was already disproven).

---

## Verdict

**The codebase is fundamentally simple and sound.** There are no architectural tangles and
**no live conflicts** — the "potential conflicts" hunt came back clean. What exists is a
handful of small **duplications** (the same constant or 2-line pattern copy-pasted across
modules) that invite future drift, plus a few oversized render functions. The motto cuts
both ways: most of the *apparent* complexity (motion gates, feed lifecycle, popup refresh
guard) is **essential and documented** — splitting or "simplifying" it would make things
worse, not simpler. The real KISS wins are single-source-of-truth de-dups.

Ranking is **value ÷ risk**. Tier 1 is the whole recommendation; Tiers 2–3 are optional.

---

## Tier 1 — Trivial, zero-risk, real KISS wins (recommend as one PR)

Each is a behavior-preserving de-duplication: one source of truth instead of N copies.
All are covered by existing tests (output is unchanged).

| # | What | Where (verified) | Fix |
|---|------|------------------|-----|
| S1 | **Easing curve duplicated** — the cubic-in-out formula `t<0.5 ? 4t³ : 1-(-2t+2)³/2` appears verbatim twice | `markers.js:2034` (arcGlide) + `markers.js:2114` (animateMarker) | Extract `cubicInOutEase(t)`; both call it. Pinned by `glide-invariant.test.js`, so the curve stays locked. |
| S2 | **Route fallback color `#231f20`** copy-pasted as `routeHexColors[x] \|\| '#231f20'` | `stations.js:219`, `boardingBadges.js:288` & `:406`, `markers.js:799` & `:1519` (5 sites, **2 use `\|\|`, 1 uses `??`**) | `export const FALLBACK_ROUTE_COLOR` in config.js; import everywhere. Standardize on `??`. |
| S3 | **Bike amenity colors hardcoded inline** (`#16a34a`/`#2563eb`/`#9ca3af`) duplicating bikeshare's constants | `stations.js:1268–1271` vs `bikeshare.js:10–12` (`C_BIKE`/`C_EBIKE`/`C_DOCK`) | Hoist the three to config (next to `routeHexColors`), import in both. Today they're a silent sister-dependency: a palette change updates one and silently desyncs the other. |
| S4 | **WS ping interval `30s` hardcoded twice**, inconsistent notation (`30000` vs `30_000`) | `api.js:240` + `tripUpdates.js:105` | `export const WS_PING_INTERVAL_MS = 30_000` in config.js (alongside the dozen other `WS_*` constants); import in both. |
| S5 | **`RAIL_CARDINAL_SORT = {N:0,E:1,S:2,W:3}` defined twice** | `stations.js:1035` + `:1158` | Hoist one copy to module scope. |
| S6 | **Cardinal-suffix HTML built inline twice** (`/^[NSEW]/.test(...)` → `<span class="sp-bus-cardinal">`) | `stations.js:1118–1119` + `:1222–1223` | Extract `_cardinalHTML(dirLabel)`; call from both route-block renderers. |
| S7 | **`_isJLineOnly` hardcodes the J routes** `r !== '910' && r !== '950'` | `stations.js:342` | Use the canonical map: `ROUTE_LETTER[r] !== 'J'`. Binds J's identity to the one source (config) instead of a local copy. |

Net effect: ~5 fewer copies of constants/curves, no behavior change, every value gets one
home. This is the batch that most directly serves "keep it stupid simple."

## Tier 2 — Small clarity wins (optional, do if touching the area)

- **`isArcAscending(cache)` predicate.** `arcAscending !== false` is inline at
  `markers.js:1197` & `:1410`; `predictions.js` already centralizes the *sign-flip* as
  `_orientArc` (used 5× there). A shared boolean predicate would unify the convention.
  Modest (2 sites). Risk: none.
- **Name the lone magic numbers** the bus-section uses inline: bike search radius `160`
  (`stations.js` `_renderAmenityRow`), nearby-bus radius `225` (`_renderNearbyBusSection`),
  hover delay `180` (`stations.js:495`). These are **single-site** (not duplicated), so
  this is tunability/readability polish, not de-dup — lower value than Tier 1.
- **`_recordFly` (11 positional params, `markers.js:1932`) → options object.** It's
  diagnostic-only (writes `localStorage.mlm_flyLog`), so the param-noise is pure ergonomics
  with zero motion risk. The other high-arg functions (`animateMarker` 10, `arcGlide` 8,
  `_applyVelocityCorrections` 8) are internal single-call-site — converting them is churn
  for little gain; skip unless you're already in there.
- **Drop the `_` prefix on local variables** inside `_renderStationAlertsSection`
  (`_seenIds`, `_routesByEffect`, `_activeService` …). The `_` reads as "module-private"
  but they're function-locals — mildly misleading. Cosmetic.

## Tier 3 — Oversized functions (defer; "simpler" is debatable here)

These are big but **well-commented and single-purpose-ish**, and KISS cuts both ways —
splitting a 150-line render function into three 50-line ones spreads the logic across the
file without necessarily making any one part easier to follow. Recommend **only if you
personally find them hard to navigate**, not on principle:

- `_renderNearbyBusSection` (~181 lines, `stations.js:1313`) — could split out
  `_collectNearbyBusArrivals` + `_resolveBusDest`.
- `_renderStationAlertsSection` (~150 lines, `stations.js:1544`) — could split access vs
  service rendering.
- `createNewMarker` (~264 lines, `markers.js:739`) — **medium risk**: the popup
  `on('open')`/`on('close')` handlers close over `marker`/`popup`/`markerKey`, so
  extraction needs careful capture. Not worth it absent a real pain point.
- `showArrivalsPopup` (~144 lines, `stations.js:549`) — **do NOT casually refactor**: the
  5 s-refresh re-entry guard (`activePopupStopIds !== stopIds`) is load-bearing and subtle.

`markers.js` (2332 LOC) and `stations.js` (1784 LOC) are large, but a file-split is a big,
risky move for a no-build app with `window.*` cross-talk; not recommended now.

## On "potential conflicts" (you asked specifically)

**None found that can actually fire.** The only thing resembling a conflict is *latent*
inconsistency: S2's `||` vs `??` route-color fallback would diverge **only** if a route's
hex were ever `null`/`""` — and config never sets that (every key is a 6-digit hex). So it's
a tidiness issue (fixed by S2), not a live bug. The feed-staleness read (`stations.js`
calling `tripUpdates.getTripUpdatesFeedHealth()`) is a clean one-way dependency, not a
fight. No double-timers, no two-writers-one-field, no CSS `!important` cascade wars in the
popup code.

## Looks complex but is ESSENTIAL — leave it (do not "simplify")

Verified deliberate per CLAUDE.md / code comments; re-litigating these wastes time:

- The bounded arc-glide motion model; the surviving spike gates (impossible-speed,
  cross-line `isOnDifferentLine`, cold-start, snap tolerance); the >5 km re-anchor; the
  stop-lag re-anchor; the spike-streak escape hatch; the no-DR contract; the
  `_lastAcceptedTs` vs `marker.timestamp` split; `computeHeading`'s ±180° disambiguation;
  the continuity-snap on self-approaching alignments; jitter-hold + bounded backward
  release.
- The **deliberately-duplicated WS lifecycle** between `api.js` and `tripUpdates.js`
  (independent hidden-tab suspend — CLAUDE.md says keep them uncoupled). A shared
  `WsLifecycleManager` is possible but **not recommended** unless a third feed appears or a
  lifecycle bug is found — it's medium-risk for low payoff.
- The single-active-popup registry + `window.__` station hooks (IoC to dodge an init
  cycle); the popup 5 s-refresh state preservation; the feed-correctness gates
  (future-ts, CANCELED/SKIPPED, cross-midnight, ID String-casting); `sw.js` pass-through;
  the feedStats ring/counters; per-theme CSS-variable redefinition.

## Suggested sequencing

1. **Tier 1 as one PR** — seven mechanical de-dups, one test run. The whole KISS payoff.
2. Tier 2 opportunistically, when you're already editing those files.
3. Tier 3 only if a specific function actually bites you while reading it.

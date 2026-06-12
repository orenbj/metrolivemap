# Tooltip Surfaces — UI/UX Design Audit (Vehicle Popup, Alert Tooltip, Bikeshare, Micro, Minor Surfaces)

**Date:** 2026-06-12 · **Status:** report only, nothing implemented · **Scope:** every
tooltip/popup surface except the station popup (audited separately —
`station-popup-ux-audit-2026-06-12.md`, implemented in #486). Same method: severity
(1–4) × frequency (1–3), ties broken glanceability > IA > polish; every claim cites
file:line; agent-reported claims were re-verified in code (one was refuted — see V4).

---

## 1. Executive summary

The popup *system* is in better shape than most apps' single popup: one ETA vocabulary
everywhere, one chrome recipe, one single-active-popup registry, and the vehicle popup's
freshness machinery (per-second age tick, 5 s ETA refresh, on-open rebuild, trusted-age
`_lastAcceptedTs`) is genuinely excellent. The findings are small and concentrated:

1. **V1 — the vehicle popup footer "● 47s" reads like an ETA.** It means "data is 47 s
   old" but nothing says so; it sits two lines under a real ETA pill. One word fixes it. (S)
2. **V2/V3 — the vehicle popup missed the station popup's #486 a11y upgrades.** Its ETA
   pill has no `aria-label`/`title` (station pills now do), and its 28 px route icon has
   `alt="route"` (station icons use the line letter). (S each)
3. **B1 — bikeshare solo pins open a STICKY popup on hover** — the only surface where
   hover-open doesn't close on mouseleave; everywhere else click is the "keep it" gesture. (S)

Everything else is polish-grade or verified-good. Total recommended effort: **under a day**.

## 2. Findings (ranked)

### V1 — Vehicle popup footer "● 47s" is ambiguous · **Sev 3 × Freq 3 = 9** · Effort S

The footer renders a green/gray dot + bare seconds (`ui.js:763`, `.pv2-time`
css:1810–1830). It means "the last trusted GPS fix is 47 s old," but the popup gives no
textual hint — and it sits directly under the next-stop ETA pill ("3m"), the only other
number in the popup. A rider can plausibly read "● 47s" as a second, contradictory
arrival estimate. The dot's `aria-label` ("Data fresh") explains it to screen readers but
not to sighted riders.

**Fix:** change the rendered text from `${secsSince}s` to `${secsSince}s ago` (and keep
the per-second tick writing the same format at `markers.js:55–66` and the on-open sync at
`markers.js:874–879` — three write sites, one string). "47s ago" + dot is unambiguous and
fits 240 px. Optionally prefix "updated" if width allows.

### V2 — Vehicle popup ETA pill missed the #486 pill-a11y treatment · **Sev 2 × Freq 3 = 6** · Effort S

Station pills now carry `role="img"` + `aria-label`/`title` ("in 7 minutes", "due now")
via `_pillTitle` (stations.js). The vehicle popup's pill is still a bare span
(`ui.js:733`) — same vocabulary, no spoken/hover form, and it has *more* variants
("Departs <1m", "Departs 5m") that read worse in a screen reader. **Fix:** move
`_pillTitle` to a shared module (predictions.js or utils.js — stations.js importing into
ui.js is the wrong direction), extend it for the "Departs" forms, apply at `ui.js:733`.
Keep both popups' pills byte-identical in treatment.

### V3 — Route icon `alt="route"` · **Sev 2 × Freq 3 = 6** · Effort S

`<img class="pv2-icon" src="…" alt="route">` (`ui.js:756`). A screen reader announces
"route, image" — zero information, on the popup's most prominent element. The station
popup already does this right (`alt="${esc(letter)}"`, stations.js). **Fix:**
`alt="${ROUTE_LETTER[routeCode] ?? routeCode} Line"` (escape it), falling back to the
route code for buses.

### B1 — Bikeshare solo-pin hover opens a *sticky* popup · **Sev 2 × Freq 2 = 4** · Effort S

Hovering a bike pin >120 m from rail opens the standalone popup after 200 ms
(`bikeshare.js:347–349`) and `mouseleave` deliberately does **not** close it
(`:356–357` comment: "popup is sticky — user dismisses via × or map click"). Every other
hover surface — vehicle markers (`markers.js:982–988`), station hover-preview, the alert
tooltip — closes on mouseleave, with **click** as the universal "keep it open" gesture.
Sweeping the cursor across a bike-dense area leaves a popup the rider never asked to
keep. **Fix:** adopt the vehicle-marker pattern: track `openedByHover`, close on
mouseleave unless clicked. (The near-rail path already behaves this way via
`__closeStationIfUnpinned`.) Touch is unaffected — tap is a click. Note: stickiness was
a deliberate code-comment decision, so this is an owner call; the recommendation is
consistency.

### V4 — Vehicle popup vanishes silently when the vehicle expires mid-read · **Sev 2 × Freq 1 = 2** · Effort S–M

(The exploration agent claimed the opposite — a floating orphan popup. **Refuted:**
`_fadeOutAndRemove` closes the popup explicitly, `markers.js:2192` + `:2206`, per the
CLAUDE.md marker-remove contract, and a `popupDOMOrphan` counter guards the invariant,
`markers.js:2312–2317`.) The *actual* behavior: at age ≥ 300 s the marker fades and the
open popup just disappears — no explanation. Rare (requires staring at a dying vehicle
for 5 minutes). **Fix if wanted:** in the expiry path, when the closing popup was open,
`showToast('That vehicle left the live feed')` — one call next to `markers.js:2206`.
Defensible to skip.

### A1 — Pinned alert tooltip can stack over an open popup · **Sev 2 × Freq 2 = 4** · Effort —

The legend alert tooltip lives outside the popups.js single-active registry (deliberate —
it's legend-scoped chrome) and at `--z-alert-tooltip: 9999` it sits *above* popups
(`css:1108` comment). A pinned tooltip can reach `min(70vh, 480px)` (`css:2724–26`) — on
a phone that can fully cover an open station popup. **Recommendation: accept and
document** — the stacking is rare (requires pinning legend alerts *then* opening a
popup), and wiring the tooltip into the registry would couple legend chrome to map
popups. Recorded here so it's a decision, not an accident.

### Minor notes (Sev 1, polish/notes — fix opportunistically)

- **V5** — the vehicle popup has no heading element (`pv2-dest` is a div); the station
  popup promoted its name to `<h3>` for SR skip-by-heading. Same one-line treatment +
  font reset would match. (`ui.js:677`)
- **T1** — the connection-status dot is `title`-only (`ui.js:597–606`); on touch the
  title is unreachable. Mitigated: the adjacent `#update-time` label carries the bad
  states ("Reconnecting…") textually. Adding `aria-label` mirroring the title is a
  one-liner.
- **A2** — the alert tooltip keeps `role="tooltip"` even when pinned, where it's
  functionally a small non-modal dialog (scrollable, selectable). SR users won't discover
  the scroll. Note only; re-roling dynamically is more churn than it's worth today.

## 3. Verified-good (checked, leave alone)

- **Vehicle popup freshness machinery** — initial HTML baked at creation, rebuilt on
  `popup.on('open')` (`markers.js:862–880`), refreshed per WS frame *only when open*
  (hot-path gate `markers.js:1779`), plus a 5 s ETA tick and a 1 s age tick gated on
  `_openVehiclePopups` (`markers.js:55–78`). Age/tier driven by `_lastAcceptedTs`, never
  the spike-bumped `marker.timestamp`. This is the right architecture end to end.
- **"Now" gated on STOPPED_AT** with every approach passing through "<1m"
  (`ui.js:693–712`) — shared vocabulary with station pills, deliberate (commit `84aa191`).
- **Hover affordance on vehicle markers** — 180 ms delay, close-on-leave unless clicked
  (`markers.js:966–991`); matches the station hover-preview. (B1 is the one outlier.)
- **Alert tooltip mechanics** — hover/focus/click triggers, tap-to-pin on touch with the
  touchstart race guarded (`alerts.js:1242–44`), Escape + outside-click dismiss, edge
  clamping with caret tracking (`alerts.js:1130–41`), 44 px badge targets on coarse
  pointers, structured-DOM blocks with per-alert "Active:" windows. The most polished
  tooltip in the app.
- **Bikeshare near-rail hover** reusing the station popup hooks (`__hoverStationByGroup`)
  instead of a competing preview — exactly right; and the open standalone popup refreshes
  counts every 30 s poll (`bikeshare.js:569–573`).
- **Metro Micro popup** — post-#486 `mp-*` port verified; static zone data needs no
  refresh; hover highlight via feature-state opacity; guard against opening over a
  transit station (`microzones.js:190`).
- **Popup-leak harness** — `_openVehiclePopups` vs DOM count divergence recorded as
  `popupDOMOrphan` (`markers.js:2312–17`).

## 4. Cross-surface consistency matrix (post-#486 state)

| Attribute | Vehicle | Alert tooltip | Bikeshare | Micro | Toast |
|---|---|---|---|---|---|
| Chrome vars | ✅ | ✅ (by construction) | ✅ (mp-*) | ✅ (mp-*) | ✅ |
| Hover behavior | preview, close on leave ✅ | preview + pin ✅ | **sticky on hover ⚠ (B1)** | click-only ✅ | n/a |
| Pill a11y | **missing ⚠ (V2)** | n/a | n/a | n/a | n/a |
| Heading semantics | div ⚠ (V5) | n/a | div (mp-title) | div (mp-title) | role=status/alert ✅ |
| Touch path | tap=click ✅ | tap-to-pin ✅ | tap ✅ | tap ✅ | visible ✅ |
| Registry | ✅ | separate (deliberate, A1) | ✅ | ✅ | n/a |

## 5. Suggested implementation order (if approved)

1. **V1 + V2 + V3 + V5** — one "vehicle popup polish" PR (all S; V2 includes moving
   `_pillTitle` to a shared module and pointing stations.js at it).
2. **B1** — one small PR (owner call: it reverses a deliberate stickiness decision).
3. **T1** — ride along with either PR.
4. **V4, A1, A2** — recommend recording as accepted behavior (this document); implement
   only if they bother you in practice.

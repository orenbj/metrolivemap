# Project Status — Snapshot

Last refreshed at the close of a multi-PR audit + cleanup pass. Captures the
state of in-flight initiatives and the deferred decisions worth remembering
the next time someone opens the repo cold.

> If the date below is more than ~3 months old, this file is stale and the
> next contributor should re-anchor it against current `main` rather than
> trust the snapshot. Test count and PR numbers will drift fastest.

---

## Phase-5 readiness (trajectory-model overhaul)

The full plan lives in [`docs/trajectory-overhaul.md`](./trajectory-overhaul.md).
Phases 0–4 are merged; Phase 5 (render-layer rewrite) is gated on the
baseline-capture window described there.

**As of this snapshot:**
- All Phase 1–4 modules — `js/trajectory.js`, `js/vehicleState.js`,
  `js/stateUpdaters.js`, `js/dwellModel.js` — are **dormant in production**.
  Zero production imports. Tests pass in isolation; their state never
  touches `window.*` globals that production reads.
- No feature flag has been added yet. Phase 5 introduces
  `USE_TRAJECTORY_MODEL` (per the plan); the absence is the gate.
- Phase 0 capture instrumentation (`tests/eta-live-accuracy.js`,
  `scripts/live-accuracy-*.js`) runs as a manual/CI harness — not in the
  production bundle.

**Integration seams Phase 5 will replace** (so the next implementer doesn't
have to grep):
| Today | After Phase 5 |
|---|---|
| `markers.js` — `_arcTick`, `_bearingTick`, `startDeadReckoning`, `startBearingDeadReckoning` (~300 lines) | `state.trajectory.positionAt(t_now)` per frame |
| `predictions.js` — `_blendArrivals`, horizon-band logic, replay guard (~500 lines) | `state.trajectory.timeAtArc(target_arc)` |
| `scheduleCalibration.js` (~8 KB) | `dwellModel.js` + Phase 6 variance learner |
| `intersections.js` (kept) | dwell logic moves to `dwellModel.js`; intersection lookup stays for heading disambiguation |

**Recent fixes touching the about-to-be-replaced code** (each is a
correctness improvement on the legacy path until Phase 5 lands — none
introduce new entanglement with Phase 1–4 modules):
- `_blendArrivals` `calcHorizon >= 0` guard (PR #148)
- Marker hard TTL + fade-race fix + DR `_fadingOut` guard (PR #126)
- Cleanup-loop `for…in` → `Object.keys` snapshot (PR #149, #153)

---

## Deferred design decisions (worth a conversation before action)

### 1. Spike-rejected fixes bump `marker.timestamp`
**Location:** `js/markers.js:973-974` (after `recordMarkerDrop('spike')`)

A GPS fix flagged as a spike currently does
`marker.timestamp = newTs; el.setAttribute('data-timestamp', newTs)`. The
code comment above this block explicitly says the bump is intentional —
the design treats spike-rejected frames as "feed liveness, data quality
unknown" and keeps the marker fresh-looking.

The cross-codebase audit flagged this as LATENT: a vehicle whose GPS is
broken (every fix rejected for ~120 s of `SPIKE_BYPASS_S`) shows green/live
to the rider even though we're not trusting any of the data. Possible UX
improvements:
- Leave it (current behaviour — feed liveness is the signal).
- Don't bump `marker.timestamp` on spike-reject so the marker ages
  naturally to amber/grey/expired — clearer "data is unreliable" cue.
- Introduce a separate "GPS quality" tier independent of feed liveness.

**Status:** untouched. Worth a UX decision before changing.

### 2. Two popup-refresh tickers (1s + 5s)
**Location:** `js/markers.js:54-65` (1 s age counter) + `:68-77` (5 s ETA rebuild)

For a single open vehicle popup, two `setVisibleInterval` callbacks fire:
the 5 s rebuild re-bakes the popup HTML (including the `data-ts` the 1 s
counter just wrote), the 1 s tick then re-mutates it. Harmless churn but
ugly.

**Status:** flagged but deferred. Phase 5 will rewrite this area
(`updatePopup` reads from the trajectory model), so consolidating now
would conflict with the imminent rewrite. Revisit post-Phase-5 if it
matters.

### 3. `chooseBadgeSlots` cornerPlacement asymmetry
**Location:** `js/stations.js:1277-1289`

When the boarding badge is at `T` vs `B`, the `(alert, access)` pair
flips left/right order. Not a no-overlap violation (covered by the
32-combinations test) but ARIA reading order across the 8 cases isn't
uniform. NIT.

---

## Outstanding hygiene the audits noted but didn't change

These are *intentional* current choices the audits surfaced. Listed here
so a future "let's improve this" instinct sees the prior reasoning.

- **GTFS-RT timestamps pre-coerced via `Number(...)`** in
  `js/tripUpdates.js:170`. `normalizeTimestamp` accepts strings, but
  GTFS-RT spec'd numeric timestamps and a string-of-digits like
  `"1700000000"` would be misread as a year by the ISO-string path.
  Keep the wrapper. Same logic does NOT apply to alerts ingest, which
  genuinely receives ISO-8601 strings.
- **`getBoardingVehicles` Tier-2 keeps GTFS-only entries for ~30 s after
  predicted departure** (`js/predictions.js:894-897`). Bridges the GPS
  layover gap — comment in source explains.
- **`marker.timestamp` advances on any WS arrival, including
  re-broadcasts** (CLAUDE.md "Vehicle freshness tiers"). Designed
  intent: feed liveness, not strictly-newer-fix clock. See the
  spike-reject deferred discussion above.

---

## Conventions reminders (the easy-to-forget ones)

- **Stop IDs** — pass through `normalizeStopId(s)` for any lookup that
  may have a `_N/_S` directional suffix. `masterStopsData` may key by
  either form depending on the build pipeline; the dual-lookup pattern
  in `markers.js` (`x ?? normalize(x)`) is the canonical fallback.
- **Timestamps** — `normalizeTimestamp(v)` handles Unix seconds, Unix
  ms, ISO strings; returns NaN for negative or unparseable input.
  Callers must `Number.isFinite()`-guard the return.
- **Intervals that should pause when hidden** — use
  `setVisibleInterval(fn, ms, key)` not raw `setInterval`. The `key`
  parameter makes re-registration idempotent.
- **No build step** — keep imports as relative ES-module paths.
- **Window globals** — additions to the table in CLAUDE.md "Cross-Module
  Globals" require explicit justification. The trend is to remove
  mirrors, not add them (PR #151 dropped `tripTerminusByTripId`).

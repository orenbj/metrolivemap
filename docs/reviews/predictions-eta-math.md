# Review: ETA & Predictions Logic + Math

Reviewer: automated review batch 2026-05-06
Scope: js/predictions.js

## Summary
The module is in good shape overall: data flow is well-isolated (pure data, no DOM), units are consistent (unix seconds throughout), and the recent additions (overrun branch in `computeTripAdherenceOffset`, horizon-adaptive blend, stale-replay guard, adherence taper) are mathematically sound and well-commented. Headline findings: (1) `getSecondsToNextStop` does not apply the adherence taper, so stale/large offsets can produce values inconsistent with the rest of the pipeline; (2) one duplicate JSDoc block was removed inline; (3) several minor consistency / null-handling smells worth a follow-up but no critical correctness bugs found.

## Findings — Bugs (highest priority)
- [LOW] Untapered adherence offset in `getSecondsToNextStop` — js/predictions.js:521-524 — the function adds the raw `adherenceOffset` (clamped only to ±600s) directly to `interStopRemainingSeconds`. Everywhere else (`getScheduledArrivals`, `getArrivalBreakdown`) the offset is tapered by `ADHERENCE_TAPER_K * remainingTime` so a stale +100s offset never overshoots a 15s remaining-time. This call site is not currently used for arrival predictions (it appears to feed marker UI), so the impact is small, but it is an inconsistency that violates the OBA-#127 invariant cited in the comments at line 318.
  - Recommendation: apply the same taper here, or factor the taper into a shared helper used by all three call sites.
  - Status: Recommended (out of scope — risk of behavioral change to marker UI; needs callers audit + tests).

- [LOW] `computeScheduleEta` sign of `ETA_DEPARTURE_LAG_S` when `remaining == null` — js/predictions.js:251 — `gap - ETA_DEPARTURE_LAG_S + dwellPad`. When `interStopRemainingSeconds` returns null (no `statusChangedAt`, or first stop), we fall back to the raw scheduled gap. Subtracting `ETA_DEPARTURE_LAG_S` here implicitly assumes the vehicle has already been moving for `ETA_DEPARTURE_LAG_S` seconds, but we have no evidence of that — `statusChangedAt` was missing. The earlier ETA is the wrong direction (optimistic) for the missing-data case.
  - Recommendation: drop the `- ETA_DEPARTURE_LAG_S` term in this branch (use `gap + dwellPad`), or add a comment justifying it.
  - Status: Recommended (out of scope — behavioral change, may need test coverage).

- [LOW] `Math.sign(0)` returns 0 — js/predictions.js:325-326, 466-467 — when `adherenceOffset === 0`, `cappedOffset = 0 * Math.min(0, maxOffset) = 0`, which is fine, but `_offsetCapped` at line 487 then evaluates `|0| < |0|` → false, which is correct. No bug, but the construction `sign * Math.min(|x|, ...)` re-derives a value already known when `x === 0`. Cosmetic.
  - Recommendation: none required.
  - Status: Recommended (cosmetic, out of scope).

## Findings — Math / Statistics
- [INFO] In-segment branch is correct — js/predictions.js:181-188 — `arcDelta = snapArc - schedExpectedArc` followed by `raw = -(arcDelta / schedSpeed)`. Sign convention: positive offset = behind schedule. With `schedExpectedArc = prevArc + (t/gap)*dist` and `snapArc` further along, `arcDelta > 0` means ahead of schedule, and the negation makes it negative (early). Verified consistent with the comment block.

- [INFO] Overrun branch is correct — js/predictions.js:168-178 — `(elapsed - gap) + remainingArc/schedSpeed` correctly expresses total lateness when the vehicle has burned through its scheduled gap and still has arc remaining. The clamp at line 153 (`snapArc < prevArc || snapArc > nextArc`) guarantees `remainingDist >= 0`; the `Math.max(0, ...)` at line 174 is therefore defensive but harmless.

- [INFO] Horizon-adaptive blend weights (0.7/0.9/1.0) are documented with empirical justification (audit on 515 arrivals, 3460 snapshots) — math is just a piecewise linear interpolation with thresholds at 60s and 300s. Sound.

- [INFO] Stale-replay guard `calcHorizon < 300 && gtfsHorizon > 2*calcHorizon + 60` — js/predictions.js:364 — the asymmetric `+60` constant absorbs near-zero `calcHorizon` cases (small calcHorizon would otherwise let any positive gtfsHorizon trigger). Reasonable.

- [INFO] Adherence taper `cappedOffset = sign * min(|offset|, K*remaining)` with K=0.35 — js/predictions.js:323-326 — eliminates the OBA #127 close-range overshoot. Worth noting that for vehicles at the next stop (remaining ~ 0), the cap drives offset to 0 — i.e. for the immediately-next stop adherence is nearly fully suppressed. This is intentional but means most adherence value accrues for the second-and-later stops in the schedule chain.

- [INFO] `gtfsLooksPlausible` math — js/predictions.js:217 — `minPlausible = distMeters / ETA_MAX_SPEED_MPS` minus `ETA_PLAUSIBILITY_GRACE_S`. Single-vehicle reasoning, no issue. Note: `distMeters <= 0` returns true (trust feed) which correctly handles loop-route turnarounds where stopArc < vehicleArc.

- [LOW] Edge case: zero-distance stops — js/predictions.js:147 — `interStopDist <= 0` returns 0. If two stops in `cache.arcMeters` resolve to the same arcMeter (snap collision), adherence is silently suppressed for that segment. No bug, but worth a note.

## Findings — Code Quality
- [LOW] Removed duplicate JSDoc block above `gtfsLooksPlausible` — js/predictions.js:191-196 (pre-fix) — the older comment-only block was a leftover from before the typed JSDoc was added. **Fixed inline.**

- [LOW] `dirs` materialization inside `getScheduledArrivals` and `getArrivalBreakdown` — js/predictions.js:293, 447 — `dirsToTry(preferredDir)` always returns a 1-element array because line 292 / 445 already exits when `preferredDir == null`. The two-element fallback path (`[0,1]`) is dead at this call site.
  - Recommendation: drop `dirsToTry` and inline `const dir = Number(preferredDir);`. Keeps the [0,1] fallback only in `getSecondsToNextStop` and `getBoardingVehicles` where it's actually reachable.
  - Status: Recommended (out of scope — minor refactor).

- [LOW] Inconsistent `direction_id` coercion — js/predictions.js:285 vs 511 — `getScheduledArrivals` does `tripMeta?.dir ?? marker.properties.direction_id` (no `Number()`); `getSecondsToNextStop` does `tripMeta?.dir ?? (direction_id != null ? Number(direction_id) : null)`. If `direction_id` arrives as the string "0", the cache lookup still works (string template literal), but the `directionId` field in result objects is a string in one path and a number in the other.
  - Recommendation: pick one (prefer `Number()`-cast at the boundary) and apply uniformly.
  - Status: Recommended (out of scope — touches result shape).

- [LOW] `seenTripIds` populated in `getBoardingVehicles` line 631 but only read in the Tier-2 loop — js/predictions.js:631-700 — readability: `coveredTripIds` (used in `getScheduledArrivals`) and `seenTripIds` (used here) serve identical roles. Fine, just naming inconsistency across functions.
  - Status: Recommended (cosmetic).

- [INFO] `targetIdxCache` keying by `cacheKey` is correct because `sid` is constant per call. Good optimization.

## Findings — Performance
- [INFO] `findIdx` is called in tight loops; for a typical Metro schedule with ~30 stops the linear scan is fine. The author already memoizes `targetIdx` per cacheKey (line 306, 454). `nextIdx` is recomputed once per marker per dir, which is also fine.

- [LOW] `gtfsList.find(e => e.tripId === trip_id)` — js/predictions.js:657 — linear scan inside the marker loop in `getBoardingVehicles`. For small `gtfsList` (<10 entries per stop) this is negligible, but if a stop has many trip_updates entries the cost is O(markers × entries). Could memoize a `gtfsByTripId` Map similar to `getScheduledArrivals` line 269.
  - Status: Recommended (minor).

- [INFO] `initPredictions` builds `cache.arcMeters` once on load. Hot-loop allocations are minimal.

## Findings — Security / Privacy
- [INFO] No DOM access, no innerHTML, no eval, no fetch with user input. Pure data module; nothing to flag.

## Findings — Documentation / JSDoc
- [INFO] Most exported functions have terse JSDoc consistent with codebase convention.

- [LOW] `interStopRemainingSeconds` — js/predictions.js:101-108 — JSDoc body well-written but missing `@param`/`@returns` tags. Inconsistent with `gtfsLooksPlausible`/`getSecondsToNextStop` which do have them.
  - Status: Recommended (cosmetic).

- [LOW] `computeTripAdherenceOffset` — js/predictions.js:122-137 — same as above: rich prose comment but no `@param`/`@returns`. The function signature is non-obvious (what is `marker`? `cache`?).
  - Status: Recommended (cosmetic).

- [LOW] `computeScheduleEta` — js/predictions.js:223-226 — no `@param` tags at all; this is the most complex private helper and the riskiest to refactor without clear contract docs.
  - Status: Recommended.

## Suggestions (non-defect improvements)
- Factor the adherence-taper block (lines 322-328 in `getScheduledArrivals` and 463-468 in `getArrivalBreakdown`) into a shared helper `applyAdherenceTaper(schedEta, offset, now)` returning `{ calcEta, cappedOffset }`. Eliminates two-place duplication and centralizes the OBA-#127 invariant. Would also let `getSecondsToNextStop` adopt the taper trivially.
- Consider exporting `ADHERENCE_TAPER_K` from this module's surface so tests can assert the boundary behavior directly.

## Findings out-of-lane (for other units)
- Unit (snap): `marker.lastSnapDeviationM` — predictions.js:161 — this module reads it but `snap.js` is the producer; the threshold values 80m (rail) / 120m (bus) are hardcoded here. A snap-side review may want to document where these thresholds come from.
- Unit (config/constants): `ETA_DEPARTURE_LAG_S` is added to elapsed time in two places (line 118, line 165) with subtly different semantics — the constants module doc may want to clarify that "departure lag" represents "time the vehicle has been in motion since the feed declared STOPPED_AT cleared," not pre-departure dwell.
- Unit (calibration): `getSpeedMultiplier` from `scheduleCalibration.js` is multiplied into `interStopGap` (line 117) and into the multi-stop `gap` (line 241) but is **not** applied in `computeTripAdherenceOffset`'s `schedSpeed = interStopDist / interStopGap` (line 166). The adherence calc treats schedule speed as un-calibrated. May or may not be a defect depending on whether multiplier is intended to model GTFS optimism (in which case adherence should also use it) or per-vehicle speed (in which case it shouldn't).

## Inline fixes applied in this PR
- Removed duplicate JSDoc block above `gtfsLooksPlausible` (predictions.js lines 191-196 of the pre-fix file). 8 lines removed; no behavioral change.

## Test impact
- npm test before: 173 passed (12 files).
- npm test after: 173 passed (12 files).
- New/changed tests: none.

# Review: Markers, DR Animation, Heading

Reviewer: automated review batch 2026-05-06
Scope: js/markers.js

## Summary
The module is generally well-structured with clear state machine ownership and good defensive guards (marker-presence rechecks across rAF boundaries, bounded pullback suppression, capped DR duration). One real runtime bug was found: a `const`-declared `snap` is reassigned on a rare degenerate-tangent fallback path, which would throw `TypeError` whenever that branch fires — fixed inline. The "tunnel-restart logic with `drStartTs`" called out in the review brief does not exist in this code at HEAD; `startDeadReckoning` has no self-restart loop and exits cleanly via `DR_MAX_SECONDS`, so the bounded-loop concern is moot for the current source.

## Findings — Bugs (highest priority)
- [HIGH] `const snap` reassigned on degenerate-tangent fallback — js/markers.js:541,550 — `snap` is declared `const` then reassigned via `snap = { ...snap, tangentForward: ... }`. The branch only fires when `snap.tangentForward == null && marker.lastSnap?.tangentForward != null` (sub-1 m polyline segments near terminal loops), which is why it has not surfaced in tests. Whenever it fires it throws `TypeError: Assignment to constant variable`, killing the entire `updateExistingMarker` invocation for that vehicle.
  - Recommendation: change `const` to `let`.
  - Status: Fixed inline.
- [LOW] Hover-timer can fire on a removed marker — js/markers.js:462 — the 180 ms `setTimeout` captures `marker` and `popup` in its closure; if the marker is removed (staleness sweep, terminus turnaround) during that window, the callback still calls `marker.togglePopup()` on a detached marker. MapLibre tolerates this in practice (no exception), but it's a latent leak/no-op.
  - Recommendation: clear `hoverTimer` in a marker-removal hook, or guard the callback with `if (markers[markerKey] === marker)`.
  - Status: Recommended.

## Findings — Math / Statistics
- [INFO] Kinematic deceleration assumes speed²/(2·a) ≈ DECEL_ZONE — js/markers.js:898-940 — `_t_decel` is computed for free travel up to `DECEL_ZONE` from the stop, then `t_in` runs through `_t_stop = speed/decelRate`. If the entry speed is high enough that `speed²/(2·a) > DR_DECEL_ZONE_M`, the integrated position would overshoot `stopArcCap` before `t_in` reaches `_t_stop`; the trailing `Math.min/Math.max(..., stopArcCap)` clamps clean up, but the visible decel curve compresses into the zone. Conversely if speed is low, the marker stops short and the clamp at line 934-935 holds it — also visible as an early stop. The current Metro feed speeds and constants make this a non-issue, but worth a comment.
  - Recommendation: add a one-line comment near line 901 noting the clamp cleans up the speed/zone mismatch; optionally pre-cap entry speed at `sqrt(2·a·DECEL_ZONE)` for a perfectly-fit ramp.
  - Status: Recommended.
- [INFO] Bearing-shortest-delta formula is correct and consistently applied — js/markers.js:136, 858, 866, 967 — `((a - b + 540) % 360) - 180` returns the signed minimum delta in `(-180, 180]`. JS `%` is signed so the `+540` keeps the operand non-negative even when `a < b - 360k`; this is the standard idiom and is used identically in all four places.
  - Status: No change.
- [INFO] `arcSign` resolution chain is sound — js/markers.js:855-869 — primary downstreamBearing vs tangent (90° threshold), fallback to consecutive arc-diff (>5 m hysteresis to ignore snap noise), final fallback to heading vs tangent. The 5 m hysteresis matches `RAIL_ARC_SPIKE_NOISE_M` semantics.
  - Status: No change.

## Findings — Code Quality
- [LOW] `parseInt` used without explicit radix on numeric strings — js/markers.js:324, 330, 411, 442, 495, 731 — feed timestamps are decimal strings, so default base-10 is correct, but explicit `parseInt(x, 10)` is the project-standard idiom and silences linters.
  - Recommendation: pass `10` or use `Number(...)` since the values are already validated upstream.
  - Status: Recommended.
- [LOW] Tunnel-restart logic referenced in review brief is absent — js/markers.js:837-963 — the brief flagged "the new tunnel-restart logic in `startDeadReckoning` (verify it can't loop forever)" via a `drStartTs` comparison, but `drStartTs` is not present in the file (verified via grep) and `startDeadReckoning` does not self-schedule a restart. Either the change was reverted before this review or it's pending on another branch. As-is, DR is bounded by `DR_MAX_SECONDS` (line 906), `lngLatAtArc → null` (line 948), and marker removal (line 904) — no unbounded loop is possible.
  - Recommendation: confirm with the user whether the tunnel-restart change is still planned; if so, ensure any restart guard caps total DR duration at `STALE_THRESHOLD_SEC` (300 s) so a stale marker can't keep DR'ing forever.
  - Status: Recommended.
- [LOW] `for...of break` after first open popup assumes a single-popup invariant — js/markers.js:44-50 — the loop `break`s after handling the first marker whose popup is open. If MapLibre allows multiple open popups (it does, by default), only the first found gets refreshed.
  - Recommendation: drop the `break` so all open popups refresh; cost is negligible (popup count is tiny).
  - Status: Recommended.
- [INFO] No dead code or unused imports observed.
  - Status: No change.
- [INFO] Spike rejection error handling: no errors are swallowed — `isGpsSpike` returns false on missing references and lets the regular update path run.
  - Status: No change.

## Findings — Performance
- [INFO] rAF chain integrity is good — animations are cancelled at update entry (line 488-491), at marker removal in cleanup (line 1012-1014), and on `lngLatAtArc → null` (line 948). Both DR functions check `markers[markerKey]` before each frame so there is no zombie loop.
  - Status: No change.
- [LOW] `setLngLat` and `setRotation` per frame for every visible marker — js/markers.js:950, 956 — fine for the current vehicle counts (~50-150) but worth noting that MapLibre's marker positioning goes through DOM transform writes per call, not a batched buffer. If marker counts ever scale 5×, consider a custom symbol layer.
  - Status: Recommended (long-term).
- [INFO] `_svgUrlCache` is bounded as documented (~20-40 entries); no eviction needed.
  - Status: No change.

## Findings — Security / Privacy
- [INFO] Popup HTML is generated by `getPopupHTML` in ui.js, which the inline comments at lines 418, 747 explicitly mark as escape-safe. No `innerHTML` is constructed in this file.
  - Status: No change.

## Findings — Documentation / JSDoc
- [LOW] `startBearingDeadReckoning` and `startDeadReckoning` JSDoc do not mention pause-but-keep-alive behavior on transient zero speed — js/markers.js:777-784, 829-837 — the bodies implement it with a long inline comment but the headers don't reflect it.
  - Recommendation: add one line: "Transient zero-speed reads pause the move but keep the rAF chain alive."
  - Status: Recommended.
- [LOW] `processVehicleData`'s priority chain comment says "snap tangent → GPS bearing → dead-reckoning → last known" — js/markers.js:305 — but `computeHeading`'s actual chain is stationary-hold → terminus-hold → tangent+downstream → downstream → cold-start snap → previous. The doc text predates the current implementation.
  - Recommendation: update the JSDoc summary to reference the chain in `computeHeading`'s header rather than re-listing.
  - Status: Recommended.

## Suggestions (non-defect improvements)
- Extract the `((a - b + 540) % 360) - 180` shortest-delta into a helper in utils.js (`shortestBearingDelta(a, b)`) — repeated four times.
- The pullback-suppression block (lines 616-647) is one of the densest in the file; consider extracting to `applyPullbackSuppression(marker, vehicle, diffLng, diffLat, ...)` and unit-testing the dot-product threshold logic directly.
- Consider promoting `marker.lastVelocity` from raw lng/lat per-second to a typed `{vx_m, vy_m}` in meters/second; spike validation already converts back via `M_PER_DEG_LAT`.

## Findings out-of-lane (for other units)
- Unit (predictions): `findIdx` is imported and used inside markers.js for calibration (line 683-684); confirm in the predictions review that `findIdx`'s fuzzy match is documented as the canonical stop-id matcher.
- Unit (snap): `snapToRoute` returning a fresh object whose `tangentForward` can be `null` on degenerate segments — verify in snap review that this is documented behavior, not a bug at the source. The markers fix at line 549-551 papers over it.
- Unit (ui): `getPopupHTML` is the sole producer of marker popup HTML; ensure the security review of ui.js confirms `escapeHtml` covers every interpolation point referenced from line 416/746.

## Inline fixes applied in this PR
- fix: change `const snap` to `let snap` in updateExistingMarker so the degenerate-tangent fallback assignment doesn't throw

## Test impact
- npm test: 173/173 pass before, 173/173 pass after
- New/changed tests: none (the fixed branch is exercised only when `snapToRoute` returns `tangentForward: null` while a previous tangent exists; adding a focused unit test would require a fake snap factory in the existing snap-mock harness — recommended but out of inline-scope)

# Review: Schedule Calibration (EWMA + Persistence)

Reviewer: automated review batch 2026-05-06
Scope: js/scheduleCalibration.js

## Summary
The module is small, well-bounded, and the core EWMA / two-stage clamp / staleness-gate logic is correct. Math constants are documented with rationale. Two minor polish issues were fixed inline (a duplicated division and a garbled JSDoc block); a handful of non-defect observations are recorded below for awareness.

## Findings — Bugs (highest priority)
- [LOW] Garbled JSDoc on `_resetForTest` — js/scheduleCalibration.js:133-137 — sentence reads "Must be called via `vi.resetModules()` is heavier than necessary", which is missing words and confuses the reset semantics.
  - Recommendation: Rewrite for clarity; also note that the function clears persisted storage in addition to memory + timer.
  - Status: Fixed inline

## Findings — Math / Statistics
- [INFO] α=0.25 choice — js/scheduleCalibration.js:19 — effective sample size ≈ 1/α = 4; half-life ≈ ln(0.5)/ln(1−α) ≈ 2.41 observations. Inline comment justifies the bump from 0.15 with N≥80 for active routes; tradeoff (faster reaction vs. variance on routes near the MIN_OBS_FOR_USE threshold) is acknowledged.
  - Recommendation: None — choice is documented and defensible.
  - Status: Recommended (no action)
- [INFO] MIN_OBS_FOR_USE=5 vs. effective EWMA N ≈ 4 — js/scheduleCalibration.js:25 — gating at 5 observations is right at the EWMA's effective sample size, so the multiplier can be heavily influenced by a single recent observation immediately on warm-up. Acceptable given the 0.7–1.7 outer clamp and the [0.3, 3.0] outlier reject, but worth being aware of.
  - Recommendation: Consider raising to 8 or 10 if early-warm jitter shows up in field data; otherwise leave as-is.
  - Status: Recommended
- [INFO] Two-stage clamp [0.3, 3.0] then [0.7, 1.7] — js/scheduleCalibration.js:73-80 — correctly rejects pre-EWMA outliers before they can pull the running mean toward a clamp boundary; the post-EWMA clamp also bounds adversarial sequences. Math is correct.
  - Status: No action
- [INFO] First-observation seed uses the clamped ratio (line 80, then line 87 branch) — correct: a first sample of ratio=0.5 is correctly seeded at 0.7 rather than 0.5.
  - Status: No action
- [INFO] Snapshot deep-copy via `JSON.parse(JSON.stringify(state))` — js/scheduleCalibration.js:116 — safe given the flat plain-object shape and no Date/Map/Set/undefined values. Tested by the "deep copy" isolation test.
  - Status: No action

## Findings — Code Quality
- [LOW] Duplicate division `observedSec / scheduledSec` — js/scheduleCalibration.js:73, 80 (pre-fix) — `rawRatio` was already computed; the second occurrence was a copy-paste leftover.
  - Recommendation: Reuse `rawRatio` in the post-clamp expression.
  - Status: Fixed inline

## Findings — Performance
- [INFO] Throttled save (30s) — js/scheduleCalibration.js:44-50 — uses a single timer flag and coalesces; correct pattern. Trailing-edge only (no leading-edge write), which matches the module's "best-effort persistence" intent.
  - Status: No action
- [INFO] Tail-loss on tab close — pending updates inside the 30 s window are not flushed on `beforeunload`/`pagehide`. For training-data persistence this is acceptable (next session re-learns within ~5 observations) but worth noting.
  - Recommendation: Optional `pagehide` listener that calls `localStorage.setItem` synchronously if a save is pending.
  - Status: Recommended (defer)

## Findings — Security / Privacy
- [INFO] localStorage payload — js/scheduleCalibration.js:15, 47 — stores only `{ multiplier, observations, updatedAt }` keyed by `routeCode|directionId`. No PII, no tokens. Cross-tab last-write-wins (no `storage` event handler), which is fine for additive learning data.
  - Status: No action

## Findings — Documentation / JSDoc
- [LOW] `getCalibrationSnapshot` JSDoc says "Safe to call from the browser console: `getCalibrationSnapshot()` after importing." — but the function is also exposed on `window` at module load (line 130), so no import is needed when running in the live app. Minor wording drift.
  - Recommendation: Replace "after importing" with "exposed on `window`".
  - Status: Recommended (defer — cosmetic)
- [LOW] Top-of-file header documents the module's intent well; the `MAX_RATIO` history comments (lines 22-24) are useful change-rationale and should stay.
  - Status: No action

## Suggestions (non-defect improvements)
- Consider exporting `MIN_OBS_FOR_USE`, `MAX_AGE_MS`, and `ALPHA` as named exports so test files don't have to hard-code their values (the test currently encodes `0.25`, `5`, and `7 days` literally).
- The `window.getCalibrationSnapshot = ...` and `window.getCalibrationRejectStats = ...` assignments at module top-level (lines 130-131) reference `window` unconditionally. Module imports cleanly under jsdom (which the tests use), but a `typeof window !== 'undefined'` guard would future-proof against any node-only consumers.

## Findings out-of-lane (for other units)
- Unit (test-suite): tests/scheduleCalibration.test.js header comment on line 5 says "ALPHA=0.15" but the implementation and another in-test comment now use 0.25. Drift introduced by the 2026-05-07 alpha bump.

## Inline fixes applied in this PR
- polish: reuse `rawRatio` instead of re-dividing in the post-EWMA clamp (js/scheduleCalibration.js:80).
- polish: fix garbled JSDoc on `_resetForTest` and document that it also clears persisted storage (js/scheduleCalibration.js:133-137).

## Test impact
- npm test: pass before, pass after (no behavioral change).
- New/changed tests: none.

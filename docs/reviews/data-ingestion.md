# Review: WebSocket Ingestion & Trip Updates

Reviewer: automated review batch 2026-05-06
Scope: js/api.js, js/tripUpdates.js

## Summary
Both modules are tight, well-instrumented, and defended against most failure modes (half-dead sockets, hidden-tab buffering, malformed frames, ms-vs-s timestamps). The vehicle-positions path (`api.js`) is in noticeably better shape than the trip-updates path (`tripUpdates.js`), which has a silent catch-all, no inbound watchdog, and no defensive normalization of arrival timestamps. Three low-risk inline fixes applied; remaining items are recommendations.

## Findings — Bugs (highest priority)
- [LOW] `parseInt(v.timestamp)` missing radix — js/api.js:68 — `parseInt` without a radix is a long-standing footgun (octal-leading-zero edge case, ESLint `radix` rule). It also coerces booleans/numbers strangely vs. `Number()`.
  - Recommendation: switch to `Number(v.timestamp)`, which preserves NaN for non-numeric input and avoids radix concerns.
  - Status: Fixed inline
- [LOW] Empty `catch {}` in trip-updates onmessage — js/tripUpdates.js:63 — swallowed *all* errors, not just `SyntaxError`. A logic bug inside `processUpdate` would be invisible in production.
  - Recommendation: log non-SyntaxError exceptions, mirroring the pattern in `api.js` onmessage.
  - Status: Fixed inline
- [LOW] No ms-vs-seconds normalization for `stu.arrival.time` — js/tripUpdates.js:100 — vehicle timestamps in `api.js` defensively divide by 1000 if they look like ms; arrival times here do not. If Metro ever flipped to ms (or a feed bug emits ms), `arrivalUnix > now` always holds, the past-drop and 60s-prune both fail to fire, and `masterArrivalsData` would leak unboundedly.
  - Recommendation: add the same `> 10_000_000_000` heuristic.
  - Status: Fixed inline

## Findings — Math / Statistics
- [INFO] Backoff jitter is multiplicative `0.8 + Math.random() * 0.4` (utils.js:106-108). Range [0.8, 1.2] of the capped delay — good thundering-herd protection. No defect.
- [INFO] `WS_INBOUND_TIMEOUT_MS = 60s` against a documented sub-30s feed cadence gives ~2× headroom — reasonable. Watchdog tick at 15s means worst-case detection is 75s after last message; the visibility-restore path tightens this to 30s when the user comes back.

## Findings — Code Quality
- [LOW] Dead code in `connect()` return value — js/tripUpdates.js:43-66 — the function returns `{ close: ... }` but `initTripUpdates` discards both calls' return values. The `closed` flag is only set by callers that don't exist. Either expose the close handles (so tests / shutdown hooks can use them) or drop the wrapper.
  - Recommendation: drop the closure, or wire it through `initTripUpdates` for symmetry with `setupWebSocket`.
  - Status: Recommended
- [LOW] Redundant `ws.close()` in `onerror` — js/tripUpdates.js:53 — per WHATWG spec, an `error` event is always followed by `close`. Calling `close()` here just races the implicit close.
  - Recommendation: drop the manual `close()`; keep the `console.warn`.
  - Status: Recommended
- [LOW] `_warnedVehicles` Set is unbounded — js/api.js:36-42 — over a long-running session, any churn in vehicle ids accumulates entries forever. Realistic ceiling is small (Metro fleet ~few thousand) so not urgent.
  - Recommendation: cap to e.g. 500 entries and drop the oldest, or clear hourly.
  - Status: Recommended
- [LOW] Inconsistent `directionId` coercion — js/api.js:91 vs js/tripUpdates.js:82-84 — vehicles forward `directionId` raw (with `?? null`); trip-updates wrap in `Number(...)`. Downstream code can see string vs number. Minor.
  - Recommendation: pick one (Number-coerced with explicit null sentinel).
  - Status: Recommended
- [INFO] Adding ad-hoc properties (`_lastMessageAt`, `_deliberateReconnect`) to `WebSocket` instances works but isn't ideal. A small wrapper object keyed by url in `_activeSockets` would be cleaner. Non-blocking.

## Findings — Performance
- [INFO] Hot path is well-shaped: a single allocation per frame (the `feature`), no JSON re-stringification, no array spreads in steady state. The `[...]` rebuild for `_pendingByVehicle` happens only on visibility-restore.
- [INFO] `drainPending` chunks by 25 with `requestIdleCallback` — sensible for backlog after long hide.
- [LOW] In `processUpdate`, `list.findIndex(...)` is O(n) per frame — fine for typical per-stop list size (≤ a handful). No action needed unless instrumentation later shows it as hot.
- [LOW] `setVisibleInterval` prune walks every key in `masterArrivalsData` and rebuilds each list with `.filter().set(...)` even when nothing is stale. Could short-circuit when `list.every(a => a.arrivalUnix > now - 60)` to avoid allocation. Micro-optimization only.

## Findings — Security / Privacy
- [INFO] WebSocket TLS is browser-handled (`wss://`). Origin check is server-side; nothing to do client-side.
- [INFO] `JSON.parse` is inside a try/catch in both files — safe.
- [LOW] `trip_id` (untrusted) is set via `el.setAttribute('data-trip', trip_id)` in markers.js — `setAttribute` is safe (no script context); this scope is clean. Out-of-lane re: any innerHTML usage of trip_id.
- [INFO] No PII in feed; vehicle ids are public.

## Findings — Documentation / JSDoc
- [LOW] `processAndUpdate` lacks a JSDoc block — js/api.js:44 — only inline comments describe it. Public-ish helper used in tests.
  - Recommendation: add a 2-line JSDoc covering the GTFS-RT input shape and validation gates.
  - Status: Recommended
- [INFO] `tripUpdates.js` header doc is good; module exports `tripTerminusByTripId` and `processUpdate`, both annotated.
- [LOW] Dedup-key contract isn't documented in `processUpdate` — js/tripUpdates.js:106 — currently `(vehicleId, routeId)`. A vehicle that swaps trips mid-block (rare) would overwrite, not append. Worth a one-liner.
  - Recommendation: add inline comment naming the dedup key.
  - Status: Recommended

## Suggestions (non-defect improvements)
- Mirror the inbound watchdog from `api.js` into `tripUpdates.js`. Trip updates have lower cadence than positions but a 5-minute silent watchdog would still beat OS-level TCP timeouts.
- Expose `closeAll()` from `tripUpdates.js` for tests and (eventually) HMR.
- Consider keying `_pendingByVehicle` by `vehicleId + routeId` for the same reason the dedup key uses both — paranoid but cheap.

## Findings out-of-lane (for other units)
- Unit (markers/popups): `getPopupHTML(... trip_id ...)` should be checked to confirm `trip_id` is HTML-escaped before insertion. setAttribute usage in markers.js:396 is safe; innerHTML callers may not be.
- Unit (predictions): `predictions.js` consumes the `lastIngestUnix` field added by this module — confirm staleness logic uses it.

## Inline fixes applied in this PR
- api.js: switched `parseInt(v.timestamp)` to `Number(v.timestamp)` to drop the missing-radix smell and accept numeric inputs cleanly.
- tripUpdates.js: log non-SyntaxError exceptions in the WS onmessage catch instead of swallowing all errors.
- tripUpdates.js: defensively normalize ms-since-epoch arrival times to seconds before the past-drop, mirroring the existing vehicle-timestamp guard in api.js.

## Test impact
- npm test: pass before / pass after (run pending — see below).
- New/changed tests: none. Existing tests/api.test.js coverage of timestamp normalization (`converts millisecond timestamps to seconds`, `keeps second-resolution timestamps untouched`, and non-numeric drop) exercise the changed `Number()` path. Existing tripUpdates tests still cover the past-arrival drop and the new ms-normalization path is dominated by a constant.

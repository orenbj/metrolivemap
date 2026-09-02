# docs/audits — point-in-time review reports

Focused reviews of a slice of the app (UX surface, code simplicity, runtime
automations, …). Each is a snapshot of the findings at the time it was written —
like [`docs/_archive/`](../_archive/), **audits are not rewritten after the
fact.** When an audit's recommendations land, the durable outcome belongs in
[`CLAUDE.md`](../../CLAUDE.md) (the contract) or [`docs/STATUS.md`](../STATUS.md)
(the snapshot); the audit itself stays here for provenance.

**Lifecycle:** an audit is *Open* while its findings are un-triaged, *Actioned*
once they're implemented or moved into the backlog, *Reference* once it's been
reviewed and its findings are informational only (not being actively tracked
for further action), and may be moved to `docs/_archive/` once fully
superseded. Keep the Status column current.

| File | What it reviews | Status |
|---|---|---|
| [`full-app-review-2026-09-02.md`](./full-app-review-2026-09-02.md) | Whole application, ten dimensions: rider UX/mobile, motion, ETA/feed data, station popup, badges/bridges, security/privacy, a11y, performance/resilience, secondary features, CI/pipeline/tests, docs. Every finding independently reproduced or refuted before listing. 63 confirmed (7 high, 38 medium, 18 low), 2 plausible, 21 unverified low/cosmetic. | **Open** — awaiting triage. No live-site capture ran (see "Honest limits"). |
| [`dist-automations-review-2026-06-16.md`](./dist-automations-review-2026-06-16.md) | Browser-side runtime automations (alerts proxy, timers, SW, geolocation, localStorage). Findings D1–D4. Framed around the "dist" bundle, since removed — but the findings are about the app's `js/` and still apply. | **Actioned** — D1 in `config.js` + `HANDOFF.md` §12.2; D2 (#523) + D3 (#524) shipped; D4 kept as intentional forensics. |
| [`app-chrome-ux-audit-2026-06-16.md`](./app-chrome-ux-audit-2026-06-16.md) | App chrome / control surfaces UX. | **Actioned** (#516/#517 + follow-ups) — C1, C2, A1, A2, A3, E1, E2, R1, R3, R5 done; R2 skipped by owner call, R4 non-issue; remaining: layer-toggle "on" cue, dashed alert separator, search outside-click focus-restore, R1/R5 live-device verification. |
| [`simplicity-audit-2026-06-14.md`](./simplicity-audit-2026-06-14.md) | Code simplicity / reuse opportunities. | **Actioned** — all seven Tier-1 de-dups resolved: `cubicInOutEase()` extracted (S1, `markers.js`); `FALLBACK_ROUTE_COLOR` centralized in `config.js` (S2); bike amenity colors share `BIKE_COLORS` from `config.js` (S3); `WS_PING_INTERVAL_MS` centralized in `config.js` (S4); `RAIL_CARDINAL_SORT` hoisted to module scope in `stations.js` (S5); `_cardinalHTML()` helper extracted in `stations.js` (S6); `_isJLineOnly` now keys off `ROUTE_LETTER` instead of hardcoded route codes (S7). Tiers 2–3 (optional/deferred by the audit itself) not re-verified. |
| [`station-popup-ux-audit-2026-06-12.md`](./station-popup-ux-audit-2026-06-12.md) | Station arrivals popup UX. | Reference. F2 (nearby-bus cap selecting by route number instead of soonest) already fixed, and per the audit's own 2026-06-12 post-review addendum the 6-route cap was subsequently removed entirely — see the `NEARBY_BUS_MAX_ROUTES` comment in `stations.js`. |
| [`tooltip-surfaces-ux-audit-2026-06-12.md`](./tooltip-surfaces-ux-audit-2026-06-12.md) | Tooltip/popup surfaces consistency across vehicle / station / bikeshare / micro / legend. | Reference. |

# docs/_archive — historical audits & retired-design specs

Point-in-time documents kept for provenance. **Archives are not rewritten** —
each file reflects the understanding at the time it was written. For the
current contract (motion model, feed-data gates, freshness tiers), always read
[`CLAUDE.md`](../../CLAUDE.md); for the current snapshot,
[`docs/STATUS.md`](../STATUS.md).

| File | What it is | Status |
|---|---|---|
| [`alert-copy-audit-2026-05.md`](./alert-copy-audit-2026-05.md) | Audit of Metro-authored alert prose → the render-time normalization rules now in `js/alerts.js`. | Implemented (linked from STATUS.md) |
| [`blend-tuning-2026-05.md`](./blend-tuning-2026-05.md) | ETA calc/GTFS-RT blend-weight tuning analysis. | Reference (linked from `js/config.js`, `js/predictions.js`) |
| [`math-audit-deferred.md`](./math-audit-deferred.md) | Math/logic audit; deferred recommendations. | Several items superseded by the DR removal (PR #257). |
| [`trajectory-overhaul.md`](./trajectory-overhaul.md) | Plan for a single-source-of-truth trajectory model (`USE_TRAJECTORY_MODEL`). | **Superseded — never shipped.** Replaced by bounded arc-glide (PR #257). |
| [`phase-5-wiring.md`](./phase-5-wiring.md) | Companion seam-map for the trajectory-overhaul plan. | **Superseded** with its parent plan. |
| [`phase-5b-anchor-animation.md`](./phase-5b-anchor-animation.md) | Blend-anchored animation experiment. | **Reverted** (PR #198). |

> **Why these stay:** the trajectory/phase-5 cluster describes the pre-PR-#257
> dead-reckoning architecture and an abandoned rewrite. None of the `js/` files
> they reference (`trajectory.js`, `dwellModel.js`, `scheduleCalibration.js`,
> the `USE_TRAJECTORY_MODEL` flag, …) exist anymore. They are retained as
> cautionary design history — **do not** treat them as roadmaps or as accurate
> descriptions of the current codebase.

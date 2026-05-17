# Blend-constant tuning sweep — 2026-05

Generated 2026-05-17 from `scripts/blend-tuning.mjs`. Offline replay of
captured live-accuracy artifacts against varied blend constants. **No
production code change in this PR.** Applying any recommendation below is
a follow-up decision PR.

---

## Methodology

- **Source:** 15 `.jsonl` artifacts downloaded from the
  `live-accuracy.yml` GitHub Actions workflow (run IDs span 2026-05-12 to 2026-05-17).
- **Rows analyzed:** 57954 snapshots where BOTH `calcEta` and `gtfsEta` are non-null
  (the only rows where blend has a meaningful choice to make).
- **Replay:** for each row we call a script-local copy of `_blendArrivals` with
  varied constants and compute `blendErr = actualUnix - blend`.
- **One-at-a-time (OAT) sweep:** five constants held at production values, the
  sixth varied across the candidate list. Reported per-value: n, MAE, RMSE,
  within30s%, within60s%, delta vs production-baseline MAE.
- **Combined-best:** the best OAT value for each constant taken together as
  one config, scored against production. If the combined improvement exceeds
  the sum of OAT improvements, the constants interact (expected).

### Limitations

- Offline replay only. No second-order effects — riders don't see the
  proposed blend, so we have no rider-perception measurement.
- Mixed weekday/weekend pooling. Metro service is structurally different on
  weekends (lighter headways, less rush-recovery operator pressure); a
  constant optimal on one may not be optimal on the other.
- `calcEta` in the captures was produced by the calc pipeline AT CAPTURE TIME
  with whatever `scheduleCalibration` multiplier was learned then. Re-running
  with a different multiplier would change `calcEta` upstream — but that's a
  separate tuning surface and outside this sweep.
- Sample size per bucket varies. The <30s and 15+ min buckets are thinner
  than the 1-2 min and 2-5 min buckets; small absolute MAE deltas in the
  thin buckets shouldn't be over-read.

---

## Production baseline

Production blend constants today:

```js
BLEND_HORIZON_NEAR_S       = 60
BLEND_HORIZON_MID_S        = 300
BLEND_WEIGHT_NEAR          = 0.7
BLEND_WEIGHT_MID           = 0.9
BLEND_DISAGREEMENT_SOFT_S  = 60
BLEND_DISAGREEMENT_HARD_S  = 180
```

**Baseline error stats on the analyzed subset:** n=57954, MAE=24.5s,
RMSE=39.45s, within30s=76.2%, within60s=89.9%.

---

## Per-constant OAT sweeps

### `horizonNearS` (production = 60)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 30 ←best | 57954 | 24 | 39.54 | 76.2% | 89.7% | -0.50s |
| 45 | 57954 | 24.26 | 39.48 | 76.2% | 89.8% | -0.24s |
| 60 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 75 | 57954 | 24.7 | 39.42 | 76.1% | 90% | +0.20s |
| 90 | 57954 | 24.85 | 39.4 | 75.9% | 90.1% | +0.35s |
| 120 | 57954 | 25.02 | 39.35 | 75.7% | 90.2% | +0.52s |

**Best OAT value:** `horizonNearS = 30` (MAE Δ -0.50s vs production).

### `horizonMidS` (production = 300)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 180 | 57954 | 24.56 | 39.57 | 76.2% | 89.9% | +0.06s |
| 240 | 57954 | 24.51 | 39.47 | 76.2% | 90% | +0.01s |
| 300 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 420 | 57954 | 24.5 | 39.44 | 76.2% | 89.9% | (current) |
| 600 | 57954 | 24.5 | 39.43 | 76.2% | 89.9% | (current) |

**Best OAT value:** `horizonMidS = 300` (MAE Δ +0.00s vs production).

### `weightNear` (production = 0.7)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 0.5 | 57954 | 26.67 | 40.3 | 71.1% | 90.2% | +2.17s |
| 0.6 | 57954 | 25.51 | 39.75 | 75.1% | 90.1% | +1.01s |
| 0.7 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 0.8 | 57954 | 23.73 | 39.39 | 76.2% | 89.7% | -0.77s |
| 0.9 ←best | 57954 | 23.37 | 39.59 | 75.9% | 89.5% | -1.13s |
| 1 | 57954 | 23.78 | 40.04 | 75.3% | 89.2% | -0.72s |

**Best OAT value:** `weightNear = 0.9` (MAE Δ -1.13s vs production).

### `weightMid` (production = 0.9)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 0.8 | 57954 | 24.65 | 39.15 | 76.1% | 90.2% | +0.15s |
| 0.85 | 57954 | 24.54 | 39.27 | 76.2% | 90.1% | +0.04s |
| 0.9 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 0.95 | 57954 | 24.57 | 39.69 | 76.2% | 89.8% | +0.07s |
| 1 | 57954 | 24.74 | 39.99 | 76.3% | 89.8% | +0.24s |

**Best OAT value:** `weightMid = 0.9` (MAE Δ +0.00s vs production).

### `disagreementSoftS` (production = 60)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 30 ←best | 57954 | 24.11 | 39.46 | 76.3% | 89.8% | -0.39s |
| 45 | 57954 | 24.31 | 39.45 | 76.3% | 89.9% | -0.19s |
| 60 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 90 | 57954 | 24.83 | 39.48 | 75.6% | 90.1% | +0.33s |
| 120 | 57954 | 25.04 | 39.5 | 74.7% | 90.2% | +0.54s |

**Best OAT value:** `disagreementSoftS = 30` (MAE Δ -0.39s vs production).

### `disagreementHardS` (production = 180)

| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |
|------:|--:|----:|-----:|----------:|----------:|-------------:|
| 120 ←best | 57954 | 24.34 | 39.74 | 76% | 89.7% | -0.16s |
| 150 | 57954 | 24.43 | 39.57 | 76.1% | 89.8% | -0.07s |
| 180 ←current | 57954 | 24.5 | 39.45 | 76.2% | 89.9% | (current) |
| 240 | 57954 | 24.63 | 39.27 | 76.2% | 90.1% | +0.13s |
| 300 | 57954 | 24.74 | 39.21 | 75.9% | 90.2% | +0.24s |

**Best OAT value:** `disagreementHardS = 120` (MAE Δ -0.16s vs production).

---

## Combined-best config

Taking the OAT-best value for each constant simultaneously:

| Constant | Production | Combined-best |
|----------|-----------:|--------------:|
| `horizonNearS` | 60 | 30 |
| `horizonMidS` | 300 | 300 |
| `weightNear` | 0.7 | 0.9 |
| `weightMid` | 0.9 | 0.9 |
| `disagreementSoftS` | 60 | 30 |
| `disagreementHardS` | 180 | 120 |

**Combined-best error stats:** n=57954, MAE=23.56s,
RMSE=40.03s, within30s=75.5%, within60s=89.2%.

**Overall MAE delta vs production:** -0.94s 
(improvement).

---

## Per-bucket cross-tab (production vs combined-best)

Same data, bucketed by GTFS horizon. A combined-best that improves overall
MAE but regresses a specific bucket should be looked at carefully — rider
perception is bucket-local (the <60 s bucket is when riders are watching the
countdown most intently).

### Production

| Bucket | n | MAE | within60s |
|--------|--:|----:|----------:|
| < 30 s | 14206 | 16.02 | 96.6% |
| 30-60 s | 13948 | 20.51 | 94.2% |
| 1-2 min | 18277 | 24.55 | 89.1% |
| 2-5 min | 11306 | 39.04 | 78.3% |
| 5-10 min | 210 | 74.98 | 55.2% |
| 10-15 min | 4 | 60.71 | 50% |
| 15+ min | 1 | 134.17 | 0% |

### Combined-best

| Bucket | n | MAE | within60s |
|--------|--:|----:|----------:|
| < 30 s | 14206 | 13.64 | 95.5% |
| 30-60 s | 13948 | 18.59 | 92.8% |
| 1-2 min | 18277 | 24.69 | 89% |
| 2-5 min | 11306 | 39.33 | 78% |
| 5-10 min | 210 | 74.98 | 55.2% |
| 10-15 min | 4 | 60.71 | 50% |
| 15+ min | 1 | 134.17 | 0% |

---

## Replay-guard sanity

The stale-replay heuristic (`replayNearS=300`,
`replayRatio=2`, `replayPadS=60`)
fires when `calcHorizon < replayNearS` AND `gtfsHorizon > replayRatio × calcHorizon + replayPadS`.

**Fired on 207 of 57954 rows (0.36%).**

Fires on under 0.5% of rows. Effect on overall stats is small either way.
Leave the constants alone; revisit only if a captured WS-reconnect window
shows the guard mis-firing.

---

## Recommendation

**Confidence call:** mixed signal — MAE improves by 0.94 s but the within60s% rate at <60 s horizon degrades. The MAE win comes from tighter mean error on accurate-GTFS rows; the within60s loss is wider tails on edge-case rows. Rider-perception tradeoff — depends on whether "popup is right within a minute" matters more than "popup is right on average".

The combined-best config improves MAE by 0.94 s but
degrades within60s% in the <30 s or 30-60 s buckets. Two reasonable choices:

1. **Apply only the constants whose individual sweep cleanly helped without
   bucket regression** — see the per-constant tables above and the bucket
   cross-tab for which constants drive the within60s loss.
2. **Keep production as-is.** within60s% ("popup is right within a minute")
   is closer to what riders actually perceive than MAE — degrading it for
   a sub-1 s mean improvement is probably the wrong trade.

The data does NOT support an "auto-apply combined-best" decision. Worth a
human read of the bucket cross-tab before any constants are changed.

---

## Reproducing

```bash
# Download recent live-accuracy artifacts:
gh run list --workflow=live-accuracy.yml --limit 30 \
  --json databaseId,createdAt,conclusion \
  --jq '.[] | select(.conclusion=="success") | .databaseId' \
  | while read id; do
      gh run download "$id" --dir "/tmp/blend-tuning/$id"
    done

# Run the sweep:
node scripts/blend-tuning.mjs \
  --input /tmp/blend-tuning \
  --output docs/blend-tuning-2026-05.md
```

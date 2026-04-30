# Arrival Time Prediction Methodology

## Executive Summary

The Metro Live Map predicts vehicle arrivals using **GTFS-RT Next Stop data** as the primary ETA anchor:

1. **Next Stop ID** — which stop each vehicle is at/heading to (from GTFS-RT VehiclePositions)
2. **Schedule gap** — time between that stop and the target stop (from GTFS static data)
3. **GTFS-RT override** — trust Metro's feed by default, override only when proven to lag

This is simpler, more reliable, and matches how transit agencies actually predict arrivals.

---

## Algorithm

### Step 1: Locate Vehicle in Trip

Use GTFS-RT `stopId` field (Next Stop) instead of deriving from GPS.

```javascript
reportedStopId = String(marker.properties.stopId ?? '');
currentStopIdx = trip.stops.indexOf(reportedStopId);
// If stopId not found in trips.json: fallback to arc-based inference (rare)
```

**Why?** The agency's feed already knows where the train is. Stop Index comparison is unambiguous (integer `<`, `==`, `>`).

---

### Step 2: Filter Already-Passed Vehicles

```javascript
hasPassed = targetStopIndex < currentStopIdx;
```

No GPS snap, no arc math, no buffer arithmetic. Just array indices.

---

### Step 3: Compute ETA — Schedule Gap

```javascript
// Scheduled time from current stop to target stop
currentSchedSec = trip.scheduledTimes[currentStopIdx];
targetSchedSec  = trip.scheduledTimes[targetStopIndex];

// ETA = now + (scheduled minutes between stops)
eta = now + (targetSchedSec - currentSchedSec);
```

This is exactly "scheduled gap" applied to real time now. Works for any distance (1 stop or 10 stops away).

**Sanity check:** If vehicle is >30 min off its own schedule, the timetable is blown (short-turn, express, intervention). Fall back to geometric.

---

### Step 4: Fallback — GPS Arc Bracket (Next Stop ID Not Found)

When `reportedStopId` isn't in `trips.json`, snap vehicle to polyline and use `findScheduleBracket` to interpolate scheduled time at the arc position, then compute delay and project forward.

This is slower and noisier, but only fires when the primary method fails.

---

### Step 5: ETA Smoothing (EMA)

Apply exponential moving average (α=0.3) to suppress GPS noise on repeated lookups, except within 2 minutes of arrival (precision > smoothness).

---

### Step 6: Monotonicity Enforcement

Rule: for a given vehicle, downstream stops must never show earlier arrival than upstream stops.

Conservative floor: 30 seconds per stop.

---

### Step 7: Merge with GTFS-RT (Audit Logic)

```javascript
if (!baseArrival) {
    // Ghost Arrival: vehicle on map, not in feed
    use liveEta;
} else {
    const stale = baseArrival.arrivalUnix < now;
    const liveIsEarlier = liveEta < baseArrival.arrivalUnix;
    const diff = abs(baseArrival.arrivalUnix - liveEta);
    
    if (stale || (diff > 240 sec && liveIsEarlier)) {
        // Override: Metro's feed is lagging or stale
        use liveEta;
    } else {
        // Trust Metro's feed
        use baseArrival.arrivalUnix;
    }
}
```

**Why only override when live is EARLIER?**
- Metro's GTFS-RT is smoothed, network-aware → generally accurate
- Our model is simpler → noisier on edge cases
- If live says 10m and Metro says 8m → Metro likely correct
- If live says 3m and Metro says 8m → we see reality, Metro has lagged
- Threshold: 240 seconds (4 min) prevents micro-oscillations

---

## Debug Display

**Each arrival shows two sources:**

```
~4m
10:32 AM
feed: 8m
calc: 4m
```

- **feed:** Raw GTFS-RT TripUpdate (agency authority)
- **calc:** Live estimate (schedule gap or arc bracket)
- Ghost arrivals show `feed: —`

**Use case:** If feed shows 8m but calc shows 3m, Metro's feed is lagging.

---

## Key Parameters

| Name | Value | Purpose |
|------|-------|---------|
| `MAX_VALID_DELAY_SEC` | 1800 | If delay exceeds ±30 min, timetable is blown → use geometric fallback |
| `SPEED_EMA_ALPHA` | 0.3 | Speed smoothing (3-tick trailing) |
| `ETA_EMA_ALPHA` | 0.3 | ETA output smoothing |
| `ETA_EMA_NEAR_SEC` | 120 | Skip EMA if <2 min away (precision mode) |
| `ETA_EMA_MAX_AGE_SEC` | 30 | Cold-start EMA if sample >30s old |
| `AUDIT_TOLERANCE_SEC` | 240 | Override threshold (live must beat Metro by 4m) |
| `MIN_INTER_STOP_SEC` | 30 | Monotonicity floor per stop |
| `ARC_SANITY_RATIO` | 4 | Snap fallback if arc distance >4× planar |
| `BUS_CURVATURE_FACTOR` | 1.3 | Planar distance multiplier for buses |

---

## Testing Checklist

- [ ] Train visibly at a station shows ~correct ETA
- [ ] Same 2 trains appear at consecutive stations with decreasing ETAs
- [ ] No "Now" arrivals for trains that are 30+ min away
- [ ] Debug display shows feed/calc explaining discrepancies
- [ ] Multi-stop station groups show monotonic increasing ETAs
- [ ] ETA pill decreases smoothly (no ±1m jump)
- [ ] Route 950 (no schedule) shows reasonable estimates
- [ ] Ghost arrivals show `feed: —`

---

## Why This Works

**Conceptual simplicity:** For each station, the train's current position is exactly which stop it's at (from GTFS-RT). The time to the target stop is exactly the schedule gap between those two stops.

No GPS snap fragility at curves. No arc direction inference from config labels. No distance weighting. No blending sources. Just: current stop index, target stop index, schedule gap.

**Accuracy:** The schedule itself encodes all systemic delays baked into the timetable (dwell, signal holds, traffic patterns). We don't need to estimate them — we use them directly via the schedule gap formula.

**Consistency:** All trains on the same trip use the same schedule gaps. No per-vehicle anchor math. No geometric variation. Cross-station consistency is automatic.

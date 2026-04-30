# Arrival Time Prediction Methodology

## Executive Summary

The Metro Live Map predicts vehicle arrivals using a **schedule-based approach** that fuses two independent data sources:

1. **GTFS-RT TripUpdates** — LA Metro's real-time predictions (agency authority)
2. **Timetable-Based Live Tracking** — vehicle arc position + current delay offset

The engine **trusts Metro's feed by default** but **overrides with live estimates** when the feed is stale or the live model detects the agency's feed is lagging behind reality.

---

## Data Sources

### 1. GTFS-RT: Real-Time Agency Feed

**Source:** LA Metro WebSocket feeds (`wss://api.metro.net`)

**What it contains:**
- `VehiclePositions` — current lat/lon, bearing, stop ID, speed (for rail and bus routes 901, 910, 950)
- `TripUpdates` — predicted arrival time at each upcoming stop
- **Direction semantics:** rail uses direction_id 0/1; Metrolink excluded from hybrid logic

**Reliability:**
- Agency-authoritative — based on radio communication and real-time tracking
- Smoothed and filtered — reduces noise
- Network latency — may lag 15–45 seconds behind actual position
- Coverage — only vehicles Metro actively tracks

---

### 2. Live Timetable Tracking: Schedule + Arc Position

**Source:** Vehicle position + schedule from GTFS

**What it is:**
- Snap vehicle GPS to polyline → arc position in meters
- Look up where the trip's schedule bracket that arc position falls between two scheduled stops
- Interpolate scheduled time at that arc, compute delay
- Project delay forward to target stop using schedule

**Advantage:**
- Uses the agency's own timetable (official ground truth)
- Accounts for systemic delays (traffic, dwell, signal holds) baked into schedule variance
- Works equally well for stops 1 stop away or 10 stops away
- Unaffected by GPS noise — schedule-derived, not speed-estimated

**Limitation:**
- Requires shape data (polyline) and schedule data
- Off-route vehicles cannot be snapped
- ADDED/UNSCHEDULED trips unavailable

---

## Algorithm: Timetable-Primary, Geometric Fallback

### Step 1: Filter Already-Passed Vehicles

For each vehicle at each stop, check if the vehicle has already passed that station.

**Method:** Arc-based direction inference from trip's own stop sequence
```javascript
// Find first and last non-null arc positions in this trip's arc array
firstArc = trip._arcs[i] (first non-null)
lastArc = trip._arcs[j] (last non-null)

// Determine if trip travels with increasing or decreasing arc
incArc = firstArc < lastArc

// Vehicle has passed if arc is already beyond station's arc
hasPassed = incArc
    ? vSnap.arcMeters > stationArc.arcMeters + 300   // 300m buffer
    : vSnap.arcMeters < stationArc.arcMeters - 300;
```

**Why not use config direction labels?** The trip's own arc sequence is unambiguous and data-driven. Config labels (e.g., "Eastbound") can be misaligned with the stored polyline orientation, causing inverted filters.

---

### Step 2: Compute ETA — Timetable Primary

**If route has shape data and schedule:**
```javascript
// Snap vehicle to polyline
vSnap = snapToRoute(routeCode, lng, lat)
// → { arcMeters, tangentForward, ... }

// Find where on the schedule the vehicle currently sits
bracket = findScheduleBracket(trip, vSnap.arcMeters)
// → { i, j, frac } where vehicle is between stops i and j

// Interpolate scheduled time at vehicle's arc position
tSchedAtVehicle = scheduledTimes[i] + frac × (scheduledTimes[j] - scheduledTimes[i])

// Current delay: how late/early is the vehicle right now?
delay = now - (baseUnix + tSchedAtVehicle)

// If delay exceeds ±30 min, schedule is blown (short-turn, express, intervention)
if (|delay| > 1800 sec) return null  // Fall back to geometric

// Project delay to target stop: ETA = scheduled_time(target) + delay
timetableEta = baseUnix + scheduledTimes[targetStopIndex] + delay
```

**Why stateless (no per-vehicle history)?**
- Handles vehicles caught mid-block or just spawned mid-route
- Feed latency doesn't accumulate; each tick is a fresh snapshot
- No need to track stop-clearance events or historical delays

---

### Step 3: ETA Fallback — Geometric (Routes Without Schedule)

**If no schedule data or schedule is blown:**
```javascript
// Simple planar distance / smoothed speed
planarDist = planarMeters(vehicle.lat, vehicle.lng, station.lat, station.lon)
smoothedSpeed = (valid & reasonable) ? speed : fallback(isBus ? 8 : 12 m/s)
rawGeometric = now + planarDist / smoothedSpeed
```

**Applies to:** Route 950 (no shape data), ADDED trips, UNSCHEDULED trips

---

### Step 4: ETA Smoothing (EMA)

```javascript
// Exponential Moving Average: suppress GPS noise, stay responsive
// α = 0.3 (3-tick trailing smoothing)

// Special rules:
// - If <120 sec away: skip EMA (precision > smoothness)
// - If last sample >30 sec old: cold-start (discard stale history)
```

---

### Step 5: Monotonicity Enforcement

```javascript
// Rule: for a vehicle, downstream stops must never show earlier arrival than upstream
// Conservative floor: 30 seconds per stop

floor = max(priorETAStops) + (stopIndex - priorIndex) × 30 sec
result = max(etaUnix, floor)
```

---

### Step 6: Merge with GTFS-RT (Audit Logic)

```javascript
baseArrival = masterArrivalsData.get(vehicleId, stopId)

if (!baseArrival) {
    // Ghost Arrival: vehicle on map, not in feed
    → use liveEta, isLiveEstimate = true
} else {
    const stale = baseArrival.arrivalUnix < now
    const liveIsEarlier = liveEta < baseArrival.arrivalUnix
    const diff = abs(baseArrival.arrivalUnix - liveEta)
    
    if (stale || (diff > 240 sec && liveIsEarlier)) {
        // Override: Metro's feed is lagging or stale
        → use liveEta, isLiveEstimate = true
    } else {
        // Trust Metro's feed
        → use baseArrival.arrivalUnix, isLiveEstimate = false
    }
}
```

**Why only override when live is EARLIER?**
- Metro's GTFS-RT is smoothed and network-aware → generally accurate for far-out predictions
- Our model depends on GPS snapping, schedule variance → noisier for nearby stops
- If live says 10m and Metro says 8m → Metro likely correct (we're noisy)
- If live says 3m and Metro says 8m → we probably see reality, Metro has lagged
- Threshold: 240 seconds (4 min) prevents micro-oscillations

---

## Debug Display: Two Sources

**Each arrival shows:**
```
~4m
10:32 AM
feed: 8m
calc: 4m
```

- **feed:** Raw GTFS-RT TripUpdate (agency authority)
- **calc:** Live timetable or geometric estimate
- Ghost arrivals show `feed: —`
- Routes without schedules show `calc: —` if geometric fallback used

**Use case:** Diagnosing discrepancies. If feed shows 8m but calc shows 3m, Metro's feed is lagging behind the train's real position.

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

- [ ] Train visibly at a station shows ~2–4m ETA
- [ ] Same 2 trains appear at consecutive B Line stations with decreasing ETAs
- [ ] No "Now" arrivals at stations train has already cleared
- [ ] Debug display shows feed/calc explaining discrepancies
- [ ] Multi-stop station groups show monotonic increasing ETAs
- [ ] ETA pill decreases smoothly over 60 seconds (no ±1m jump)
- [ ] Route 950 (no schedule) shows reasonable planar-based ETAs
- [ ] Ghost arrivals show `~Xm` badge and `feed: —`

---

## Summary

**Conceptual model:** For each station, find the trains that are upstream (haven't passed yet) in the direction they're traveling. Use the schedule to compute the time gap from the vehicle's current arc position to the target station.

**Implementation:**
1. Snap vehicle to polyline → arc position
2. Interpolate scheduled time at that arc position
3. Compute delay = now - scheduled_time(arc)
4. ETA = scheduled_time(target) + delay
5. Fallback to geometric (planar / speed) for routes without schedule data
6. Trust Metro's GTFS-RT by default; override only when live model proves Metro has lagged
7. Smooth output with EMA; enforce monotonicity across stops

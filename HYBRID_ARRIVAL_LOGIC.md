# Hybrid Arrival Prediction Engine

## Overview

The livemap's arrival predictions fuse two data sources:

1. **GTFS-RT TripUpdates** — LA Metro's official real-time feed with agency-provided ETAs (authority source)
2. **Geometric ETA** — Our GPS-based position tracking and distance calculation (ground truth sensor)

The engine computes a **hybrid ETA** for each vehicle at each stop by resolving conflicts between these sources using asymmetric audit logic: we override GTFS-RT *only* when our geometric model proves Metro's feed is stale or lagging behind the train's actual position.

---

## Data Pipeline

### 1. Data Loading (main.js)

At startup, three datasets load in parallel:
- `stops.json` → `window.masterStopsData` — keyed by stopId, contains lat/lon/name
- `trips.json` → `window.masterTripsData` — keyed by tripId, contains rc (route_code), dir (direction_id), stops[] array
- `rail-shapes.json` → `shapeData` (in snap.js) — keyed by route_code, contains polyline vertices [lat, lng]

After these load, `precomputeStationArcs()` runs once:
- For each (route, stop) pair appearing in trips, snap the stop to that route's polyline
- Cache the arc distance in `stationArc` Map, keyed by `"routeCode|stopId"`
- This gives predictions.js O(1) lookup of each station's position along the track

### 2. Live Vehicle Tracking (markers.js + api.js)

WebSocket feeds stream vehicle position updates from LA Metro:
- **Rail (LACMTA_Rail/vehicle_positions)** — position, bearing, direction_id, stopId (next/current stop)
- **Bus (LACMTA/vehicle_positions)** — routes 901, 910, 950
- **Metrolink** — separate feed, excluded from hybrid ETA logic (uses different direction_id semantics)

Each update creates a marker at `markers[vehicleId]` with properties:
- `route_code`, `trip_id`, `direction_id`
- `stopId` — the GTFS-RT current or next stop (used to locate vehicle in trip sequence)
- `speed` — meters per second from GPS
- `lastStopSequence` — 1-indexed stop sequence number from GTFS-RT (deprecated; see note below)

### 3. Real-Time Arrivals (tripUpdates.js)

GTFS-RT TripUpdates stream arrival predictions from Metro:
- For each (stop, vehicle, route, direction), store `{ arrivalUnix, directionId, vehicleId, routeId, tripId }`
- Accumulate in `window.masterArrivalsData` Map, keyed by stopId
- This is the **baseline** data source — authoritative for known vehicles

---

## Core Algorithm: getHybridArrivals(stopId)

Called by UI to fetch all predicted arrivals at a given stop. Returns a sorted array of hybrid arrivals per vehicle.

### Step 1: Resolve Vehicle Position in Trip

For each live marker (vehicle on the map):

```
currentSequenceIndex = trip.stops.indexOf(marker.stopId)
```

**Why `stopId` and not `lastStopSequence - 1`?**
GTFS `stop_sequence` values are not guaranteed to be consecutive (LA Metro uses gaps like 10, 20, 30...).
Using `sequence - 1` as an array index is unreliable and silently breaks on routes with non-consecutive sequences.
Instead, we look up the vehicle's reported current/next stop directly in the trip's stop array.
Fallback: index 0 if stopId is missing from the trip.

### Step 2: Skip Vehicles Outside Trip Scope

```
targetStopIndex = trip.stops.indexOf(stopId)

if (targetStopIndex === -1)                          → stop not on this trip, skip
if (targetStopIndex < currentSequenceIndex)          → vehicle already passed stop, skip
```

### Step 3: Compute Distance

#### 3a. Arc Distance (True Track Distance)

If the route has shape data (`shapeData[route_code]`):

1. **Snap the vehicle** to the polyline (cached per tick to deduplicate across multi-stop queries):
   ```
   vehicleArc = snapToRoute(route_code, vehicleCoords) → arcMeters
   ```

2. **Look up the station's arc position**:
   ```
   stationArc = stationArc.get("routeCode|stopId") → arcMeters
   ```

3. **Compute distance**:
   ```
   arcDistRaw = |stationArc.arcMeters - vehicleArc.arcMeters|
   ```

4. **Sanity check** — if arc distance is >4× planar distance, snap likely hit wrong segment; fall back to planar + curvature:
   ```
   if (arcDistRaw > planarDistance * 4)
       distanceMeters = planarDistance * (isBus ? 1.3 : 1.2)
   else
       distanceMeters = arcDistRaw
   ```

#### 3b. Planar Distance (Fallback)

For routes without shape data (e.g., route 950):
```
distanceMeters = planarMeters(vehicle, station) * (isBus ? 1.3 : 1.2)
```

The 1.3x/1.2x factors account for track curvature when snapping is unavailable.

### Step 4: Compute Speed

Get the vehicle's smoothed speed via exponential moving average (EMA):

```
smoothedSpeed = smoothedSpeed(vehicleId, rawGpsSpeed)
```

**EMA details:**
- Coefficient α = 0.3 (standard "3-tick" trailing smoothing)
- Valid range: 1–35 m/s (ignores idle noise < 1 m/s, GPS spikes > 35 m/s)
- Invalid samples hold the previous EMA without updating
- If no history exists, use route average: 12 m/s (rail) or 8 m/s (bus)
- Floor: at least 3 m/s (bus) or 4 m/s (rail) to avoid division by near-zero when crawling

**Why EMA?**
Raw GPS speeds jump ±1 m/s every tick due to measurement noise, especially at traffic lights and station dwells. EMA smooths these spikes while staying responsive to real speed changes.

### Step 5: Compute Base ETA

```
intermediateStops = targetStopIndex - currentSequenceIndex
dwellPenalty = intermediateStops * 25 seconds per stop

timeToArrival = distanceMeters / smoothedSpeed (in seconds)
rawEtaUnix = now + timeToArrival + dwellPenalty
```

**Dwell penalty:** 25 seconds per intermediate stop accounts for boarding/alighting time.

### Step 6: Temporal EMA Smoothing

Apply exponential moving average to the ETA itself (per-vehicle, per-stop):

```
geometricEtaUnix = smoothEta(vehicleId, stopId, rawEtaUnix, now)
```

**ETA EMA details:**
- Coefficient α = 0.3
- **Cold-start**: if last sample is >30 seconds old, discard history and use raw value
- **Near-arrival cutoff**: if arrival is within 120 seconds, skip EMA entirely (precision > smoothness)
- **History**: stored in `etaEma` Map, keyed by `"vehicleId|stopId"`

**Why separate from speed EMA?**
The speed EMA smooths the physics; the ETA EMA smooths the prediction output. Together they eliminate "pill jumping" (±1 minute oscillation every 5 seconds) while keeping near-arrival accuracy crisp.

### Step 7: Monotonicity Enforcement

Ensure that for a given vehicle, downstream stops never show earlier arrivals than upstream stops:

```
enforceMonotonicity(vehicleId, stopIndex, etaUnix)
```

For each prior stop seen this tick:
```
floor = max(priorEta + (stopIndex - priorIndex) * 30 seconds)
result = max(etaUnix, floor)
```

This prevents logical inversions (e.g., "7th/Metro in 4 minutes, Downtown LA in 3 minutes"). The 30-second floor is deliberately conservative — on LA Metro, correct ETAs increase ~67–190 seconds per stop, so this floor only triggers when something is genuinely wrong.

### Step 8: Merge with GTFS-RT

Retrieve the baseline arrival from Metro's feed:
```
baseArrival = masterArrivalsData.get(vehicleId, stopId)
```

**Audit logic:**

1. **If Metro's ETA is in the past** (stale feed):
   ```
   if (baseArrival.arrivalUnix < now)
       → use geometricEtaUnix, flag isLiveEstimate = true
   ```

2. **Else if geometric ETA is EARLIER by >240 seconds** (Metro lagging):
   ```
   if (abs(baseArrival.arrivalUnix - geometricEtaUnix) > 240s
       AND geometricEtaUnix < baseArrival.arrivalUnix)
       → use geometricEtaUnix, flag isLiveEstimate = true
   ```

3. **Else trust Metro** (our model is noisier):
   ```
   → use baseArrival.arrivalUnix, flag isLiveEstimate = false
   ```

**Why only override when geometric is *earlier*?**
- Metro's GTFS-RT feed is a smoothed real-time prediction from the agency — if it says a train arrives in 8 minutes, that's based on continuous tracking and radio communication
- Our geometric model is noisier — it depends on GPS accuracy (±5m typical), polyline snapping, and speed estimates
- If our model says 10 minutes and Metro says 8 minutes, Metro is likely correct and our estimate is noisy
- But if our model says 3 minutes and Metro says 8 minutes, we're probably right — Metro's feed has lagged behind the train's actual position

**Ghost Arrivals:**
If a vehicle is on the map but absent from Metro's feed:
```
→ create arrival with geometricEtaUnix, flag isLiveEstimate = true
→ include routeId, directionId, vehicleId, tripId
```

### Step 9: Garbage Collection

Periodically (every ~30 wall-clock seconds) prune stale entries:
```
prune():
  - etaEma: remove entries not seen in >120s
  - vehicleSpeedEma: remove entries not seen in >120s
  - vehicleSnapCache: remove entries from ticks >60 ticks old
  - vehicleTickEtas: remove entries from ticks >2 ticks old
```

---

## Data Structures

### Module State (predictions.js)

```javascript
vehicleSpeedEma
  Map<vehicleId, {ema: number, lastSeenSec: number}>
  
vehicleSnapCache
  Map<vehicleId, {tickId, arcMeters, routeCode}>
  
etaEma
  Map<"vehicleId|stopId", {etaUnix, lastSeenSec}>
  
vehicleTickEtas
  Map<vehicleId, {tickId, stops: Map<stopIndex, etaUnix>}>
```

### Pre-Computed Data (snap.js)

```javascript
stationArc
  Map<"routeCode|stopId", {arcMeters, snappedLat, snappedLng}>
  
shapeData
  {routeCode: [[lat, lng], ...]}
  
arcLengths
  {routeCode: Float64Array of cumulative distances}
```

---

## Key Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `SPEED_EMA_ALPHA` | 0.3 | GPS speed smoothing coefficient |
| `ETA_EMA_ALPHA` | 0.3 | ETA prediction smoothing coefficient |
| `ETA_EMA_NEAR_SEC` | 120 | Disable ETA EMA if <120s away (precision mode) |
| `ETA_EMA_MAX_AGE_SEC` | 30 | Cold-start EMA if sample >30s old |
| `SPEED_MIN_VALID` | 1 m/s | Reject GPS speeds below this (idle noise) |
| `SPEED_MAX_VALID` | 35 m/s | Reject GPS speeds above this (~78 mph spike) |
| `STATION_DWELL_PENALTY_SEC` | 25 | Seconds per intermediate stop |
| `ARC_SANITY_RATIO` | 4 | Fallback if arc distance > planar × this |
| `AUDIT_TOLERANCE_SEC` | 240 | Seconds to override Metro's ETA |
| `MIN_INTER_STOP_SEC` | 30 | Monotonicity floor per stop |
| `BUS_CURVATURE_FACTOR` | 1.3 | Planar distance multiplier for buses |
| `STATION_SNAP_MAX_M` | 250 | Max distance from polyline to cache station |

---

## Accuracy Notes

**Geometric ETA is more accurate when:**
- Vehicle is close (within 2–3 stops) where polyline snap is reliable
- Vehicle is moving at consistent speed (not stuck at lights)
- Route has shape data loaded (all Metro rail and bus lines 901/910)

**GTFS-RT is more accurate when:**
- Vehicle is far (>5 stops) where small snap errors compound
- Vehicle is in slow zone (downtown) where speed varies dramatically minute-to-minute
- Vehicle is on a route without shape data (route 950)

**The hybrid engine leans on GTFS-RT by default** (trust Metro unless we prove them wrong), but **steps in with live estimates** (Ghost Arrivals, stale feed override) when Metro can't keep up.

---

## Live Popup Refresh

Station popups refresh every 5 seconds (`POPUP_REFRESH_MS = 5000`) without requiring the user to close and reopen:

1. Interval calls `buildArrivalsHTML()`, which calls `getHybridArrivals()` for each stop in the group
2. Compares new HTML content against current DOM
3. If different, replaces the wrapper (avoids blink when unchanged)
4. On popup close, interval is cleared and entry is garbage collected

This keeps the `~Xm` pill honest — it ticks down as the vehicle approaches, not just as the clock advances.

---

## Testing Checklist

- [ ] Train visibly 1–2 stops away shows ~2–4m ETA (not 17m+)
- [ ] Trains already passed a station don't appear in arrivals
- [ ] Multi-stop station groups show monotonic increasing ETAs downstream
- [ ] Open popup, leave 60s; ETA pill decreases smoothly (no ±1m jump)
- [ ] Temporarily throttle network; ETA should not whipsaw
- [ ] Route 950 (no shape data) still shows reasonable planar-based ETAs
- [ ] Ghost Arrivals appear with `~Xm` badge when visible on map but absent from GTFS-RT
- [ ] Performance: 100+ vehicles on map, getHybridArrivals total time flat (per-tick snap cache working)

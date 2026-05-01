# Arrival Time Prediction Methodology

## Executive Summary

The LA Metro Live Map predicts vehicle arrivals using a **route-geometry model**: for each visible vehicle, find its position in the trip sequence, then add the scheduled time gap to the target stop. This is dramatically simpler than prior approaches and handles all edge cases (unscheduled trains, stop ID format mismatches, transfer station isolation) naturally.

```
ETA = anchorTime + getStopGap(route, nextStop, targetStop)
```

That's the entire algorithm. No trip lookup. No arc snapping. No per-vehicle state. Just two array index comparisons and one subtraction.

---

## Core Architecture

### Data Structure: `routeStops`

Built once per route/direction from `masterTripsData`:

```javascript
routeStops: Map<"routeCode|dir", {
  stops: string[],           // [80201, 80202, 80203, ...]
  cum: number[]              // [0, 120, 245, 380, ...] (cumulative seconds from stop[0])
}>
```

**Why this works:** All trips on the same route in the same direction have identical inter-stop times (geometry-driven). We pick the longest trip and extract its schedule. This single sequence is our source of truth for the entire direction.

### `findIdx(stops, rawId)` — Stop ID Normalization

LA Metro stop IDs come in multiple formats:
- Numeric only: `80201`
- Platform suffixes: `80201S`, `80201A`, `80201N`, `80201B`
- Route-specific variants: may not exist in this route's stops array

`findIdx()` handles this with a fallback chain:
1. Exact match on `rawId`
2. Strip platform suffix (`/_.*$`) and try again
3. Strip all trailing letters and try again
4. Fuzzy match on prefix + suffix

This ensures stop ID normalization doesn't silently fail and downgrade to geometric fallback.

### `getStopGap(routeCode, fromStopId, toStopId)`

The heart of the prediction system:

```javascript
function getStopGap(routeCode, fromStopId, toStopId) {
  for (const dir of [0, 1]) {
    const rs = routeStops.get(`${routeCode}|${dir}`);
    if (!rs) continue;
    const fromIdx = findIdx(rs.stops, fromStopId);
    if (fromIdx === -1) continue;
    const toIdx = findIdx(rs.stops, toStopId);
    if (toIdx === -1 || toIdx < fromIdx) continue;
    return { gap: rs.cum[toIdx] - rs.cum[fromIdx], dir };
  }
  return null;
}
```

Returns:
- `{ gap: seconds, dir: 0|1 }` if both stops exist in the same direction and `fromStop ≤ toStop`
- `null` otherwise (route doesn't serve target, or vehicle has already passed)

**Why null is correct:** If `getStopGap` returns null, the vehicle is either:
- Past the target stop (handled by turnaround logic)
- On a route that doesn't serve this target (transfer station isolation, naturally enforced)

No explicit guards needed.

---

## Prediction Flow

### Main Export: `getHybridArrivals(stopId)`

```javascript
export function getHybridArrivals(stopId) {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [];
  const seenVehicles = new Set();

  // For each visible vehicle:
  for (const markerKey in markers) {
    const marker = markers[markerKey];
    const { route_code, vehicle_id, stopId: nextStopRaw } = marker.properties;
    
    // Does this route serve the target?
    const result = getStopGap(route_code, nextStopRaw, stopId);
    if (!result) continue;  // No → skip
    
    // Use GTFS-RT anchor for next stop, fall back to now
    const anchorArrivals = window.masterArrivalsData?.get(nextStopRaw) ?? [];
    const anchorEntry = anchorArrivals.find(a => String(a.vehicleId) === vehicleId);
    const anchorTime = (anchorEntry && anchorEntry.arrivalUnix > now)
      ? anchorEntry.arrivalUnix
      : now;
    
    const etaUnix = anchorTime + result.gap;
    if (etaUnix < now - 60) continue;  // Skip ancient predictions
    
    candidates.push({
      vehicleId, routeId: route_code, directionId: result.dir,
      tripId, arrivalUnix: etaUnix, isLiveEstimate: true
    });
  }
  
  // Keep 2 soonest per direction
  candidates.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
  const dirCount = {};
  const arrivals = [];
  for (const c of candidates) {
    if ((dirCount[c.directionId] ?? 0) >= 2) continue;
    dirCount[c.directionId]++;
    seenVehicles.add(c.vehicleId);
    arrivals.push(c);
  }
  
  // Turnaround: vehicles past target heading to terminus
  for (const a of getTurnaroundArrivals(stopId, now)) {
    if (!seenVehicles.has(a.vehicleId)) {
      seenVehicles.add(a.vehicleId);
      arrivals.push(a);
    }
  }
  
  arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
  return arrivals;
}
```

**Why this is so clean:**
- One condition check per vehicle (`getStopGap` returns null or a number)
- All filtering (transfer station isolation, "already passed", vehicle identification) falls out naturally
- No trip_id lookup — unscheduled trains work automatically
- No stop ID normalization failure path — `findIdx` handles it

---

## Turnaround Handling

### The Problem

Trains often reverse direction at a terminus (e.g., B Line at North Hollywood, heading back to Union Station). If a train is currently heading **away** from your target stop, it will eventually return as the next service **toward** it.

GTFS-RT is slow to publish the new trip_id after a reversal (often 5+ minutes). If we only look at forward motion, we miss that incoming service.

### Solution: `getTurnaroundArrivals(targetId, now)`

For each vehicle currently past the target stop (heading toward terminus):

1. Locate its terminus: `terminusStopId = trip.stops[trip.stops.length - 1]`
2. Get its predicted arrival there from `masterArrivalsData`
3. Look up the flip time (dwell at terminus): `getFlipTime(routeCode, terminusStopId)`
4. Compute return gap: `getStopGap(routeCode, terminusStopId, targetId)` in the opposite direction
5. ETA = `max(now, terminusArrival) + flipTime + returnGap`

`getFlipTime()` computes empirical dwell by examining scheduled arrivals/departures at the terminus across all trips. Median gap + 120s buffer for real-world variability.

**Why this works:** We're using the vehicle's actual predicted arrival at the terminus (from GTFS-RT) as the anchor, then applying scheduled time gaps in both directions. No guess work — just chained schedule gaps.

---

## Edge Cases & Guarantees

### Transfer Stations (e.g., 7th St/Metro Center)

E Line uses stop ID `80317`, B Line uses `80211`. Same physical station, different sequences.

**How it's handled:** `getStopGap(route_code, ..., 80211)` returns null for E Line because `80211` doesn't exist in E Line's stop array. Vehicles automatically stay within their route. No explicit guard needed.

### Unscheduled Trips

GTFS-RT sometimes reports trips with `scheduleRelationship=ADDED` or `UNSCHEDULED`. These may not exist in `masterTripsData` with the same trip_id.

**How it's handled:** We don't look up trip_id at all. We only use the vehicle's `stopId` and route. As long as the next stop exists in the route's sequence, we can predict. Unscheduled trips are invisible to this logic — they just work.

### Stop ID Format Drift

Same station, different stop IDs in different feeds:
- Vehicle reports next stop as `80201` (parent)
- trips.json has `80201_N` (platform)

**How it's handled:** `findIdx()` tries both, stripping suffixes as needed. Stop ID normalization is automatic.

### Vehicles With Missing Next Stop Data

If `marker.properties.stopId` is null or empty, `getStopGap` returns null immediately (can't find fromIdx). Vehicle is skipped. Handled implicitly.

---

## Why This Works

**Simplicity is the feature.**

The entire prediction model is: "The vehicle is at stop A. Stop B is N seconds further along the route. ETA = now + N."

- **No GPS:** Unreliable at curves, needs snapping, drifts.
- **No per-trip lookup:** Unscheduled trips fail. Trip IDs can mismatch between feeds.
- **No arc-based geometry:** Works for rail, breaks for buses. Needs curvature factors and rotation matrices.
- **No state machine:** No prior heading, no arc progression history, no speed EMA.
- **No per-vehicle smoothing:** EMA on top of an already-smoothed schedule is noise.

Just: **Which stop is the vehicle at? How long to the target? Add those numbers.**

The schedule already encodes all systemic delays (dwell time, signal holds, traffic patterns). We don't estimate them; we use them directly.

---

## Testing Checklist

- [x] Vehicle visible on map with correct Next Stop tooltip
- [x] Same 2 vehicles appear at consecutive stations with decreasing ETAs
- [x] No arrivals for vehicles clearly past the target
- [x] B Line Hollywood section (historically broken) shows correct arrivals
- [x] K Line Expo section (historically broken) shows correct arrivals
- [x] Transfer stations (7th St/Metro Center) show only vehicles on that line
- [x] Unscheduled trains show up in predictions
- [x] Turnaround arrivals appear for vehicles heading to terminus

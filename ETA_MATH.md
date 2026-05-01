# ETA Calculation — Exact Math

## Core Formula

```
ETA_unix = ANCHOR_TIME + SCHEDULE_GAP
```

Where:
- **ETA_unix** = predicted arrival time (seconds since Unix epoch)
- **ANCHOR_TIME** = when the vehicle reaches its next stop (from GTFS-RT)
- **SCHEDULE_GAP** = scheduled time from next stop to target stop (from static schedule)

---

## Step-by-Step Calculation

### Step 1: Build Route Sequences (Once Per Route/Direction)

For each route/direction, extract the longest trip:

```javascript
const trip = trips.find(t => 
  t.routeCode === routeCode && 
  t.direction === dir &&
  t.stops.length === maxLength  // pick longest
);

const stops = trip.stops;           // [80201, 80202, 80203, ...]
const times = trip.scheduledTimes;  // [0, 120, 245, 380, ...]
```

The `scheduledTimes` array is **cumulative seconds from stop[0]**:
- Stop 0: 0 seconds (baseline)
- Stop 1: 120 seconds (2 min from stop 0)
- Stop 2: 245 seconds (4 min 5 sec from stop 0)
- Stop 3: 380 seconds (6 min 20 sec from stop 0)

### Step 2: Locate Vehicle's Next Stop

From GTFS-RT VehiclePositions feed:

```
vehicle.properties.stopId = "80202"  // vehicle's reported next stop
```

Find its index in the stops array:

```javascript
const fromIdx = findIdx(stops, vehicle.properties.stopId);
// If "80202" exactly matches: fromIdx = 1
```

### Step 3: Locate Target Stop

User clicks on a station, e.g., "80204":

```javascript
const toIdx = findIdx(stops, targetStopId);
// If "80204" matches: toIdx = 3
```

**Guard:** If either `fromIdx === -1` or `toIdx === -1`, vehicle doesn't serve this route. Return null.

**Guard:** If `toIdx < fromIdx`, vehicle has already passed the target. Handled by turnaround logic instead.

### Step 4: Calculate Schedule Gap

```javascript
const timeAtFrom = scheduledTimes[fromIdx];  // 120 seconds
const timeAtTo   = scheduledTimes[toIdx];    // 380 seconds

const scheduleGap = timeAtTo - timeAtFrom;   // 260 seconds = 4 min 20 sec
```

This is the **constant inter-stop time** for this route in this direction.

### Step 5: Get Anchor Time

From GTFS-RT trip_updates feed (or fallback to now):

```javascript
const anchorEntries = masterArrivalsData.get(fromStopId) ?? [];
const anchorEntry = anchorEntries.find(a => a.vehicleId === vehicleId);

if (anchorEntry && anchorEntry.arrivalUnix > now) {
  anchorTime = anchorEntry.arrivalUnix;
} else {
  anchorTime = now;  // fallback if no prediction available
}
```

The anchor is **when Metro predicts this vehicle reaches the next stop**.

### Step 6: Calculate ETA

```javascript
const etaUnix = anchorTime + scheduleGap;
```

**Example:**
```
Now: 1714521600 (5:00 PM)
Anchor (vehicle's ETA at next stop): 1714521660 (5:01 PM, 60 sec from now)
Schedule gap: 260 seconds (4 min 20 sec)
ETA at target: 1714521660 + 260 = 1714521920 (5:05:20 PM)
```

---

## Stop ID Normalization: `findIdx(stops, rawId)`

LA Metro uses multiple formats for the same stop. The lookup must be fuzzy:

```javascript
function findIdx(stops, rawId) {
  // 1. Exact match
  let idx = stops.indexOf(rawId);
  if (idx !== -1) return idx;
  
  // 2. Strip platform suffix
  //    80201_N → 80201, or 80201N → 80201
  const base = rawId.replace(/[_-][A-Za-z0-9]+$/, '');
  if (base !== rawId) {
    idx = stops.indexOf(base);
    if (idx !== -1) return idx;
  }
  
  // 3. Strip all trailing letters
  //    80201N → 80201 (in case suffix regex didn't catch it)
  const stripped = rawId.replace(/[A-Za-z]+$/, '');
  if (stripped !== rawId && stripped.length > 0) {
    idx = stops.indexOf(stripped);
    if (idx !== -1) return idx;
  }
  
  // 4. Fuzzy match on prefix
  //    80201 could match 80201_N or 80201S in the array
  return stops.findIndex(s =>
    s.startsWith(rawId + '_') || 
    s.startsWith(rawId + '-') ||
    (s.startsWith(rawId) && s.length > rawId.length && /^[A-Za-z]/.test(s[rawId.length]))
  );
}
```

Returns -1 if no match found in any category.

---

## Turnaround Calculation

For vehicles heading **past** the target toward the terminus:

```
ETA_turnaround = max(now, terminusArrival) + flipTime + returnGap
```

Where:

### `terminusArrival`
Vehicle's predicted arrival at the route's last stop (from GTFS-RT):

```javascript
const terminusStopId = trip.stops[trip.stops.length - 1];
const terminusArrivals = masterArrivalsData.get(terminusStopId) ?? [];
const vTerminus = terminusArrivals.find(a => a.vehicleId === vehicleId);
const terminusArrival = vTerminus?.arrivalUnix;
```

### `flipTime`
Dwell time at terminus (empirical, from schedule):

```javascript
// Collect all arrivals and departures at this terminus across all trips
const arrivals = [];
const departures = [];

for (const t of Object.values(masterTripsData)) {
  if (t.routeCode !== routeCode) continue;
  
  // Arrival: if this trip ends at terminusStopId
  if (t.stops[t.stops.length - 1] === terminusStopId) {
    arrivals.push(t.scheduledTimes[t.scheduledTimes.length - 1]);
  }
  
  // Departure: if this trip starts at terminusStopId
  if (t.stops[0] === terminusStopId) {
    departures.push(t.scheduledTimes[0]);
  }
}

// For each arrival, find the next departure
const gaps = [];
let di = 0;
for (const arr of arrivals.sort((a, b) => a - b)) {
  while (di < departures.length && departures[di] < arr) di++;
  if (di < departures.length) {
    gaps.push(departures[di] - arr);
  }
}

// Median gap + safety buffer
gaps.sort((a, b) => a - b);
const medianGap = gaps[Math.floor(gaps.length / 2)];
const flipTime = medianGap + 120;  // 120s buffer for real-world dwell
```

**Why this works:** The schedule tells us the dwell time between the last arrival and next departure. Real-world dwell is typically 2-4 minutes. The median captures typical behavior; the 120s buffer accounts for variability.

### `returnGap`
Schedule gap from terminus back to target in the **opposite direction**:

```javascript
const returnGapResult = getStopGap(routeCode, terminusStopId, targetStopId);
// This calls getStopGap again but with opposite direction logic
// It finds the gap in the reverse-direction sequence (dir = 1 - currentDir)

const returnGap = returnGapResult?.gap;
```

If `returnGap` is null (terminus not in reverse-direction sequence), turnaround is skipped.

---

## Numerical Example

### Forward Case

Route: B Line (802)  
Direction: 0 (Southbound, Union Station → North Hollywood)  
Vehicle: 80-001  
Vehicle's next stop: Hollywood/Vine (80202)  
Target stop: Union Station (80201)

**Route stops sequence:**
```
[80201, 80202, 80203, 80204, ...]
[0,     120,   245,   380,   ...]  (scheduledTimes in seconds)
```

**Lookup:**
```
fromIdx = 1 (80202, Hollywood/Vine)
toIdx = 0 (80201, Union Station)
toIdx < fromIdx → TRUE, vehicle already past target
→ Skip forward case, check turnaround instead
```

### Turnaround Case

**Vehicle data:**
```
Vehicle 80-001
Current next stop: 80204
Route: 802
Direction: 0
```

**Check if past target:**
```
getStopGap(802, 80204, 80201) in direction 0
→ 80201 comes before 80204 in stops array
→ Returns null (vehicle already past)
```

**Get terminus:**
```
Terminus = stops[stops.length - 1] = 90000 (North Hollywood)
```

**Lookup terminus arrival from GTFS-RT:**
```
masterArrivalsData[90000] = [
  { vehicleId: 80001, arrivalUnix: 1714521900, ... }
]
terminusArrival = 1714521900 (5:05 PM)
```

**Get flip time (empirical dwell):**
```
Collected gaps: [60, 65, 70, 75, 80, 85, 90]  (seconds)
Median: 75 seconds
flipTime = 75 + 120 = 195 seconds (3 min 15 sec)
```

**Get return gap (southbound terminus → union station):**
```
Direction 1 (Northbound) stops sequence:
[90000, 90001, 80204, 80203, 80202, 80201, ...]
[0,     140,   280,   390,   520,   650,   ...]

fromIdx = 0 (terminus)
toIdx = 5 (union station, 80201)
returnGap = 650 - 0 = 650 seconds (10 min 50 sec)
```

**Calculate turnaround ETA:**
```
etaUnix = max(1714521600, 1714521900) + 195 + 650
        = 1714521900 + 195 + 650
        = 1714522745
        = 5:19:05 PM
```

The vehicle will arrive at Union Station around 5:19 PM after:
- Reaching North Hollywood: 5:05 PM
- Dwell time: 3:15
- Return trip: 10:50
- Total: ~14 minutes from now

---

## Key Invariants

1. **Schedule gap is constant:** All trips on the same route/direction have identical inter-stop times (geometry-driven).
2. **Anchor is authority:** We trust GTFS-RT's arrival prediction at the next stop, then apply schedule gap.
3. **No delay propagation:** We don't estimate accumulated delay. The schedule itself encodes typical delays (dwell, signals, traffic).
4. **Direction isolation:** `getStopGap` implicitly isolates routes. E Line doesn't match B Line stops.
5. **Stop ID normalization is automatic:** `findIdx()` handles format variance without special cases.

---

## Edge Cases

### Vehicle Before First Stop
If vehicle's next stop is `stops[0]`, then:
```
anchorTime = GTFS-RT arrival at stops[0]
scheduleGap = scheduledTimes[toIdx] - 0
etaUnix = anchorTime + scheduleGap
```
Works correctly.

### Vehicle At Final Stop (No Turnaround)
If vehicle is heading to terminus and there's no reverse trip:
```
returnGap = getStopGap(route, terminus, target) in direction 1
→ Returns null if reverse direction doesn't exist
→ Turnaround skipped
```
Handled gracefully.

### Missing Anchor Time
If GTFS-RT doesn't have a prediction for the next stop:
```
anchorTime = now  (fallback)
etaUnix = now + scheduleGap
```
Conservative estimate; vehicle may arrive sooner.

### Stop Not In Route
If target stop doesn't exist in this route:
```
getStopGap(route, nextStop, targetStop)
→ toIdx = -1
→ Returns null
→ Vehicle skipped
```
Transfer station isolation, automatic.

---

## Performance

- **Per vehicle:** ~5 array lookups + 1 subtraction = **~0.1ms**
- **Per popup (50 vehicles):** ~200ms total (including sort)
- **Precompute (once per direction):** ~10ms

No per-vehicle state. No EMA smoothing. No geometric fallback. Just pure arithmetic on precomputed arrays.

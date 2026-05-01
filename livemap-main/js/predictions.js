const routeStops = {};

export function initPredictions() {
    const trips = window.masterTripsData;
    if (!trips) return;

    const best = {};
    for (const [tripId, trip] of Object.entries(trips)) {
        const { rc, dir, stops, scheduledTimes } = trip;
        if (rc == null || dir == null || !stops?.length || !scheduledTimes?.length) continue;
        const key = `${rc}|${dir}`;
        if (!best[key] || stops.length > best[key].stops.length) best[key] = { ...trip, tripId };
    }

    for (const [key, trip] of Object.entries(best)) {
        routeStops[key] = {
            stops: trip.stops.map(String),
            times: trip.scheduledTimes,
        };
    }
    console.log(`[predictions] schedule cache: ${Object.keys(routeStops).length} route-dirs`);
}

function findIdx(stops, targetId) {
    const t = String(targetId);
    let idx = stops.indexOf(t);
    if (idx !== -1) return idx;

    const stripped = t.replace(/_[NSEW]$/i, '');
    if (stripped !== t) {
        idx = stops.indexOf(stripped);
        if (idx !== -1) return idx;
        idx = stops.findIndex(s => s.replace(/_[NSEW]$/i, '') === stripped);
        if (idx !== -1) return idx;
    }

    const noTrail = t.replace(/\D+$/, '');
    if (noTrail && noTrail !== t && noTrail !== stripped) {
        idx = stops.indexOf(noTrail);
        if (idx !== -1) return idx;
    }

    if (t.length >= 5) {
        idx = stops.findIndex(s => s.startsWith(t) || t.startsWith(s));
        if (idx !== -1) return idx;
    }
    return -1;
}

export function getScheduledArrivals(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;

        // Use trip lookup only to get direction; scheduledTimes not needed here
        const tripMeta = window.masterTripsData?.[trip_id];
        const dir = tripMeta?.dir;
        if (dir == null) continue;

        // Use the pre-built cache (longest trip for this route+dir) for stop sequence + times
        const cache = routeStops[`${route_code}|${dir}`];
        if (!cache) continue;

        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;

        const nextIdx   = findIdx(cache.stops, vehicleNextStop);
        const targetIdx = findIdx(cache.stops, sid);

        if (nextIdx === -1 || targetIdx === -1) continue;
        if (targetIdx < nextIdx) continue;

        const gap = cache.times[targetIdx] - cache.times[nextIdx];
        if (gap < 0) continue;

        results.push({
            routeId:     route_code,
            directionId: dir,
            vehicleId:   vehicle_id,
            tripId:      trip_id,
            arrivalUnix: now + gap,
            _dbgMath:    `${vehicleNextStop} [${nextIdx}→${targetIdx}] +${Math.round(gap/60)}m`,
        });
    }

    results.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Keep only the 2 closest vehicles per route+direction
    const countPerDir = {};
    return results.filter(a => {
        const k = `${a.routeId}|${a.directionId}`;
        countPerDir[k] = (countPerDir[k] ?? 0) + 1;
        return countPerDir[k] <= 2;
    });
}

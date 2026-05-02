import { cleanStationName } from './utils.js';

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
        if (trip.stops.length !== trip.scheduledTimes.length) continue;
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
        // Only match if the longer ID is the shorter one plus a non-numeric suffix (e.g. "80204N")
        idx = stops.findIndex(s => {
            const [longer, shorter] = s.length >= t.length ? [s, t] : [t, s];
            return longer.startsWith(shorter) && !/\d/.test(longer.slice(shorter.length));
        });
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

        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;

        if (now - (marker.timestamp ?? 0) > 60) continue;

        // Direction: prefer static trip metadata, fall back to live feed direction_id.
        // Only try both directions when direction is genuinely unknown.
        const tripMeta = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        const dirsToTry = preferredDir != null ? [preferredDir] : [0, 1];

        for (const dir of dirsToTry) {
            const cache = routeStops[`${route_code}|${dir}`];
            if (!cache) continue;

            const nextIdx   = findIdx(cache.stops, vehicleNextStop);
            const targetIdx = findIdx(cache.stops, sid);

            if (nextIdx === -1 || targetIdx === -1) continue;
            if (targetIdx < nextIdx) continue;

            let arrivalUnix;
            if (nextIdx === targetIdx) {
                arrivalUnix = now;
            } else {
                const gap = cache.times[targetIdx] - cache.times[nextIdx];
                if (gap < 0) continue;

                const status = marker.properties.currentStatus;
                const isStoppedAt = status === 1 || status === 'STOPPED_AT';

                if (isStoppedAt) {
                    // Vehicle is definitively at its stop — gap is accurate from here
                    arrivalUnix = now + Math.max(0, gap);
                } else {
                    // IN_TRANSIT_TO or INCOMING_AT: dead-reckon position within the inter-stop segment.
                    // scheduledTimes uses departure_time, so interStopGap = pure travel time (no dwell).
                    // statusChangedAt is when the feed reported this stopId — actual departure was ~15s earlier.
                    const statusChangedAt = marker.properties.statusChangedAt;
                    if (statusChangedAt != null && nextIdx > 0) {
                        const interStopGap = cache.times[nextIdx] - cache.times[nextIdx - 1];
                        if (interStopGap <= 0) {
                            arrivalUnix = now + Math.max(0, gap - 15);
                        } else {
                            const timeInTransit = Math.min((now - statusChangedAt) + 15, interStopGap);
                            const remainingToNext = Math.max(0, interStopGap - timeInTransit);
                            arrivalUnix = now + Math.max(0, remainingToNext + gap);
                        }
                    } else {
                        // No statusChangedAt yet (fresh marker) or vehicle is at first stop — use flat lag
                        arrivalUnix = now + Math.max(0, gap - 15);
                    }
                }
            }

            results.push({
                routeId:     route_code,
                directionId: dir,
                vehicleId:   vehicle_id,
                tripId:      trip_id,
                arrivalUnix,
            });
            break;
        }
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

export function getTerminalStopId(routeCode, directionId) {
    const cache = routeStops[`${routeCode}|${directionId}`];
    if (!cache?.stops?.length) return null;
    return [...cache.stops].reverse().find(s => s) ?? null;
}

export function getTerminalName(routeCode, directionId) {
    const cache = routeStops[`${routeCode}|${directionId}`];
    if (!cache?.stops?.length) return null;
    const lastStopId = [...cache.stops].reverse().find(s => s);
    const stop = lastStopId ? window.masterStopsData?.[String(lastStopId)] : null;
    return stop?.name ? cleanStationName(stop.name) : null;
}

/**
 * @module serviceDate
 * Helpers for the midnight service-date rollover in main.js. Kept in a
 * dependency-free module so the logic can be unit-tested without importing
 * main.js (which would pull in MapLibre, all feature modules, etc.).
 */

/**
 * Merge old trip entries into the new trips object for any tripId currently
 * referenced by an active vehicle marker but missing from the new trips.json.
 *
 * Background: a vehicle that started yesterday (e.g. an owl A-Line train that
 * left Long Beach at 23:45) is still physically on the map at 00:01 today.
 * Without preservation, the rollover swaps masterTripsData wholesale and the
 * owl trip's static context (terminus, stop sequence, isLast pill) becomes
 * undefined until the trip actually terminates — the popup loses
 * destination details mid-route.
 *
 * The 2026-05-26 feed-reliability audit confirmed the safety condition for
 * this approach: tripIds are NOT recycled across service dates (200 distinct
 * tripIds across 39k vehicle_positions samples, and the next day's tripIds
 * already appear in trip_updates 12+ hours before the rollover with no
 * collisions). So copying old[tid] into new[] when new[tid] is absent is
 * never going to silently mask a real same-id-different-trip entry.
 *
 * Pure function. Mutates `newTrips` in place; returns the count of preserved
 * entries so the caller can log it.
 *
 * @param {Object} oldTrips  Previous masterTripsData (may be {} or null)
 * @param {Object} newTrips  Just-fetched trips.json (mutated in place)
 * @param {Object} markers   window.vehicleMarkers snapshot (tripId → marker)
 * @returns {number} Count of tripIds preserved from oldTrips into newTrips.
 */
export function _preserveActiveTrips(oldTrips, newTrips, markers) {
    if (!oldTrips || !newTrips || !markers) return 0;
    let preserved = 0;
    for (const m of Object.values(markers)) {
        const tid = m?.properties?.trip_id;
        if (!tid) continue;
        const key = String(tid);
        if (newTrips[key]) continue;          // new GTFS already has it
        if (!oldTrips[key]) continue;         // not in old GTFS either, nothing to preserve
        newTrips[key] = oldTrips[key];
        preserved++;
    }
    return preserved;
}

/**
 * Count live vehicle markers whose tripId exists ONLY in the just-fetched
 * trips data — the measurable footprint of the midnight rollover race
 * (issue #246, instrument-first).
 *
 * The race: between the local-midnight date change and the completion of
 * `_reloadGtfsData` (watcher tick ≤ SERVICE_DATE_CHECK_MS + fetch time), a
 * WS frame can arrive for a brand-new service-day trip that the still-current
 * masterTripsData doesn't contain. The frame is NOT dropped — markers render
 * with degraded static context (no terminus, no stop sequence, weaker ETA)
 * until the swap lands. A marker present at swap time with a tripId in
 * `newTrips` but absent from `oldTrips` is exactly such a vehicle.
 *
 * Counts VEHICLES (one per affected marker, once per rollover), not frames —
 * the per-frame rate the issue asks about is this count × (window / feed
 * cadence), but vehicles-affected is the decision metric: if this stays at
 * 0–2 per night across a few weeks of rings, close #246 unfixed.
 *
 * Pure function, no mutation. Order-independent with _preserveActiveTrips
 * (preserved entries are by definition in oldTrips, so they can never count
 * as misses), but call it BEFORE preservation for conceptual clarity.
 *
 * @param {Object} oldTrips  masterTripsData at the time of the swap
 * @param {Object} newTrips  Just-fetched trips.json (unmutated)
 * @param {Object} markers   window.vehicleMarkers snapshot (tripId → marker)
 * @returns {number} Count of live markers running on new-day-only tripIds.
 */
export function _countMidnightTripIdMisses(oldTrips, newTrips, markers) {
    if (!oldTrips || !newTrips || !markers) return 0;
    let misses = 0;
    for (const m of Object.values(markers)) {
        const tid = m?.properties?.trip_id;
        if (!tid) continue;
        const key = String(tid);
        if (oldTrips[key]) continue;          // old data knew it — no race
        if (!newTrips[key]) continue;         // in neither — baseline coverage gap, not the race
        misses++;
    }
    return misses;
}

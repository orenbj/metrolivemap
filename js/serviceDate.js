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

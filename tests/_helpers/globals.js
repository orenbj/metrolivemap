/**
 * Per-test setup/reset for the four window globals that predictions.js,
 * markers.js, and stations.js read from. Wraps the seeding done in
 * tests/setup.js so individual tests can install fixtures cleanly.
 */

import { makeTrips, makeStops } from '../_fixtures/trips.js';

export function installGlobals({
    trips    = null,
    stops    = null,
    arrivals = null,
    markers  = null,
} = {}) {
    window.masterTripsData    = trips    ?? makeTrips();
    window.masterStopsData    = stops    ?? makeStops();
    window.masterArrivalsData = arrivals ?? new Map();
    window.vehicleMarkers     = markers  ?? {};
}

export function resetGlobals() {
    window.masterTripsData    = {};
    window.masterStopsData    = {};
    window.masterArrivalsData = new Map();
    window.vehicleMarkers     = {};
}

/**
 * Add a single arrival entry to masterArrivalsData under the given stopId.
 * Convenient for tests that want to assert blend behavior.
 */
export function addArrival(stopId, entry) {
    const sid = String(stopId);
    if (!window.masterArrivalsData.has(sid)) window.masterArrivalsData.set(sid, []);
    window.masterArrivalsData.get(sid).push(entry);
}

/**
 * Synthetic trip / stop / route fixtures for unit tests.
 *
 * Mirrors the shape of window.masterTripsData, masterStopsData, and the
 * route-stops cache that predictions.js builds from them. Coordinates are
 * loosely placed along LA Metro corridors; values are illustrative, not
 * geographically precise. Tests that need exact arc-distances build their
 * own synthetic polylines inline.
 */

/**
 * Build a synthetic A-Line (rail, route_code 801) trip in direction 0
 * (Northbound). 4 stops, 120 s scheduled gap between each.
 */
export function makeRailTripA(overrides = {}) {
    return {
        rc: '801',
        dir: 0,
        dest: 'Azusa / Downtown',
        total: 4,
        stops: ['80101', '80202', '80303', '80404'],
        scheduledTimes: [0, 120, 240, 360],
        ...overrides,
    };
}

/**
 * Build a synthetic G-Line (bus, route_code 901) trip in direction 0
 * (Eastbound). 4 stops, 180 s scheduled gap between each.
 */
export function makeBusTripG(overrides = {}) {
    return {
        rc: '901',
        dir: 0,
        dest: 'Chatsworth',
        total: 4,
        stops: ['90101', '90202', '90303', '90404'],
        scheduledTimes: [0, 180, 360, 540],
        ...overrides,
    };
}

/**
 * Build a stops dictionary covering both fixtures above. Coordinates are
 * approximate — they're collinear along a south→north line so tests that
 * compute bearings get sensible values.
 */
export function makeStops() {
    return {
        // A Line — northbound, lat increasing.
        '80101': { lat: 34.040, lon: -118.260, name: 'A Stop 1' },
        '80202': { lat: 34.060, lon: -118.260, name: 'A Stop 2' },
        '80303': { lat: 34.080, lon: -118.260, name: 'A Stop 3' },
        '80404': { lat: 34.100, lon: -118.260, name: 'A Stop 4' },
        // G Line — eastbound, lon increasing.
        '90101': { lat: 34.180, lon: -118.500, name: 'G Stop 1' },
        '90202': { lat: 34.180, lon: -118.450, name: 'G Stop 2' },
        '90303': { lat: 34.180, lon: -118.400, name: 'G Stop 3' },
        '90404': { lat: 34.180, lon: -118.350, name: 'G Stop 4' },
    };
}

/**
 * Build the masterTripsData dictionary keyed by tripId. Default seeds one
 * rail trip ('TR-A-1') and one bus trip ('TR-G-1'); pass overrides to
 * extend or replace.
 */
export function makeTrips(overrides = {}) {
    return {
        'TR-A-1': makeRailTripA(),
        'TR-G-1': makeBusTripG(),
        ...overrides,
    };
}

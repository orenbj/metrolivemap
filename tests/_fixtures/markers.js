/**
 * Marker stub factory.
 *
 * Returns an object that quacks like a maplibregl.Marker for the parts of the
 * code under test (predictions, spike rejection, heading) — getLngLat,
 * setLngLat, setRotation, getElement, plus the project-specific properties
 * bag (route_code, trip_id, lastSnap, etc.).
 *
 * The DOM element is a real HTMLElement (jsdom), so `style`, `setAttribute`,
 * `hasAttribute`, and `removeAttribute` all work without further mocking.
 */

export function makeStubElement() {
    const el = document.createElement('div');
    el.className = 'marker';
    return el;
}

/**
 * @param {Object} opts
 * @param {string}  [opts.tripId='TR-A-1']
 * @param {string}  [opts.routeCode='801']
 * @param {number}  [opts.directionId=0]
 * @param {string}  [opts.vehicleId='V1']
 * @param {[number,number]} [opts.lngLat=[-118.260, 34.060]]
 * @param {string|number} [opts.stopId='80202']
 * @param {string}  [opts.currentStatus='IN_TRANSIT_TO']
 * @param {number}  [opts.timestamp]    Unix seconds; defaults to now
 * @param {number}  [opts.statusChangedAt] Unix seconds; defaults to timestamp
 * @param {Object|null} [opts.lastSnap=null]
 * @param {number|null} [opts.lastSnapDeviationM=null]
 * @param {number}  [opts.speed=10]      m/s
 * @param {number}  [opts.heading=0]     degrees
 * @param {number}  [opts.validFixCount=1]
 * @returns {Object} marker stub
 */
export function makeMarker(opts = {}) {
    const {
        tripId          = 'TR-A-1',
        routeCode       = '801',
        directionId     = 0,
        vehicleId       = 'V1',
        lngLat          = [-118.260, 34.060],
        stopId          = '80202',
        currentStatus   = 'IN_TRANSIT_TO',
        timestamp       = Math.floor(Date.now() / 1000),
        statusChangedAt = null,
        lastSnap        = null,
        lastSnapDeviationM = null,
        speed           = 10,
        heading         = 0,
        validFixCount   = 1,
        atTerminus      = false,
    } = opts;

    let _lng = lngLat[0];
    let _lat = lngLat[1];
    let _rot = heading;
    const el = makeStubElement();

    return {
        // MapLibre-shaped methods used by the SUT
        getLngLat:   () => ({ lng: _lng, lat: _lat }),
        setLngLat:   ([lng, lat]) => { _lng = lng; _lat = lat; },
        setRotation: (r) => { _rot = r; },
        getElement:  () => el,
        getRotation: () => _rot,           // test-only helper
        getPopup:    () => null,
        togglePopup: () => {},
        remove:      () => {},

        // Project-specific marker fields
        properties: {
            vehicle_id: vehicleId,
            trip_id: tripId,
            route_code: routeCode,
            direction_id: directionId,
            currentStatus,
            stopId: stopId != null ? String(stopId) : null,
            statusChangedAt: statusChangedAt ?? timestamp,
            Heading: heading,
            speed,
            position_speed: speed,
        },
        timestamp,
        route_code: routeCode,
        vehicleLabel: 'Train Car #',
        lastSnap,
        lastSnapDeviationM,
        validFixCount,
        atTerminus,
    };
}

/**
 * Build a synthetic GTFS-RT vehicle feature (the shape that flows into
 * processVehicleData and processAndUpdate).
 */
export function makeFeature(opts = {}) {
    const {
        vehicleId    = 'V1',
        tripId       = 'TR-A-1',
        routeCode    = '801',
        directionId  = 0,
        lngLat       = [-118.260, 34.060],
        stopId       = '80202',
        currentStatus = 'IN_TRANSIT_TO',
        timestamp    = Math.floor(Date.now() / 1000),
        speed        = 10,
        bearing      = null,
        currentStopSequence = 1,
    } = opts;

    return {
        type: 'Feature',
        properties: {
            vehicle_id: vehicleId,
            trip_id: tripId,
            route_code: routeCode,
            direction_id: directionId,
            stopId: stopId != null ? String(stopId) : null,
            currentStatus,
            currentStopSequence,
            timestamp,
            position_speed: speed,
            position_bearing: bearing,
            position_latitude: lngLat[1],
            position_longitude: lngLat[0],
            agency: 'metro',
        },
        geometry: { type: 'Point', coordinates: lngLat },
    };
}

/**
 * Build a raw GTFS-RT vehicle_positions WebSocket frame (the shape that
 * arrives at api.js processAndUpdate before normalization).
 */
export function makeRawVehicleFrame(opts = {}) {
    const {
        vehicleId   = 'V1',
        tripId      = 'TR-A-1',
        routeCode   = '801',
        directionId = 0,
        lng         = -118.260,
        lat         = 34.060,
        speed       = 10,
        bearing     = null,
        timestamp   = Math.floor(Date.now() / 1000),
        stopId      = '80202',
        currentStatus = 'IN_TRANSIT_TO',
        currentStopSequence = 1,
    } = opts;

    return {
        route_code: routeCode,
        vehicle: {
            vehicle:   { id: vehicleId },
            trip:      { tripId, directionId },
            position:  { latitude: lat, longitude: lng, speed, bearing },
            timestamp,
            currentStatus,
            stopId,
            currentStopSequence,
        },
    };
}

/**
 * Build a raw GTFS-RT trip_updates WebSocket message.
 */
export function makeRawTripUpdate(opts = {}) {
    const {
        tripId      = 'TR-A-1',
        routeId     = '801',
        directionId = 0,
        vehicleId   = 'V1',
        stopTimeUpdates = [{ stopId: '80202', arrival: { time: Math.floor(Date.now() / 1000) + 60 } }],
    } = opts;

    return {
        tripUpdate: {
            trip: { tripId, routeId, directionId },
            vehicle: { id: vehicleId },
            stopTimeUpdate: stopTimeUpdates,
        },
    };
}

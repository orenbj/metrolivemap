import { VEHICLE_SIZE_PX, STALE_THRESHOLD_SEC, STALE_CHECK_INTERVAL_MS, MOVEMENT_THRESHOLD, routeHexColors, METROLINK_ROUTE_IDS } from './config.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { snapToRoute, hasShapeData } from './snap.js';

export const markers = {};
const animations = {};

const terminusesByRoute = {
    '801': ['Downtown Long Beach', 'APU', 'Citrus'],
    '802': ['North Hollywood', 'Union Station'],
    '803': ['Norwalk', 'Redondo Beach'],
    '804': ['Santa Monica', 'Atlantic'],
    '805': ['Wilshire / Western', 'Union Station'],
    '807': ['Expo / Crenshaw', 'Westchester'],
    '901': ['Chatsworth', 'North Hollywood'],
    '910': ['El Monte', 'San Pedro', 'Harbor Gateway']
};

function isTerminus(routeCode, stopId) {
    if (!stopId || !routeCode) return false;
    const stopName = window.masterStopsData?.[String(stopId)]?.name || '';
    const keywords = terminusesByRoute[routeCode] || [];
    return keywords.some(kw => stopName.includes(kw));
}

function bearingTo(fromLng, fromLat, toLng, toLat) {
    const toRadians = deg => (deg * Math.PI) / 180;
    const toDegrees = rad => (rad * 180) / Math.PI;

    const lat1 = toRadians(fromLat);
    const lat2 = toRadians(toLat);
    const dLng = toRadians(toLng - fromLng);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    const bearing = toDegrees(Math.atan2(y, x));
    return (bearing + 360) % 360;
}

/**
 * Expected "canonical" bearing for each route + direction_id.
 * direction_id 0 = generally Northbound/Westbound
 * direction_id 1 = generally Southbound/Eastbound
 *
 * The canonical bearing is the rough compass heading a train *should*
 * be pointing when travelling in that direction.  We allow ±90° tolerance
 * so this only catches gross reversals, not minor curves.
 */
const canonicalBearings = {
    // ── Metro Rail ──
    // A Line (801) omitted — L-shaped; shape-snap handles it.
    // B Line (802) omitted — L-shaped; shape-snap handles it.
    '803': { 0: 270, 1: 90  },   // C Line  — W to Redondo / E to Norwalk
    '804': { 0: 90,  1: 270 },   // E Line  — Swapped to match feed behavior
    '805': { 0: 315, 1: 135 },   // D Line  — NW to Wilshire/Western / SE to Union
    '806': { 0: 0,   1: 180 },   // L Line  (placeholder)
    '807': { 0: 180, 1: 0   },   // K Line  — Swapped to match feed behavior
    '901': { 0: 270, 1: 90  },   // G Line  — W to Chatsworth / E to NoHo
    '910': { 0: 180, 1: 0   },   // J Line  — S to San Pedro/Harbor / N to El Monte
    // ── Metrolink — direction_id 0 = outbound from Union Station ──
    'AV':  { 0: 0,   1: 180 },   // Antelope Valley — N to Lancaster / S to LA
    'SB':  { 0: 90,  1: 270 },   // San Bernardino  — E to SB / W to LA
    'VT':  { 0: 315, 1: 135 },   // Ventura County  — NW to Ventura / SE to LA
    'OC':  { 0: 157, 1: 337 },   // Orange County   — SSE to Oceanside / NNW to LA
    // IE omitted — complex cross-route, GPS fallback handles it
    '91':  { 0: 135, 1: 315 },   // 91/Perris Valley — SE to Perris / NW to LA
};

/**
 * Returns true when `heading` is within ±tolerance° of `target`.
 */
function bearingWithin(heading, target, tolerance) {
    const diff = ((heading - target + 540) % 360) - 180; // [-180, 180)
    return Math.abs(diff) <= tolerance;
}

/**
 * Picks whichever of `bearing` or `bearing+180` is angularly closer to `reference`.
 */
function alignToReference(bearing, reference) {
    const flipped = (bearing + 180) % 360;
    const diffA = Math.abs(((bearing - reference + 540) % 360) - 180);
    const diffB = Math.abs(((flipped  - reference + 540) % 360) - 180);
    return diffA <= diffB ? bearing : flipped;
}

/**
 * Computes the best heading for a vehicle marker.
 *
 * Priority stack for travel direction (used to align the snap):
 *   1. Movement trajectory  — most reliable (actual physics)
 *   2. Previous heading     — continuity, prevents random flips
 *   3. API position_bearing — noisy but correct quadrant, great for cold start
 *   4. Stop approach        — bearing toward next stop
 *
 * The snap gives a precise track-aligned angle; the above signals decide
 * which of the two possible snap directions (or raw trajectory) to return.
 */
function computeHeading(vehicle, fromLng, fromLat, toLng, toLat, existingHeading) {
    const routeCode = vehicle.properties.route_code;

    // ── Build reference heading from best motion signal ──────────────────────
    let reference = null;

    // 1. Movement trajectory
    const dLng = toLng - fromLng;
    const dLat = toLat - fromLat;
    if (Math.abs(dLng) > MOVEMENT_THRESHOLD || Math.abs(dLat) > MOVEMENT_THRESHOLD) {
        reference = bearingTo(fromLng, fromLat, toLng, toLat);
    }

    // 2. Previous heading
    if (reference == null && existingHeading != null) {
        reference = existingHeading;
    }

    // 3. API-provided bearing (noisy but directionally correct)
    if (reference == null) {
        const api = vehicle.properties.position_bearing;
        if (api != null && api !== 0) reference = api;
    }

    // 4. Stop approach bearing
    if (reference == null) {
        const stopId = vehicle.properties.stopId;
        const status = vehicle.properties.currentStatus;
        const approaching = status === 0 || status === 2
            || status === 'INCOMING_AT' || status === 'IN_TRANSIT_TO';
        if (approaching && stopId != null) {
            const target = window.masterStopsData?.[String(stopId)];
            if (target) {
                const dlnt = target.lon - toLng;
                const dlat = target.lat - toLat;
                if (Math.abs(dlnt) > MOVEMENT_THRESHOLD || Math.abs(dlat) > MOVEMENT_THRESHOLD) {
                    reference = bearingTo(toLng, toLat, target.lon, target.lat);
                }
            }
        }
    }

    // ── Apply to snap bearing ─────────────────────────────────────────────────
    if (hasShapeData(routeCode)) {
        const snap = snapToRoute(routeCode, toLng, toLat);
        if (snap) {
            if (reference != null) return alignToReference(snap.bearing, reference);
            return snap.bearing; // No signal — return raw snap
        }
    }

    // ── No shape data: return reference or fallback ───────────────────────────
    if (reference != null) return reference;
    return existingHeading != null ? existingHeading : (vehicle.properties.position_bearing || 0);
}




// Metro rail — circle with arrow
function makeArrowSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <circle cx="25" cy="25" r="22" fill="${color}" stroke="#ffffff" stroke-width="4"/>
        <path d="M 25 10 L 36 36 L 25 29 L 14 36 Z" fill="#ffffff"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

// Metro bus (G/J Line) — square with arrow
function makeSquareSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <rect x="4" y="4" width="42" height="42" rx="5" fill="${color}" stroke="#ffffff" stroke-width="4"/>
        <path d="M 25 11 L 35 34 L 25 27 L 15 34 Z" fill="#ffffff"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

// Metrolink — pentagon (house shape: rect body + pointed direction tip)
function makePentagonSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <path d="M 25 4 L 39 18 L 39 46 Q 39 48 37 48 L 13 48 Q 11 48 11 46 L 11 18 Z"
              fill="${color}" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

function markerSvgUrl(agency, routeCode, color) {
    if (agency === 'metrolink') return makePentagonSvgUrl(color);
    if (['901', '910'].includes(routeCode)) return makeSquareSvgUrl(color);
    return makeArrowSvgUrl(color);
}

export function processVehicleData(data, features, map) {
    const nowSec = Math.floor(Date.now() / 1000);
    data.features
        .filter(v => v.properties?.trip_id)
        .forEach(vehicle => {
            const ts = parseInt(vehicle.properties.timestamp);
            if (nowSec - ts > STALE_THRESHOLD_SEC) return; // skip stale data

            const markerKey = vehicle.properties.trip_id;
            const existing = markers[markerKey];
            if (existing) {
                if (ts > parseInt(existing.timestamp)) {
                    existing.timestamp = ts;
                    updateExistingMarker(vehicle, features, map, markerKey);
                }
            } else {
                // New trip detected. Check if it's a terminus turnaround.
                let oldMarkerKey = null;
                let isTerminusTurnaround = false;

                for (const key in markers) {
                    if (markers[key].properties.vehicle_id === vehicle.properties.vehicle_id && key !== markerKey) {
                        const oldPos = markers[key].getLngLat();
                        const [newLng, newLat] = vehicle.geometry.coordinates;
                        const dist = Math.sqrt(Math.pow(newLng - oldPos.lng, 2) + Math.pow(newLat - oldPos.lat, 2));
                        
                        // If it's less than ~1km jump, it's the same physical train at the terminus changing trips.
                        if (dist < 0.01) {
                            oldMarkerKey = key;
                            isTerminusTurnaround = true;
                            break;
                        }
                    }
                }

                if (isTerminusTurnaround && oldMarkerKey) {
                    const oldHeading = markers[oldMarkerKey].properties.Heading;
                    markers[oldMarkerKey].remove();
                    delete markers[oldMarkerKey];
                    
                    createNewMarker(vehicle, features, map, markerKey, oldHeading);
                } else {
                    createNewMarker(vehicle, features, map, markerKey, null);
                }
            }
        });

    updateDataPanel(markers);
}

function createNewMarker(vehicle, features, map, markerKey, initialHeading) {
    const { vehicle_id, route_code, trip_id, timestamp } = vehicle.properties;
    const agency = vehicle.properties.agency || 'metro';
    const isMetrolink = agency === 'metrolink';
    const isBus = !isMetrolink && ['901', '910'].includes(route_code);

    if (markers[markerKey]) {
        markers[markerKey].remove();
        delete markers[markerKey];
    }

    const el = document.createElement('div');
    el.className = 'marker';
    el.setAttribute('data-route', route_code);
    el.setAttribute('data-trip', trip_id);
    el.setAttribute('data-mode', isMetrolink ? 'metrolink' : (isBus ? 'bus' : 'rail'));
    el.setAttribute('data-agency', agency);
    el.setAttribute('data-timestamp', timestamp);
    el.setAttribute('data-vehicle-id', vehicle_id);
    const sizeExpr = isBus
        ? 'calc(var(--vehicle-size, 24px) * 0.80)'
        : 'var(--vehicle-size, 24px)';
    el.style.cssText = `width:${sizeExpr};height:${sizeExpr};background-repeat:no-repeat;background-size:contain;background-position:center;cursor:pointer;`;

    const brandColor = routeHexColors[route_code] || '#231f20';
    el.style.backgroundImage = markerSvgUrl(agency, route_code, brandColor);

    const [lng, lat] = vehicle.geometry.coordinates;
    const heading = initialHeading !== null ? initialHeading : computeHeading(vehicle, lng, lat, lng, lat, null);

    const vehicleLabel = isMetrolink ? 'Train #' : (isBus ? 'Bus ID ' : 'Train Car #');
    const { stopId, currentStatus, direction_id } = vehicle.properties;
    const popupHtml = getPopupHTML(route_code, vehicle_id, vehicleLabel, timestamp, stopId, currentStatus, direction_id, agency);
    const popup = new maplibregl.Popup({ offset: 15 }).setHTML(popupHtml);

    const marker = new maplibregl.Marker({
        element: el,
        anchor: 'center',
        rotationAlignment: 'map',
        pitchAlignment: 'map'
    })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .setRotation(heading)
        .addTo(map);

    marker.properties = { vehicle_id, trip_id, Heading: heading, speed: vehicle.properties.position_speed };
    marker.timestamp = parseInt(timestamp);
    marker.route_code = route_code;
    markers[markerKey] = marker;
}

function updateExistingMarker(vehicle, features, map, markerKey) {
    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
    }

    const marker = markers[markerKey];
    const current = marker.getLngLat();
    const [newLng, newLat] = vehicle.geometry.coordinates;

    const heading = computeHeading(
        vehicle,
        current.lng, current.lat,
        newLng, newLat,
        marker.properties.Heading
    );

    marker.setRotation(heading);
    marker.properties.Heading = heading;
    marker.properties.speed = vehicle.properties.position_speed; // Update speed for metrics

    // Snap position to track before animating
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        const snap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (snap) {
            targetLng = snap.snappedLng;
            targetLat = snap.snappedLat;
        }
    }

    const diffLng = targetLng - current.lng;
    const diffLat = targetLat - current.lat;
    const distanceDeg = Math.sqrt(diffLng * diffLng + diffLat * diffLat);

    if (distanceDeg > 0.05) { // Roughly 5km jump — teleport directly
        marker.setLngLat([targetLng, targetLat]);
        updateMarkerTimestamp(marker, vehicle, markerKey);
    } else {
        animateMarker(vehicle, diffLng, diffLat, 60, current, markerKey, targetLng, targetLat).then(() => {
            updateMarkerTimestamp(marker, vehicle, markerKey);
        });
    }

    marker.properties.stopId = vehicle.properties.stopId;

    updatePopup(vehicle, markerKey);
}

function updateMarkerTimestamp(marker, vehicle, markerKey) {
    if (vehicle.properties) {
        const newTs = parseInt(vehicle.properties.timestamp);
        marker.timestamp = newTs;
        const el = document.querySelector(`.marker[data-trip="${vehicle.properties.trip_id}"]`);
        if (el) el.setAttribute('data-timestamp', newTs);
    }
}

function updatePopup(vehicle, markerKey) {
    const marker = markers[markerKey];
    const popup = marker?.getPopup();
    if (!popup) return;
    const agency = vehicle.properties.agency || 'metro';
    const isMetrolink = agency === 'metrolink';
    const isBus = !isMetrolink && ['901', '910'].includes(marker.route_code);
    const vehicleLabel = isMetrolink ? 'Train #' : (isBus ? 'Bus ID ' : 'Train Car #');
    const { stopId, currentStatus, direction_id } = vehicle.properties;
    const popupHtml = getPopupHTML(marker.route_code, vehicle.properties.vehicle_id, vehicleLabel, marker.timestamp, stopId, currentStatus, direction_id, agency);
    popup.setHTML(popupHtml);
}

function animateMarker(vehicle, diffLng, diffLat, steps, currentCoordinates, markerKey, targetLng, targetLat) {
    return new Promise(resolve => {
        let i = 0;
        function animate() {
            if (i <= steps) {
                const progress = i / steps;
                const eased = progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                markers[markerKey]?.setLngLat([
                    currentCoordinates.lng + eased * diffLng,
                    currentCoordinates.lat + eased * diffLat
                ]);
                i++;
                animations[markerKey] = requestAnimationFrame(animate);
            } else {
                // Ensure we land exactly on the snapped target
                if (targetLng != null && targetLat != null) {
                    markers[markerKey]?.setLngLat([targetLng, targetLat]);
                }
                resolve();
            }
        }
        animate();
    });
}

export function initMarkerCleanup() {
    setInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        let removedAny = false;
        for (const markerKey in markers) {
            if (markers[markerKey]?.timestamp && nowSec - markers[markerKey].timestamp > STALE_THRESHOLD_SEC) {
                markers[markerKey].remove();
                delete markers[markerKey];
                removedAny = true;
            }
        }
        if (removedAny) updateDataPanel(markers);
    }, STALE_CHECK_INTERVAL_MS);
}

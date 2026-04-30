import { markers } from './markers.js';
import { planarMeters } from './snap.js';

const AVG_RAIL_SPEED_MPS = 12; // ~26 mph
const AVG_BUS_SPEED_MPS = 8; // ~18 mph
const STATION_DWELL_PENALTY_SEC = 25; // added per intermediate stop
const AUDIT_TOLERANCE_SEC = 240; // 4 mins difference triggers override

/**
 * Returns an array of predicted arrivals for a given stopId.
 * Fuses Metro's GTFS-RT TripUpdates with our live geometric GPS tracking.
 * If Metro's ETA is wildly inaccurate or missing entirely (Ghost Trains),
 * our geometric ETA takes over and flags it as `isLiveEstimate = true`.
 */
export function getHybridArrivals(stopId) {
    const now = Math.floor(Date.now() / 1000);
    const baseArrivals = window.masterArrivalsData?.get(String(stopId)) || [];
    const hybridArrivals = [];
    const targetStation = window.masterStopsData?.[String(stopId)];

    if (!targetStation) return baseArrivals;

    // Create a lookup for existing base arrivals by vehicleId
    const baseByVehicle = new Map();
    baseArrivals.forEach(a => baseByVehicle.set(String(a.vehicleId), a));

    // Iterate through all active markers (live trains)
    for (const markerKey in markers) {
        const marker = markers[markerKey];
        const { route_code, trip_id, speed } = marker.properties;
        const vehicleId = String(marker.properties.vehicle_id);

        // Skip Metrolink or vehicles without a trip
        if (!trip_id || marker.properties.agency === 'metrolink') continue;

        const trip = window.masterTripsData?.[trip_id];
        if (!trip) continue;

        const targetStopIndex = trip.stops.indexOf(String(stopId));
        const currentSequenceIndex = marker.lastStopSequence ? marker.lastStopSequence - 1 : 0;
        
        // If the stop is not in this trip, or the train has already passed it
        if (targetStopIndex === -1 || targetStopIndex < currentSequenceIndex) continue;

        // The train is heading towards this station!
        const isBus = ['901', '910', '950'].includes(route_code);
        const trainCoords = marker.getLngLat();
        
        // Planar distance with track-curvature factor (1.2x rail, 1.3x bus)
        const distanceMeters = planarMeters(trainCoords.lat, trainCoords.lng, targetStation.lat, targetStation.lon) * (isBus ? 1.3 : 1.2);

        // Calculate active speed (fallback to route averages if stopped or glitching)
        let activeSpeed = Number(speed);
        if (!activeSpeed || activeSpeed < 5) {
            activeSpeed = isBus ? AVG_BUS_SPEED_MPS : AVG_RAIL_SPEED_MPS;
        }

        const timeSeconds = Math.round(distanceMeters / activeSpeed);
        
        // Dwell penalty for intermediate stops
        const intermediateStops = targetStopIndex - currentSequenceIndex;
        const dwellPenalty = intermediateStops > 0 ? intermediateStops * STATION_DWELL_PENALTY_SEC : 0;

        const geometricEtaUnix = now + timeSeconds + dwellPenalty;

        // Merge logic
        const baseArrival = baseByVehicle.get(vehicleId);
        
        if (baseArrival) {
            // Metro knows about it. Let's audit.
            const diff = Math.abs(baseArrival.arrivalUnix - geometricEtaUnix);
            
            // If Metro is wildly off OR stuck in the past
            if (diff > AUDIT_TOLERANCE_SEC || baseArrival.arrivalUnix < now) {
                hybridArrivals.push({
                    ...baseArrival,
                    arrivalUnix: geometricEtaUnix,
                    isLiveEstimate: true
                });
            } else {
                // Trust Metro's backend
                hybridArrivals.push({
                    ...baseArrival,
                    isLiveEstimate: false
                });
            }
            baseByVehicle.delete(vehicleId);
        } else {
            // Metro missed this train! Insert Ghost Arrival.
            hybridArrivals.push({
                routeId: route_code,
                directionId: trip.dir,
                vehicleId: vehicleId,
                tripId: trip_id,
                arrivalUnix: geometricEtaUnix,
                isLiveEstimate: true
            });
        }
    }

    // Add remaining base arrivals that aren't on our map
    baseByVehicle.forEach(arrival => {
        hybridArrivals.push({ ...arrival, isLiveEstimate: false });
    });

    // Sort by arrival time ascending
    hybridArrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
    
    return hybridArrivals;
}

// Quick diagnostic: show what vehicle IDs each feed sends
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trips = JSON.parse(readFileSync(join(__dirname, '../data/trips.json'), 'utf8'));

// Build routeStops to check if stop IDs match
const routeStops = {};
const best = {};
for (const [tripId, trip] of Object.entries(trips)) {
    const { rc, dir, stops: s, scheduledTimes: t } = trip;
    if (rc == null || dir == null || !s?.length || !t?.length) continue;
    const key = `${rc}|${dir}`;
    if (!best[key] || s.length > best[key].stops.length) best[key] = { ...trip, tripId };
}
for (const [key, trip] of Object.entries(best)) {
    if (trip.stops.length !== trip.scheduledTimes.length) continue;
    routeStops[key] = { stops: trip.stops.map(String), times: trip.scheduledTimes };
}
console.log('Route-dirs in schedule cache:', Object.keys(routeStops).join(', '));
console.log('Sample A-line stops (801|0):', routeStops['801|0']?.stops.slice(0,5));
console.log('Sample A-line stops (801|1):', routeStops['801|1']?.stops.slice(0,5));

const posVehicles = {};
const tripVehicles = {};

function connectWS(url, onMessage) {
    const ws = new WebSocket(url);
    ws.addEventListener('message', e => { try { onMessage(JSON.parse(e.data)); } catch {} });
    ws.addEventListener('error', () => {});
}

connectWS('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', msg => {
    const v = msg?.vehicle;
    if (!v?.trip?.tripId) return;
    const key = `${v.vehicle?.id}|${msg.route_code}|${v.trip.tripId}`;
    if (!posVehicles[key]) {
        posVehicles[key] = { vehicleId: v.vehicle?.id, routeCode: msg.route_code, tripId: v.trip.tripId, stopId: v.stopId };
    }
});

connectWS('wss://api.metro.net/ws/LACMTA_Rail/trip_updates', msg => {
    const tu = msg?.tripUpdate;
    if (!tu?.stopTimeUpdate?.length) return;
    const key = `${tu.vehicle?.id}|${tu.trip?.routeId}|${tu.trip?.tripId}`;
    if (!tripVehicles[key]) {
        tripVehicles[key] = {
            vehicleId: tu.vehicle?.id,
            routeId: String(tu.trip?.routeId ?? '').split('-')[0],
            tripId: tu.trip?.tripId,
            firstStopId: tu.stopTimeUpdate[0]?.stopId
        };
    }
});

setTimeout(() => {
    console.log('\n── Vehicle Positions feed (first 5) ──');
    Object.values(posVehicles).slice(0,5).forEach(v =>
        console.log(`  vehicleId="${v.vehicleId}"  route="${v.routeCode}"  stopId="${v.stopId}"`));

    console.log('\n── Trip Updates feed (first 5) ──');
    Object.values(tripVehicles).slice(0,5).forEach(v =>
        console.log(`  vehicleId="${v.vehicleId}"  route="${v.routeId}"  firstStopId="${v.firstStopId}"`));

    // Check if trip update stopIds appear in our schedule
    console.log('\n── Stop ID match check (trip_updates stopIds vs schedule) ──');
    const cache801 = [...(routeStops['801|0']?.stops ?? []), ...(routeStops['801|1']?.stops ?? [])];
    Object.values(tripVehicles).filter(v => v.routeId === '801').slice(0,3).forEach(v => {
        const inSchedule = cache801.includes(String(v.firstStopId));
        console.log(`  stopId="${v.firstStopId}" → in 801 schedule: ${inSchedule}`);
    });

    process.exit(0);
}, 8000);

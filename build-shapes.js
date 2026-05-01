/**
 * build-shapes.js
 * Pre-processes GTFS shapes.txt + trips.txt into a compact rail-shapes.json
 * that maps each Metro rail route_code to a single representative polyline
 * (union of all shape points for that route, deduplicated).
 *
 * Run:  node build-shapes.js
 * Output: livemap-main/data/rail-shapes.json
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DIR = __dirname;
const TRIPS_FILE            = path.join(DIR, 'data', 'rail_gtfs', 'trips.txt');
const SHAPES_FILE           = path.join(DIR, 'data', 'rail_gtfs', 'shapes.txt');
const RAIL_STOP_TIMES_FILE  = path.join(DIR, 'data', 'rail_gtfs', 'stop_times.txt');
const BUS_TRIPS_FILE        = path.join(DIR, 'data', 'trips.txt');    // main combined (has 901/910)
const BUS_SHAPES_FILE       = path.join(DIR, 'data', 'shapes.txt');   // main combined
const BUS_STOP_TIMES_FILE   = path.join(DIR, 'data', 'stop_times.txt');
const OUT_FILE              = path.join(DIR, 'data', 'rail-shapes.json');
const TRIPS_OUT_FILE        = path.join(DIR, 'data', 'trips.json');

// Rail route codes we care about (matches config.js routeHexColors)
const RAIL_ROUTE_CODES = new Set(['801','802','803','804','805','806','807','901','910','950']);
const BUS_RAIL_CODES   = new Set(['901','910','950']); // G+J are in bus GTFS

// Metro GTFS route_id → route_code
const RAIL_NAME_MAP = {
    'Metro A Line': '801', 'Metro B Line': '802', 'Metro C Line': '803',
    'Metro E Line': '804', 'Metro D Line': '805', 'Metro K Line': '807',
    'Metro L Line': '806',
};

function routeCodeFromId(routeId) {
    if (!routeId) return null;
    // Handle full names first
    if (RAIL_NAME_MAP[routeId]) return RAIL_NAME_MAP[routeId];
    // Plain numeric (rail GTFS)
    if (RAIL_ROUTE_CODES.has(routeId)) return routeId;
    // Prefixed (bus GTFS)
    const prefix = routeId.split('-')[0];
    return BUS_RAIL_CODES.has(prefix) ? prefix : null;
}

function parseCSVLine(line) {
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuote && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
            else inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
            cols.push(cur); cur = '';
        } else {
            cur += ch;
        }
    }
    cols.push(cur);
    return cols;
}

async function readCSV(file, onRow) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        let headers = null;
        rl.on('line', line => {
            if (!line.trim()) return;
            const cols = parseCSVLine(line);
            if (!headers) { headers = cols.map(h => h.trim()); return; }
            const row = {};
            headers.forEach((h, i) => row[h] = (cols[i] || '').trim());
            onRow(row);
        });
        rl.on('close', resolve);
        rl.on('error', reject);
    });
}

async function main() {
    const shapeToRoute = {};
    const tripMeta = {}; // trip_id -> { rc, dir, srv }

    // Pass 1: Rail GTFS trips (801–807)
    console.log('Pass 1: Rail trips...');
    await readCSV(TRIPS_FILE, row => {
        const code = routeCodeFromId(row.route_id || '');
        if (code) {
            if (row.shape_id) shapeToRoute[row.shape_id] = code;
            if (row.trip_id) tripMeta[row.trip_id] = { rc: code, dir: row.direction_id, srv: row.service_id };
        }
    });

    // Pass 2: Bus GTFS trips (901, 910)
    console.log('Pass 2: Bus trips for G+J lines...');
    await readCSV(BUS_TRIPS_FILE, row => {
        const code = routeCodeFromId(row.route_id || '');
        if (code) {
            if (row.shape_id) shapeToRoute[row.shape_id] = code;
            if (row.trip_id) tripMeta[row.trip_id] = { rc: code, dir: row.direction_id, srv: row.service_id };
        }
    });

    console.log(`  Found ${Object.keys(shapeToRoute).length} total shape IDs`);

    const routePoints = {};
    const routePointsArr = {};
    for (const code of RAIL_ROUTE_CODES) {
        routePoints[code] = new Set();
        routePointsArr[code] = [];
    }

    function addPoint(row) {
        const code = shapeToRoute[row.shape_id];
        if (!code) return;
        const lat = parseFloat(row.shape_pt_lat);
        const lng = parseFloat(row.shape_pt_lon);
        if (isNaN(lat) || isNaN(lng)) return;
        const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
        if (!routePoints[code].has(key)) {
            routePoints[code].add(key);
            routePointsArr[code].push([parseFloat(lat.toFixed(5)), parseFloat(lng.toFixed(5))]);
        }
    }

    // Pass 3: Rail shapes
    console.log('Pass 3: Rail shapes...');
    let n = 0;
    await readCSV(SHAPES_FILE, row => { n++; addPoint(row); });
    console.log(`  Read ${n.toLocaleString()} rows`);

    // Pass 4: Bus shapes (only stores G/J points)
    console.log('Pass 4: Bus shapes for G+J (large file)...');
    n = 0;
    await readCSV(BUS_SHAPES_FILE, row => { n++; addPoint(row); });
    console.log(`  Scanned ${n.toLocaleString()} rows`);

    const output = {};
    for (const code of RAIL_ROUTE_CODES) {
        const pts = routePointsArr[code];
        output[code] = pts;
        console.log(`  Route ${code}: ${pts.length} unique points`);
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(output));
    const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024);
    console.log(`\nDone → ${OUT_FILE} (${sizeKB} KB)`);

    // Build trips.json
    await buildTripsJson(tripMeta);
}

function timeToSec(t) {
    if (!t) return 0;
    const parts = t.split(':');
    return parseInt(parts[0] || 0, 10) * 3600 + parseInt(parts[1] || 0, 10) * 60 + parseInt(parts[2] || 0, 10);
}

/**
 * Builds trips.json: trip_id → { dest, total, stops, scheduledTimes }
 *
 * dest           — human-readable terminus ("Pomona Station")
 * total          — max stop_sequence for the trip
 * stops          — ordered array of stop_id strings, index = stop_sequence - 1
 * scheduledTimes — parallel array of departure_time in seconds-since-midnight
 *                  (arrival_time used as fallback when departure_time is absent)
 *                  Used by predictions.js for inter-stop gap calculations.
 *
 * Sourced from:
 *   Rail (801–807): data/rail_gtfs/stop_times.txt (extracted from gtfs_rail.zip)
 *   Bus  (901/910): data/stop_times.txt (large combined file, filtered by route_code)
 */
async function buildTripsJson(tripMeta) {
    console.log('\nBuilding trips.json...');
    const tripsData = {}; // trip_id → { dest, total, stops: [] }
    const tripTimes = {}; // trip_id → max time in seconds

    function processRow(row, routeFilter) {
        const rc = routeCodeFromId((row.route_code || '').trim());
        if (routeFilter && !routeFilter.has(rc)) return;

        const tripId = (row.trip_id || '').trim();
        const stopId = (row.stop_id  || '').trim();
        const dest   = (row.destination_code || '').trim();
        const seq    = parseInt(row.stop_sequence || '0', 10);
        if (!tripId || !stopId || isNaN(seq)) return;

        if (!tripsData[tripId]) {
            const meta = tripMeta[tripId] || {};
            tripsData[tripId] = {
                dest: dest || '',
                rc: rc || meta.rc || '',
                dir: meta.dir != null ? Number(meta.dir) : null,
                total: 0,
                stops: [],
                scheduledTimes: [],
            };
        }
        const t = tripsData[tripId];
        if (!t.dest && dest) t.dest = dest;
        if (seq > t.total) t.total = seq;
        // Store stop_id at index seq-1 (sequences are 1-based)
        t.stops[seq - 1] = stopId;
        // Store departure_time (arrival_time as fallback) — pure travel gaps, no dwell inflation
        const depTime = row.departure_time || row.arrival_time;
        if (depTime) t.scheduledTimes[seq - 1] = timeToSec(depTime);

        // Track max arrival time per trip for last-train detection
        const arrTime = row.arrival_time || row.departure_time;
        if (arrTime) {
            const sec = timeToSec(arrTime);
            if (!tripTimes[tripId] || sec > tripTimes[tripId]) {
                tripTimes[tripId] = sec;
            }
        }
    }

    // Pass A: Rail stop_times (801-807) — all rows are rail
    console.log('  Pass A: Rail stop_times...');
    let n = 0;
    await readCSV(RAIL_STOP_TIMES_FILE, row => { n++; processRow(row, null); });
    console.log(`    ${n.toLocaleString()} rows read`);

    // Pass B: Bus stop_times — filter to 901, 910, 950 only
    console.log('  Pass B: Bus stop_times (901/910/950 only)...');
    const BUS_RAIL_FILTER = new Set(['901', '910', '950']);
    n = 0;
    await readCSV(BUS_STOP_TIMES_FILE, row => {
        n++;
        const rc = (row.route_code || '').trim();
        if (BUS_RAIL_FILTER.has(rc)) processRow(row, null);
    });
    console.log(`    ${n.toLocaleString()} rows scanned`);

    // Compact: fill any sparse holes in stops and scheduledTimes arrays
    for (const t of Object.values(tripsData)) {
        for (let i = 0; i < t.total; i++) {
            if (!t.stops[i]) t.stops[i] = '';
            if (t.scheduledTimes[i] == null) t.scheduledTimes[i] = 0;
        }
    }

    // Flag 'last train' per route + direction + service (exclude 24/7 lines)
    const groupLatest = {};
    const EXCLUDE_LAST_TRAIN = new Set(['901', '910', '950']);

    for (const tripId in tripsData) {
        const meta = tripMeta[tripId];
        if (!meta || EXCLUDE_LAST_TRAIN.has(meta.rc)) continue;
        const sec = tripTimes[tripId] || 0;
        const key = `${meta.rc}|${meta.dir}|${meta.srv}`;
        if (!groupLatest[key] || sec > groupLatest[key].maxSec) {
            groupLatest[key] = { tripId, maxSec: sec };
        }
    }

    let lastTrainCount = 0;
    for (const key in groupLatest) {
        const tId = groupLatest[key].tripId;
        if (tripsData[tId]) {
            tripsData[tId].isLast = true;
            lastTrainCount++;
        }
    }
    console.log(`    Marked ${lastTrainCount} trips as Last Train`);

    fs.writeFileSync(TRIPS_OUT_FILE, JSON.stringify(tripsData));
    const sizeKB = Math.round(fs.statSync(TRIPS_OUT_FILE).size / 1024);
    const tripCount = Object.keys(tripsData).length;
    console.log(`  Done → ${TRIPS_OUT_FILE} (${sizeKB} KB, ${tripCount.toLocaleString()} trips)`);
}

main().catch(err => { console.error(err); process.exit(1); });

/**
 * build-shapes.cjs
 * Pre-processes raw GTFS .txt files into the JSON artifacts the live map
 * loads at runtime.
 *
 * Run:    node scripts/build-shapes.cjs   (from repo root)
 *
 * GTFS source files are auto-downloaded from Metro's public GitLab repos if
 * they are missing from scripts/data/.  Pass --no-download to skip the
 * network fetch and fail fast instead (useful in CI when files are pre-cached).
 *
 * Outputs (committed under repo data/):
 *   - data/rail-shapes.json — per-route polylines (+ `${code}|${dir}` splits
 *                             where the two directions diverge)
 *   - data/trips.json       — trip_id → stops + scheduled times
 *   - data/bus-routes.json  — bus route metadata
 *   - data/bus-destinations.json — rider-facing bus destination_code labels
 *   - data/stops.json       — stop_id → { lat, lon, name } registry
 */

const fs   = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const GTFS_RAIL_URL = 'https://gitlab.com/LACMTA/gtfs_rail/raw/master/gtfs_rail.zip';
const GTFS_BUS_URL  = 'https://gitlab.com/LACMTA/gtfs_bus/raw/master/gtfs_bus.zip';

const DIR = __dirname;
const TRIPS_FILE            = path.join(DIR, 'data', 'rail_gtfs', 'trips.txt');
const SHAPES_FILE           = path.join(DIR, 'data', 'rail_gtfs', 'shapes.txt');
const RAIL_STOP_TIMES_FILE  = path.join(DIR, 'data', 'rail_gtfs', 'stop_times.txt');
const RAIL_STOPS_FILE       = path.join(DIR, 'data', 'rail_gtfs', 'stops.txt');
const BUS_TRIPS_FILE        = path.join(DIR, 'data', 'trips.txt');    // main combined (has 901/910)
const BUS_SHAPES_FILE       = path.join(DIR, 'data', 'shapes.txt');   // main combined
const BUS_STOP_TIMES_FILE   = path.join(DIR, 'data', 'stop_times.txt');
const BUS_ROUTES_FILE       = path.join(DIR, 'data', 'routes.txt');   // bus GTFS routes.txt
const BUS_STOPS_FILE        = path.join(DIR, 'data', 'stops.txt');
const OUT_FILE              = path.join(DIR, '..', 'data', 'rail-shapes.json');
const TRIPS_OUT_FILE        = path.join(DIR, '..', 'data', 'trips.json');
const BUS_ROUTES_OUT_FILE   = path.join(DIR, '..', 'data', 'bus-routes.json');
const BUS_DEST_OUT_FILE     = path.join(DIR, '..', 'data', 'bus-destinations.json');
const STOPS_OUT_FILE        = path.join(DIR, '..', 'data', 'stops.json');

// Rail route codes we care about (matches config.js routeHexColors)
const RAIL_ROUTE_CODES = new Set(['801','802','803','804','805','806','807','901','910','950']);

// Minimum max-divergence between a route's two direction polylines (metres)
// before we emit separate `${code}|0` / `${code}|1` shapes. 25 m is above the
// two-track centerline separation (~3–15 m) and urban GPS scatter, but well
// below the rider-visible couplet/loop errors this split exists to fix (A Line
// Long Beach loop ~400 m, J Line downtown couplet ~120–420 m, B Line ~30 m).
const DIRECTION_SPLIT_MIN_M = 25;

// Planar metres per degree at LA latitude — mirrors js/utils.js so the
// build-time divergence metric matches the runtime snap metric.
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_LA = 92630;

/**
 * Max distance (metres) from any vertex of polyline A to the nearest point on
 * polyline B — a one-sided Hausdorff-style divergence used to decide whether a
 * route's two directions are far enough apart to warrant separate shapes.
 * Equirectangular projection at fixed LA latitude (same metric as snap.js).
 * @param {Array<[number,number]>} a  [lat,lng] points
 * @param {Array<[number,number]>} b  [lat,lng] points
 * @returns {number}
 */
function maxPolylineDivergence(a, b) {
    let worst = 0;
    for (const [lat, lng] of a) {
        let best = Infinity;
        for (let i = 0; i < b.length - 1; i++) {
            const ay = b[i][0],   ax = b[i][1];
            const by = b[i + 1][0], bx = b[i + 1][1];
            const aby = (by - ay) * M_PER_DEG_LAT, abx = (bx - ax) * M_PER_DEG_LNG_LA;
            const qy  = (lat - ay) * M_PER_DEG_LAT, qx = (lng - ax) * M_PER_DEG_LNG_LA;
            const ab2 = aby * aby + abx * abx;
            const t   = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (qy * aby + qx * abx) / ab2));
            const cy  = ay + t * (by - ay), cx = ax + t * (bx - ax);
            const d   = Math.hypot((lat - cy) * M_PER_DEG_LAT, (lng - cx) * M_PER_DEG_LNG_LA);
            if (d < best) best = d;
        }
        if (best > worst) worst = best;
    }
    return worst;
}
const BUS_RAIL_CODES   = new Set(['901','910','950']); // G+J are in bus GTFS
// Rail routes sourced from the RAIL GTFS feed = everything except the G/J
// busways (which live in the bus GTFS). Derived from the two sets above so the
// three route-code groupings can't drift if a line is added/retired.
const RAIL_GTFS_CODES  = new Set([...RAIL_ROUTE_CODES].filter(c => !BUS_RAIL_CODES.has(c)));

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

/**
 * Download both Metro GTFS zips and extract them into scripts/data/.
 * Uses curl (available on Win 10+, macOS, Linux) for download and the
 * platform-native unzip command for extraction.
 */
async function downloadGtfs() {
    const dataDir   = path.join(DIR, 'data');
    const railDir   = path.join(dataDir, 'rail_gtfs');
    const railZip   = path.join(dataDir, 'gtfs_rail.zip');
    const busZip    = path.join(dataDir, 'gtfs_bus.zip');
    fs.mkdirSync(railDir, { recursive: true });

    console.log('Downloading Metro GTFS rail...');
    execSync(`curl -sSL -o "${railZip}" "${GTFS_RAIL_URL}"`, { stdio: 'inherit' });
    console.log('Downloading Metro GTFS bus (large — may take ~30 s)...');
    execSync(`curl -sSL -o "${busZip}" "${GTFS_BUS_URL}"`, { stdio: 'inherit' });

    console.log('Extracting...');
    if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Force '${railZip}' '${railDir}'"`, { stdio: 'inherit' });
        execSync(`powershell -Command "Expand-Archive -Force '${busZip}' '${dataDir}'"`, { stdio: 'inherit' });
    } else {
        execSync(`unzip -oq "${railZip}" -d "${railDir}"`, { stdio: 'inherit' });
        execSync(`unzip -oq "${busZip}" -d "${dataDir}"`, { stdio: 'inherit' });
    }
    fs.unlinkSync(railZip);
    fs.unlinkSync(busZip);
    console.log('GTFS download complete.\n');
}

async function main() {
    const noDownload = process.argv.includes('--no-download');
    if (!fs.existsSync(TRIPS_FILE) || !fs.existsSync(BUS_TRIPS_FILE)) {
        if (noDownload) {
            console.error('ERROR: GTFS source files missing and --no-download was set.');
            process.exit(1);
        }
        console.log('GTFS source files not found — downloading from Metro...');
        await downloadGtfs();
    }

    // shape_id → Set<route_code>. Multi-valued so a shape can belong to more than
    // one route. Route 950 (J Line San Pedro) has NO distinct alignment in the
    // current GTFS: Metro publishes both 910 and 950 J Line trips under the single
    // 910 route prefix, so 950 is registered below by copying 910's busway shape
    // set verbatim (910's canonical shape already reaches San Pedro). If a future
    // GTFS ever gives 950 its own shape_ids, register them at the Pass 2 block.
    // The old single-value map was last-write-wins, so whichever code happened to
    // iterate later in trips.txt claimed *all* shared shapes and the other route
    // ended up with 0 polyline points in the JSON output.
    const shapeToRoute = {};
    const addShapeRoute = (shape_id, code) => {
        if (!shape_id || !code) return;
        if (!shapeToRoute[shape_id]) shapeToRoute[shape_id] = new Set();
        shapeToRoute[shape_id].add(code);
    };
    // Parallel map for the per-DIRECTION build (Pass 5). Keyed the same way as
    // shapeToRoute but the values are composite `${code}|${dir}` codes, so the
    // SAME buildCanonicalShapes() picks the longest shape per route-direction
    // with zero new logic. A vehicle's NB and SB alignments diverge sharply on
    // one-way couplets (J Line downtown ~120 m apart) and loop terminals (A Line
    // Long Beach Pacific Ave arm ~400 m off the SB shape); the single canonical
    // shape (one direction) snaps the OTHER direction onto the wrong street.
    const shapeToCodeDir = {};
    const addShapeCodeDir = (shape_id, code, dir) => {
        if (!shape_id || !code || (dir !== '0' && dir !== '1')) return;
        const cd = `${code}|${dir}`;
        if (!shapeToCodeDir[shape_id]) shapeToCodeDir[shape_id] = new Set();
        shapeToCodeDir[shape_id].add(cd);
    };
    const tripMeta = {}; // trip_id -> { rc, dir, srv }

    // Pass 1: Rail GTFS trips (801–807)
    console.log('Pass 1: Rail trips...');
    await readCSV(TRIPS_FILE, row => {
        const code = routeCodeFromId(row.route_id || '');
        if (code) {
            addShapeRoute(row.shape_id, code);
            addShapeCodeDir(row.shape_id, code, row.direction_id);
            if (row.trip_id) tripMeta[row.trip_id] = { rc: code, dir: row.direction_id, srv: row.service_id };
        }
    });

    // Pass 2: Bus GTFS trips (901, 910, 950)
    // Metro publishes 910 and 950 under a single route_id (910-13196), so
    // routeCodeFromId returns '910' for all J Line trips. Register each shape
    // under both 910 and 950 so 950 vehicles get polyline snap data too.
    console.log('Pass 2: Bus trips for G+J lines...');
    await readCSV(BUS_TRIPS_FILE, row => {
        const code = routeCodeFromId(row.route_id || '');
        if (code) {
            addShapeRoute(row.shape_id, code);
            addShapeCodeDir(row.shape_id, code, row.direction_id);
            if (code === '910') {
                addShapeRoute(row.shape_id, '950');
                addShapeCodeDir(row.shape_id, '950', row.direction_id);
            }
            if (row.trip_id) tripMeta[row.trip_id] = { rc: code, dir: row.direction_id, srv: row.service_id };
        }
    });

    console.log(`  Found ${Object.keys(shapeToRoute).length} total shape IDs`);

    // Rail (801–807) and bus G/J (901/910/950) both build ONE canonical polyline
    // per route: the longest associated shape_id, emitted in shape_pt_sequence
    // order. This yields a single clean directional alignment per route with a
    // monotonic arc length. (Rail previously unioned ALL of a route's shape
    // variants in shapes.txt file order, deduped by rounded coordinate — a
    // scrambled, non-monotonic polyline, e.g. the A Line came out ~186 km. That
    // broke the direction-aware arc math in predictions.js. See buildCanonicalShapes.)
    const routePointsArr = {};
    for (const code of RAIL_ROUTE_CODES) routePointsArr[code] = [];

    console.log('Pass 3: Rail shapes (canonical longest shape, sequence order)...');
    const railBuilt = await buildCanonicalShapes(SHAPES_FILE, RAIL_GTFS_CODES, shapeToRoute);
    for (const code of RAIL_GTFS_CODES) routePointsArr[code] = railBuilt.shapes[code] ?? [];

    console.log('Pass 4: Bus G/J shapes (canonical longest shape, sequence order)...');
    const busBuilt = await buildCanonicalShapes(BUS_SHAPES_FILE, BUS_RAIL_CODES, shapeToRoute);
    for (const code of BUS_RAIL_CODES) routePointsArr[code] = busBuilt.shapes[code] ?? [];

    // Log the canonical shape chosen per route (rail + bus).
    for (const code of RAIL_ROUTE_CODES) {
        const built = RAIL_GTFS_CODES.has(code) ? railBuilt : busBuilt;
        const shid  = built.canonical[code];
        if (shid) console.log(`  Route ${code}: canonical shape ${shid} (${built.pointCount[`${shid}|${code}`]} pts)`);
        else      console.log(`  Route ${code}: no canonical shape found (0 pts in output)`);
    }

    const output = {};
    for (const code of RAIL_ROUTE_CODES) {
        const pts = routePointsArr[code];
        output[code] = pts;
        console.log(`  Route ${code}: ${pts.length} points`);
    }

    // Pass 5: per-direction shapes. Feed the SAME buildCanonicalShapes the
    // composite `${code}|${dir}` codes so it picks the longest shape per
    // route-direction. Emit a `${code}|${dir}` key ONLY where the two
    // directions diverge beyond DIRECTION_SPLIT_MIN_M — below that the
    // directions are within GPS-noise + two-track scale and the single bare
    // centerline is an acceptable shared representation, so we don't pay the
    // data cost. The bare `${code}` key is left untouched (still the longest
    // overall shape = one direction), so every direction-agnostic consumer
    // (cross-line guard, hasShapeData, the direction-null fallback) is
    // byte-for-byte unchanged; the direction keys are purely additive.
    console.log('Pass 5: Per-direction shapes (split where directions diverge)...');
    const railDirCodes = new Set();
    const busDirCodes  = new Set();
    for (const cds of Object.values(shapeToCodeDir)) {
        for (const cd of cds) {
            const code = cd.slice(0, cd.indexOf('|'));
            (RAIL_GTFS_CODES.has(code) ? railDirCodes : busDirCodes).add(cd);
        }
    }
    const railDir = await buildCanonicalShapes(SHAPES_FILE,     railDirCodes, shapeToCodeDir);
    const busDir  = await buildCanonicalShapes(BUS_SHAPES_FILE, busDirCodes,  shapeToCodeDir);
    const dirShapes = { ...railDir.shapes, ...busDir.shapes }; // `code|dir` -> pts

    for (const code of RAIL_ROUTE_CODES) {
        const d0 = dirShapes[`${code}|0`], d1 = dirShapes[`${code}|1`];
        if (!d0?.length || !d1?.length) continue; // need both directions to split
        const div = maxPolylineDivergence(d0, d1);
        if (div < DIRECTION_SPLIT_MIN_M) {
            console.log(`  Route ${code}: shared centerline (divergence ${div.toFixed(0)} m < ${DIRECTION_SPLIT_MIN_M} m)`);
            continue;
        }
        // Emit ONLY the non-canonical direction. The bare `${code}` key already
        // holds the canonical (longest-overall) shape, which IS one direction's
        // alignment, so resolveShapeKey() falls back to it for that direction —
        // storing it again under `${code}|${dir}` would duplicate the largest
        // polyline in the file. Identify the canonical direction by shape_id
        // (the bare canonical equals exactly one direction's canonical).
        const built   = RAIL_GTFS_CODES.has(code) ? railBuilt : busBuilt;
        const dBuilt  = RAIL_GTFS_CODES.has(code) ? railDir   : busDir;
        const bareShid = built.canonical[code];
        const emitted = [];
        for (const dir of ['0', '1']) {
            if (dBuilt.canonical[`${code}|${dir}`] === bareShid) continue; // canonical dir → served by bare
            output[`${code}|${dir}`] = dirShapes[`${code}|${dir}`];
            emitted.push(`${code}|${dir} (${dirShapes[`${code}|${dir}`].length})`);
        }
        console.log(`  Route ${code}: SPLIT (divergence ${div.toFixed(0)} m) → bare ${code} (${output[code].length}) + ${emitted.join(' + ')}`);
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(output));
    const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024);
    console.log(`\nDone → ${OUT_FILE} (${sizeKB} KB)`);

    // Build trips.json
    await buildTripsJson(tripMeta);

    // Build bus-routes.json (route_id → { short_name, long_name }) for popup labeling
    await buildBusRoutesJson();

    // Build bus-destinations.json (rider-facing destination_code labels)
    await buildBusDestinationsJson();

    // Build stops.json (stop_id → { lat, lon, name }) — the runtime stop registry
    await buildStopsJson();
}

/**
 * Builds data/bus-routes.json: route_code → { short_name, long_name }
 *
 * Sourced from the bus GTFS routes.txt (route_type === 3 only).
 * Metro's bus GTFS leaves route_color empty and uses a generic route_long_name
 * ("Metro Local Line"); the descriptive corridor name lives in route_desc, so
 * we prefer route_desc and fall back to route_long_name.
 *
 * Used at runtime to render "33 — Downtown LA / Santa Monica via Venice Bl"
 * in the nearby-buses section of the station popup.
 */
async function buildBusRoutesJson() {
    if (!fs.existsSync(BUS_ROUTES_FILE)) {
        console.log(`\nSkipping bus-routes.json — ${BUS_ROUTES_FILE} not found.`);
        return;
    }
    console.log('\nBuilding bus-routes.json...');
    const out = {};
    await readCSV(BUS_ROUTES_FILE, row => {
        if (row.route_type !== '3') return;
        const code = (row.route_id || '').split('-')[0];
        if (!code) return;
        out[code] = {
            short_name: row.route_short_name || code,
            long_name:  (row.route_desc || row.route_long_name || '').trim(),
        };
    });
    const sorted = {};
    for (const k of Object.keys(out).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
        sorted[k] = out[k];
    }
    fs.writeFileSync(BUS_ROUTES_OUT_FILE, JSON.stringify(sorted, null, 2));
    const sizeKB = Math.round(fs.statSync(BUS_ROUTES_OUT_FILE).size / 1024);
    console.log(`  Done → ${BUS_ROUTES_OUT_FILE} (${sizeKB} KB, ${Object.keys(sorted).length} routes)`);
}

/**
 * Builds data/bus-destinations.json — rider-facing bus destination labels.
 *
 * Metro's bus GTFS leaves `trip_headsign` EMPTY, but every stop_times row carries
 * a populated `destination_code` (e.g. "Santa Monica", "Vermont / Athens
 * Station") — the destination printed on the bus's headsign, which is what bus
 * riders actually recognize. The live feed's terminus is the last *stop* (often
 * an obscure intersection/layover), so we prefer destination_code in the
 * nearby-buses section of the station popup.
 *
 * Shape (compact, ~17 KB gzipped, ZERO mislabels):
 *   { dests: [ ...unique strings... ],
 *     byRouteDir: { "route|dir": destIdx },  // dominant destination per (route,direction)
 *     byTrip:     { tripId: destIdx } }       // ONLY trips whose dest differs from
 *                                             // their (route,direction) dominant
 * Runtime resolves: byTrip[tripId] ?? byRouteDir[`route|dir`] ?? (live-terminus fallback).
 * byTrip carries only the minority branch / short-turn trips (≈12% of trips) — a
 * 111-to-Inglewood among mostly-LAX trips — so the file stays tiny while every
 * trip still resolves to its TRUE destination, not a per-direction approximation.
 *
 * direction_id comes from the bus trips.txt (tripMeta covers only rail + G/J);
 * destination_code + route_code come from the bus stop_times.txt.
 */
async function buildBusDestinationsJson() {
    if (!fs.existsSync(BUS_TRIPS_FILE) || !fs.existsSync(BUS_STOP_TIMES_FILE)) {
        console.log('\nSkipping bus-destinations.json — bus GTFS source not found.');
        return;
    }
    console.log('\nBuilding bus-destinations.json...');

    // Pass 1: trip_id → direction_id (small file).
    const tripDir = {};
    await readCSV(BUS_TRIPS_FILE, row => {
        if (row.trip_id) tripDir[row.trip_id] = (row.direction_id || '').trim();
    });

    // Pass 2: first destination_code + route_code per trip (large file — one row
    // per trip suffices; destination_code is constant along a trip's stops).
    const tripDest = {}; // trip_id → { rc, dest }
    await readCSV(BUS_STOP_TIMES_FILE, row => {
        const tid = (row.trip_id || '').trim();
        if (!tid || tripDest[tid]) return;
        const dest = (row.destination_code || '').trim();
        if (!dest) return;
        // Normalize the route_code the SAME way the runtime does (splitRouteId
        // strips any `-suffix`) so the byRouteDir key matches the live-feed lookup
        // BY CONSTRUCTION — not just by the advisory non-bare-key warning below.
        const rc = (row.route_code || '').trim().split('-')[0];
        tripDest[tid] = { rc, dest };
    });

    // Tally destinations per (route|dir) and pick the dominant one.
    const pairCounts = {}; // "rc|dir" → Map(dest → count)
    for (const tid in tripDest) {
        const { rc, dest } = tripDest[tid];
        const key = `${rc}|${tripDir[tid] || ''}`;
        (pairCounts[key] ||= new Map()).set(dest, (pairCounts[key].get(dest) || 0) + 1);
    }
    const dominant = {}; // "rc|dir" → dest
    for (const key in pairCounts) {
        let best = null, bestN = -1;
        for (const [d, n] of pairCounts[key]) if (n > bestN) { best = d; bestN = n; }
        dominant[key] = best;
    }

    // Dedup destination strings → sorted index table (deterministic output).
    const dests = [...new Set(Object.values(tripDest).map(x => x.dest))].sort();
    const didx = new Map(dests.map((d, i) => [d, i]));

    // byRouteDir keys are `route|dir`. The runtime (resolveBusDestination) only
    // ever queries dir 0/1, so a key with an EMPTY direction (a trip whose GTFS
    // row lacked direction_id) is unmatchable dead weight — skip it. Currently
    // every bus trip has a direction, so this is purely defensive.
    const byRouteDir = {};
    let droppedEmptyDir = 0;
    for (const key of Object.keys(dominant).sort()) {
        if (key.endsWith('|')) { droppedEmptyDir++; continue; }
        byRouteDir[key] = didx.get(dominant[key]);
    }

    // byTrip: only trips whose dest differs from their (route|dir) dominant.
    const byTrip = {};
    for (const tid of Object.keys(tripDest).sort()) {
        const { rc, dest } = tripDest[tid];
        const key = `${rc}|${tripDir[tid] || ''}`;
        if (dest !== dominant[key]) byTrip[tid] = didx.get(dest);
    }

    // Silent-breakage guard. The runtime matches these keys against the LIVE
    // feed's `splitRouteId(routeId)` (bare numeric) + literal direction 0/1. If a
    // future GTFS revision changes the bus `route_code` shape (e.g. adds a
    // `-suffix`) or drops direction_id, the keys stop matching and the feature
    // silently reverts to the terminus-stop fallback with NO error. Warn loudly
    // at build time so the weekly-rebuild PR surfaces it instead.
    const nonBareRoutes = [...new Set(Object.keys(byRouteDir).map(k => k.slice(0, k.lastIndexOf('|'))))]
        .filter(r => !/^\d+$/.test(r));
    if (nonBareRoutes.length) {
        console.warn(`  ⚠ bus-destinations: ${nonBareRoutes.length} non-numeric route code(s) ` +
                     `— runtime splitRouteId yields bare codes, so these will NOT match: ` +
                     `${JSON.stringify(nonBareRoutes.slice(0, 10))}`);
    }
    if (droppedEmptyDir) {
        console.warn(`  ⚠ bus-destinations: dropped ${droppedEmptyDir} route|dir key(s) with no ` +
                     `direction_id (GTFS direction coverage regressed — those routes lose their ` +
                     `dominant-destination fallback).`);
    }

    fs.writeFileSync(BUS_DEST_OUT_FILE, JSON.stringify({ dests, byRouteDir, byTrip }));
    const sizeKB = Math.round(fs.statSync(BUS_DEST_OUT_FILE).size / 1024);
    console.log(`  Done → ${BUS_DEST_OUT_FILE} (${sizeKB} KB; ${dests.length} dests, ` +
                `${Object.keys(byRouteDir).length} route-dirs, ${Object.keys(byTrip).length} branch trips)`);
}

/**
 * Builds data/stops.json: stop_id → { lat, lon, name }
 *
 * Merges the bus GTFS stops.txt (the full ~12k-stop system registry) with the
 * rail GTFS stops.txt (80xxx platform/station IDs, incl. lettered platform
 * variants and `S`-suffixed parent stations — the live feed references these
 * directly, so ALL location_types are kept, mirroring the historical file).
 * Rail wins on key collision (its coordinates are platform-accurate).
 *
 * stops.json previously had NO builder — it was generated once by hand and
 * went stale silently (the weekly rebuild-gtfs workflow refreshed the other
 * three artifacts but not this one, and the drift check's 5% alarm can't see
 * a handful of missing stops, e.g. the G Line Sepulveda pair 6140/6139 that
 * all 700 G Line trips reference). Emitting it here puts it on the same
 * weekly refresh as everything else.
 */
async function buildStopsJson() {
    if (!fs.existsSync(BUS_STOPS_FILE) || !fs.existsSync(RAIL_STOPS_FILE)) {
        console.log('\nSkipping stops.json — GTFS stops.txt not found.');
        return;
    }
    console.log('\nBuilding stops.json...');
    const out = {};
    let skipped = 0;
    const addRow = row => {
        const id   = (row.stop_id || '').trim();
        const lat  = parseFloat(row.stop_lat);
        const lon  = parseFloat(row.stop_lon);
        const name = (row.stop_name || '').trim();
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) { skipped++; return; }
        out[id] = { lat, lon, name };
    };
    await readCSV(BUS_STOPS_FILE, addRow);
    await readCSV(RAIL_STOPS_FILE, addRow); // after bus: rail wins collisions
    // Deterministic numeric-aware key order so rebuild diffs are reviewable.
    const sorted = {};
    for (const k of Object.keys(out).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
        sorted[k] = out[k];
    }
    fs.writeFileSync(STOPS_OUT_FILE, JSON.stringify(sorted));
    const sizeKB = Math.round(fs.statSync(STOPS_OUT_FILE).size / 1024);
    console.log(`  Done → ${STOPS_OUT_FILE} (${sizeKB} KB, ${Object.keys(sorted).length} stops${skipped ? `, ${skipped} rows skipped` : ''})`);
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

/**
 * Pick the canonical (highest-point-count) shape per route_code from a flat
 * map keyed by `${shape_id}|${route_code}`. Pure helper, exported for tests.
 *
 *   Input: { 's1|910': 22, 's1|950': 22, 's2|950': 34, 's3|901': 18 }
 *   Output: { '910': 's1', '950': 's2', '901': 's3' }
 *
 * Tie-breaks deterministically: the first code-tied entry encountered in
 * Object.entries order wins (insertion order in modern JS).
 */
function pickCanonicalByCode(pointCount) {
    const canonical = {};
    for (const [k, cnt] of Object.entries(pointCount)) {
        const sep = k.indexOf('|');
        if (sep < 0) continue;
        const shid = k.slice(0, sep);
        const code = k.slice(sep + 1);
        const cur = canonical[code];
        if (!cur || cnt > pointCount[`${cur}|${code}`]) {
            canonical[code] = shid;
        }
    }
    return canonical;
}

/**
 * Clean a polyline of two GTFS digitization artifacts (both verified present
 * in Metro's shapes and both harmful to snap/arc math):
 *
 *  1. Consecutive duplicate vertices (zero-length segments — 40 in the J Line
 *     shape). Tolerated at runtime by snap.js's degenerate guards, but they
 *     waste bytes and shrink the tangent window to nothing around the dup run.
 *  2. Micro-backtracks: a vertex B in A→B→C where the path reverses on itself
 *     (turn angle > 165°) over a short hop (< 20 m) — a digitization zigzag,
 *     not real track (the D Line had a 15 m backtrack at Wilshire/Vermont, the
 *     only bearing reversals in the dataset). It adds ~2× the hop of phantom
 *     arc length and a momentarily reversed tangent for every passing train.
 *     Real geometry is safe: genuine switchbacks/loop turns are far longer
 *     than 20 m, and a real 90° street corner is nowhere near 165°.
 *
 * Iterates until stable (removing a backtrack can create a new adjacent dup).
 * Exported for tests.
 * @param {Array<[number,number]>} pts  [lat, lng] points
 * @returns {Array<[number,number]>}
 */
function cleanPolyline(pts) {
    const BACKTRACK_MIN_TURN_DEG = 165;
    const BACKTRACK_MAX_HOP_M = 20;
    const segM = (a, b) => Math.hypot((b[0] - a[0]) * M_PER_DEG_LAT, (b[1] - a[1]) * M_PER_DEG_LNG_LA);
    let out = pts;
    for (let pass = 0; pass < 5; pass++) {
        const next = [];
        let changed = false;
        for (let i = 0; i < out.length; i++) {
            const prev = next[next.length - 1];
            const cur  = out[i];
            // 1. consecutive duplicate
            if (prev && prev[0] === cur[0] && prev[1] === cur[1]) { changed = true; continue; }
            // 2. micro-backtrack: test the last accepted vertex B against its
            // neighbors A (before it) and C (= cur).
            if (next.length >= 2) {
                const a = next[next.length - 2], b = prev, c = cur;
                const ab = segM(a, b), bc = segM(b, c);
                if (ab > 0 && bc > 0 && Math.min(ab, bc) < BACKTRACK_MAX_HOP_M) {
                    const dot = ((b[0] - a[0]) * (c[0] - b[0]) * M_PER_DEG_LAT * M_PER_DEG_LAT
                               + (b[1] - a[1]) * (c[1] - b[1]) * M_PER_DEG_LNG_LA * M_PER_DEG_LNG_LA);
                    const cos = dot / (ab * bc);
                    // turn angle > 165° ⇔ cos(angle between AB and BC) < cos(165°)
                    if (cos < Math.cos(BACKTRACK_MIN_TURN_DEG * Math.PI / 180)) {
                        next.pop();
                        changed = true;
                    }
                }
            }
            next.push(cur);
        }
        out = next;
        if (!changed) break;
    }
    return out;
}

/**
 * Build one canonical polyline per route_code from a shapes.txt file.
 *
 * For each route, the canonical shape is its longest associated shape_id (by
 * point count); its points are emitted in `shape_pt_sequence` order so the
 * polyline is a single clean directional alignment with monotonically
 * increasing arc length. This is the construction the bus path always used;
 * unifying rail onto it fixes the scrambled-union polylines that broke the
 * direction-aware arc math in predictions.js (a route's stops now project to
 * a monotonic arc sequence — increasing for the direction matching the shape,
 * decreasing for the reverse, which predictions.js orients per direction).
 *
 * @param {string} shapesFile          Path to a GTFS shapes.txt
 * @param {Set<string>} codes          Route codes to build (e.g. rail 801–807)
 * @param {Object<string,Set<string>>} shapeToRoute  shape_id → Set<route_code>
 * @returns {Promise<{shapes:Object<string,Array<[number,number]>>, canonical:Object<string,string>, pointCount:Object<string,number>}>}
 */
async function buildCanonicalShapes(shapesFile, codes, shapeToRoute) {
    // Pass 1: count points per (shape_id, route_code) so we can pick the longest.
    const pointCount = {}; // `${shape_id}|${code}` → count
    await readCSV(shapesFile, row => {
        const shid = row.shape_id;
        const shapeCodes = shid ? shapeToRoute[shid] : null;
        if (!shapeCodes) return;
        for (const code of shapeCodes) {
            if (!codes.has(code)) continue;
            const k = `${shid}|${code}`;
            pointCount[k] = (pointCount[k] || 0) + 1;
        }
    });

    const canonical = pickCanonicalByCode(pointCount); // code → canonical shape_id
    // Reverse index: shape_id → [codes for which it is canonical] (a single
    // shape can be canonical for >1 code, e.g. J Line 910 & 950 sharing a shape).
    const reverse = {};
    for (const [code, shid] of Object.entries(canonical)) {
        (reverse[shid] = reverse[shid] || []).push(code);
    }

    // Pass 2: read only canonical shapes, buffering points to sort by sequence.
    const seqBuffer = {};
    for (const code of codes) seqBuffer[code] = [];
    await readCSV(shapesFile, row => {
        const shid = row.shape_id;
        const codesForShape = shid ? reverse[shid] : null;
        if (!codesForShape) return;
        const lat = parseFloat(row.shape_pt_lat);
        const lng = parseFloat(row.shape_pt_lon);
        const seq = parseInt(row.shape_pt_sequence, 10);
        if (isNaN(lat) || isNaN(lng) || isNaN(seq)) return;
        const pt = { seq, lat: parseFloat(lat.toFixed(5)), lng: parseFloat(lng.toFixed(5)) };
        for (const code of codesForShape) seqBuffer[code].push(pt);
    });

    const shapes = {};
    for (const code of codes) {
        shapes[code] = cleanPolyline(seqBuffer[code].sort((a, b) => a.seq - b.seq).map(p => [p.lat, p.lng]));
    }
    return { shapes, canonical, pointCount };
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { pickCanonicalByCode, buildCanonicalShapes, maxPolylineDivergence, cleanPolyline, buildBusDestinationsJson };

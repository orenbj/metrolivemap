/**
 * build-intersections.cjs
 *
 * Downloads the LA Metro light-rail intersections KML (published as a Google My
 * Maps layer) and writes data/light-rail-intersections.json — used at runtime
 * to distinguish "stopped at a real crossing" from "speed=0 due to GPS dropout
 * in a tunnel or elevated section."
 *
 * Source map (~263 Point placemarks: gated crossings + traffic-light controlled):
 *   https://www.google.com/maps/d/viewer?mid=1l8_hVErM7_4OpHQ-n9eBQTxUnP9cOxo
 *
 * Output shape:
 *   [{ "name": "Crenshaw", "lat": 34.023, "lng": -118.335, "type": "gated" }, …]
 *
 * Run:    node scripts/build-intersections.cjs   (from repo root)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KML_URL = 'https://www.google.com/maps/d/kml?mid=1l8_hVErM7_4OpHQ-n9eBQTxUnP9cOxo&forcekml=1';

const DIR       = __dirname;
const KMZ_FILE  = path.join(DIR, 'data', 'light-rail-intersections.kmz');
const KML_FILE  = path.join(DIR, 'data', 'doc.kml');
const OUT_FILE  = path.join(DIR, '..', 'data', 'light-rail-intersections.json');

/**
 * Map a placemark description to a normalized crossing type.
 * Source uses free-form text like "Gated Crossing" / "Traffic Light Controlled".
 */
function classifyType(desc) {
    if (!desc) return 'unknown';
    const d = desc.toLowerCase();
    if (d.includes('gated') || d.includes('gate'))     return 'gated';
    if (d.includes('traffic') || d.includes('signal')) return 'traffic_light';
    return 'unknown';
}

/**
 * Lightweight KML Placemark parser. KML is XML, but the structure we care
 * about is shallow and uniform — regex over `<Placemark>…</Placemark>` blocks
 * is sufficient and avoids pulling in a dependency.
 */
function parsePlacemarks(kml) {
    const out = [];
    const re  = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g;
    let match;
    while ((match = re.exec(kml)) !== null) {
        const block = match[1];

        // Point intersections only (skip LineString segments).
        const ptMatch = block.match(/<Point[^>]*>[\s\S]*?<coordinates>([^<]+)<\/coordinates>[\s\S]*?<\/Point>/);
        if (!ptMatch) continue;

        const coords = ptMatch[1].trim().split(',').map(parseFloat);
        if (coords.length < 2 || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
        const lng = coords[0];
        const lat = coords[1];

        const nameMatch = block.match(/<name[^>]*>([^<]*)<\/name>/);
        const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/);
        const rawDesc   = (descMatch?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        out.push({
            name: (nameMatch?.[1] || '').trim() || null,
            lat,
            lng,
            type: classifyType(rawDesc),
        });
    }
    return out;
}

async function download() {
    fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
    console.log('Downloading LA Metro intersections KML...');
    // forcekml=1 returns raw KML on most queries, but Google may still serve
    // KMZ (zipped) — handle both. curl follows redirects via -L.
    execSync(`curl -sSL -o "${KMZ_FILE}" "${KML_URL}"`, { stdio: 'inherit' });

    // Sniff the first two bytes: KMZ files start with "PK" (zip magic).
    const fd = fs.openSync(KMZ_FILE, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);

    if (buf[0] === 0x50 && buf[1] === 0x4B) {
        // KMZ — extract doc.kml from the zip.
        console.log('Response is KMZ — extracting...');
        if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Force '${KMZ_FILE}' '${path.join(DIR, 'data')}'"`,
                { stdio: 'inherit' });
        } else {
            execSync(`unzip -oq "${KMZ_FILE}" -d "${path.join(DIR, 'data')}"`, { stdio: 'inherit' });
        }
        fs.unlinkSync(KMZ_FILE);
        return fs.readFileSync(KML_FILE, 'utf8');
    }
    // Raw KML — rename and read.
    fs.renameSync(KMZ_FILE, KML_FILE);
    return fs.readFileSync(KML_FILE, 'utf8');
}

async function main() {
    const noDownload = process.argv.includes('--no-download');
    let kml;
    if (fs.existsSync(KML_FILE) && noDownload) {
        console.log('Using cached doc.kml (--no-download).');
        kml = fs.readFileSync(KML_FILE, 'utf8');
    } else {
        kml = await download();
    }

    const intersections = parsePlacemarks(kml);
    if (intersections.length === 0) {
        console.error('ERROR: parsed 0 Placemarks — KML format may have changed.');
        process.exit(1);
    }

    // Sort by lat then lng for deterministic output (smaller git diffs on rebuilds).
    intersections.sort((a, b) => a.lat - b.lat || a.lng - b.lng);

    fs.writeFileSync(OUT_FILE, JSON.stringify(intersections) + '\n');
    const byType = intersections.reduce((acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
    }, {});
    console.log(`\nWrote ${intersections.length} intersections → ${OUT_FILE}`);
    console.log('  By type:', byType);
}

main().catch(err => { console.error(err); process.exit(1); });

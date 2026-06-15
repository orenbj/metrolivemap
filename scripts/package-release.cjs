/**
 * package-release.cjs
 * Assemble a self-hostable static bundle of Metro Live Map.
 *
 * The app has NO build step — the "bundle" is simply the runtime files served
 * as-is. This script copies that runtime file set into dist/, stamps the
 * version, writes a self-hosting README + a portable (root-targeted) 404.html,
 * then produces a .zip + .sha256 checksum.
 *
 * Run:    node scripts/package-release.cjs   (from repo root)
 *
 * Outputs (all under the gitignored dist/):
 *   - dist/metrolivemap-v<version>/          the unpacked bundle
 *   - dist/metrolivemap-v<version>.zip       the distributable
 *   - dist/metrolivemap-v<version>.zip.sha256
 *
 * Requires the `zip` CLI (preinstalled on Linux/macOS and the GitHub ubuntu
 * runners). No npm dependencies — pure Node + crypto.
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { execFileSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..');
const pkg     = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;
const NAME    = `metrolivemap-v${VERSION}`;
const DIST    = path.join(ROOT, 'dist');
const OUT     = path.join(DIST, NAME);

// The runtime file set — everything the app needs at its origin, nothing else.
// Dev/infra (scripts/, tests/, docs/, .github/, node_modules/, package*.json,
// lint/test configs, CLAUDE.md, the GitHub-Pages CNAME, raw GTFS) is excluded
// by omission. 404.html is generated below (the repo's copy is GitHub-Pages
// specific), so it is intentionally NOT in this list.
const INCLUDE = [
    'index.html', 'manifest.json', 'sw.js',
    'js', 'styles', 'images', 'vendor',
    'data',                 // built JSON only — raw GTFS *.txt/*.zip are gitignored
    'LICENSE', 'NOTICE.md',
];

// Built data the app fetches at runtime; fail loudly if the tree wasn't built.
const REQUIRED_DATA = [
    'stops.json', 'trips.json', 'rail-shapes.json',
    'bus-routes.json', 'metro-micro-zones.json',
];

const log = (...a) => console.log('[package]', ...a);

function shortSha() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
            .toString().trim();
    } catch {
        return 'unknown';
    }
}

// Root-targeted 404 for the bundle. The repo's 404.html detects github.io and
// redirects to /metrolivemap/; a self-host needs the site root instead. A
// SUBPATH deployment should configure its static host to fall back to
// index.html for unknown routes (the proper SPA fix) — noted inline.
function portable404() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Metro Live Map</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- Self-host 404: redirects to the site ROOT. If you serve the app under a
         subpath, configure your static host to fall back to index.html for
         unknown routes (the proper SPA fix), or change the "/" targets below. -->
    <meta http-equiv="refresh" content="0;url=/">
    <link rel="canonical" href="/">
    <style>
        body { font-family: 'Open Sans', system-ui, sans-serif; background: #f5f5f5; color: #222; margin: 0; padding: 2rem; text-align: center; }
        a { color: #0072bc; }
    </style>
</head>
<body>
    <h1>Page not found</h1>
    <p>Redirecting to the <a href="/">Metro Live Map</a>&hellip;</p>
    <script>location.replace('/');</script>
</body>
</html>
`;
}

function bundleReadme(version, sha) {
    return `# Metro Live Map — self-hosted bundle (v${version})

This is a **self-contained static build** of Metro Live Map (commit \`${sha}\`).
There is no build step: serve these files from any static web host.

## Quick start

1. Copy everything in this folder to your web root (or any subpath).
2. Serve it over **HTTPS** — a service worker, geolocation, and the secure
   WebSocket feed all require a secure context. (\`http://localhost\` also works
   for local testing.)
3. Open the site. That's it.

Any static file server works, e.g.:

    npx serve .            # quick local test (http://localhost:3000)
    # or copy to nginx / Apache / Caddy / S3+CloudFront / etc.

## Required outbound network access

The app pulls live data and map tiles directly from these origins in the
visitor's browser. Your host does **not** proxy them, but the visitor's network
must be able to reach them:

| Origin | Purpose |
|--------|---------|
| \`wss://api.metro.net\` | Live vehicle positions + trip updates (WebSocket) |
| \`basemaps.cartocdn.com\` (+ subdomains) | Base map tiles |
| \`tiles.arcgis.com\`, \`server.arcgisonline.com\` | Metro-styled basemap overlay |
| \`fonts.googleapis.com\`, \`fonts.gstatic.com\` | Open Sans webfont |
| \`lacmta.github.io\` | Route line icons (SVG) |
| \`gbfs.bcycle.com\` | Metro Bike Share availability |
| \`*.lambda-url.us-west-1.on.aws\` | Service alerts |

These are also the only external origins allowed by the Content-Security-Policy
baked into \`index.html\`; the CSP uses \`'self'\` + the list above, so it works at
any hosting origin without changes.

## Subpath hosting

All asset paths are relative, so serving under \`/transit/\` etc. works for the
app itself. Only \`404.html\` assumes the site root — configure your host's
unknown-route fallback to \`index.html\` if you host under a subpath.

## Licensing & attribution (required)

This bundle includes \`LICENSE\` (MIT, the app's own code) and \`NOTICE.md\`
(third-party data, tiles, libraries, and fonts, with the attribution each
requires). **You must keep the on-map MapLibre attribution control visible** —
it carries the legally required OpenStreetMap / CARTO / Esri / LA Metro credits.
See \`NOTICE.md\`.

The live data and map tiles are subject to their providers' terms (LA Metro
developer terms, OpenStreetMap ODbL, CARTO, Esri). Confirm your use complies.
`;
}

// ── build ────────────────────────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) throw new Error(`missing runtime file: ${item}`);
    fs.cpSync(src, path.join(OUT, item), { recursive: true });
}

// Safety: the built data must be present, and no raw GTFS may leak in.
for (const d of REQUIRED_DATA) {
    if (!fs.existsSync(path.join(OUT, 'data', d))) {
        throw new Error(`missing data/${d} — run: node scripts/build-shapes.cjs`);
    }
}
const strays = fs.readdirSync(path.join(OUT, 'data'))
    .filter(f => f.endsWith('.txt') || f.endsWith('.zip'));
if (strays.length) throw new Error(`raw GTFS leaked into bundle: ${strays.join(', ')}`);

// Cleanliness guard: the distributable must carry no internal "claude"
// reference (filename, comment, or otherwise). The repo keeps its own design
// docs; this fails the build loudly if any leak into the shipped bundle, so it
// can never silently regress. Scans text files only.
const TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.txt', '']);
function scanForClaude(dir) {
    const hits = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { hits.push(...scanForClaude(p)); continue; }
        if (!TEXT_EXT.has(path.extname(entry.name))) continue;
        const text = fs.readFileSync(p, 'utf8');
        text.split('\n').forEach((line, i) => {
            if (/claude/i.test(line)) hits.push(`${path.relative(OUT, p)}:${i + 1}`);
        });
    }
    return hits;
}
const sha = shortSha();
fs.writeFileSync(path.join(OUT, 'VERSION'),
    `metrolivemap ${VERSION}\nbuilt ${new Date().toISOString()}\ncommit ${sha}\n`);
fs.writeFileSync(path.join(OUT, '404.html'), portable404());
fs.writeFileSync(path.join(OUT, 'README.md'), bundleReadme(VERSION, sha));

// Run the cleanliness guard AFTER all files (copied + generated) are in place.
const claudeHits = scanForClaude(OUT);
if (claudeHits.length) {
    throw new Error(`internal "claude" reference leaked into bundle:\n  ${claudeHits.join('\n  ')}`);
}

// Zip + checksum.
const zipPath = path.join(DIST, `${NAME}.zip`);
execFileSync('zip', ['-r', '-q', '-X', zipPath, NAME], { cwd: DIST });
const hash = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${hash}  ${NAME}.zip\n`);

const mib = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
log(`bundle: ${path.relative(ROOT, OUT)}/`);
log(`zip:    ${path.relative(ROOT, zipPath)} (${mib} MiB)`);
log(`sha256: ${hash}`);

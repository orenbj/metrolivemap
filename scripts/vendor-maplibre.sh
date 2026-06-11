#!/usr/bin/env bash
#
# vendor-maplibre.sh — refresh the vendored MapLibre GL JS dist from npm.
#
# WHY VENDORED (issue #245)
# -------------------------
# MapLibre GL JS used to load from unpkg.com with SRI — a single point of
# failure: an unpkg outage hard-failed the whole app on first load (SRI/SW
# caching only ever help repeat visits, and a caching SW is barred by the
# "sw.js is installability-only" contract in CLAUDE.md). Serving the library
# from our own origin removes the runtime dependency entirely, lets the CSP
# drop unpkg from script-src / style-src / connect-src, and makes the cold
# load one DNS+TLS handshake shorter on mobile.
#
# WHAT THIS DOES
# --------------
#   1. `npm pack maplibre-gl@$VERSION` (pinned) into a temp dir.
#   2. Copies dist/maplibre-gl.css and LICENSE.txt VERBATIM (BSD-3-Clause
#      requires the license be retained alongside the redistributed binary).
#   3. Copies dist/maplibre-gl.js with ONLY the trailing
#      `//# sourceMappingURL=maplibre-gl.js.map` line stripped — the 5.6 MB
#      source map is dev-only and not worth committing, and leaving the
#      comment would 404 in devtools. This is the file's ONLY delta from
#      upstream.
#   4. Prints the upstream sha384 SRI digests so a reviewer can confirm the
#      vendored bytes match the published package (the .css and the .js sans
#      the stripped comment).
#
# BUMPING THE VERSION: change VERSION below, run this, and update the version
# string in index.html's MapLibre comment. No SRI hash to recompute (the
# library is now same-origin; SRI is for cross-origin trust we no longer need).
#
set -euo pipefail

VERSION="5.24.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/maplibre-gl"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[vendor-maplibre] packing maplibre-gl@$VERSION"
( cd "$TMP" && npm pack "maplibre-gl@$VERSION" --pack-destination "$TMP" >/dev/null )
tar -xzf "$TMP"/maplibre-gl-*.tgz -C "$TMP"

mkdir -p "$DEST"
cp "$TMP/package/dist/maplibre-gl.css" "$DEST/maplibre-gl.css"
cp "$TMP/package/LICENSE.txt"          "$DEST/LICENSE.txt"
# Strip the single trailing sourceMappingURL comment (dev-only map not vendored).
sed '/^\/\/# sourceMappingURL=maplibre-gl\.js\.map$/d' \
    "$TMP/package/dist/maplibre-gl.js" > "$DEST/maplibre-gl.js"

echo "[vendor-maplibre] wrote:"
ls -la "$DEST"

echo "[vendor-maplibre] upstream SRI (sha384) for provenance review:"
printf '  css = sha384-%s\n' "$(openssl dgst -sha384 -binary "$TMP/package/dist/maplibre-gl.css" | openssl base64 -A)"
printf '  js  = sha384-%s  (upstream, before comment strip)\n' \
    "$(openssl dgst -sha384 -binary "$TMP/package/dist/maplibre-gl.js" | openssl base64 -A)"
echo "[vendor-maplibre] done."

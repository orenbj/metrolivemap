# Self-Hosting Metro Live Map

Metro Live Map is a **no-build static site**: the app is plain HTML + ES modules
served as-is, with MapLibre GL JS vendored same-origin. You can host the exact
files that run in production on any static web server.

This doc covers building the distributable bundle, what it contains, how to serve
it, the network access it requires, attribution obligations, and the release
process.

---

## 1. Get a bundle

**Option A — download a release.** Grab `metrolivemap-vX.Y.Z.zip` from the
[Releases page](https://github.com/orenbj/metrolivemap/releases) and verify it:

```sh
sha256sum -c metrolivemap-vX.Y.Z.zip.sha256
unzip metrolivemap-vX.Y.Z.zip
```

**Option B — build it yourself** (requires Node ≥ 24 and the `zip` CLI):

```sh
git clone https://github.com/orenbj/metrolivemap
cd metrolivemap
npm ci
node scripts/build-shapes.cjs     # only if data/*.json are missing
npm run package                   # → dist/metrolivemap-v<version>.zip (+ .sha256)
```

The bundle is fully self-contained — no `npm install` on the host, no build step.

## 2. What's in the bundle

The runtime file set only:

```
index.html  404.html  manifest.json  sw.js  VERSION  README.md
js/  styles/  images/  vendor/maplibre-gl/  data/  LICENSE  NOTICE.md
```

Deliberately **excluded**: dev/CI tooling (`scripts/`, `tests/`, `.github/`,
`node_modules/`, `package*.json`, lint/test configs), internal docs
(`CLAUDE.md`, the rest of `docs/`), the GitHub-Pages `CNAME`, and raw GTFS
source files. `data/` holds only the built JSON the app fetches at runtime.

## 3. Serve it

Any static file server works. The only hard requirement is **HTTPS** — the
service worker, the Geolocation API, and the secure WebSocket feed all need a
secure context (`http://localhost` is treated as secure for local testing).

```sh
npx serve dist/metrolivemap-v1.2.0      # quick local check
# or: copy the folder to nginx / Apache / Caddy / S3+CloudFront / GitHub Pages …
```

**Subpath hosting.** All app asset paths are relative, so serving under
`/transit/` etc. works. The only exception is `404.html`, which assumes the site
root — if you host under a subpath, configure your server to fall back to
`index.html` for unknown routes (the standard SPA fallback).

## 4. Required outbound network access

The browser fetches live data and tiles **directly** from these origins (your
host does not proxy them — but visitors' networks must reach them). This list is
also exactly what the Content-Security-Policy in `index.html` permits; the CSP
uses `'self'` + the origins below, so it works at any hosting origin unchanged.

| Origin | Purpose |
|--------|---------|
| `wss://api.metro.net` | Live vehicle positions + trip updates (WebSocket) |
| `basemaps.cartocdn.com` (+ subdomains) | Base map tiles (CARTO Voyager / Dark Matter) |
| `tiles.arcgis.com`, `server.arcgisonline.com` | Metro-styled basemap overlay (Esri) |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Open Sans webfont |
| `lacmta.github.io` | Route line icons (SVG) |
| `gbfs.bcycle.com` | Metro Bike Share availability |
| `*.lambda-url.us-west-1.on.aws` | Service alerts |

> No API keys are involved — every tile/data source is reached via a keyless
> URL, and the project ships no client-visible key.

## 5. Licensing & attribution (required)

The bundle includes `LICENSE` (MIT — the project's own code) and `NOTICE.md`
(third-party data, tiles, libraries, and fonts, with the attribution each one
requires). Two obligations to keep in mind:

- **Do not remove the on-map MapLibre attribution control** (bottom-right ⓘ). It
  carries the legally required OpenStreetMap / CARTO / Esri / LA Metro credits.
- The **live data and map tiles** are subject to their providers' terms (LA
  Metro developer terms, OpenStreetMap ODbL, CARTO, Esri). Confirm your
  deployment complies — see `NOTICE.md`.

## 6. Release process (maintainers)

The bundle version comes from `package.json`; `CHANGELOG.md` is the human log.

1. Update `CHANGELOG.md` (move items from **Unreleased** into the new version).
2. Bump the version: `npm version <patch|minor|major> --no-git-tag-version`.
3. Commit, open a PR, merge to `main`.
4. Tag the merge commit and push the tag:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   The [`release` workflow](../.github/workflows/release.yml) then lints, tests,
   builds the bundle, verifies the tag matches `package.json`, and publishes a
   GitHub Release with the `.zip` + `.sha256` attached.

To test the packaging without cutting a release, run the `release` workflow
manually (**Actions → release → Run workflow**) — it builds and uploads the
bundle as a workflow artifact without creating a Release.

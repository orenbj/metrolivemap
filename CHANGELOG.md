# Changelog

All notable, user-facing changes to Metro Live Map are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here is the source of truth for the self-hostable release bundle
(`scripts/package-release.cjs` reads it from `package.json`). See
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for the release process.

## [Unreleased]

## [1.1.0] — 2026-06-15

### Added
- Self-hostable static release: `scripts/package-release.cjs` builds a versioned,
  self-contained `.zip` (+ `.sha256`); a tag-driven `release` GitHub Actions
  workflow publishes it as a GitHub Release; `docs/SELF-HOSTING.md` documents
  deployment, required network egress, and attribution obligations.
- Follow a vehicle — quality-of-life: follow now ends automatically when the
  vehicle reaches the end of its route; pauses when you navigate elsewhere
  (open a station, search, locate-me, or home/reset view) so the camera no
  longer snaps back; and stops when the followed vehicle's route is filtered
  out via the legend.

### Fixed
- Motion: stop the STOPPED_AT GPS-glitch "fly to the terminus then teleport
  back" — a vehicle whose GPS briefly jumped to the end of the line no longer
  animates the whole route.
- Vehicle popup: the vehicle-ID row no longer flips between sitting inline next
  to "Xs ago" and on its own line below it; it now sits consistently below.

## [1.0.0]

- Initial public release: live LA Metro rail + BRT vehicle map with bounded
  arc-glide motion, hybrid GTFS-RT/schedule ETAs, station arrival popups,
  service alerts, Metro Bike Share and Metro Micro layers, PWA installability,
  and the keyless CARTO/Esri basemaps. Deployed on GitHub Pages.

[Unreleased]: https://github.com/orenbj/metrolivemap/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/orenbj/metrolivemap/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/orenbj/metrolivemap/releases/tag/v1.0.0

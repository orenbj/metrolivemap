# Changelog

All notable, user-facing changes to Metro Live Map are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here is the source of truth for the self-hostable release bundle
(`scripts/package-release.cjs` reads it from `package.json`). See
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for the release process.

## [Unreleased]

### Added
- Self-hostable static release: `scripts/package-release.cjs` builds a versioned,
  self-contained `.zip` (+ `.sha256`); a tag-driven `release` GitHub Actions
  workflow publishes it as a GitHub Release; `docs/SELF-HOSTING.md` documents
  deployment, required network egress, and attribution obligations.

## [1.0.0]

- Initial public release: live LA Metro rail + BRT vehicle map with bounded
  arc-glide motion, hybrid GTFS-RT/schedule ETAs, station arrival popups,
  service alerts, Metro Bike Share and Metro Micro layers, PWA installability,
  and the keyless CARTO/Esri basemaps. Deployed on GitHub Pages.

[Unreleased]: https://github.com/orenbj/metrolivemap/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/orenbj/metrolivemap/releases/tag/v1.0.0

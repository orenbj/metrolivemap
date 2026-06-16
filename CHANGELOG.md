# Changelog

All notable, user-facing changes to Metro Live Map are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here is the source of truth for the self-hostable release bundle
(`scripts/package-release.cjs` reads it from `package.json`). See
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) for the release process.

## [Unreleased]

## [1.3.0] — 2026-06-16

### Fixed
- Search results dropdown now closes on Escape and tap-outside; previously a
  populated list could stay floating over the map until the next keystroke.
- Service-alert tooltips whose description restates the header (e.g. detours)
  now show their "Active: …" window directly under the title — consistent with
  every other alert, instead of trailing the whole body.

### Accessibility
- Larger touch targets for the floating map controls (zoom, locate, layer
  toggles, Alerts) via a hit-area overlay — the icons stay the same size.
- Higher-contrast muted text (the collapsed bus-route list and similar) to meet
  WCAG AA on white, and a stronger, more visible search-input focus ring
  (especially in dark mode).
- The Service Alerts panel's tab content is now correctly labelled by the
  active tab for screen-reader users.
- The follow pill wraps its label on narrow phones so the "tap to resume"
  action is never truncated; the top map controls respect a side notch /
  Dynamic Island when held in landscape.

### Housekeeping
- Added an app-chrome / cross-cutting UI-UX audit under `docs/audits`; renamed a
  misleading z-index variable for clarity; refreshed drifted doc test counts.

## [1.2.0] — 2026-06-15

### Changed
- Follow pill relocated from a fixed bottom-center overlay to an in-flow pill
  beneath the search bar; the "Unofficial · not affiliated with LA Metro"
  disclaimer moved from a standalone on-screen pill into the map's attribution
  ⓘ popover.

### Fixed
- Vehicle freshness unified on a single clock: the marker opacity, the popup
  freshness dot, and the "Xs ago" number now always agree (a feed-lagged train
  no longer fades gray on the map while its popup still reads a green "45s ago").
- Vehicle popup footer vehicle-ID row stops flipping between inline and below
  "Xs ago" (settled in the v1.1.0 footer change; freshness fix completes it).

### Housekeeping
- Untracked the gitignored `.claude/launch.json`; refreshed drifted doc counts.

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

[Unreleased]: https://github.com/orenbj/metrolivemap/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/orenbj/metrolivemap/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/orenbj/metrolivemap/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/orenbj/metrolivemap/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/orenbj/metrolivemap/releases/tag/v1.0.0

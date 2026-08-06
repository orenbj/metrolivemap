# Changelog

All notable, user-facing changes to Metro Live Map are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Search now finds vehicles as well as stations.** Type the car number printed
  on a train or G/J Line bus and the map flies to it and follows it as it moves.
  Results show the line and where the vehicle is heading, so the same number on
  two different lines is easy to tell apart. If the line was hidden in the
  legend, selecting the vehicle brings it back. Search is keyboard- and
  screen-reader-operable, which also gives non-mouse users a way to reach a
  specific vehicle's live details for the first time.
- Service-alert tooltips now lead with the affected line's logo, so an alert
  opened from a station badge or a bus-bridge glyph says which line it applies
  to at a glance. Alerts affecting several lines show one logo per line.

### Changed
- In the station popup, the nearby-buses section now sits below the bike /
  restroom row. Expanding the bus list no longer pushes those off the bottom
  of the popup.
- The station popup now opens below the station dot instead of above it, so
  expanding the nearby-buses list unfolds downward. Previously the popup grew
  upward and shoved the station name and arrivals up the screen as you
  expanded. The map nudges itself if the popup would run off the edge.

### Fixed
- The installed app rotated with the phone even when the device's auto-rotate
  was switched off. It now follows your rotation lock.
- Terminus stations sometimes showed "—" instead of the next departure, even
  though the next station down the line listed those same trains. The row only
  considered trains within 10 minutes, and it measured each train by when it
  pulls INTO the terminus rather than when it pulls OUT — so a train laying
  over was both mistimed and hidden. Terminus rows now show the next real
  departure times, and tag the last one of the night.
- When two service alerts of the same kind were merged into one station banner
  (e.g. a B Line detour and a D Line detour at a shared station), the second
  alert's tooltip showed the first alert's line logo and headline. Each merged
  alert now carries its own line logo, headline, and active window.
- A hover preview (station, vehicle, or bike-share) could close another popup
  type's pinned, tap-opened popup — e.g. hovering a station while a train's
  popup was pinned would close the train popup. Hover previews no longer
  evict a pinned popup.
- A pinned service-alert tooltip could get stranded in the top-left corner of
  the screen after its alert marker was removed from the map, instead of
  closing along with it.
- Tapping a J Line street-running stop inside a Metro Micro service zone could
  open two overlapping popups at once (the station and the Micro zone); now
  only one opens.
- Pressing Escape while typing in the search box no longer closes an
  unrelated pinned popup elsewhere on the map — it only dismisses the search
  suggestions.
- Vehicles stopped at a handful of platforms that sit noticeably off the
  rail/busway line (Union Station's B/D subway platforms, G Line Canoga) now
  render at their actual platform location instead of a point projected
  sideways onto the track.
- Destination/terminus labels in vehicle popups could blank out early while
  the vehicle marker was still visible on the map; they now stay populated
  for as long as the vehicle does.
- Rail vehicles running the reverse direction of the Long Beach A Line's
  one-way downtown street pair no longer get mistakenly flagged as off their
  own line.
- Returning to the app after it was backgrounded for a while could, in rare
  timing cases, leave every live feed disconnected until the next long
  backgrounding or a manual reload — vehicles would fade out and station
  arrivals would go empty while the connection indicator still showed
  "connected." Reconnecting on return is now immediate and reliable in every
  case. (A related edge case, where returning to a just-suspended tab could
  quietly re-disconnect one feed, is also fixed.)
- The "Departs" time on a train dwelling at its first/layover stop now shows the
  real scheduled pull-out time instead of reading "Now" for the entire layover,
  and a boarding train no longer drops off the station's boarding list partway
  through its dwell.
- A tab opened in the background (e.g. "open link in new tab") now suspends its
  live feeds while unattended just like a tab you switch away from — previously
  it kept the feeds running until first viewed, wasting battery and data.
- Bus-bridge brackets for a service closure now clear promptly when the closure
  ends, instead of lingering briefly.

### Accessibility
- Pressing **Escape** now closes an open station, vehicle, bike-share, or
  micro-zone popup — matching the alerts panel, which already did.
- Closed panels (the alerts panel, the desktop legend, and collapsed legend
  rows) are no longer reachable by keyboard Tab while hidden, so keyboard and
  screen-reader users can't land on — or accidentally toggle — controls they
  can't see.
- Keyboard focus is preserved when a station popup refreshes its live times, so
  a keyboard user is no longer bumped out of the popup every few seconds.
- Boarding-time pills now carry a spoken label pairing the line with its
  departure (e.g. "E Line, departs 5 min") for screen-reader users.
- Focusing the station search box on an iPhone no longer zooms the page in.

## [1.4.0] — 2026-06-26

### Added
- Nearby buses in the station popup now show the **rider-facing destination**
  (e.g. "Santa Monica" — the bus headsign) instead of the live feed's terminus
  stop name, which was often an obscure intersection riders don't recognize.
  Branch and short-turn trips show their own true destination.
- Service Alerts panel now shows an explicit "Alerts unavailable" state when the
  alerts feed can't be reached, instead of silently showing zero alerts (which
  during a real disruption read as "service is fine").

### Changed
- Next-stop arrival ETAs now round to the nearest minute instead of rounding
  down, matching the countdown on Metro's platform screens — a train ~110 s away
  reads "2m", not "1m".
- The nearby-bus destination always keeps its compass direction visible (the
  name truncates first), so two same-route rows stay distinguishable.
- On first load the app no longer fires an unsolicited location-permission
  prompt: it auto-locates only when permission was already granted, and
  otherwise waits for an explicit tap on the Locate button.

### Fixed
- Returning to the app after it was backgrounded no longer briefly shows a false
  "Live feed delayed" banner for the time you were away (a deliberate power-save
  was being mislabeled as a feed problem).
- The nearby-bus list keeps its scroll position when arrivals refresh, instead of
  jumping back to the top every few seconds.
- Nearby-bus hover tooltips no longer repeat the destination and route already
  shown in the row.

### Removed
- The self-hostable release bundle and its tooling (`scripts/package-release.cjs`,
  the tag-driven `release` GitHub Actions workflow, and `docs/SELF-HOSTING.md`).
  The project is a no-build static site, so the "dist" was only ever a filtered
  copy of the repo; the canonical handoff is the git repository itself (clone
  and serve the root, or fork onto GitHub Pages). See `docs/HANDOFF.md`.

### Performance
- Trimmed per-frame work on the marker/feed hot paths — the marker glide tick no
  longer computes an unused bearing every animation frame.

### Housekeeping
- Repo readied for transfer to a future maintainer: added `docs/HANDOFF.md` §12
  "Transfer to a new owner" (incl. notification-delivery best practices), made the
  uptime-check probe URL owner-agnostic, archived the now-historical
  `LAUNCH-READINESS.md`, and refreshed all docs.
- Documented the project's origin as a fork of LA Metro's MIT-licensed
  `realtime-map` / `livemap`, with upstream attribution retained in `LICENSE` and
  `NOTICE.md`.

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

[Unreleased]: https://github.com/orenbj/metrolivemap/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/orenbj/metrolivemap/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/orenbj/metrolivemap/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/orenbj/metrolivemap/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/orenbj/metrolivemap/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/orenbj/metrolivemap/releases/tag/v1.0.0

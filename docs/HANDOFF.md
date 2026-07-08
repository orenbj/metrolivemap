# Operations & Handoff Guide

A practical guide for the team taking over **Metro Live Map**. It assumes no
prior context and points to the deeper docs rather than duplicating them.

- **What it is & how it's built:** [`README.md`](../README.md)
- **Durable invariants / guardrails (read before changing motion or ETA code):** [`CLAUDE.md`](../CLAUDE.md)
- **Engineering snapshot & deferred decisions:** [`STATUS.md`](STATUS.md)
- **"Production is broken" runbook:** [`ROLLBACK.md`](ROLLBACK.md)
- **Launch verdict & findings register (historical):** [`_archive/LAUNCH-READINESS.md`](_archive/LAUNCH-READINESS.md)
- **Third-party data/tile/font attribution & licenses:** [`NOTICE.md`](../NOTICE.md)

---

## 1. In one paragraph

A **no-build, static, client-only** single-page app. Plain ES-module JS, no
bundler, no server, no framework. It loads MapLibre GL JS from `vendor/maplibre-gl/`
(pinned, same-origin), renders LA Metro rail + G/J-Line BRT vehicles in real time from Metro's
GTFS-Realtime WebSocket feeds, and shows station arrivals/alerts. Static GTFS
(routes/stops/trips/shapes) is pre-built into `data/*.json` and committed.
Deployed on **GitHub Pages from the repo root** — pushing to `main`
auto-deploys in ~60 s.

## 2. Local development

```bash
# Use Node 24 (matches CI; see .nvmrc). Node 25+ works for tests via the
# tests/setup.js localStorage shim, but 24 is the supported baseline.
nvm use            # reads .nvmrc

npm ci             # install dev tooling (vitest, jsdom, playwright)
npm test           # run the unit suite — expect 1095/1095 green

npx serve .        # serve the static site at http://localhost:3000
#   (any static server works: `python3 -m http.server`, etc.)
```

There is **no build step**. Edit a `js/*.js` file, reload the browser. MapLibre
is vendored same-origin (`vendor/maplibre-gl/`, loaded via `<script>`/`<link>`
tags in `index.html`); the only remaining CDN dependency is Google Fonts.

## 3. The GTFS data pipeline

Static GTFS is committed as JSON in `data/` (`trips.json`, `stops.json`,
`rail-shapes.json`, `bus-routes.json`, `bus-destinations.json`,
`metro-micro-zones.json`). The raw GTFS
`.txt`/`.zip` sources are **gitignored** — only the built JSON ships.

**Rebuild manually** (e.g. if the automation is down and a schedule changed):

```bash
node scripts/build-shapes.cjs    # auto-downloads the latest Metro GTFS and
                                 # regenerates data/*.json
git add data/ && git commit -m "data: regenerate from latest Metro GTFS"
```

GTFS source: LA Metro's public feeds (rail + bus), documented at
<https://lacmta.github.io/GTFS_Documents/>. The build script holds the exact
URLs.

**Automated rebuild:** `.github/workflows/rebuild-gtfs.yml` runs every Monday
09:00 UTC, rebuilds, and opens a PR if anything changed. If PR creation is
blocked (repo setting off), it files an issue under `gtfs-rebuild-failure`
instead. `gtfs-drift-check.yml` (Mon 08:00 UTC) independently warns when the
committed data has drifted ≥5% from upstream.

**`data/metro-micro-zones.json`** — this file is **not** rebuilt by
`build-shapes.cjs`. It is a manually maintained GeoJSON of Metro Micro
on-demand service zone polygons. If Metro Micro adds, removes, or redraws
a zone, update it by hand:

1. Go to <https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas>
2. Download → GeoJSON → save as `data/metro-micro-zones.json`
3. Commit and merge to `main`.

## 4. Deployment

- **Mechanism:** GitHub Pages serves the repo root. `index.html` must stay at
  root. Merging to `main` auto-deploys (~60 s).
- **No secrets / keys** are involved — basemaps are keyless (see `NOTICE.md`).
- **Custom domain:** the `livemap.metro.net` CNAME is committed. That domain is
  the **LA Metro handoff target** — already live, served from `LACMTA/livemap`
  (a beta). The current live URL of *this* repo is
  `https://orenbj.github.io/metrolivemap/`; pointing `livemap.metro.net` at the
  Metro deployment is the **domain cutover** in the migration runbook (§12.3,
  step 4), not a pending delegation to this repo.

## 5. Legal & compliance

### Map attribution (ODbL / CARTO / Esri) — legally required

The app renders a compact **AttributionControl** (bottom-right ⓘ on the map)
that displays OSM, CARTO, Esri, and LA Metro credits drawn from each tile
source. This control is **legally load-bearing**:

| Requirement | Governed by | What the app does |
|---|---|---|
| "© OpenStreetMap contributors" must be visible | ODbL 1.0 — legally binding | `AttributionControl` displays it |
| "© CARTO" must be visible | CARTO basemap terms | `AttributionControl` displays it |
| "© LA Metro, Esri" must be visible | Esri / ArcGIS terms | Set on the raster source in `js/map.js` |

> ⚠️ **Never remove the `AttributionControl`** from `js/map.js`, and never
> hide it with CSS. Removing it violates the ODbL and CARTO terms of use.
> See [`NOTICE.md`](../NOTICE.md) for the full licensing details.

**Verify this on the live site:** open
`https://orenbj.github.io/metrolivemap/` (or `https://livemap.metro.net/`
after the Metro handoff — §12.3), click the ⓘ icon at bottom-right, and confirm
the OSM, CARTO, and Esri credits are present.

### LA Metro developer terms

The app uses LA Metro's public GTFS and GTFS-RT feeds. `NOTICE.md` flags
an action item: **confirm the project's use satisfies Metro's current
developer terms of use**, and that the "Powered by LA Metro" credit wording
is acceptable. See <https://developer.metro.net/>.

### Accessibility (WCAG 2.1 AA / Section 508 — VPAT note)

The app targets **WCAG 2.1 AA**. A full audit (2026-06) found the **static chrome
conformant**: the station search (combobox + listbox ARIA), legend/route filter,
alerts panel (modal with focus-trap, roving tablist, live-region announcements),
station arrival popups (dialog role, focus moved in/restored), and the map control
buttons are all keyboard-operable and screen-reader-labeled, with AA contrast.
(Route brand colors E/K/J are a documented 1.4.11 exception, mitigated by the
numeric vehicle counts rendered as text — see `CLAUDE.md`. Decorative animation
honors `prefers-reduced-motion`; vehicle *position* motion is WCAG-2.3.3-exempt
essential motion.)

> ⚠️ **Known limitation — capture in the VPAT.** The live **vehicle markers**,
> **bike-share markers**, and **Metro Micro zones** are pointer-only: they are
> MapLibre HTML/canvas overlays with no keyboard focus or role, so a keyboard /
> screen-reader user cannot open a vehicle popup to read a specific dot's
> live position / next-stop / ETA. This is a **2.1.1 (Keyboard) + 4.1.2
> (Name/Role/Value) partial-support** item.
>
> **Accessible equivalent path (the remediation to cite):** the **station
> search → station arrivals popup is fully keyboard- and SR-accessible** and
> surfaces the same live arrival/ETA data *per stop*. So the live-arrivals
> *information* is reachable without a pointer; only the map-dot *interaction*
> is not. For a fully-conformant deployment (no VPAT exception), the planned
> fix is an off-canvas "nearby/active vehicles" list as the keyboard equivalent
> of clicking a dot — deferred as a product decision.

---

## 6. First-time repo setup checklist

Complete these once before anything else — the automations depend on them.

- [ ] **Enable PR creation by Actions** — in Settings → Actions → General →
  Workflow permissions, turn on **"Allow GitHub Actions to create and approve
  pull requests"**. Without this, `rebuild-gtfs.yml` cannot open its weekly
  PR; it falls back to filing an issue with manual instructions instead.

- [ ] **Pre-create the six issue/PR labels** so the auto-file / auto-close
  queries (and the weekly rebuild PR) work correctly:

  | Label | Used by | Color suggestion |
  |---|---|---|
  | `uptime-failure` | `uptime-check.yml` | red `#d73a4a` |
  | `gtfs-drift` | `gtfs-drift-check.yml` | orange `#e4e669` |
  | `gtfs-rebuild-failure` | `rebuild-gtfs.yml` (fallback) | orange `#e4e669` |
  | `feed-reliability-failure` | `feed-reliability.yml` | yellow `#fbca04` |
  | `live-accuracy-failure` | `live-accuracy.yml` | yellow `#fbca04` |
  | `gtfs-data` | `rebuild-gtfs.yml` (weekly PR) | blue `#0e8a16` |

  Labels can be created at `github.com/<org>/<repo>/labels`.

- [ ] **Watch the repo for Issues** — the alert system fires GitHub issues,
  not emails. Have at least one maintainer set their watch to **Custom →
  Issues** so alerts don't go unnoticed. **Better:** push them to a shared
  team channel / on-call platform per the best-practice options in § 8.1
  (don't rely on a single personal watch).

- [ ] **Confirm `tests.yml` is a required status check** — in Settings →
  Branches → Branch protection rule for `main`, add `test` as a required
  status check. This blocks a red test suite from merging.

- [ ] **Verify map attribution is visible** — open the live site, click the
  ⓘ at bottom-right, confirm "© OpenStreetMap contributors", "© CARTO",
  and "© LA Metro, Esri" credits are all present (see § 5 above).

---

## 7. Ongoing maintenance

**The only recurring task is a ~2-minute PR review every 6–12 weeks.**

When Metro publishes a new schedule, `rebuild-gtfs.yml` (Monday 09:00 UTC)
automatically downloads the latest GTFS, regenerates `data/*.json`, and opens
a PR titled `data: weekly GTFS rebuild`. Someone needs to:

1. Open the PR, glance at the diff — check that route/trip counts look
   reasonable (e.g. trip count changed by hundreds, not tens of thousands).
2. Merge. GitHub Pages redeploys in ~60 s.

If the PR isn't merged for several weeks, `gtfs-drift-check.yml` will keep
filing `gtfs-drift` issues as a reminder.

**The automations handle everything else on their own** — uptime, feed health,
and accuracy are monitored continuously, with issues filed on failure and
auto-closed on recovery. No human action is needed unless an issue is filed.

### Longer-term considerations

- **MapLibre version** — pinned to `5.24.0`, **vendored** into
  `vendor/maplibre-gl/` and served same-origin (#245 — no longer loaded from
  `unpkg.com`). The pin prevents silent breaking changes. To update, bump
  `VERSION` in `scripts/vendor-maplibre.sh`, run it (re-fetches the pinned dist
  from npm), and update the version string in the `index.html` MapLibre comment.
  No SRI hash to recompute (same-origin). No automation watches for new releases.

- **Metro feed URLs** — the GTFS-RT WebSocket endpoints (vehicle positions +
  trip updates) are hardcoded in `js/config.js` (`METRO_WS_FEEDS`); the separate
  HTTP service-alerts endpoints live in `js/config.js` too (`RAIL_ALERTS_URL` /
  `BUS_ALERTS_URL`, consumed by `js/alerts.js` — see §12.2). If Metro ever changes them, the
  `feed-reliability.yml` audit will flag a threshold failure (feeds go
  silent), but the fix requires a one-line code change + PR.

- **Metro Micro zone boundaries** — `data/metro-micro-zones.json` is manual
  (not rebuilt by the weekly cron). If Metro Micro adds or redraws service
  zones, download the updated GeoJSON from the ArcGIS Hub link in § 3 and
  commit it.

- **Playwright version is coupled across two places** — the `playwright`
  devDependency in `package.json` and the container image tag in
  `.github/workflows/live-accuracy.yml` (`mcr.microsoft.com/playwright:v1.59.1-noble`)
  must be **bumped in lockstep**. The container ships a pre-installed Chromium
  validated for its own tag; if the npm pin drifts to a newer minor, the
  headless accuracy harness can break with a runner-image regression (the
  workflow file documents this inline). Only relevant if you upgrade Playwright.

### External service dependencies

The app has no backend — all data comes from external services. Here is what
breaks when each one is unavailable:

| Service | Used for | Failure mode |
|---|---|---|
| _(MapLibre GL JS + CSS)_ | Core map library | **Vendored same-origin** (`vendor/maplibre-gl/`) — no external dependency; served by GitHub Pages with the rest of the site |
| `basemaps.cartocdn.com` | Default + dark-mode basemap tiles | Map canvas renders but no street basemap |
| `tiles.arcgis.com` | Metro-styled raster overlay | Overlay missing; street basemap still shows |
| `wss://api.metro.net` | Live vehicle positions + trip updates (GTFS-RT WebSocket) | No live vehicles or ETAs; map renders empty |
| `*.lambda-url.us-west-1.on.aws` | Service alerts (JSON) — see §12.2 | Alerts panel/badges show nothing (silently — handled gracefully via the "Alerts unavailable" state; root cause per [`audit D2`](audits/dist-automations-review-2026-06-16.md)). Treated as Metro's alerts.metro.net backend — **verify in-house per §12.2** (2-min DevTools check) |
| `gbfs.bcycle.com` | Metro Bike Share station data | Bike share layer absent |
| `fonts.googleapis.com` | Open Sans typeface | Falls back to system sans-serif |
| `lacmta.github.io` | GTFS static file downloads (build-time only) | Doesn't affect the live site; breaks `build-shapes.cjs` manual rebuild |

`uptime-check.yml` monitors the site itself every 10 minutes. External CDN
or feed outages are detected indirectly: `feed-reliability.yml` will file a
`feed-reliability-failure` issue when the Metro feeds go silent.

---

## 8. Incident response

The first signal of trouble comes from the CI workflows, which **file a GitHub
issue on failure and auto-close it on recovery**. Each uses a distinct label:

| Label | Filed by | Means |
|-------|----------|-------|
| `uptime-failure` | `uptime-check.yml` (every 10 min) | The site is down or not serving the expected HTML. |
| `feed-reliability-failure` | `feed-reliability.yml` | A live-feed coverage threshold failed (e.g. static-trip-coverage < 70% → data is stale; rebuild). |
| `live-accuracy-failure` | `live-accuracy.yml` | The headless ETA-accuracy capture harness broke. |
| `gtfs-drift` | `gtfs-drift-check.yml` | Committed GTFS data has drifted from upstream → rebuild. |
| `gtfs-rebuild-failure` | `rebuild-gtfs.yml` | The weekly auto-rebuild couldn't open its PR. |

> ⚠️ **These issues are label-only — no assignee or notification by default.**
> See the first-time setup checklist (§ 6) for how to ensure alerts reach the
> right people and labels exist before the first run.

### 8.1 Notification delivery (best practice)

The file-an-issue / auto-close-on-recovery design is correct and should be kept
— it is self-healing and avoids alert fatigue. The weak link is **delivery**:
by default an alert is *discoverable* (someone has to be watching the repo), not
*pushed*. Relying on a single maintainer's GitHub "watch" is fragile — it breaks
the moment that person leaves, mutes the repo, or filters the mail. For an
org-owned ops repo, route alerts to a **shared destination that survives staff
turnover**:

1. **Push failures to a shared channel.** Add a notification to each workflow's
   `if: failure()` step that posts to whatever Metro uses (Microsoft Teams via an
   Incoming Webhook, a shared email alias such as `livemap-alerts@metro.net`, or
   an on-call platform like PagerDuty/Opsgenie). Store the webhook/routing key as
   a **repo secret**, never inline. Point it at a **team alias or shared channel,
   never a personal account.** (Metro does not use Slack — pick the Microsoft 365
   / on-call equivalent.)
2. **Assign issues to a team, not nobody.** Have the failure step open the issue
   assigned to a team (or add it to a project board) and set `.github/CODEOWNERS`
   to a `@LACMTA/<team>` handle, not an individual. An unowned alert is an ignored
   alert.
3. **Match severity to channel.** Site-down (`uptime-failure`) is page-worthy —
   route it to the on-call rotation if one exists. The weekly GTFS rebuild PR is
   *not* an incident: **keep it a manual human merge** (a schedule diff wants a
   2-minute eyeball — do not auto-merge it).
4. **Verify the loop once.** Create the six labels *first* (§ 6), then let one
   workflow run and confirm an issue both **opens on failure and auto-closes on
   recovery** — a missing label silently breaks the dedup/close query.

**Deliberately out of scope:** centralized server-side error reporting
(Sentry-style). It was kept out on purpose to avoid a third-party / PII
dependency (see the analytics note in `index.html` and § 9). Adding it is a
conscious future decision gated on a consent/DPIA review — not a default
"monitor everything" step, since it would regress the project's privacy posture.

For "the site renders wrong / is broken in production," follow
[`ROLLBACK.md`](ROLLBACK.md): severity triage, `git revert` (never force-push),
fix-forward, or restore-from-known-good-SHA.

## 9. Observability

In-app telemetry is **client-side only** (no server backend). Counters
(`globalErrors`, `unhandledRejections`, feed `rcv/acc/drops`, `ghostArrivals`,
marker hygiene) print to the browser console each minute and append to a
`localStorage` ring (24 h):

```js
JSON.parse(localStorage.feedStatsRing)   // inspect recent feed/marker health
```

**Limitation to know:** because this lives on the user's tab, there is **no
server-side error telemetry** — you cannot see production errors centrally, only
on a tab you control. The `uptime-check` workflow is the only external health
signal. If Metro wants centralized error reporting, that's a deliberate future
addition (it was kept out to avoid a third-party/PII dependency — see the
analytics note in `index.html`).

## 10. Test & CI summary

- `npm test` → Vitest, **1095 tests / 54 files**. Run after any change to ETA,
  snapping, or marker logic.
- `tests.yml` runs the suite on every push/PR to `main` (required status check
  — see setup checklist in § 6).
- 7 workflows total — all documented in `README.md` and § 8 above.

## 11. Conventions for changing this codebase

`CLAUDE.md` is the durable contract. The two highest-risk areas:
- **Motion model** (`js/markers.js`) — the marker must NEVER move past its last
  GPS fix. Dead-reckoning was removed deliberately; do not reintroduce
  extrapolation. Read the "Motion model" section of `CLAUDE.md` first.
- **Feed boundary** (`js/api.js`) — every feed ID is String-cast at ingest;
  downstream does strict-equality joins. Don't bypass that.

Commit style: `feat:` / `fix:` / `polish:` / `refactor:` / `docs:`, one logical
change per commit, PR review before merge, no force-pushes.

## 12. Transfer to a new owner

Everything above assumes the **same** owner keeps operating the project. This
section is the checklist for handing the repository to a **new owner** (a GitHub
repo transfer that keeps history/issues/PRs).

Good news first: there are **no API keys or secrets anywhere**. CI uses only the
auto-provisioned `GITHUB_TOKEN` (transfers automatically), and every data/tile
source is keyless. What must be re-homed is **hosting identity** plus **one
external data endpoint** (alerts, §12.2).

### 12.1 Reconfigure after transfer

GitHub repo *settings* do **not** travel with a transfer — re-establish them:

- **GitHub Pages** — re-enable (source = `main`, root). Per-repo setting.
- **"Allow GitHub Actions to create and approve pull requests"** (Settings →
  Actions → General → Workflow permissions) — OFF by default; until ON,
  `rebuild-gtfs.yml` files a `gtfs-rebuild-failure` issue every Monday instead of
  opening its data PR.
- **Branch protection** — re-add `tests.yml` ("test") as a required status check.
- **Issue labels** — create them or the issue-filing workflows silently no-op /
  mis-dedup: `gtfs-data`, `gtfs-drift`, `gtfs-rebuild-failure`,
  `feed-reliability-failure`, `live-accuracy-failure`, `uptime-failure`.
- **Watch the repo** — all CI alerts are *unassigned* issues; nobody is notified
  otherwise.
- **Actions minutes** — every cron assumes a **public repo (unlimited minutes)**;
  `uptime-check.yml` alone is 144 runs/day. If you make the repo private, cut the
  cadence or you'll exhaust the private-minute budget.

In-repo identity that points at the previous owner — change on transfer:

| Where | Points at old owner | Action |
|---|---|---|
| `.github/CODEOWNERS` | `@orenbj` | replace with the new owner/team handle (a stale handle that loses access can block "require Code Owner review") |
| `.github/workflows/uptime-check.yml` | — (probe URL auto-derives from `github.repository{,_owner}`, #522) | **none** — owner-agnostic; override only via the `url` workflow_dispatch input if hosting off GitHub Pages |
| `package.json` | `homepage`, `repository.url` | point at the new owner |
| `index.html` | `og:url`, `og:image` | point at the new canonical URL (else link previews 404 when the old account is gone) |
| `404.html` | `/metrolivemap/` base path | only needed if the **repo is renamed** — an owner-only change keeps the path |
| docs `*.md`, `CHANGELOG.md` | `github.com/orenbj/metrolivemap` links | bulk find-replace the repo path (CHANGELOG compare links break otherwise) |
| `CNAME` | `livemap.metro.net` (Metro IT; already live serving the `LACMTA/livemap` beta — cutover is a DNS repoint, see §12.3) | keep + re-point DNS at the new Pages host and re-set Pages "Custom domain", **or** delete the file (else the custom domain 404s) |
| `LICENSE` | `Copyright (c) 2024–2026 orenbj` **+** the LA Metro upstream line | MIT — **keep both** existing notices (orenbj **and** the upstream LA Metro line this repo forked from — `LACMTA/realtime-map` / `LACMTA/livemap`) and **add** the new owner's line; MIT requires retaining prior notices, never replace one |

### 12.2 The alerts data endpoints (the one real unknown)

`js/config.js` (`RAIL_ALERTS_URL` / `BUS_ALERTS_URL`) point at two AWS Lambda
Function URLs in `us-west-1`. They are the app's **only** dependency whose
provenance isn't fully pinned down — give this the most attention:

- **Most likely Metro-operated.** They appear to be the backend that powers
  Metro's official **alerts.metro.net** page (which the app consumes directly),
  per the note in `config.js`. **Verify in ~2 minutes, no AWS needed:** open
  alerts.metro.net → DevTools → Network → filter `on.aws`; if `5cgdcfl7…` /
  `lbwlhl4z…` appear, they're Metro's.
- **If Metro's:** no transfer action — same risk class as the WS feed (an
  undocumented third-party endpoint that may change without notice). Monitor it;
  the `// last-verified` date in `config.js` is the re-check reminder.
- **If a personal proxy** (the original author's AWS account): re-home it — obtain
  the Lambda source, redeploy under the new owner's AWS account, and update the
  two URLs in `config.js`, the copy in `scripts/audit-feeds.js`, and the two
  `on.aws` hosts in the CSP `connect-src` (`index.html`).

Either way the endpoint is **reproducible**. It returns a JSON array of
GTFS-RT-shaped service alerts, so a replacement only needs to read Metro's
GTFS-RT alerts feed and emit this shape (authoritative reader: `_ingest` in
`js/alerts.js`):

```jsonc
[
  {
    "id": "string",
    "effect": "NO_SERVICE | DETOUR | SIGNIFICANT_DELAYS | ACCESSIBILITY_ISSUE | OTHER_EFFECT | UNKNOWN_EFFECT | …",
    "headerText": "short title",
    "descriptionText": "longer body",
    // start/end accept ISO 8601, Unix seconds, or Unix ms; end may be omitted (open-ended)
    "activePeriods": [ { "start": "2026-06-16T22:00:00Z", "end": "2026-06-17T06:00:00Z" } ],
    // routeId is a Metro route code (e.g. "801"); stopId optional
    "informedEntities": [ { "routeId": "801", "stopId": "80101" } ]
  }
]
```

The two endpoints split rail vs. bus; the app fetches both and concatenates them.

### 12.3 Migrating into `LACMTA/livemap` (the concrete plan)

§12.1–12.2 describe a generic **GitHub repo transfer** (one that carries
history/issues/PRs). The actual Metro handoff is **not** that transfer — it is a
**content migration into a repository that already exists**:

- **Target repo:** `github.com/LACMTA/livemap`, in the Metro org. It already
  holds a **beta** of the map, so a GitHub "Transfer repository" is impossible
  (the name collides) — the current code has to be **landed into** that repo.
- **Domain:** `livemap.metro.net` is **already live**, serving that beta. So the
  DNS work is a **repoint/cutover**, not the "pending delegation" described
  elsewhere in the older docs (README, CLAUDE.md, LAUNCH-READINESS).
- **Executed by the Metro web team** — the original author has no write access to
  `LACMTA/livemap`. This section is written for that team.

**Step 1 — Land the code in `LACMTA/livemap`.** Pick one (web team's call; the
beta's current contents decide which is cleanest):

- *Replace contents, keep repo:* add `orenbj/metrolivemap` as a remote (or import
  the tree) onto a branch in `LACMTA/livemap`, open a PR, review, merge to the
  deploy branch. History from this repo does **not** carry unless deliberately
  imported — that's fine; `CHANGELOG.md` + the git log here remain the record.
- *Fresh import:* if the beta is throwaway, replace the working tree wholesale on
  a branch and PR it in.

Either way, **no secrets move** — CI uses only the auto-provisioned
`GITHUB_TOKEN`, and every tile/data source is keyless.

**Step 2 — Apply the in-repo identity edits AS PART OF the import** (do these on
the import branch, not in `orenbj/metrolivemap` — that repo stays live at
`orenbj.github.io` until cutover, so flipping its canonical URL early would
mislabel the live site). Use the table in **§12.1**, with these Metro values:

| Where | New value |
|---|---|
| `.github/CODEOWNERS` | the Metro **team handle** (e.g. `@LACMTA/<team>`) — the web team fills this; a guessed handle that lacks access can block "require Code Owner review" |
| `package.json` `homepage` | `https://livemap.metro.net` |
| `package.json` `repository.url` | `https://github.com/LACMTA/livemap` |
| `index.html` `og:url` / `og:image` | `https://livemap.metro.net/` (+ the `/images/...` path under it) |
| `404.html` base path | the new project-pages base path **only if the repo name differs** from `metrolivemap` — `LACMTA/livemap` ⇒ `/livemap/`. The host-sniff already routes the custom domain to `/`, so this only matters for the `lacmta.github.io/livemap/` project URL |
| docs `*.md`, `CHANGELOG.md`, `README.md`, `CLAUDE.md` | bulk find-replace `orenbj/metrolivemap` → `LACMTA/livemap` and `orenbj.github.io/metrolivemap` → `livemap.metro.net` (the "pending DNS" narrative is already reconciled — these docs now describe the domain as the Metro handoff target) |
| `CNAME` | keep `livemap.metro.net` (already correct for the Metro repo) |
| `LICENSE` | **add** a Metro copyright line; keep BOTH existing notices — orenbj's **and** the LA Metro upstream line (MIT requires retaining it). Note: this is a homecoming — the project began as a fork of Metro's own MIT-licensed live-map code (`LACMTA/realtime-map` / `LACMTA/livemap`, the same codebase) |

`.github/workflows/uptime-check.yml` needs **no edit** — its probe URL
auto-derives from `github.repository{,_owner}` (#522), so it follows the repo
automatically.

**Step 3 — Repo settings on `LACMTA/livemap`** (these never travel with code —
run the **§12.1 / §6** checklist on the Metro repo): GitHub Pages source =
deploy branch + root; "Allow Actions to create and approve PRs" ON; re-add
`test` as a required status check; create the six issue labels; set a maintainer
watch — **and wire CI failures to a shared team channel / on-call platform per
§ 8.1** rather than relying on a personal watch (Metro doesn't use Slack — use
the Teams / email-alias / PagerDuty equivalent). **Actions minutes:** the crons
assume a **public repo** (unlimited) —
`uptime-check.yml` alone is 144 runs/day; if `LACMTA/livemap` is private, cut the
cron cadence or the minute budget will blow out.

**Step 4 — Domain cutover.** `livemap.metro.net` already resolves to the beta.
At go-live, point GitHub Pages "Custom domain" for `LACMTA/livemap` at
`livemap.metro.net` and confirm the DNS record targets the Metro repo's Pages
host. The committed `CNAME` is already correct. After cutover, `orenbj`'s claim
on `livemap.metro.net` is moot — decide separately whether `orenbj/metrolivemap`
is archived, kept as a dev fork (delete its `CNAME` so it doesn't 404), or
retired.

**Step 5 — Confirm the alerts Lambda (§12.2) — now an internal check.** Since the
handoff is to Metro, the open provenance question in §12.2 is answerable in-house:
confirm with the team that the two `*.lambda-url.us-west-1.on.aws` endpoints in
`js/config.js` are Metro-operated (they back `alerts.metro.net`). If yes, no
action — same risk class as the WS feed. If they turn out to be a personal proxy,
re-home per §12.2. Record the outcome on the `// last-verified` line in
`config.js`.

**Step 6 — Optional security-header upgrade (only if Metro's hosting can set HTTP
response headers).** On plain GitHub Pages, headers can't be set, so the app uses
a JS frame-buster + a `<meta>` CSP. If `livemap.metro.net` is fronted by anything
that *can* set response headers (CDN/proxy/edge), prefer delivering
`Content-Security-Policy` as a header and adding `X-Frame-Options: SAMEORIGIN` +
`frame-ancestors 'self'` (the JS frame-buster and `<meta>` CSP can then stay as a
belt-and-suspenders fallback). See the CSP comment in `index.html` and the
clickjacking note in `CLAUDE.md`. **Confirm with the web team whether headers are
available before planning this** — it's a no-op on bare Pages.

**Step 7 — Verify after cutover.** Hard-refresh `https://livemap.metro.net/` in
an incognito window: page loads, loading splash clears, vehicles appear within
~5 s, the ⓘ attribution shows OSM/CARTO/Esri credits (§5 — legally required), and
alerts populate. Then run the §6 "first-time setup" verification on the Metro
repo.

---

_Last updated: 2026-06-22. Keep this guide current as ownership,
infrastructure, or the data pipeline changes._

# Operations & Handoff Guide

A practical guide for the team taking over **Metro Live Map**. It assumes no
prior context and points to the deeper docs rather than duplicating them.

- **What it is & how it's built:** [`README.md`](../README.md)
- **Durable invariants / guardrails (read before changing motion or ETA code):** [`CLAUDE.md`](../CLAUDE.md)
- **Engineering snapshot & deferred decisions:** [`STATUS.md`](STATUS.md)
- **"Production is broken" runbook:** [`ROLLBACK.md`](ROLLBACK.md)
- **Launch verdict & findings register:** [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md)
- **Third-party data/tile/font attribution & licenses:** [`NOTICE.md`](../NOTICE.md)

---

## 1. In one paragraph

A **no-build, static, client-only** single-page app. Plain ES-module JS, no
bundler, no server, no framework. It loads MapLibre GL JS from a CDN (pinned +
SRI), renders LA Metro rail + G/J-Line BRT vehicles in real time from Metro's
GTFS-Realtime WebSocket feeds, and shows station arrivals/alerts. Static GTFS
(routes/stops/trips/shapes) is pre-built into `data/*.json` and committed.
Deployed on **GitHub Pages from the repo root** — pushing to `main`
auto-deploys in ~60 s.

## 2. Local development

```bash
# Use Node 20 (matches CI; see .nvmrc). Node 25+ works for tests via the
# tests/setup.js localStorage shim, but 20 is the supported baseline.
nvm use            # reads .nvmrc

npm ci             # install dev tooling (vitest, jsdom, playwright)
npm test           # run the unit suite — expect 753/753 green

npx serve .        # serve the static site at http://localhost:3000
#   (any static server works: `python3 -m http.server`, etc.)
```

There is **no build step**. Edit a `js/*.js` file, reload the browser. CDN libs
load via `<script>` tags in `index.html`.

## 3. The GTFS data pipeline

Static GTFS is committed as JSON in `data/` (`trips.json`, `stops.json`,
`rail-shapes.json`, `bus-routes.json`, `metro-micro-zones.json`). The raw GTFS
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

## 4. Deployment

- **Mechanism:** GitHub Pages serves the repo root. `index.html` must stay at
  root. Merging to `main` auto-deploys (~60 s).
- **No secrets / keys** are involved — basemaps are keyless (see `NOTICE.md`).
- **Custom domain:** the `livemap.metro.net` CNAME is committed. **Remaining for
  Metro IT:** complete the DNS delegation so the custom domain resolves. No code
  change is needed at that point. Until then the live URL is
  `https://orenbj.github.io/metrolivemap/`.

## 5. Incident response

The first signal of trouble comes from the CI workflows, which **file a GitHub
issue on failure and auto-close it on recovery**. Each uses a distinct label:

| Label | Filed by | Means |
|-------|----------|-------|
| `uptime-failure` | `uptime-check.yml` (every 10 min) | The site is down or not serving the expected HTML. |
| `feed-reliability-failure` | `feed-reliability.yml` | A live-feed coverage threshold failed (e.g. static-trip-coverage < 70% → data is stale; rebuild). |
| `live-accuracy-failure` | `live-accuracy.yml` | The headless ETA-accuracy capture harness broke. |
| `gtfs-drift` | `gtfs-drift-check.yml` | Committed GTFS data has drifted from upstream → rebuild. |
| `gtfs-rebuild-failure` | `rebuild-gtfs.yml` | The weekly auto-rebuild couldn't open its PR. |

> ⚠️ **These issues are label-only — no assignee or notification.** A team that
> isn't *watching the repo* will not see them. **Set this up at handoff:** either
> have the on-call engineer Watch the repo (Custom → Issues), or add assignees /
> a notification webhook to the `if: failure()` steps. Also **pre-create the five
> labels above** (the auto-close queries return empty until a label exists).

For "the site renders wrong / is broken in production," follow
[`ROLLBACK.md`](ROLLBACK.md): severity triage, `git revert` (never force-push),
fix-forward, or restore-from-known-good-SHA.

## 6. Observability

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

## 7. Test & CI summary

- `npm test` → Vitest, **753 tests / 32 files**. Run after any change to ETA,
  snapping, or marker logic.
- `tests.yml` runs the suite on every push/PR to `main`. **Confirm it is a
  *required* status check** in Settings → Branches so a red suite blocks merge.
- 6 workflows total — all documented in `README.md` and section 5 above.

## 8. Conventions for changing this codebase

`CLAUDE.md` is the durable contract. The two highest-risk areas:
- **Motion model** (`js/markers.js`) — the marker must NEVER move past its last
  GPS fix. Dead-reckoning was removed deliberately; do not reintroduce
  extrapolation. Read the "Motion model" section of `CLAUDE.md` first.
- **Feed boundary** (`js/api.js`) — every feed ID is String-cast at ingest;
  downstream does strict-equality joins. Don't bypass that.

Commit style: `feat:` / `fix:` / `polish:` / `refactor:` / `docs:`, one logical
change per commit, PR review before merge, no force-pushes.

---

_Last updated: 2026-06-02 (pre-handoff). Keep this guide current as ownership,
infrastructure, or the data pipeline changes._

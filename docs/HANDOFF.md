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

## 5. First-time repo setup checklist

Complete these once before anything else — the automations depend on them.

- [ ] **Enable PR creation by Actions** — in Settings → Actions → General →
  Workflow permissions, turn on **"Allow GitHub Actions to create and approve
  pull requests"**. Without this, `rebuild-gtfs.yml` cannot open its weekly
  PR; it falls back to filing an issue with manual instructions instead.

- [ ] **Pre-create the five issue labels** so the auto-file / auto-close
  queries work correctly:

  | Label | Color suggestion |
  |---|---|
  | `uptime-failure` | red `#d73a4a` |
  | `gtfs-drift` | orange `#e4e669` |
  | `gtfs-rebuild-failure` | orange `#e4e669` |
  | `feed-reliability-failure` | yellow `#fbca04` |
  | `live-accuracy-failure` | yellow `#fbca04` |

  Labels can be created at `github.com/<org>/<repo>/labels`.

- [ ] **Watch the repo for Issues** — the alert system fires GitHub issues,
  not emails. Have at least one maintainer set their watch to **Custom →
  Issues** (or configure a webhook/Slack integration on the `if: failure()`
  steps) so alerts don't go unnoticed.

- [ ] **Confirm `tests.yml` is a required status check** — in Settings →
  Branches → Branch protection rule for `main`, add `test` as a required
  status check. This blocks a red test suite from merging.

---

## 6. Ongoing maintenance

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

### Longer-term considerations (no scheduled maintenance needed)

- **MapLibre version** — pinned to `5.24.0` in `index.html` (loaded from
  `unpkg.com`). The pin prevents silent breaking changes. If a security patch
  or important fix is released, update the version number in the two `<link>`
  and `<script>` tags and verify the SRI hash matches. No automation watches
  for this.

- **Metro feed URLs** — the GTFS-RT WebSocket endpoints are hardcoded in
  `js/config.js` and `js/alerts.js`. If Metro ever changes them, the
  `feed-reliability.yml` audit will flag a threshold failure (feeds go
  silent), but the fix requires a one-line code change + PR.

---

## 7. Incident response

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
> See the first-time setup checklist (§ 5) for how to ensure alerts reach the
> right people and labels exist before the first run.

For "the site renders wrong / is broken in production," follow
[`ROLLBACK.md`](ROLLBACK.md): severity triage, `git revert` (never force-push),
fix-forward, or restore-from-known-good-SHA.

## 8. Observability

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

## 9. Test & CI summary

- `npm test` → Vitest, **753 tests / 32 files**. Run after any change to ETA,
  snapping, or marker logic.
- `tests.yml` runs the suite on every push/PR to `main` (required status check
  — see setup checklist in § 5).
- 6 workflows total — all documented in `README.md` and § 7 above.

## 10. Conventions for changing this codebase

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

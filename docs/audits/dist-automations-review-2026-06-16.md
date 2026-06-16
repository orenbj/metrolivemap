# Dist Runtime Automations — Review

**Date:** 2026-06-16 · **Status:** report only · **Scope:** the **browser-side automations that
ship inside the self-hostable dist bundle** — i.e. the runtime file set
`scripts/package-release.cjs` copies (`index.html`, `manifest.json`, `sw.js`, `js/`, `styles/`,
`vendor/`, `data/`). This is what a self-hoster inherits and what runs without operator
oversight. The repo-only CI/cron workflows (`feed-reliability`, `live-accuracy`, `rebuild-gtfs`,
`gtfs-drift-check`, `release`, `tests`) are **out of scope** — they are not in the bundle.

Method matches the prior audits: every claim cites `file:line`, verified by hand;
Severity (1 cosmetic → 4 broken/leaky) × Frequency (1 edge → 3 every session).

---

## 1. Executive summary

The shipped automations are, with one exception, **clean and well-behaved**: the service worker
genuinely caches nothing, every recurring timer pauses when the tab is hidden, both WebSocket
feeds suspend after 60 s backgrounded, every network fetch has an abort timeout, and there is
**no analytics / telemetry phone-home** (GTM/GA4 were removed). All third-party egress is
keyless and documented.

The **one finding that matters for the dist** is that **service alerts are fetched from two
owner-operated AWS Lambda endpoints hardcoded in the bundle.** Every self-hosted deployment
silently depends on (and routes its visitors' requests through) the maintainer's personal
infrastructure, and `SELF-HOSTING.md` doesn't disclose it. Everything else is small.

**Ranked:**
1. **D1 — Alerts come from owner-operated Lambdas baked into the dist; not disclosed to self-hosters.** (Sev 3 × Freq 3)
2. **D2 — A total alerts-feed outage is invisible to riders** (shows as "no alerts"). (Sev 2 × Freq 1)
3. **D3 — Unsolicited geolocation prompt on first load** (no Permissions pre-check). (Sev 2 × Freq 2)
4. **D4 — Diagnostic `mlm_flyLog` writes to localStorage in production.** (Sev 1 × Freq 2)

## 2. Findings

### D1 — Service alerts are fetched from owner-operated AWS Lambdas hardcoded in the bundle · **Sev 3 × Freq 3 = 9**
`js/config.js:468–469` hardcodes the **only** source of service alerts:
```
RAIL_ALERTS_URL = 'https://5cgdcfl7…lambda-url.us-west-1.on.aws/'
BUS_ALERTS_URL  = 'https://lbwlhl4z…lambda-url.us-west-1.on.aws/'
```
`alerts.js:483–484` polls both every `ALERTS_POLL_MS` (120 s). These are personal
`*.lambda-url.us-west-1.on.aws` functions (almost certainly CORS proxies for Metro's alerts feed,
which a browser can't fetch cross-origin directly). Consequences for the **dist**:
- **Hidden dependency / single point of failure.** Every self-hosted copy depends on the
  maintainer's Lambdas. If they're decommissioned or rate-limited, *all* self-hosted alerts break
  — silently (see D2). The live vehicle/tile sources are official + keyless; alerts are the lone
  exception that routes through private infra.
- **Cost & traffic shift.** The maintainer's account bears the request load (and AWS cost) of
  **every self-host's visitors**, not just the canonical deployment.
- **Privacy/disclosure.** Visitors of a self-hosted site have their IPs/requests sent to the
  maintainer's Lambdas — something neither the self-hoster nor their visitors are told.
- **Doc gap.** `docs/SELF-HOSTING.md:80` lists `*.lambda-url.us-west-1.on.aws` only as
  "Service alerts", implying an official data source. It does not say these are
  **maintainer-operated**, may change/disappear, and are overridable.

**Recommendations** (pick per intent):
1. **Disclose (do this regardless):** in `SELF-HOSTING.md` §4, mark the Lambda row as
   *maintainer-operated proxy — may change without notice; see below to point at your own*, and
   add a short note on what they proxy (Metro GTFS-RT alerts) and that they're set in
   `js/config.js`. Low effort, removes the silent surprise.
2. **Make them first-class config** (already module constants — good): document the override
   path, and consider reading from a small `config.local.js` / build-time substitution so a
   self-hoster doesn't edit a shipped source file.
3. **Optional, larger:** ship the proxy (e.g. a documented Cloudflare Worker / Lambda template)
   so self-hosters can stand up their own instead of borrowing the maintainer's.

The `// last-verified 2026-05` comments are good hygiene — keep them.

### D2 — A total alerts-feed outage is invisible to riders · **Sev 2 × Freq 1 = 2**
`alerts.js:506–520`: on failure `_fetchAlerts` only `console.warn`s and schedules **one** 10 s
retry, then yields to the 120 s poll. On sustained failure (D1's Lambdas down, or a self-hoster
who hasn't repointed them) the alert badges and panel simply render **zero alerts** — which is
indistinguishable from "no active disruptions." A rider could conclude service is fine during an
outage. (Same class as the panel's loading-vs-empty gap, audit E1.)

**Fix:** after N consecutive failures, surface a non-alarming "alerts unavailable" state on the
alerts control/panel (distinct from the empty state). Effort S–M. Especially valuable given D1
makes a self-hoster outage plausible.

### D3 — Unsolicited geolocation prompt on first load · **Sev 2 × Freq 2 = 4**
On startup `main.js:255` calls `autoLocate(true)` → `getUserLocation()` (`map.js:395–405`) →
`navigator.geolocation.getCurrentPosition(..., { enableHighAccuracy: true, … })` with **no
`navigator.permissions` pre-check**. So a first-time visitor gets a location permission prompt
**unsolicited on page load** (a recognized anti-pattern; some browsers penalize gesture-less
prompts). Startup denial is handled silently (`main.js:234 if (isStartup) return`) — good — but
the prompt still appears, and `enableHighAccuracy:true` on a passive load is a battery cost.

This is partly a **deliberate product choice** (nearest-station-on-load is the app's core value),
so it's an owner call. **Suggested:** gate the *startup* auto-locate on
`permissions.query({name:'geolocation'})` — auto-locate only when already `granted`; otherwise
wait for the explicit Locate button (the `isStartup=false` path, which already shows error
toasts). Consider dropping `enableHighAccuracy` for the passive startup fix. Effort S.

### D4 — Diagnostic `mlm_flyLog` writes to localStorage in production · **Sev 1 × Freq 2 = 2**
`markers.js` `_recordFly` writes `localStorage.mlm_flyLog` (a ring capped at 150 entries) on
fly/teleport events; only the **`console.warn`** is gated behind `mlm_debug_fly` — the
**localStorage write always runs** in the shipped dist. It's bounded and PII-free, but it's
always-on diagnostic I/O for every user. **Fix (optional):** gate the write behind the same
`mlm_debug_fly === '1'` flag (or accept it as bounded local telemetry). Effort S.

## 3. Verified-good (checked, leave alone)

- **`sw.js`** — truly pass-through: empty `fetch` handler, no `respondWith`, caches nothing.
  Correct for a live-data app (a cache would only ever show stale positions); `skipWaiting` +
  `clients.claim` make the first load installable. Exactly as the contract intends.
- **Recurring timers all pause when hidden.** `alerts:poll` (120 s), `bikeshare` (30 s),
  `tripUpdates:prune` (30 s), station/boarding-badge refreshes, the marker per-second + 5 s ETA
  ticks all go through `setVisibleInterval` (`utils.js:299`) or are gated on open-popup count
  (`markers.js:66/80`). No tight background loops.
- **Both WS feeds suspend after 60 s hidden and resume with a fresh snapshot** (`api.js:520`,
  `tripUpdates.js:445`, `WS_HIDDEN_SUSPEND_MS`); reconnect uses bounded backoff + 30 s ping +
  watchdog. No reconnect storm while backgrounded.
- **Every fetch has an abort timeout** — `fetchWithTimeout` (10 s alerts, 15 s static data,
  `utils.js:416`); no hung requests can wedge a load.
- **`feedStats` localStorage ring** capped at 1440 (24 h), best-effort, swallows quota errors,
  no PII (`feedStats.js:73`).
- **localStorage surface is small + safe** — `darkMode`, follow-restore, bike/micro visibility,
  PWA-dismissal, `mlm_debug_*` flags, the capped feedStats ring, and `mlm_flyLog` (D4). All
  writes are wrapped; no PII.
- **Data-load blob worker** (`main.js:53`) fetches the static JSON off the main thread; CSP
  permits it via `worker-src 'self' blob:`. Fine.
- **No analytics / telemetry phone-home** — GTM/GA4 removed; the alerts Lambdas (D1) are the only
  non-third-party, non-official egress. Everything else (CARTO/Esri tiles, `lacmta.github.io`
  icons, `gbfs.bcycle.com`, Google Fonts, `wss://api.metro.net`) is keyless and documented in
  `SELF-HOSTING.md` §4.

## 4. Suggested order

1. **D1 disclosure** (S, docs-only) — update `SELF-HOSTING.md` §4 to mark the Lambdas
   maintainer-operated + how to repoint. Ship first; it's pure documentation truth.
2. **D2** (S–M) — "alerts unavailable" state; pairs naturally with D1.
3. **D3** (S) — Permissions-gated startup auto-locate (owner call on the product behavior).
4. **D4** (S) — gate the `mlm_flyLog` write behind its debug flag.

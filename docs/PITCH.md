<!-- Internal pitch one-pager. Draft — adapt freely into a slide or email.
     Bracketed [ ... ] notes are for you to fill/confirm before sharing. -->

# Metro Live Map — a near-zero-cost upgrade to Metro's real-time map

**In one line:** a fast, accurate, accessible real-time map of Metro rail and rapid-bus service — built on Metro's *own* public data, already running in production, at essentially zero marginal cost.

**Not a concept.** It's built, it works, and it's been hardened: ~674 automated tests gate every change, and it runs live against Metro's real-time feeds today (currently on a private, password-protected site).

---

## The opportunity

Metro already publishes the real-time data and already offers a basic live map — so **the need is proven and the data plumbing exists.** This is a dramatically better front-end for that *same* data. It's an **upgrade to a capability Metro already has**, not a new program to stand up or justify.

## What it does

- **Live vehicle positions** for every rail line (A / B / C / D / E / K) and the G / J rapid-bus lines, updating in real time.
- **Accurate next-stop ETAs** — blends Metro's live predictions with a GPS-corrected schedule model, with physical sanity checks so it never shows an impossible arrival.
- **Truthful motion** — vehicles glide along the actual track between GPS fixes; they never teleport, never extrapolate past the last known position, and (newly) don't jitter or drift backward at stops.
- **Tap a station** for upcoming arrivals by line and direction; **tap a vehicle** for its next stop, destination, and ETA.
- **Integrated service alerts** (severity-coded), **Metro Bike Share** availability, and **Metro Micro** zones.
- **Excellent on mobile** (one-handed bottom-sheet UI) and desktop; dark mode; ~100-language support via the browser's built-in translation.

## Why it's better than the current map

[*You know the current map's specifics — drop them in. The differentiators to lean on:*]
accuracy of arrival times · smoothness/honesty of vehicle motion · mobile experience · accessibility · integrated alerts + bikeshare + micro · load speed.

## The cost story

- **~$0/yr to run.** It's a *static* site — no servers, no application backend, no database. It consumes the **free GTFS-RT feeds Metro already publishes** and an Esri/ArcGIS basemap [*confirm: this appears to use a Metro ArcGIS org, so the basemap tiles may already be covered by Metro's existing ArcGIS Enterprise agreement — i.e. no incremental tile cost*]. No per-seat licenses, no usage metering, no new vendor.
- **Contrast:** vendor real-time passenger-information / AVL-map products carry recurring license + hosting + integration fees. [*Insert Metro's current spend or a vendor quote here for the sharpest comparison.*]
- **The only real cost is a little maintenance time** — and most of that is automated: weekly GTFS auto-rebuild, schedule-drift detection, feed-reliability audits, and ~674 tests that block any regression.

## Posture (the questions IT, Legal, and Comms will ask)

- **Security** — no user accounts, no analytics, **no PII collected**; Content-Security-Policy + clickjacking guard; API keys are referrer-restricted; every change is gated by the test suite.
- **Privacy** — GDPR-clean: no cookies, no tracking, no third-party analytics.
- **Accessibility** — built to **WCAG 2.1 AA** (contrast, keyboard focus management, ARIA, reduced-motion aware). Material for a public agency (ADA / Section 508).
- **Reliability** — global error boundary + user-facing recovery banner, live observability, automatic data refresh with drift detection, documented rollback runbook.

## Data & attribution

Metro's **own** GTFS-RT WebSocket feeds (rail + bus), an Esri/ArcGIS basemap, and GBFS for bike share. Nothing proprietary — everything it uses, Metro already publishes or licenses.

## What "making it official" would take

(Honest next steps — only if there's interest.)

1. Metro IT / InfoSec review (data-flow, dependency inventory).
2. Legal / IP & brand sign-off; the official domain (`livemap.metro.net`, already configured, pending DNS).
3. An ownership / maintenance home (Metro IT or a sponsored arrangement) — and moving it off personal accounts and hosting.

## Known limits (no surprises)

- **B/D tunnel segments** lose GPS underground, so those trains pause for a few minutes mid-tunnel — inherent to the data, not the app.
- Today it's a **single-maintainer side project** (which is exactly why the ownership question above matters).

## The ask

[*Tailor this.* Suggested: **interest + an executive sponsor to scope making this Metro's official real-time map** — e.g. a short, low-risk pilot — starting with the IT/InfoSec and brand review above.]

---

*Built by [your name], [title], as a side project. Not an official Metro product (yet).*

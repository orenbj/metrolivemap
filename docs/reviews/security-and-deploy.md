# Review: Security, Privacy, Build, Deploy

Reviewer: automated review batch 2026-05-06
Scope: index.html (CSP/SRI/meta), js/config.js (keys), .gitignore, deploy config

## Summary
Overall security posture is solid: CSP is present and reasonably strict (default-src 'none' + per-directive allowlists), SRI is applied to the two static-CDN scripts/styles, no API keys are checked into the repo, and `.gitignore` correctly excludes the categories called out in CLAUDE.md. The two notable gaps are (1) no `Referrer-Policy` meta tag (now added inline) and (2) `'unsafe-inline'` in both `script-src` and `style-src`, which is justified for GA/GTM but worth flagging for future hardening.

## Findings — Bugs (highest priority)
- None. No outright bugs in the security/deploy surface.

## Findings — Security / Privacy

- [INFO] No API keys present in `js/config.js` — `js/config.js` only contains tunable constants, route metadata, GBFS public endpoints, and two undocumented Lambda URLs that back the public alerts page. ESRI tile service used (`tiles.arcgis.com/tiles/TNoJFjk1LsD45Juj/.../MapServer` in `js/map.js:179`) is keyless. There is no MapTiler key, no Mapbox token, no ArcGIS API key. CLAUDE.md's note about "API keys in config.js are client-visible; restrict via referrer policies" is currently aspirational — there are no keys to restrict yet. If a keyed tile provider is added later, this guidance applies.
  - Recommendation: When a keyed provider is introduced, lock the key to `https://livemap.metro.net` (and `https://orenbj.github.io` if used as a staging origin) via the vendor dashboard's HTTP-Referer allowlist. Document the restriction in `config.js` next to the constant.
  - Status: Recommended (no current exposure).

- [LOW] No `Referrer-Policy` meta tag — `index.html` had no `<meta name="referrer">`. Default browser behavior (`strict-origin-when-cross-origin` in modern browsers) is already conservative, but pinning it explicitly prevents older clients from leaking full URLs to third-party CDNs (unpkg, fonts.googleapis.com, lacmta.github.io, basemaps.cartocdn.com, the Lambda URLs in `config.js`).
  - Recommendation: Add `<meta name="referrer" content="strict-origin-when-cross-origin">`.
  - Status: Fixed inline.

- [INFO] CSP analysis (`index.html:20`):
  - `default-src 'none'` is correct — strict allowlist baseline.
  - `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://unpkg.com` — `'unsafe-inline'` is required for the inline GTM/gtag bootstrap blocks (see lines 30-44). Hardening path: move GTM bootstrap to an external `js/analytics.js` and drop `'unsafe-inline'`. Or use a hash-based CSP (`'sha256-...'`) for each inline block. Either approach is non-trivial because GTM injects further inline scripts at runtime; would also require a CSP nonce served from the host. On GitHub Pages (static-only) nonces aren't possible — only `'unsafe-inline'` or hashes are options. Hash-based approach is feasible since the inline blocks are static.
  - `style-src 'self' 'unsafe-inline' ...` — `'unsafe-inline'` here covers MapLibre GL's runtime style injection and inline `style=` attributes used throughout `index.html` (lines 116, 145–155, etc.). Hardening this would require refactoring all inline style attributes into CSS classes — sizable but not impossible.
  - `connect-src` is precise (lists each Lambda URL pattern, the WSS endpoint, GBFS host, ESRI tiles, etc.). Good.
  - `img-src 'self' data: blob: https:` — broad `https:` is acceptable for a map app loading SVG icons from `lacmta.github.io` and tile images from various CDNs.
  - `frame-src https://www.googletagmanager.com` — correctly scoped to GTM noscript iframe.
  - `worker-src blob:` — needed for MapLibre GL worker bootstrapping. Correct.
  - `object-src 'none'` and `base-uri 'self'` — both correct hardening flags.
  - Recommendation: Document the `'unsafe-inline'` justification (already in HTML comment on lines 5-19 — good). Long-term, consider hash-based CSP for the static inline GA/GTM blocks. No change for this PR.
  - Status: Recommended.

- [INFO] SRI coverage (`index.html`):
  - MapLibre GL JS 5.24.0 CSS + JS — `integrity=` present (lines 62-67). Good.
  - mapbox-gl-esri-sources 0.0.7 — `integrity=` present (lines 69-71). Good.
  - Typekit (`https://use.typekit.net/goe1fni.css`, line 59) — no `integrity=`. The HTML comment explains: Typekit serves dynamic CSS that imports versioned font files, so a static SRI hash would break on every Typekit publish. CSP `style-src` whitelist mitigates. Acceptable.
  - Google Fonts (`https://fonts.googleapis.com/css2?...`, line 74) — no `integrity=`. Same dynamic-CSS reasoning. Acceptable.
  - GTM/gtag scripts — loaded async via inline JS, no SRI possible (Google rotates the file). Acceptable.
  - Recommendation: When bumping MapLibre or mapbox-gl-esri-sources versions, regenerate SRI hashes (`openssl dgst -sha384 -binary file.js | openssl base64 -A`). The HTML comment on line 61 already calls this out.
  - Status: No change.

- [LOW] CSP `connect-src` includes `https://*.lambda-url.us-west-1.on.aws` — broad wildcard across the entire AWS Lambda function URL namespace in us-west-1. The two specific URLs are in `js/config.js`. Tightening to the exact two hosts would prevent a future code change (or compromised dependency) from exfiltrating data to an attacker-controlled Lambda. Trade-off: every alerts URL change requires a CSP update.
  - Recommendation: Consider replacing `https://*.lambda-url.us-west-1.on.aws` with the two specific subdomains: `https://5cgdcfl7csnoiymgfhjp5bqgii0yxifx.lambda-url.us-west-1.on.aws` and `https://lbwlhl4z4pktjvxw3tm6emxfui0kwjiv.lambda-url.us-west-1.on.aws`.
  - Status: Recommended (deferred — small attack-surface reduction, requires coordinating with backend owner if Lambda URLs ever rotate).

- [INFO] XSS surface baseline check — `js/utils.js:125` defines `escHtml()`. Imported and used in `js/bikeshare.js`, `js/microzones.js`, `js/stations.js`, `js/ui.js`. Sample line `js/bikeshare.js:389` shows `${escHtml(st.name)}` interpolating GBFS station names — correct. No deep-dive performed (per scope); other units cover their own modules. Baseline sanity check: every module that does `innerHTML` from feed data also imports `escHtml`. Good.

- [INFO] localStorage usage — three keys, all client-side preferences with no PII:
  - `darkMode` (`js/map.js:13,109`) — boolean string.
  - `disabledRoutes` (`js/ui.js:74,78,112`) — JSON array of route codes.
  - schedule calibration state (`js/scheduleCalibration.js:37,47`) — wrapped in try/catch for quota.
  - Recommendation: None. No PII, no auth tokens, no leakable data.
  - Status: OK.

- [INFO] Privacy / analytics — GA4 (`G-BK2E8DN75J`) + GTM (`GTM-M9GDT89R`) load on every pageview. CLAUDE.md / repo do not disclose a privacy notice or cookie banner. For a public transit map this is typical, but if the site is intended to fall under any consent regime (CCPA notice for CA users — likely, since this is a Metro Los Angeles app), a footer link to a privacy policy and a "Do Not Sell My Personal Information" link would be appropriate.
  - Recommendation: Add a privacy-policy footer link (out of scope for this PR — site copy decision).
  - Status: Recommended (out-of-band).

- [INFO] `.gitignore` audit — required entries are present:
  - `.env`, `.env.*` (line 29-30)
  - `scripts/*.jsonl` (line 52)
  - `*.log` (line 47)
  - GTFS `*.txt` via `/data/*.txt` (line 43) and raw GTFS subdir `/data/rail_gtfs/` (line 42)
  - `*.zip` (line 41)
  - `node_modules/` (line 23)
  - Bonus: `package-lock.json` (line 24) — the project deliberately doesn't commit lockfiles.
  - `git ls-files | grep -E '\.(env|jsonl|log|zip|txt)$|node_modules'` returns 0 hits. Repo is clean.
  - Status: OK.

## Findings — Deploy / Build

- [OK] No build step — `package.json` has only `test` / `test:watch` / `test:live` / `test:audit` scripts. `index.html` references `js/main.js` directly via `<script type="module">`. ES module imports use relative paths. CDN libs are loaded via `<script>` tags. Matches CLAUDE.md.

- [OK] `index.html` is at repo root. GitHub Pages will serve it as `/`.

- [OK] `CNAME` file is at repo root and contains `livemap.metro.net` (single line, no trailing whitespace observed). Per CLAUDE.md DNS for `livemap.metro.net` is "pending DNS" — CNAME presence is correct in anticipation. Note: until DNS resolves, the OG-image / og:url meta tags currently point to `https://metrolivemap.net/` (`index.html:52-53`) — that domain may or may not be intended as the canonical fallback.
  - Recommendation: Verify whether `metrolivemap.net` is owned/intended as the canonical URL or whether `og:url` should be `https://livemap.metro.net/` to match `CNAME`. Resolve before DNS goes live.
  - Status: Recommended.

- [OK] `.github/workflows/tests.yml` — CI runs `npm test` on push/PR (out-of-scope for content deep-dive, but presence is good).

## Findings — Documentation / JSDoc

- [INFO] CSP / SRI strategy is well-documented inline in `index.html:5-19`. No additional JSDoc needed.

- [INFO] `js/config.js` — well-documented with rationale and audit history for tunable constants. Lambda URL constants (`RAIL_ALERTS_URL`, `BUS_ALERTS_URL`) are commented as "undocumented but stable" — appropriate.

## Suggestions (non-defect improvements)

- [SUGGESTION] Add `Permissions-Policy` meta or remove unused features. Modern browsers allow disabling camera/microphone/geolocation/etc. via Permissions-Policy. The map doesn't request geolocation, camera, or microphone. Adding `<meta http-equiv="Permissions-Policy" content="camera=(), microphone=(), geolocation=()">` reduces risk if a third-party script is ever compromised.
  - Status: Recommended (out-of-band).

- [SUGGESTION] Consider adding a `SECURITY.md` at repo root with a contact email (`security@…` or `orenbj@…`) for vulnerability disclosure. GitHub recognizes this file and surfaces it in the Security tab.
  - Status: Recommended.

- [SUGGESTION] Pin GitHub Actions in `.github/workflows/*.yml` to commit SHAs rather than version tags (defense against tag re-pointing). Out of immediate scope but worth flagging for the unit covering CI.

## Findings out-of-lane (for other units)

- Unit covering `js/stations.js` / `js/predictions.js` / `js/ui.js` (likely UI/popups unit): I noted 27 occurrences of `innerHTML` / `insertAdjacentHTML` across `js/bikeshare.js` (6), `js/map.js` (6), `js/microzones.js` (3), `js/stations.js` (5), `js/ui.js` (6), `js/utils.js` (1). I sample-confirmed `escHtml` is imported in all the modules that interpolate feed-derived strings, but a per-module audit (every interpolation site) is the right unit's job, not mine.
- Unit covering `js/api.js` (feed/networking unit): Verify all `fetch()` calls reject non-200 responses and don't blindly `JSON.parse()` arbitrary text — outside my scope, but worth a per-call audit there.
- Unit covering `js/scheduleCalibration.js`: localStorage payload is parsed via `JSON.parse` — confirm the parse is wrapped in try/catch and the loaded object is shape-validated before use (defense against a tampered or corrupted localStorage entry).

## Inline fixes applied in this PR
- index.html: added `<meta name="referrer" content="strict-origin-when-cross-origin">` to pin referrer policy across all browsers.

## Test impact
- npm test: 12 files / 173 tests passed before and after change.
- New/changed tests: none (HTML meta-tag addition has no test surface).

# Alert Tooltip Copy Audit — 2026-05

Audit of LACMTA GTFS-RT service-alert and accessibility-alert prose as it
currently surfaces in Metro Live Map tooltips (legend badge tooltips,
station-popup banners, station-marker badge tooltips). Snapshot pulled
2026-05-16 from the two REST endpoints wired in `js/config.js`
(`RAIL_ALERTS_URL`, `BUS_ALERTS_URL`): 1,000 raw alerts, 115 currently
active across `DETOUR` (48), `NO_SERVICE` (40), `ACCESSIBILITY_ISSUE`
(18), and `MODIFIED_SERVICE` (9).

Scope: this is a copy / UX audit only. No code change is proposed in this
PR; the deliverable is this document plus a list of candidate render-time
cleanups for follow-up work.

---

## Executive summary

1. **Headers are useless as ledes.** 105 of 115 active alerts (~91%) ship
   a `headerText` that is ALL-CAPS shouting and contains either a route
   label (`LINE 92 DETOUR`), a station name (`PERSHING SQUARE STATION`),
   or both. None of them answer the rider's actual question ("can I take
   this train? when? what should I do instead?"). The first 6 words a
   rider reads on hover are almost always wasted.
2. **Accessibility alerts are a single sentence reused 15+ times verbatim.**
   "Escalators may be unavailable during this time due to maintenance."
   appears identically across 15 of 18 active accessibility entries. It
   is grammatically broken in isolation ("during this time" — what time?
   the rider has no schedule context in the tooltip) and provides zero
   actionable info. The two genuinely useful accessibility alerts in the
   set (Wilshire/Fairfax with an alternate-route hint, Memorial Park
   with a shuttle plan) prove the template *could* carry more.
3. **Detour copy buries the lede behind boilerplate.** The dominant
   pattern is `"Buses are detouring [via X] between Y and Z [from … to …]
   due to [reason]."` followed by 1–2 `Toward [destination], stops from
   A through B will not be served.` paragraphs. The rider's key question
   ("will my stop be skipped?") only resolves after parsing the second
   or third paragraph. The text averages 250–500 chars and ~70 words
   per detour.
4. **Date/time formatting is wildly inconsistent.** Observed in a single
   feed pull: `"Saturday, May 23 between 8am and 2pm"`, `"From Friday,
   May 15 at 9 pm through Monday, May 18 at 4 am"`, `"from 8 pm to 6
   am Monday to Friday until 5 am Saturday, July 11"`, `"Closure in
   effect weekly on Monday, Friday from 5:00 AM to 12:00 AM"`. Same
   feed, same author pool, four spellings of am/pm, three date formats,
   inconsistent use of hyphenated ranges vs `"from X through Y"`.
   Riders cannot scan these.
5. **5 of 115 active alerts have `activePeriod.end === null`** — they will
   sit in the tooltip surface until a human deletes them. One of them
   (`LINE 20, 210`) started 2025-11-13 and has been live for ~6 months.
   The app currently treats null as `Infinity`, so these alerts are
   functionally permanent and dilute the signal of the other ~95
   genuinely time-bounded notices.
6. **Header-vs-description redundancy is structural.** `buildAlertTooltipText`
   in `js/alerts.js` already handles the trivial cases ("description
   repeats header verbatim", "body is a superset of header"), but
   nothing handles the much more common pattern: header is a noisy
   ALL-CAPS label of *what the alert is about*, description is the
   actual prose. Both end up in the tooltip with the header just adding
   visual chrome.

---

## Categorized examples

Verbatim quotes from the 2026-05-16 feed snapshot. All formatting,
punctuation, and capitalization is reproduced as published.

### Good (rare)

These actually answer the rider question on first read.

**Wilshire/Fairfax elevator + alternate route**
> Header: `WILSHIRE/FAIRFAX STATION`
> Body: `Elevators are currently out of service. Use Wilshire/La Brea +
> Metro Bus Lines 20 or 720 on Wilshire Blvd. as alternative.`

What works: present-tense lede, concrete alternate (named stop + named
bus lines), no date math required because the alert is open-ended.

**K Line single-tracking**
> Header: `K LINE`
> Body: `Between 10am and 2pm, K Line trains at the Downtown Inglewood
> Station will use the northbound platform for each direction of travel.`

What works: time window first, station named, plain-English description
of the operational change. Still doesn't say *what action the rider should
take* (in practice: arrive at any platform; trains share one), but a
rider who reads it will not be surprised by what they see.

**Memorial Park ramp closure with shuttle plan**
> Header: `MEMORIAL PARK STATION RAMP CLOSURE`
> Body: `Due to a temporary ramp closure on the northbound platform at
> Memorial Park Station, we will run a free Access Services shuttle for
> all passengers needing accessible transportation.
>
> The shuttle will run every 10 minutes between
> the following stations:
>
> • Del Mar Station
> • Memorial Park Station
> • Lake Station
>
> The shuttle will take riders to the closest working elevator at Lake
> Station or closest accessible northbound ADA ramp at Del Mar Station.`

What works: bullets, frequency stated ("every 10 minutes"), explicit
fallback ("closest working elevator at Lake Station"). The mid-line break
after `"between"` is a hand-line-wrap artifact from the authoring tool,
but `white-space: pre-line` in the tooltip CSS renders it fine.

### Mediocre

Answer is in there but riders have to dig.

**E Line Saturday headway change**
> Header: `E LINE`
> Body: `Saturday, May 23 between 8am and 2pm, E Line trains will run every
> 16 minutes instead of the usual 10-minute service due to maintenance.
> Trains will share 1 track at Jefferson/USC, Expo Park/USC and Expo/Vermont.`

The lede ("Saturday, May 23 between 8am and 2pm") is the right shape but
the *impact* ("every 16 minutes instead of the usual 10-minute service")
is buried 14 words in. Riders skimming a busy popup will not reach it.
Better as: `"Sat May 23, 8am–2pm: trains every 16 min (normally 10)."`

**B Line bus bridge**
> Header: `B LINE`
> Body: `From Friday, May 15 at 9 pm through Monday, May 18 at 4 am, bus
> shuttles will replace train service at Hollywood/Highland, Universal
> City and North Hollywood Stations due to rehabilitation of our
> communication systems.`

"bus shuttles will replace train service at … Stations" is doing a lot of
work and is grammatically tortured. A rider on the B Line at Vermont/Sunset
has to guess whether their trip is affected. Reasonable rewrite: `"Fri
May 15 9pm – Mon May 18 4am: bus replaces B Line trains north of
Hollywood/Vine (Hollywood/Highland, Universal City, North Hollywood)."`

**Typical detour**
> Header: `LINE 92 DETOUR`
> Body: `Buses are detouring from Main St to Cesar E Chavez Ave between Main
> St and Grand Ave until 6 pm Saturday, May 16 due to construction.
>
> Toward Sylmar Metrolink Station, stops Temple / Spring and Temple / Hill
> will not be served.`

The skipped-stops paragraph is the *only* thing 95% of riders need to
read. The opening 24-word boilerplate ("Buses are detouring from … due
to construction") is invariant across the entire detour corpus and could
be collapsed to a leading icon or one-word effect label (we already have
"Detour:" prefixed by `buildAlertTooltipText`, so the prose is repeating
the prefix).

### Bad

Either grammatically broken in tooltip context, ambiguous, or stale.

**Generic accessibility (×15 in this snapshot)**
> Header: `PERSHING SQUARE STATION` (and ten other stations)
> Body: `Escalators may be unavailable during this time due to maintenance.`

"may be unavailable during this time" is meaningless without a time
window — and the time window is in `activePeriod`, which the tooltip
does not render. A rider standing at Pershing Square at 9 PM tonight
has no way to tell from this string whether the alert is currently
in effect, ended this morning, or starts next Tuesday. **This is the
single highest-impact normalization win in the audit.**

**Headway alert with no end date**
> Header: `C/K LINES`
> Body: `From Open to 9pm, C and K Line trains will run every 13 minutes
> due to maintenance. This change is necessary to enable rehabilitation
> of the overhead power system along the original C Line alignment.`
> `activePeriod.end`: `null`. Started 2026-04-27.

"From Open to 9pm" — every day? Through what date? `null` end-time +
ambiguous time-of-day = a permanent tooltip on every C/K Line legend
row that the rider can't act on.

**Stale-but-active stop closure**
> Header: `LINE 20, 210` (cause: not visible from feed surface)
> Body: (omitted from snapshot, retained internally; flagged as `end=null`,
> start `2025-11-13T14:52:00.000Z`).

Has been "active" for ~6 months. Either the underlying disruption is
actually permanent (and should be reflected in the GTFS static
schedule, not the alerts feed), or the alert was never closed. Either
way: stale tooltips erode rider trust in the rest of the feed.

**Inconsistent capitalization between sibling alerts**
> `LINE 92 DETOUR`
> ` G Line` (leading space; mixed case)
> `Stop Closure - LINE 35/38`
> `LINE 28 ` (trailing space)

These are 4 alerts pulled side-by-side from the same feed dump on
2026-05-16. No template enforcement.

**Identical content under different IDs**
Two distinct alert IDs at Wilshire/Fairfax (one elevator-out, one
escalator-out) are correctly disjoint, but Metro's data ops also
sometimes attaches the same outage to multiple stop IDs (e.g. merged
910/950 stops at El Monte), producing different IDs with identical
header + description. `stations.js` already dedupes by content
fingerprint inside `_collectBoardingState`, so the popup surface is
clean — but the legend-row tooltip combines all matching alerts on a
route and shows duplicates verbatim.

---

## Proposed rewrite rules

Authoring guidance that should be sent upstream to LACMTA Communications
(or applied at our render layer as a fallback). Ranked by rider impact.

1. **Lead with the window, then the impact.** First 12 words: when + what.
   Reason ("due to construction", "due to maintenance") goes last or is
   dropped. Example: `"Sat May 23, 8am–2pm: trains every 16 min."` not
   `"Saturday, May 23 between 8am and 2pm, E Line trains will run every
   16 minutes instead of the usual 10-minute service due to maintenance."`
2. **Never publish "during this time" with no time in-string.** If the
   tooltip surface won't show `activePeriod`, the prose must repeat the
   window. Either: render `activePeriod` in the tooltip (current proposal,
   see candidate #5 below), OR mandate that authoring tools auto-inject
   the dates into the body string.
3. **Skipped-stops first, geography second.** For detours, lead with the
   stop-impact paragraph; demote the routing description to a secondary
   line. Riders pick a bus by which stop it serves, not which streets
   it uses.
4. **No ALL-CAPS headers.** Use sentence case. The current convention
   (`PERSHING SQUARE STATION`) reads as shouting and is redundant when
   the popup or legend row is already labeled with the station/route.
5. **Hard ban on `end = null` for time-bounded disruptions.** Anything
   genuinely permanent belongs in GTFS static, not in the alerts feed.
   For genuinely indefinite work (e.g. ongoing elevator repair), require
   a `"review by"` date in the body so the rider knows what "currently"
   means.
6. **One template per disruption class.** Define exactly one canonical
   shape per `effect` value:
   - `DETOUR`: `<Line>: skipping <stop A>–<stop B> toward <terminus>, <window>. Alt: <nearest stop>.`
   - `NO_SERVICE` (stop closure): `<Line>: <stop> closed <window>. Use <alt stop>.`
   - `MODIFIED_SERVICE` (headway): `<Line>: <freq> service <window> (normal: <freq>).`
   - `MODIFIED_SERVICE` (single-tracking): `<Line>: shared track at <stop list>, <window>. Expect delays.`
   - `ACCESSIBILITY_ISSUE`: `<Station>: <facility> out <window>. Alt: <route or station>.`
7. **Bus-shuttle alerts must name the affected segment, not the affected
   stations.** "Bus replaces train at Hollywood/Highland, Universal City,
   North Hollywood Stations" is parsed by most riders as "those three
   stations are closed", not "the segment between Hollywood/Vine and
   North Hollywood is bridged". Use "between X and Y" framing.

---

## Minimum viable cleanup — candidate JS render-time normalizers

These are things `buildAlertTooltipText` (or a new sibling helper) could
do today without coordination with LACMTA Communications. **Listed, not
implemented.** Each is low-risk and reversible. Numbered in rough
implementation-order; each one should be its own small PR with tests so
the regex catalog stays auditable.

1. **Title-case ALL-CAPS headers.** Regex: if `header === header.toUpperCase()`
   and `header.length > 3`, lowercase + capitalize each word except known
   acronyms (`LAX`, `MTC`, `USC`, `LA`, `DTLA`, `ADA`, `EOL`, `AM`, `PM`).
   Apply at `buildAlertTooltipText` entry, not at ingest, so the raw
   `entry.header` stays auditable in `masterAlertsData`.
2. **Strip trailing/leading whitespace and double spaces in header & body.**
   Many entries have ` G Line` or `LINE 28 ` (trailing space). Trivial.
3. **Append `activePeriod` to bodies that contain "during this time" with
   no other date.** Heuristic: if `/during this time|currently/i.test(body)`
   and `!/\d{1,2}\s*(am|pm|:)/i.test(body)`, prepend a formatted window
   from `activePeriod`. Format: `"Through Mon May 18, 9pm:"` (relative
   day name for ≤7 days out, absolute otherwise; drop time component
   if the start is in the past). Skips alerts with `end = Infinity`.
4. **Demote duplicate body text when header is a station name and body
   already starts with the same name.** Builds on the existing
   "looksLikeStationName" check in `stations.js` (line ~908) — move the
   logic into `buildAlertTooltipText` so the legend-row path benefits
   too.
5. **Promote skipped-stops paragraphs to the top.** Regex split body on
   `/\n\s*\n/`; if any paragraph matches `/will not be served/i`, render
   it first followed by the rest. Cheap to implement, deterministic on
   the current corpus (every detour we saw uses this exact phrase).
6. **Drop "due to <reason>" tails when the prefix already says "Detour"
   or "Stop closure".** `s/\s*due to (construction|maintenance|an event|a technical problem)\.?\s*$//i` —
   the cause is already implicit in the icon + label.
7. **Suppress alerts older than N days with `end = null`.** Either filter
   at ingest (`_ingest` in `alerts.js`) or render-time with a "stale"
   visual tier (gray, smaller). Threshold proposal: 30 days. Today, 1 of
   115 active alerts trips this rule (`LINE 20, 210`, started Nov 2025).
8. **Normalize am/pm formatting.** Project an in-string regex over body
   text: `/(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?\s*m\.?\b/gi` → canonical
   `"$1:$2 $3m"` (or `"$1 $3m"` if no minutes). Eliminates the four
   observed spellings (`9 pm`, `9pm`, `9 p.m.`, `9:00 PM`) in one pass.

The whole cleanup pipeline should live as a single named function
(suggestion: `normalizeAlertProse(alert) → { header, body }`) called by
`buildAlertTooltipText` and `stations.js _collectBoardingState` so both
surfaces stay in sync. Tests should pin the before/after for ~20
representative inputs drawn from this snapshot.

---

## Open questions for product

1. **Suppress vs surface stale alerts.** Should we filter `end = null`
   alerts older than 30 days at ingest, or render them with a "stale"
   visual treatment (e.g. dim color, age badge)? Filtering risks hiding
   a real ongoing outage; surfacing risks training riders to ignore
   tooltips because most are stale.
2. **Render `activePeriod` in tooltips directly.** If we always append a
   `"Active: <window>"` line at the end of the tooltip body, candidate
   #3 above becomes redundant. Visual cost is one extra line in every
   alert tooltip; benefit is rider can always answer "is this active
   right now?" without depending on author prose.
3. **Should we send rewrites upstream?** This audit is grounded in
   LACMTA's public feed, so the same prose issues affect alerts.metro.net,
   the official mobile app, Google Maps Transit, and third-party
   trip-planners. Talking to LACMTA Communications would fix the root
   cause across the ecosystem; client-side normalization fixes only us.
4. **Per-locale handling.** The app now relies on browser-native
   translation rather than the retired `i18n.js` dictionary. Any
   render-time rewriting (#1 title-case, #5 paragraph reordering) is
   pre-translation, so it applies to all locales. Confirm that the
   normalizers do not insert phrases that translate awkwardly (e.g.
   "Through Mon May 18, 9pm" should probably be authored as a single
   `<time>` element with `datetime` attribute so translation engines
   can re-format).
5. **Accessibility alert template completeness.** Of the 18 active
   `ACCESSIBILITY_ISSUE` alerts, 15 reuse the same single sentence with
   no alternate-route guidance. Should we (a) lobby LACMTA for a
   template that *requires* an alternate, or (b) inject a generic
   "Contact station agent for assistance" fallback at render time?
6. **Tooltip length cap.** Should we truncate bodies longer than ~280
   chars with a "more…" affordance (already a `<details>` element in
   station popups), or accept that detour alerts will always be long?
   The four longest in this snapshot are 446–497 chars and structurally
   need the length.

---

## Methodology

- Snapshot pulled 2026-05-16 (`curl` against the same Lambda URLs the app
  polls in production: `js/config.js` lines 301–302).
- 1,000 alerts total (500 rail + 500 bus), 115 active by the same
  `activePeriod.end > now` filter the app uses in `_ingest`/`getActive*`.
- Effects: `DETOUR` 48, `NO_SERVICE` 40, `ACCESSIBILITY_ISSUE` 18,
  `MODIFIED_SERVICE` 9.
- Quoted prose is verbatim and unaltered, including whitespace and
  punctuation artifacts.
- No GTFS-RT canary or sandbox endpoint exists — this snapshot is the
  same data the production app rendered to riders on the audit date.

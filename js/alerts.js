/**
 * alerts.js
 * Polls the Metro service-alerts REST endpoints (which power alerts.metro.net)
 * and maintains a live lookup of active alerts:
 *
 *   window.masterAlertsData                    Map { routeCode → Alert[] }
 *   window.masterStopAlertsData                Map { stopId    → Alert[] }
 *   window.masterStopAccessibilityAlertsData   Map { stopId    → Alert[] } (♿)
 *
 *   Alert = { id, effect, header, description, activePeriod: { start, end } }
 *
 * Exports:
 *   initAlerts                            — bootstrap the poll loop
 *   updateAlertBadges                     — refresh legend "!" indicators
 *   wireAlertBadge                        — shared tooltip + click handler
 *   getActiveAlerts(routeCode)            — route-keyed canonical filter
 *   getActiveStopAlerts(stopId)           — stop-keyed regular alerts
 *   getActiveStopAccessibilityAlerts(id)  — stop-keyed elevator/escalator
 *   classifyAccessibilityAlert(h, d)      — 'elevator' | 'escalator' | 'both' | 'unknown'
 *   STRIP_EFFECT_LABELS                   — GTFS-RT effect → display label
 *   _clearStationIndexCache               — invalidate the regex index on GTFS reload
 */

import { RAIL_ALERTS_URL, BUS_ALERTS_URL, ALERTS_POLL_MS, METRO_ROUTE_CODES } from './config.js';
import { setVisibleInterval, normalizeStopId, fetchWithTimeout, normalizeTimestamp, splitRouteId, cleanStationName, stationNameKey } from './utils.js';
import { getRouteCache } from './predictions.js';

// ── Station-name text-mining fallback ──────────────────────────────────────
//
// LA Metro's alerts feed often publishes station-specific delays/issues as
// route-scoped alerts (informedEntities: [{ routeId: '801' }]) where the
// affected station name appears only in descriptionText/headerText —
// e.g. "delays due to mechanical issue at Allen Station". Without any
// stopId in the feed, masterStopAlertsData stays empty for that stop and
// the per-station "!" badge never renders.
//
// Fallback: when an alert produced zero stopIds from informedEntities, scan
// its text against the names of stops on the alert's routes. Match is
// constrained to:
//   - station name + literal " Station" (case-insensitive, word boundaries)
//   - OR, if the stop's name already ends in "Station", just the name
//   - name must be ≥ 4 chars (avoid matching tokens like "7th")
// Restricting candidates to stops on the alert's routes prevents matching
// e.g. a bus stop named "Allen / Colorado" against a rail alert.
//
// The whole index is rebuilt per _fetchAlerts pass (cheap: ~150 rail stops
// total) and the rebuild is keyed by the union of all routes seen, so we
// only do it when there's at least one fallback-eligible alert.
let _stationIndexCache = null;
let _stationIndexCacheKey = '';

// Directional qualifier that Metro authors routinely drop in alert prose.
// "Pomona North Station" gets written as "Pomona Station" in the feed
// even though the system has only one Pomona stop — so a regex that
// requires the full name silently misses the alert. Matches a direction
// word either at the very end of the name ("Pomona North") OR immediately
// before " Station" ("Pomona North Station") so both spellings of the
// stop name produce the same core when stripped. Used in the alias
// branch below; the bare full-name regex is always emitted as primary.
const _DIRECTIONAL_SUFFIX_RE = /\s+(North|South|East|West)(?=\s+Station\b|$)/i;

/** Escape user-supplied text for inclusion in a RegExp literal source. */
function _escapeRegex(s) {
    return s
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // Treat slash and hyphen separators as interchangeable so the regex
        // matches both "Willowbrook - Rosa Parks" and "Willowbrook/Rosa
        // Parks" — Metro's prose uses both forms interchangeably.
        .replace(/\s*[-/]\s*/g, '\\s*[-/]\\s*');
}

/** Build [{ stopId, regex }] for every stop on the given routeCodes. */
function _buildStationIndex(routeCodes) {
    const key = [...routeCodes].sort().join(',');
    if (key === _stationIndexCacheKey && _stationIndexCache) return _stationIndexCache;
    _stationIndexCacheKey = key;
    _stationIndexCache = [];
    if (!window.masterStopsData) return _stationIndexCache;

    // Two-pass build:
    //   1. Collect every candidate (stopId, full name, core-without-direction)
    //      so we can detect collisions on the core name across the indexed set.
    //   2. Emit the primary full-name regex for each candidate. Two secondary
    //      alias regexes are also emitted when unambiguous:
    //      a) Directional alias: "Pomona North" → "Pomona Station" when no
    //         other stop shares the bare core.
    //      b) No-Station alias: "Culver City Station" → bare "Culver City"
    //         when no other stop's stripped core collides. Handles Metro's
    //         "[A] and [B] Stations" list pattern where neither A nor B is
    //         immediately adjacent to "Station" in the text.
    const seen = new Set();
    const candidates = [];        // { id, name, core }
    const coreCounts = new Map(); // core → count

    for (const rc of routeCodes) {
        for (const dir of [0, 1]) {
            const cache = getRouteCache(rc, dir);
            if (!cache?.stops) continue;
            for (const sid of cache.stops) {
                const id = normalizeStopId(String(sid));
                if (seen.has(id)) continue;
                seen.add(id);
                const stop = window.masterStopsData[id]
                          ?? window.masterStopsData[String(sid)];
                const rawName = String(stop?.name ?? '').trim();
                if (rawName.length < 4) continue;
                // Strip line designators ("- Metro A-Line", "C-Line Station",
                // etc.) so the regex matches the canonical station name found
                // in alert prose. Without this, names like "Willowbrook - Rosa
                // Parks Station - Metro A-Line" produce a regex that requires
                // the literal line suffix in the text, which never matches.
                // Pass stripStation=false so the "Station" word is preserved
                // for the suffix-or-no-suffix branch below.
                const name = cleanStationName(rawName, false);
                if (name.length < 4) continue;
                // Core = name with the trailing direction word stripped (or
                // unchanged when no direction is present). Used both for the
                // collision check and to build the alias regex.
                const core = name.replace(_DIRECTIONAL_SUFFIX_RE, '').trim();
                candidates.push({ id, name, core });
                coreCounts.set(core, (coreCounts.get(core) ?? 0) + 1);
            }
        }
    }

    // Precompute stripped-core collision counts for the no-Station alias (2b).
    // A name like "Culver City Station" has strippedCore "Culver City".
    // Only emit the bare alias when no other indexed stop shares that core,
    // so a multi-station hub (e.g. "Union Station") on two routes doesn't
    // trigger a false match on the word "Union" alone.
    const strippedCoreCounts = new Map();
    for (const { name } of candidates) {
        if (!/\bstation$/i.test(name)) continue;
        const stripped = name.replace(/\s+Station$/i, '').trim();
        if (stripped.length < 4) continue;
        const k = stationNameKey(stripped);
        strippedCoreCounts.set(k, (strippedCoreCounts.get(k) ?? 0) + 1);
    }

    for (const { id, name, core } of candidates) {
        const escaped = _escapeRegex(name);
        const endsInStation = /\bstation$/i.test(name);
        const pattern = endsInStation
            ? `\\b${escaped}\\b`
            : `\\b${escaped}\\s+Station\\b`;
        _stationIndexCache.push({ stopId: id, regex: new RegExp(pattern, 'i') });

        // No-Station alias (2b): "Culver City Station" → also match bare
        // "Culver City" so Metro's "[A] and [B] Stations" pattern is caught
        // even though neither name sits immediately before "Station".
        if (endsInStation) {
            const stripped = name.replace(/\s+Station$/i, '').trim();
            if (stripped.length >= 4 && strippedCoreCounts.get(stationNameKey(stripped)) === 1) {
                const escapedStripped = _escapeRegex(stripped);
                _stationIndexCache.push({ stopId: id, regex: new RegExp(`\\b${escapedStripped}\\b`, 'i') });
            }
        }

        // Directional alias (2a): "Pomona North" → also match "Pomona Station"
        // when no other indexed stop has "Pomona" as its core.
        if (core !== name && core.length >= 4 && coreCounts.get(core) === 1) {
            const escapedCore = _escapeRegex(core);
            const aliasPattern = /\bstation$/i.test(core)
                ? `\\b${escapedCore}\\b`
                : `\\b${escapedCore}\\s+Station\\b`;
            _stationIndexCache.push({ stopId: id, regex: new RegExp(aliasPattern, 'i') });
        }
    }
    return _stationIndexCache;
}

/** Find stopIds whose station name appears in the given text, scoped to routeCodes. */
function _matchStationsInText(text, routeCodes) {
    if (!text || routeCodes.size === 0) return new Set();
    const matches = new Set();
    for (const { stopId, regex } of _buildStationIndex(routeCodes)) {
        if (regex.test(text)) matches.add(stopId);
    }
    return matches;
}

/** Map of GTFS-RT effect codes to human-readable labels shown in popups and badges. */
export const STRIP_EFFECT_LABELS = {
    DETOUR:               'Detour',
    REDUCED_SERVICE:      'Reduced service',
    SIGNIFICANT_DELAYS:   'Delays',
    NO_SERVICE:           'No service',
    MODIFIED_SERVICE:     'Modified service',
    STOP_MOVED:           'Stop changes',
    OTHER_EFFECT:         'Service alert',
    UNKNOWN_EFFECT:       'Service alert',
};

// Severity tiers — single source of truth used by every alert indicator
// (legend badges, station markers, panel chips, panel count badge, toggle
// dot). The values are also the `data-severity` attribute that CSS keys
// off, so adding a new effect only requires editing this map.
//
// • severe   — service is missing or substantially delayed; the rider can
//              no longer rely on the schedule. Renders red.
// • moderate — service is altered but running; the rider should adjust but
//              isn't stranded. Renders amber.
const EFFECT_SEVERITY = {
    NO_SERVICE:         'severe',
    SIGNIFICANT_DELAYS: 'severe',
    DETOUR:             'moderate',
    REDUCED_SERVICE:    'moderate',
    MODIFIED_SERVICE:   'moderate',
    STOP_MOVED:         'moderate',
    OTHER_EFFECT:       'moderate',
    UNKNOWN_EFFECT:     'moderate',
};

/**
 * Severity tier for a single effect code. Defaults to 'moderate' for any
 * unrecognised effect so a new GTFS-RT effect code introduced by Metro
 * still surfaces visibly (amber dot) rather than vanishing.
 *
 * @param {string} effect  GTFS-RT effect code (e.g. 'NO_SERVICE')
 * @returns {'severe'|'moderate'}
 */
export function effectSeverity(effect) {
    return EFFECT_SEVERITY[effect] ?? 'moderate';
}

/**
 * Highest severity present in a list of alerts. Returns null when the list
 * is empty so callers can skip rendering an indicator entirely.
 *
 * @param {Array<{effect:string}>} alerts
 * @returns {'severe'|'moderate'|null}
 */
export function maxSeverity(alerts) {
    let max = null;
    for (const a of alerts) {
        const s = effectSeverity(a.effect);
        if (s === 'severe') return 'severe';
        if (s === 'moderate') max = max ?? 'moderate';
    }
    return max;
}

/**
 * Start polling Metro service-alerts REST endpoints and populate
 * window.masterAlertsData (Map<routeCode, Alert[]>). Polls every ALERTS_POLL_MS
 * and pauses while the tab is hidden.
 */
let _alertsInitialized = false;

export function initAlerts() {
    // Allow re-init if module state was wiped (test reset path) — production
    // callers never delete masterAlertsData, so this early-return covers the
    // legitimate idempotency case without breaking the test harness.
    if (_alertsInitialized && window.masterAlertsData) return;
    _alertsInitialized = true;
    window.masterAlertsData = new Map();
    window.masterStopAlertsData = new Map();
    window.masterStopAccessibilityAlertsData = new Map();
    _fetchAlerts();
    setVisibleInterval(_fetchAlerts, ALERTS_POLL_MS, 'alerts:poll');
}

/**
 * Clear the station-name regex index. Called when GTFS data reloads at
 * midnight so the index rebuilds from the new masterStopsData on the
 * next poll instead of routing alerts to yesterday's stops.
 */
export function _clearStationIndexCache() {
    _stationIndexCache = null;
    _stationIndexCacheKey = '';
}

// Pending retry timer from a failed first poll. Tracked at module scope so a
// re-entrant initAlerts (test reset / hot reload) can cancel a stale retry
// instead of letting orphan timers fire on the new instance.
let _alertsRetryTimer = null;

async function _fetchAlerts(_retry = 0) {
    try {
        const [rail, bus] = await Promise.all([
            fetchWithTimeout(RAIL_ALERTS_URL, 10000).then(r => r.json()),
            fetchWithTimeout(BUS_ALERTS_URL,  10000).then(r => r.json()),
        ]);
        const now = Math.floor(Date.now() / 1000);
        window.masterAlertsData.clear();
        window.masterStopAlertsData.clear();
        window.masterStopAccessibilityAlertsData.clear();
        // Invalidate the station-name index — masterStopsData may have hot-reloaded
        // since the previous poll (e.g. weekly GTFS rebuild), and stale entries
        // would mis-route fallback matches.
        _stationIndexCache = null;
        _stationIndexCacheKey = '';
        for (const alert of [...(Array.isArray(rail) ? rail : []), ...(Array.isArray(bus) ? bus : [])]) {
            _ingest(alert, now);
        }
        updateAlertBadges();
        document.dispatchEvent(new CustomEvent('alertsUpdated'));
        // Successful fetch — discard any pending retry from a prior failure
        // so we don't double-fetch on the next regular tick after recovery.
        if (_alertsRetryTimer) {
            clearTimeout(_alertsRetryTimer);
            _alertsRetryTimer = null;
        }
    } catch (err) {
        console.warn('[alerts] fetch failed:', err);
        // One quick retry covers transient network blips — without this a
        // single bad poll silently leaves alerts stale for the full 120 s
        // poll interval. After the retry we yield to the regular poll.
        // Guard against piling up multiple retries if a re-entrant call
        // raced an in-flight one — a single pending retry is sufficient.
        if (_retry === 0 && !_alertsRetryTimer) {
            _alertsRetryTimer = setTimeout(() => {
                _alertsRetryTimer = null;
                _fetchAlerts(1);
            }, 10_000);
        }
    }
}

function _ingest(alert, now) {
    // Classify accessibility alerts (elevator/escalator outages) — Metro often
    // mislabels them as OTHER_EFFECT, so match the text too. These are routed
    // into a separate per-stop map (masterStopAccessibilityAlertsData) so they
    // don't pollute the route-level service-alert UI and don't double-render
    // as both an amber "!" and a blue ♿ badge on the same station.
    const _accessText = (alert.descriptionText ?? '') + (alert.headerText ?? '');
    // Word-boundary anchor avoids accidental substring matches in service-alert
    // prose (e.g. "service elevated to priority", "issue escalated"). Without
    // \b, a metaphorical "elevator" or "escalator" mention silently re-routes
    // a service alert into the per-stop accessibility map and renders as ♿.
    const isAccessibility =
        alert.effect === 'ACCESSIBILITY_ISSUE' ||
        /\b(?:elevator|escalator)/i.test(_accessText);

    // Pick the first period that hasn't expired yet. Metro occasionally publishes
    // two periods (e.g., Fri night + Sat night) — using [0] always left the
    // second period invisible if the first had already ended.
    const period = (alert.activePeriods ?? []).find(p => {
        const e = p.end ? normalizeTimestamp(p.end) : Infinity;
        return Number.isFinite(e) ? e > now : true; // Infinity-end periods never expire
    }) ?? alert.activePeriods?.[0] ?? {};
    // Metro alert API mixes ISO strings and Unix integers (seconds or ms) for
    // activePeriod boundaries. normalizeTimestamp handles all three forms,
    // returning NaN for unparseable input.
    const end = period.end ? normalizeTimestamp(period.end) : Infinity;
    // Drop malformed timestamps loudly. Without this, NaN slips through
    // (`NaN < now` is false), the alert lurks in masterAlertsData with NaN
    // periods, and getActiveAlerts silently filters it out forever — an
    // invisible memory leak until the next 120s poll's clear() phase.
    if (!Number.isFinite(end) && end !== Infinity) {
        console.warn(`[alerts] dropping malformed activePeriod.end for alert ${alert.id}:`, period.end);
        return;
    }
    if (end < now) return;

    const routeCodes = new Set();
    const stopIdSet  = new Set();
    for (const ie of (alert.informedEntities ?? [])) {
        const rc = splitRouteId(ie.routeId);
        if (METRO_ROUTE_CODES.has(rc)) routeCodes.add(rc);
        if (ie.stopId) stopIdSet.add(normalizeStopId(String(ie.stopId)));
    }
    // Route-scoped requirement applies only to service alerts. Accessibility
    // alerts are inherently station-scoped — an elevator outage tagged only to
    // a stop (with no route) is still actionable for riders.
    if (!isAccessibility && routeCodes.size === 0) return;

    // Fallback: when the feed provided no per-stop targeting, scan the alert
    // text for station names on the affected routes. Used both for labelled
    // service alerts (STRIP_EFFECT_LABELS) and for accessibility alerts where
    // the feed omits stopIds.
    if (stopIdSet.size === 0 &&
        (isAccessibility || Object.hasOwn(STRIP_EFFECT_LABELS, alert.effect))) {
        const scanRoutes = routeCodes.size ? routeCodes : new Set(METRO_ROUTE_CODES);
        const text = `${alert.headerText ?? ''} ${alert.descriptionText ?? ''}`;
        for (const sid of _matchStationsInText(text, scanRoutes)) stopIdSet.add(sid);
    }

    // Accessibility "alternative station" filter — when an elevator outage
    // alert lists multiple stopIds AND the header is a single station name
    // (e.g. "HOLLYWOOD/HIGHLAND STATION"), filter the stopIds to only the
    // ones whose station name matches the header. Metro routinely tags the
    // SUGGESTED ALTERNATIVE stop in informedEntities too — the alert body
    // reads "Elevator unavailable... Use Hollywood/Vine instead" — which
    // caused the unaffected stop's marker to display the outage banner.
    //
    // Only applied to accessibility alerts because service alerts
    // legitimately span multiple stops ("delays between A and B Stations").
    // No-op when the header doesn't normalize to any tagged stop's name
    // (system-wide alerts, vague headers) — falls back to feed semantics.
    if (isAccessibility && stopIdSet.size > 1) {
        const headerKey = stationNameKey(alert.headerText ?? '');
        if (headerKey) {
            // Use prefix match so entrance-variant stop entries belong to
            // the same station as the base. Metro publishes entries like:
            //   80204   "Hollywood / Vine Station"               → key "hollywoodvine"
            //   80204A  "Hollywood / Vine Station - Elevator"    → key "hollywoodvineelevator"
            //   80204B  "Hollywood / Vine Station - Main Entrance" → key "hollywoodvinemainentrance"
            // The plain equality check used to drop 80204A/80204B
            // because their keys aren't equal to "hollywoodvine". Prefix
            // match keeps them (they share the base station prefix) while
            // still excluding a genuinely different station like
            // "hollywoodhighland" that doesn't share the prefix.
            const matched = [];
            for (const sid of stopIdSet) {
                const stop = window.masterStopsData?.[sid]
                          ?? window.masterStopsData?.[normalizeStopId(sid)];
                if (!stop?.name) continue;
                const stopKey = stationNameKey(stop.name);
                if (stopKey === headerKey || stopKey.startsWith(headerKey)) {
                    matched.push(sid);
                }
            }
            if (matched.length > 0 && matched.length < stopIdSet.size) {
                stopIdSet.clear();
                for (const sid of matched) stopIdSet.add(sid);
            }
        }
    }

    // Same NaN guard as end above. A malformed start could let
    // activePeriod.start > now silently rule a future alert "active".
    const start = period.start ? normalizeTimestamp(period.start) : 0;
    if (!Number.isFinite(start)) {
        console.warn(`[alerts] dropping malformed activePeriod.start for alert ${alert.id}:`, period.start);
        return;
    }
    // The same `entry` object is pushed by reference into both
    // masterAlertsData[routeCode] and masterStopAlertsData[stopId] below,
    // so a single alert spanning N routes × M stops uses one heap object,
    // not N×M copies. **Callers must treat entries as immutable** — mutating
    // an entry from one lookup path silently changes it on every other path.
    const entry = {
        id:          alert.id ?? '',
        effect:      alert.effect ?? '',
        header:      alert.headerText ?? '',
        description: alert.descriptionText ?? '',
        activePeriod: { start, end },
        stopIds:     [...stopIdSet],
    };

    if (isAccessibility) {
        // Accessibility alerts only land in the per-stop accessibility map.
        // No per-stop targeting (after fallback) → nothing to attach to.
        if (stopIdSet.size === 0) return;
        for (const stopId of stopIdSet) {
            if (!window.masterStopAccessibilityAlertsData.has(stopId)) {
                window.masterStopAccessibilityAlertsData.set(stopId, []);
            }
            const aList = window.masterStopAccessibilityAlertsData.get(stopId);
            const aIdx  = aList.findIndex(a => a.id === entry.id);
            if (aIdx >= 0) aList[aIdx] = entry;
            else aList.push(entry);
        }
        return;
    }

    for (const rc of routeCodes) {
        if (!window.masterAlertsData.has(rc)) window.masterAlertsData.set(rc, []);
        const list = window.masterAlertsData.get(rc);
        const idx  = list.findIndex(a => a.id === entry.id);
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
    }
    for (const stopId of stopIdSet) {
        if (!window.masterStopAlertsData.has(stopId)) window.masterStopAlertsData.set(stopId, []);
        const sList = window.masterStopAlertsData.get(stopId);
        const sIdx  = sList.findIndex(a => a.id === entry.id);
        if (sIdx >= 0) sList[sIdx] = entry;
        else sList.push(entry);
    }
}

/**
 * Return currently-active alerts for a route, filtered by current time.
 * @param {string|number} routeCode  e.g. "801", "901"
 * @returns {Alert[]} Active alerts (may be empty)
 */
export function getActiveAlerts(routeCode) {
    if (!window.masterAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterAlertsData.get(String(routeCode)) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

// Acronyms / proper nouns that should stay uppercase when we title-case
// shouting headers. Anything not on this list goes through standard
// capitalize-each-word logic. Keep alphabetized.
const ACRONYM_ALLOWLIST = new Set([
    'ADA', 'AM', 'CBD', 'DTLA', 'EOL', 'LA', 'LAPD', 'LAX', 'OBI',
    'PM', 'POI', 'PV', 'SF', 'TSA', 'USC',
]);

// Single-letter Metro line codes (E, B, D, A, K, G, J, C). When the header
// starts with one, e.g. "E LINE", we keep the letter uppercase even though
// the rest gets title-cased.
const LINE_CODE_RE = /^[A-K]$/;

/**
 * Recapitalize a SHOUTING ALL-CAPS string into title case while preserving
 * known acronyms, single-letter line codes ("E LINE" → "E Line"), and
 * ordinal-ish tokens with embedded digits ("37TH" → "37th"). Only triggers
 * when the input is entirely uppercase letters (with whitespace / digits /
 * punctuation) — mixed-case input is returned unchanged.
 *
 * @param {string} s
 * @returns {string}
 */
function _titleCaseShout(s) {
    if (!s || s !== s.toUpperCase() || s.length < 4) return s;
    // Don't touch strings without any A-Z (pure numbers, symbols, etc.).
    if (!/[A-Z]/.test(s)) return s;
    // Re-case each alphanumeric run independently. Splitting on /\S+/
    // would treat "WILSHIRE/FAIRFAX" as one token; matching alphanumeric
    // runs instead lets us preserve `/`, `-`, etc. as separators while
    // capitalizing each side ("Wilshire/Fairfax").
    return s.replace(/[A-Za-z0-9]+/g, (core) => {
        if (ACRONYM_ALLOWLIST.has(core)) return core;
        if (LINE_CODE_RE.test(core))     return core;             // "E", "K"…
        // "37TH" → "37th", "5TH" → "5th", "1ST" → "1st"
        if (/^\d+[A-Z]+$/.test(core)) {
            return core.replace(/[A-Z]+$/, m2 => m2.toLowerCase());
        }
        // Leading digits ("28", "92") pass through unchanged; alphabetic
        // runs get standard title case.
        if (/^\d+$/.test(core)) return core;
        return core[0] + core.slice(1).toLowerCase();
    });
}

// Pre-compiled regex used by _normalizeAmPm: match `9pm`, `9 pm`,
// `9 p.m.`, `9:30 PM`, etc. — but not bare numbers or other letter
// suffixes. Capture groups: 1=hour, 2=minutes (optional), 3=a|p.
// `\b` after `m` would leave a trailing `.` from `9 p.m.` behind; absorbing
// the optional trailing dot into the capture instead keeps the substitution
// clean across all four observed spellings.
// Negative-lookahead instead of `\b` after `m` so the optional trailing `.`
// is actually consumed when present ("9 p.m." → "9 pm" not "9 pm.").
const AMPM_RE = /(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?\s*m\.?(?![A-Za-z])/gi;

/**
 * Normalize the four observed am/pm spellings (`9pm`, `9 pm`, `9 p.m.`,
 * `9:00 PM`) to one canonical form: `<h>:<mm> <a|p>m` with lowercase
 * `am`/`pm` and a space separator. Minutes are preserved when present.
 *
 * @param {string} s
 * @returns {string}
 */
function _normalizeAmPm(s) {
    if (!s) return s;
    return s.replace(AMPM_RE, (_match, hour, minutes, half) => {
        const mm = minutes ? `:${minutes}` : '';
        return `${hour}${mm} ${half.toLowerCase()}m`;
    });
}

/**
 * Collapse runs of internal whitespace to a single space, trim ends, but
 * preserve paragraph breaks (`\n\n`) and single newlines used by Metro
 * authors for bullet lists. The tooltip CSS uses `white-space: pre-line`
 * so newlines render — we only flatten *horizontal* runs.
 *
 * @param {string} s
 * @returns {string}
 */
function _normalizeWhitespace(s) {
    if (!s) return s;
    // Per-line trim + collapse intra-line runs, then trim the whole.
    return s
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Apply the rider-facing copy normalizers to an alert entry. Returns a
 * fresh `{ header, body }` pair without mutating the original alert (so
 * `masterAlertsData` retains the raw Metro-authored strings for audit).
 *
 * Stage 1 normalizers (audit doc `docs/_archive/alert-copy-audit-2026-05.md`):
 *   - Title-case ALL-CAPS shouting headers (#1 in candidate list).
 *   - Trim + collapse whitespace in header and body (#2).
 *   - Canonicalize am/pm formatting in the body (#8).
 *   - Drop a body prefix that just repeats the (possibly normalized)
 *     header — this generalizes the existing prefix-of-header guard
 *     so it survives the title-casing step (#4).
 *
 * @param {Object} alert  {header, description, …}
 * @returns {{header: string, body: string}}
 */
export function normalizeAlertProse(alert) {
    const rawHeader = (alert?.header ?? '').trim();
    const rawBody   = (alert?.description ?? '').trim();
    const header = _titleCaseShout(_normalizeWhitespace(rawHeader));
    let body     = _normalizeAmPm(_normalizeWhitespace(rawBody));
    // Drop body lede when it just repeats the header (in any casing) AND
    // a clear separator follows ("Wilshire/Fairfax Station: Elevators…").
    // Without the separator requirement we'd also strip Metro's superset
    // pattern "Elevator out" + "Elevator out of service…", which is real
    // prose continuation. buildAlertTooltipText already handles that case
    // by promoting the body to the title line.
    if (header && body) {
        const headerLc = header.toLowerCase();
        const bodyLc   = body.toLowerCase();
        if (bodyLc === headerLc) {
            body = '';
        } else if (bodyLc.startsWith(headerLc)) {
            const after = body.slice(header.length);
            // Strip only when the joiner is punctuation/newline — keep
            // space + continuation alone so superset bodies still merge.
            if (/^[.:;,\n–—-]/.test(after)) {
                body = after.replace(/^[\s.:;,–—-]+/, '');
            }
        }
    }
    return { header, body };
}

/**
 * Decompose a single alert into a structured tooltip block:
 *   { prefix, title, body }
 *
 * `title` is the line that goes next to the bold `<prefix>:` chip.
 * `body` is the longer-form description (may be empty). The same
 * redundancy rules from `buildAlertTooltipText` apply — description
 * that duplicates or is a prefix of header collapses into the title.
 *
 * This is the canonical shape consumed by the DOM renderer
 * (`_renderTooltipDom`); `buildAlertTooltipText` is now a thin
 * adapter over this that flattens to plain text for aria-labels.
 *
 * @param {string} prefix
 * @param {Object} alert
 * @returns {{prefix: string, title: string, body: string}}
 */
export function buildAlertTooltipBlock(prefix, alert) {
    const { header, body } = normalizeAlertProse(alert);
    // Body is a superset of header → promote the full body to the
    // title line, drop the bare-header duplicate (existing behavior).
    if (header && body && body.includes(header)) {
        return { prefix, title: body, body: '' };
    }
    // No body, or body matches header verbatim → title-only block.
    if (!body || body === header) {
        return { prefix, title: header, body: '' };
    }
    return { prefix, title: header, body };
}

/**
 * Compose the full hover-tooltip text for a single alert. Format:
 *
 *     <prefix>: <header>
 *     <description>
 *
 * Empty / redundant lines are dropped — when description is missing,
 * matches the header exactly, or is a prefix of header (Metro feeds
 * sometimes truncate header from description), only the title line is
 * shown. The blank line between title and body uses `\n\n`.
 *
 * The visual rendering goes through `_renderTooltipDom` which uses the
 * structured block from `buildAlertTooltipBlock` directly. This plain-text
 * form is still used for `aria-label` and as a fallback when blocks
 * aren't available on the wrap.
 *
 * Used at four sites — legend route badges (this file's
 * updateAlertBadges, x2 — create + update path), and station map-badge
 * tooltips for alerts and accessibility (stations.js _collectBoardingState).
 *
 * Header + body are run through `normalizeAlertProse` first so all
 * tooltip surfaces share the same cleaned strings. See the audit doc at
 * docs/_archive/alert-copy-audit-2026-05.md for the rationale behind each
 * normalizer.
 *
 * @param {string} prefix
 * @param {Object} alert
 * @returns {string} formatted text (single line if no body, multi-line otherwise)
 */
export function buildAlertTooltipText(prefix, alert) {
    const { title, body } = buildAlertTooltipBlock(prefix, alert);
    const titleLine = `${prefix}: ${title}`;
    return body ? `${titleLine}\n\n${body}` : titleLine;
}

/**
 * Format an alert's active-period window into a short human-readable line,
 * e.g. "Active: Sun Jun 1, 8 am – 2 pm" or "Active: Sat, 10 pm – Sun, 2 am".
 * Returns an empty string when no useful time info is available (open-ended
 * permanent alerts with start = 0 and end = Infinity).
 *
 * @param {number} start  Unix seconds (0 = unknown start)
 * @param {number} end    Unix seconds or Infinity (open-ended)
 * @returns {string}
 */
export function formatActivePeriodLine(start, end) {
    const noStart = start === 0;
    const noEnd   = !Number.isFinite(end);
    if (noStart && noEnd) return ''; // No schedule info at all

    const TZ  = 'America/Los_Angeles';
    const fmtTime = (unix) =>
        new Date(unix * 1000)
            .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ })
            .replace(/:00(?= [ap]m)/i, '')  // drop :00 → "8 am" not "8:00 am"
            .replace(' AM', ' am')
            .replace(' PM', ' pm');
    const fmtDay = (unix) =>
        new Date(unix * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });

    if (noEnd) {
        // Open-ended: "Active from Sat Jun 1, 8 am"
        return noStart ? '' : `Active from ${fmtDay(start)}, ${fmtTime(start)}`;
    }
    if (noStart) {
        // Known end, unknown start: "Until Sun Jun 2, 2 am"
        return `Until ${fmtDay(end)}, ${fmtTime(end)}`;
    }
    const startDay = fmtDay(start);
    const endDay   = fmtDay(end);
    if (startDay === endDay) {
        // Same calendar day: "Active: Sat Jun 1, 8 am – 2 pm"
        return `Active: ${startDay}, ${fmtTime(start)} – ${fmtTime(end)}`;
    }
    // Spans midnight: "Active: Sat Jun 1, 10 pm – Sun Jun 2, 2 am"
    return `Active: ${startDay}, ${fmtTime(start)} – ${endDay}, ${fmtTime(end)}`;
}

// Singleton tooltip appended to <body> so position:fixed is never trapped
// inside a CSS-transformed ancestor (MapLibre markers, legend slide panel).
let _activeTooltip  = null;
let _alertTipEl     = null;

function _getOrCreateTip() {
    if (_alertTipEl) return _alertTipEl;
    _alertTipEl = document.createElement('div');
    _alertTipEl.className = 'alert-tooltip';
    _alertTipEl.setAttribute('role', 'tooltip');
    // Inner body wrapper hosts the scroll context when pinned. The outer
    // .alert-tooltip must stay overflow:visible so the ::before/::after
    // carets aren't clipped and don't drag a permanent scrollbar onto
    // short content — see styles/index-style.css `.alert-tooltip.is-pinned`.
    const body = document.createElement('div');
    body.className = 'alert-tooltip-body';
    _alertTipEl.appendChild(body);
    document.body.appendChild(_alertTipEl);
    return _alertTipEl;
}

function _hideAlertTooltip() {
    if (!_activeTooltip) return;
    _alertTipEl?.classList.remove('is-visible');
    _alertTipEl?.classList.remove('is-pinned');
    _activeTooltip.wrap.classList.remove('is-open');
    _activeTooltip = null;
}

/**
 * Render an array of `{prefix, title, body}` blocks into the tooltip
 * body wrapper as structured DOM. Bolds the prefix chip and tightens
 * the title/body spacing relative to the plain `\n\n` text fallback.
 *
 * @param {HTMLElement} bodyEl  The .alert-tooltip-body inner wrapper.
 * @param {Array<{prefix:string,title:string,body:string}>} blocks
 */
function _renderTooltipDom(bodyEl, blocks) {
    bodyEl.replaceChildren();
    for (const blk of blocks) {
        const block = document.createElement('div');
        block.className = 'alert-tooltip-block';

        const title = document.createElement('div');
        title.className = 'alert-tooltip-title';
        const strong = document.createElement('strong');
        strong.className = 'alert-tooltip-prefix';
        strong.textContent = `${blk.prefix}:`;
        title.appendChild(strong);
        title.appendChild(document.createTextNode(` ${blk.title}`));
        block.appendChild(title);

        if (blk.body) {
            const body = document.createElement('div');
            body.className = 'alert-tooltip-desc';
            body.textContent = blk.body;
            block.appendChild(body);
        }
        bodyEl.appendChild(block);
    }
}

/**
 * Open or refresh the tooltip anchored to `wrap`.
 * @param {HTMLElement} wrap  The .alert-icon-wrap / .station-*-badge-wrap.
 * @param {Object} [opts]
 * @param {boolean} [opts.pinned=false]  When true, tooltip sticks past
 *   mouseleave (rider can scroll body / select text) until dismissed by
 *   another click on the badge, click outside, or Escape.
 */
function _showAlertTooltip(wrap, { pinned = false } = {}) {
    const text = wrap.dataset.alertText;
    if (!text) return;
    if (_activeTooltip && _activeTooltip.wrap !== wrap) _hideAlertTooltip();

    const tip = _getOrCreateTip();
    // Write content into the inner body wrapper, not the outer tip — see
    // _getOrCreateTip for the scroll-context rationale. Prefer structured
    // DOM render when the call site attached `_alertBlocks`; otherwise fall
    // back to plain textContent (still honors `white-space: pre-line`).
    const body = tip.firstElementChild;
    const blocks = wrap._alertBlocks;
    if (Array.isArray(blocks) && blocks.length) {
        _renderTooltipDom(body, blocks);
    } else {
        body.textContent = text;
    }
    tip.classList.add('is-visible');
    tip.classList.toggle('is-pinned', pinned);
    wrap.classList.add('is-open');

    const wrapRect = wrap.getBoundingClientRect();
    const tipW     = tip.offsetWidth;
    const tipH     = tip.offsetHeight;
    const margin   = 8;
    const gap      = 8;

    // Prefer above the icon; flip below if there's not enough room.
    const wantAbove = wrapRect.top - tipH - gap >= margin;
    const top  = wantAbove
        ? wrapRect.top - tipH - gap
        : wrapRect.bottom + gap;
    const wrapCx  = wrapRect.left + wrapRect.width / 2;
    const rawLeft = wrapCx - tipW / 2;
    const left    = Math.max(margin, Math.min(window.innerWidth - tipW - margin, rawLeft));

    tip.style.top  = `${top}px`;
    tip.style.left = `${left}px`;
    const caretX = Math.max(10, Math.min(tipW - 10, wrapCx - left));
    tip.style.setProperty('--caret-x', `${caretX}px`);
    tip.classList.toggle('is-below', !wantAbove);

    _activeTooltip = { wrap, tip, pinned };
}

// One-time global listeners (registered on first call to updateAlertBadges).
// `_mapBound` is split out because window.map may not exist on the first
// call — we keep retrying just the map binding on subsequent ticks until
// it succeeds.
let _alertTooltipBound = false;
let _mapBound = false;
function _bindAlertTooltipGlobals() {
    if (_alertTooltipBound) {
        _bindMapReflow();
        return;
    }
    _alertTooltipBound = true;
    const dismiss = (e) => {
        if (!_activeTooltip) return;
        // Clicks inside the badge wrap are handled by its own click listener
        // (toggleTap below). Clicks inside the pinned tooltip itself
        // (scrolling, selecting text) must NOT dismiss either. Anything else
        // is "outside" and closes the tooltip.
        if (_activeTooltip.wrap.contains(e.target)) return;
        if (_activeTooltip.tip?.contains(e.target)) return;
        _hideAlertTooltip();
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('touchstart', dismiss, { passive: true });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') _hideAlertTooltip();
    });
    // Reposition on scroll/resize so the tooltip tracks its anchor.
    // Also follow MapLibre map pan/zoom — station-badge wraps live inside
    // marker DOM that MapLibre transforms on every map move, so without
    // these listeners a pinned tooltip stays put while the badge slides
    // away beneath the rider's cursor. We preserve `pinned` across reflow
    // so a tracked pinned tooltip doesn't quietly revert to hover mode.
    const reflow = () => {
        if (!_activeTooltip) return;
        _showAlertTooltip(_activeTooltip.wrap, { pinned: _activeTooltip.pinned });
    };
    window.addEventListener('scroll', reflow, { passive: true, capture: true });
    window.addEventListener('resize', reflow);
    _bindMapReflow();
}

// Hook MapLibre's pan/zoom events so a pinned tooltip on a station-marker
// badge tracks the badge as the map moves. window.map may not exist on
// the first call (alerts.js can load before map.js boots), so retry on
// every subsequent _bindAlertTooltipGlobals call until it succeeds.
function _bindMapReflow() {
    if (_mapBound) return;
    if (!window.map?.on) return;
    _mapBound = true;
    const mapReflow = () => {
        if (!_activeTooltip) return;
        _showAlertTooltip(_activeTooltip.wrap, { pinned: _activeTooltip.pinned });
    };
    window.map.on('move', mapReflow);
    window.map.on('zoom', mapReflow);
}

export function wireAlertBadge(wrap, badge) {
    if (badge._alertWired) return;
    badge._alertWired = true;
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');

    // Hover anywhere on the icon wrap reveals the tooltip in its transient
    // (unpinned) form. mouseleave hides it UNLESS the rider has pinned it
    // via click — pinned tooltips persist until dismissed explicitly.
    // Touch devices fire a synthetic mouseenter after tap, but we drive
    // touch through click on the badge; the synthetic hover is harmless.
    wrap.addEventListener('mouseenter', () => {
        if (_activeTooltip?.wrap === wrap && _activeTooltip.pinned) return;
        _showAlertTooltip(wrap);
    });
    wrap.addEventListener('mouseleave', () => {
        if (_activeTooltip?.wrap !== wrap) return;
        if (_activeTooltip.pinned) return;                              // pinned: stay open
        if (wrap.contains(document.activeElement)) return;              // keyboard focus: stay open
        _hideAlertTooltip();
    });
    badge.addEventListener('focus', () => _showAlertTooltip(wrap));
    badge.addEventListener('blur',  () => {
        if (_activeTooltip?.wrap === wrap && !_activeTooltip.pinned) _hideAlertTooltip();
    });

    // Click on the badge pins the tooltip. If already pinned, a second
    // click unpins and closes. stopPropagation() prevents both the row's
    // click handler (route filter) and the global outside-tap dismiss
    // from firing on this same event.
    const togglePin = (e) => {
        e.stopPropagation();
        const alreadyPinned = _activeTooltip?.wrap === wrap && _activeTooltip.pinned;
        if (alreadyPinned) _hideAlertTooltip();
        else               _showAlertTooltip(wrap, { pinned: true });
    };
    badge.addEventListener('click', togglePin);
    // touchstart bubbles to the document-level dismiss handler too — stop it
    // so a tap on the badge doesn't trigger an immediate hide-then-show race.
    badge.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    badge.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(e); }
    });
}

/**
 * Return currently-active alerts targeting a specific stop, filtered by current time.
 * Includes both feed-side per-stop alerts (informedEntities listed this stop
 * explicitly) and text-mining matches where the feed gave only a route-level
 * informedEntity but the description mentions this stop's name. Pure route-wide
 * alerts (no stop-name match, no per-stop informedEntity) are not included.
 * @param {string} stopId  Canonical stop ID, e.g. "80111"
 * @returns {Alert[]} Active stop-targeted alerts (may be empty)
 */
export function getActiveStopAlerts(stopId) {
    if (!window.masterStopAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterStopAlertsData.get(normalizeStopId(String(stopId))) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

/**
 * Return currently-active accessibility (elevator/escalator) outages targeting
 * a specific stop. Returned alerts have `effect === 'ACCESSIBILITY_ISSUE'` or
 * mention elevator/escalator in their text. Disjoint from getActiveStopAlerts.
 * @param {string} stopId  Canonical stop ID, e.g. "80111"
 * @returns {Alert[]} Active accessibility alerts (may be empty)
 */
export function getActiveStopAccessibilityAlerts(stopId) {
    if (!window.masterStopAccessibilityAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterStopAccessibilityAlertsData.get(normalizeStopId(String(stopId))) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

/**
 * Classify an accessibility alert as elevator, escalator, both, or unknown
 * by scanning header + description for the word that names the facility.
 * Anchored on both sides (`\b…s?\b`) so plural matches but arbitrary letter
 * continuations don't — "elevators" and "escalator's" classify, "elevator123"
 * or "escalatorish" don't. Real Metro feed text has never mixed digits into
 * facility words, but the tight anchor makes the rule explicit.
 *
 * @param {string} [headerText='']
 * @param {string} [descriptionText='']
 * @returns {'elevator'|'escalator'|'both'|'unknown'}
 */
export function classifyAccessibilityAlert(headerText = '', descriptionText = '') {
    const text = `${headerText} ${descriptionText}`.toLowerCase();
    const hasElevator  = /\belevators?\b/.test(text);
    const hasEscalator = /\bescalators?\b/.test(text);
    if (hasElevator && hasEscalator) return 'both';
    if (hasElevator)  return 'elevator';
    if (hasEscalator) return 'escalator';
    return 'unknown';
}

/**
 * Severity tier for an accessibility-alert classification. An elevator
 * outage is a hard barrier (wheelchair / stroller / mobility-impaired
 * riders can't reach the platform) so it renders red. An escalator outage
 * is an inconvenience — the rider can usually still use the station, just
 * with stairs — so it renders amber. "Both" is the worst case → severe.
 * "Unknown" defaults to moderate (visible amber) rather than vanishing.
 *
 * @param {'elevator'|'escalator'|'both'|'unknown'} type
 * @returns {'severe'|'moderate'}
 */
export function accessibilitySeverity(type) {
    if (type === 'elevator' || type === 'both') return 'severe';
    return 'moderate';
}

/**
 * Max accessibility severity present in a list of accessibility alerts.
 * Returns null when the list is empty so callers can skip the indicator.
 *
 * @param {Array<{header?:string,description?:string}>} alerts
 * @returns {'severe'|'moderate'|null}
 */
export function maxAccessibilitySeverity(alerts) {
    let max = null;
    for (const a of alerts) {
        const type = classifyAccessibilityAlert(a.header ?? '', a.description ?? '');
        const sev  = accessibilitySeverity(type);
        if (sev === 'severe') return 'severe';
        if (sev === 'moderate') max = max ?? 'moderate';
    }
    return max;
}

/**
 * Add or remove "!" alert badges on legend rows based on current masterAlertsData.
 * Safe to call repeatedly — idempotent, detects existing badges before creating new ones.
 */
export function updateAlertBadges() {
    _bindAlertTooltipGlobals();
    document.querySelectorAll('.legend-row[data-route]').forEach(row => {
        const rc          = row.getAttribute('data-route');
        const routeAlerts = getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect));
        const hasAlert    = routeAlerts.length > 0;
        const severity    = maxSeverity(routeAlerts);
        let   badge       = row.querySelector('.alert-badge');

        if (hasAlert && !badge) {
            const img = row.querySelector('img');
            if (!img) return;
            let wrap = img.parentNode.classList?.contains('alert-icon-wrap')
                ? img.parentNode : null;
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'alert-icon-wrap';
                img.parentNode.insertBefore(wrap, img);
                wrap.appendChild(img);
            }
            badge = document.createElement('span');
            badge.className = 'alert-badge';
            badge.textContent = '!';
            if (severity) badge.dataset.severity = severity;
            wrap.appendChild(badge);

            const alerts = [...new Map(
                routeAlerts.map(a => [a.effect, a])
            ).values()];
            // Per-alert blocks rendered as structured DOM (bold prefix chip
            // + tighter spacing) when _alertBlocks is wired. The flat string
            // remains the source of truth for aria-label + textContent fallback.
            const tipBlocks = alerts.map(a =>
                buildAlertTooltipBlock(STRIP_EFFECT_LABELS[a.effect], a));
            const tipText = alerts
                .map(a => buildAlertTooltipText(STRIP_EFFECT_LABELS[a.effect], a))
                .join('\n\n');
            wrap.dataset.alertText = tipText;
            wrap._alertBlocks = tipBlocks;
            badge.setAttribute('aria-label', `Service alert: ${tipText}`);
            wireAlertBadge(wrap, badge);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
            badge.remove();
            if (wrap?.classList.contains('alert-icon-wrap')) {
                const img = wrap.querySelector('img');
                if (img) wrap.parentNode.insertBefore(img, wrap);
                wrap.remove();
            }
        } else if (hasAlert && badge) {
            // Refresh severity to track effect changes between polls.
            if (severity) badge.dataset.severity = severity;
            else delete badge.dataset.severity;
            // Update tooltip text in case alerts changed.
            const wrap = badge.parentNode;
            const alerts = [...new Map(
                routeAlerts.map(a => [a.effect, a])
            ).values()];
            const tipBlocks = alerts.map(a =>
                buildAlertTooltipBlock(STRIP_EFFECT_LABELS[a.effect], a));
            const tipText = alerts
                .map(a => buildAlertTooltipText(STRIP_EFFECT_LABELS[a.effect], a))
                .join('\n\n');
            wrap.dataset.alertText = tipText;
            wrap._alertBlocks = tipBlocks;
            badge.setAttribute('aria-label', `Service alert: ${tipText}`);
        }
    });
}


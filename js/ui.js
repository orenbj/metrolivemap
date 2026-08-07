import { routeIcons, routeHexColors, routeDirectionLabels, ROUTE_LETTER, VIEWPORT_BREAKPOINT_TABLET } from './config.js';
import { resolveTripDestination } from './predictions.js';
import { stationGroups, openStationByGroup } from './stations.js';
import { toggleFollow, isFollowingKey } from './followVehicle.js';
import { cleanStationName, escHtml as esc, isStoppedAt, isArrivingAt, pillTitle, isBusRoute, legendRouteFor } from './utils.js';
import { getFreshnessTierFromAge, getFreshnessTier } from './freshness.js';

/**
 * Cleans a GTFS destination_code string for display.
 *   "El Monte Station - Downtown LA / J Line" → "El Monte"
 *   "North Hollywood Station G Line"          → "North Hollywood"
 *   "Pomona Station"                          → "Pomona"
 *   "Union Station"                           → "Union Station"  (preserved)
 */
export function cleanDestination(dest) {
    dest = String(dest ?? '');
    const d = dest.trim();
    if (/^union station$/i.test(d)) return 'Union Station';
    return d
        .replace(/\s*-\s*.*$/, '')          // strip " - Downtown LA / J Line" etc.
        .replace(/\s+[A-Z]\s+Line\b.*/i, '') // strip trailing " G Line", " J Line" etc.
        .replace(/\s*\bStation\b/i, '')      // strip remaining " Station"
        .replace(/\s*\/\s*$/, '')            // strip trailing " /"
        .trim();
}

/**
 * Pure helper for ArrowDown/ArrowUp navigation through the search-results
 * listbox. Returns the next active option index given the current index, the
 * number of options, and the arrow direction.
 *
 *  - From "nothing active" (current === -1): ArrowDown → first (0),
 *    ArrowUp → last (count-1).
 *  - Otherwise wraps around: last + ArrowDown → 0, first + ArrowUp → last.
 *
 * Extracted so the wrap-around logic is unit-testable without a DOM.
 *
 * @param {number} current  current active index, or -1 if none active
 * @param {number} count    number of options (must be > 0)
 * @param {1|-1}   dir       +1 for ArrowDown, -1 for ArrowUp
 * @returns {number} the next active index in [0, count-1], or -1 if no options
 */
export function nextActiveIndex(current, count, dir) {
    if (count <= 0) return -1;
    if (current < 0) return dir > 0 ? 0 : count - 1;
    return (current + dir + count) % count;
}

/**
 * Rank buckets for search results, ascending. A stable sort on these puts an
 * exact car-number hit above everything, which is the whole point of vehicle
 * search: someone typing the number off the train in front of them wants THAT
 * train first, not a station whose name happens to contain those digits.
 */
const RANK_VEHICLE_EXACT  = 0;
const RANK_STATION_PREFIX = 1;
const RANK_VEHICLE_PREFIX = 2;
const RANK_STATION_SUB    = 3;
const RANK_VEHICLE_SUB    = 4;

/** Max results rendered at once; the remainder becomes the "and N more" hint. */
const SEARCH_RESULT_LIMIT = 5;

/**
 * Match a query against stations AND live vehicles.
 *
 * Pure and exported so search behaviour is testable — all of it previously lived
 * in closures inside `initUI`, which is why the feature had no coverage beyond
 * the `nextActiveIndex` arrow-key helper.
 *
 * Vehicles are matched on `vehicle_id`, which is the number physically printed
 * on the train car / bus. The app already surfaces it in the vehicle popup
 * ("Train Car #…" / "Bus ID …"), so search and popup agree by construction.
 *
 * Deliberately NOT filtered by the legend route filter: a rider searching a real
 * car number should find it even if they have that line hidden, and
 * `ensureRouteVisible` un-hides it on select. Excluding them would report "not
 * found" for a vehicle that is plainly running.
 *
 * @param {string} rawQuery
 * @param {Object} opts
 * @param {Array}  opts.groups   station groups (see stations.js `stationGroups`)
 * @param {Object} opts.markers  tripId → marker (`window.vehicleMarkers`)
 * @param {number} opts.nowSec   unix seconds, for the freshness gate
 * @param {number} [opts.limit]
 * @returns {{results: Array, overflow: number}}
 */
export function matchSearch(rawQuery, { groups = [], markers = {}, nowSec = 0, limit = SEARCH_RESULT_LIMIT } = {}) {
    const query = String(rawQuery ?? '').toLowerCase().trim();
    if (!query) return { results: [], overflow: 0 };

    const scored = [];

    for (const g of groups) {
        const name = String(g?.displayName ?? '').toLowerCase();
        if (!name.includes(query)) continue;
        scored.push({
            rank: name.startsWith(query) ? RANK_STATION_PREFIX : RANK_STATION_SUB,
            kind: 'station', id: g.normName, label: g.displayName, group: g,
        });
    }

    for (const marker of Object.values(markers ?? {})) {
        const vid = marker?.properties?.vehicle_id;
        // A marker keeps vehicle_id null until it adopts one from a frame that
        // carries it — those are simply unsearchable, not an error.
        if (vid == null) continue;
        // An expired marker is about to be faded and removed; offering it would
        // land the rider on a dot that vanishes under them.
        if (getFreshnessTier(marker, nowSec) === 'expired') continue;
        const idStr = String(vid);
        const id = idStr.toLowerCase();
        if (!id.includes(query)) continue;
        scored.push({
            rank: id === query ? RANK_VEHICLE_EXACT
                : id.startsWith(query) ? RANK_VEHICLE_PREFIX : RANK_VEHICLE_SUB,
            kind: 'vehicle',
            id: idStr,
            routeCode: marker.properties.route_code ?? null,
            label: vehicleSearchLabel(marker.properties.route_code, idStr),
            sublabel: vehicleSearchSublabel(marker),
            marker,
        });
    }

    // Stable sort: Array#sort is stable per spec, so equal ranks keep insertion
    // order (stations in stationGroups order, vehicles in registry order).
    scored.sort((a, b) => a.rank - b.rank);
    return { results: scored.slice(0, limit), overflow: Math.max(0, scored.length - limit) };
}

/**
 * "Train Car #1234" / "Bus ID 7788" — the EXACT wording the vehicle popup uses
 * (`markers.js`: `isBus ? 'Bus ID ' : 'Train Car #'`), so the result row and
 * the popup it opens show the same phrase. It shipped as "Bus #", which
 * contradicted both the popup and this very comment.
 */
export function vehicleSearchLabel(routeCode, vehicleId) {
    return `${isBusRoute(routeCode) ? 'Bus ID ' : 'Train Car #'}${vehicleId}`;
}

/**
 * Secondary line for a vehicle row: line letter + where it is heading, e.g.
 * "A Line · to Downtown Long Beach". This is what disambiguates the case that
 * makes vehicle search awkward — ids are unique only within a MODE, so one
 * number can legitimately return a rail car AND a BRT coach.
 *
 * Best-effort: destination resolution needs static GTFS, which may not be loaded
 * yet (or may not know a brand-new trip), so every step degrades to the line
 * name alone rather than throwing inside a keystroke handler.
 */
export function vehicleSearchSublabel(marker) {
    const p = marker?.properties ?? {};
    const rc = p.route_code;
    const line = rc ? `${ROUTE_LETTER[rc] ?? rc} Line` : '';
    let dest = '';
    try {
        const tripInfo = window.masterTripsData?.[p.trip_id];
        dest = resolveTripDestination(rc, Number(p.direction_id), p.trip_id, tripInfo, null) ?? '';
    } catch { dest = ''; }
    if (!dest) {
        // Fall back to the compass direction the popup would show.
        dest = routeDirectionLabels[rc]?.[p.direction_id] ?? '';
        return [line, dest].filter(Boolean).join(' · ');
    }
    return [line, `to ${cleanDestination(dest)}`].filter(Boolean).join(' · ');
}

/**
 * Find a live marker by vehicle_id, optionally scoped to a route.
 *
 * MUST be called at action time, never cached: `window.vehicleMarkers` is keyed
 * by trip_id and Metro reassigns trip_ids mid-run, so a key captured when the
 * results were rendered can be stale by the time the rider clicks. Scoping by
 * route_code matters because vehicle ids are only unique within a MODE — a rail
 * car and a BRT coach can share one.
 *
 * ~200 live markers (hard cap 500), so a linear scan is cheaper than maintaining
 * an index that would need invalidating on every trip-id reassignment.
 *
 * @returns {Object|null}
 */
export function findMarkerByVehicleId(vehicleId, routeCode = null) {
    if (vehicleId == null) return null;
    const want = String(vehicleId);
    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const p = marker?.properties;
        if (!p || p.vehicle_id == null) continue;
        if (String(p.vehicle_id) !== want) continue;
        if (routeCode != null && String(p.route_code) !== String(routeCode)) continue;
        return marker;
    }
    return null;
}

/**
 * Route badge for a search row: the official route icon when one exists, else a
 * coloured letter pill. Same two-tier pattern the station popup uses, since bus
 * routes have no icon asset.
 */
function _searchRouteBadge(routeCode) {
    if (!routeCode) return '';
    const icon = routeIcons[routeCode];
    if (icon) {
        const letter = ROUTE_LETTER[routeCode] ?? routeCode;
        return `<img src="${esc(icon)}" class="sp-route-icon" alt="${esc(letter)}">`;
    }
    const color = routeHexColors[routeCode] ?? '#666';
    return `<span class="sp-alert-chip" style="background:${esc(color)}">${esc(ROUTE_LETTER[routeCode] ?? routeCode)}</span>`;
}

/**
 * One search-result row.
 *
 * `data-kind` namespaces the id: a station's `normName` and a vehicle id share
 * one attribute otherwise, and a numeric station name could collide with a car
 * number. The click handler dispatches on it.
 */
function _renderSearchOption(r, i, optionId) {
    const badge = r.kind === 'vehicle' ? _searchRouteBadge(r.routeCode) : '';
    const sub = r.kind === 'vehicle' && r.sublabel
        ? `<span class="search-opt-sub">${esc(r.sublabel)}</span>` : '';
    return `<div id="${optionId(i)}" class="search-opt search-opt-${esc(r.kind)}" role="option" aria-selected="false" `
        + `data-kind="${esc(r.kind)}" data-id="${esc(r.id)}"`
        + (r.routeCode ? ` data-route="${esc(r.routeCode)}"` : '')
        + `>${badge}<span class="search-opt-main">${esc(r.label)}</span>${sub}</div>`;
}

/**
 * Announce result counts to screen readers. The search had no live region at
 * all, so a keyboard/SR user got no feedback that typing had produced anything.
 * Mirrors the `#alerts-tab-announce` polite-region pattern.
 */
function _announceResults(count, overflow) {
    const el = document.getElementById('search-announce');
    if (!el) return;
    el.textContent = count === 0
        ? 'No matches'
        : `${count} result${count === 1 ? '' : 's'}${overflow > 0 ? `, ${overflow} more` : ''}`;
}

/**
 * Land on a live vehicle: un-hide its route if filtered, fly to it, then open
 * its popup and start following.
 *
 * Every step here is ordered for a reason:
 *
 *  - `mlm:camera-takeover` fires FIRST. `followVehicle` listens for it and
 *    pauses the active follow — dispatching it after `toggleFollow` would pause
 *    the follow we just started.
 *  - `ensureRouteVisible` runs BEFORE the fly. A hidden route means an invisible
 *    dot, and `followVehicle` re-checks the hide class every ~280 ms and would
 *    abort with "that route is now hidden".
 *  - The popup + follow happen on `moveend`, not immediately. The follow chase
 *    eases the camera every ~280 ms and would fight the in-flight `flyTo`.
 *  - The marker is RE-RESOLVED after the flight. `window.vehicleMarkers` is
 *    keyed by trip_id, Metro reassigns trip_ids mid-run, and the vehicle has
 *    moved during the flight — a key captured at render time can be stale.
 *  - `togglePopup()` is the sanctioned open path: it routes through the popup's
 *    own `open` handler, which registers with the single-active-popup registry,
 *    increments `_openVehiclePopups`, and rebuilds the ETA. A hand-rolled
 *    `popup.addTo(map)` would silently skip all three.
 *  - `toggleFollow` is a TOGGLE — calling it on an already-followed vehicle
 *    would stop the follow, so it is guarded by `isFollowingKey`.
 */
function _goToVehicle(map, vehicleId, routeCode, labelText, dismiss) {
    const marker = findMarkerByVehicleId(vehicleId, routeCode);
    if (!marker) {
        // Matches followVehicle's wording for the same situation.
        showToast('That vehicle is no longer in the live feed', { severity: 'info' });
        dismiss(labelText);
        return;
    }
    if (!map) { dismiss(labelText); return; }

    document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
    ensureRouteVisible(routeCode);
    map.flyTo({ center: marker.getLngLat(), zoom: 14 });

    map.once('moveend', () => {
        const m = findMarkerByVehicleId(vehicleId, routeCode);
        if (!m) {
            showToast('That vehicle is no longer in the live feed', { severity: 'info' });
            return;
        }
        const pop = m.getPopup?.();
        if (pop && !pop.isOpen?.()) m.togglePopup?.();
        const key = m.properties?.trip_id;
        if (key != null && !isFollowingKey(key)) toggleFollow(key);
    });

    dismiss(labelText);
}

let showMini = false;
let legendRows   = []; // cached once at init — avoids repeated DOM queries in hot paths
let legendRoutes = []; // parallel array of data-route strings for updateDataPanel hot path
let _panelLastUpdated = 0;

// ── Legend filter state ────────────────────────────────────────────────────────
// null  = all routes visible (normal).
// Set   = filter mode; only routes in the Set are visible.
// First click on any row enters filter mode (that row only).
// Subsequent clicks on other rows add them to the set.
// Clicking an already-selected row removes it; empty set → exit filter mode.
let _activeFilter = null; // Set<routeCode> | null

/**
 * Single DOM write for one legend row's visibility: body class (which drives the
 * `.marker[data-route]` display rule), row class, aria-checked.
 * Module-scoped rather than an initUI closure so `ensureRouteVisible` can reuse
 * it — the three pieces of state must move together or the legend desyncs from
 * the map.
 */
const _applyRowVisible = (row, route, visible) => {
    document.body.classList.toggle(`hide-route-${route}`, !visible);
    row.classList.toggle('disabled', !visible);
    row.setAttribute('aria-checked', visible ? 'true' : 'false');
};

/**
 * Make `routeCode` visible if the legend filter is currently hiding it.
 *
 * Exists for vehicle search: the route filter hides markers with CSS only
 * (`body.hide-route-<rc>`), so landing on a filtered-out vehicle would fly the
 * camera to an invisible dot AND `followVehicle` would abort within ~280 ms with
 * "Stopped following — that route is now hidden". Rather than exclude those
 * vehicles from search (a rider searching a real car number would get a
 * misleading "not found"), we un-hide the route on select.
 *
 * Goes through `_applyRowVisible` and updates `_activeFilter` so the legend row,
 * the body class and the filter set stay consistent — stripping the body class
 * alone would leave the legend showing the route as still filtered out.
 *
 * @param {string} routeCode e.g. '801'
 * @returns {boolean} true if a change was made.
 */
/**
 * Test-only: reset the route-filter state machine. `_activeFilter` is module
 * state that `initUI` deliberately does not reset (in production it runs once
 * per page load), so without this, filter state from one test leaks into the
 * next and assertions become order-dependent.
 */
export function _resetRouteFilter() {
    _activeFilter = null;
    for (const cls of [...document.body.classList]) {
        if (cls.startsWith('hide-route-')) document.body.classList.remove(cls);
    }
}

export function ensureRouteVisible(routeCode) {
    if (!routeCode) return false;
    // Not in filter mode → everything is already visible.
    if (_activeFilter === null) return false;
    // Operate on the LEGEND route (950 → 910): the filter set must only ever
    // hold codes that have a legend row, or a phantom entry blocks the
    // empty-set → Show All auto-exit and the legend desyncs from the map.
    const rc = legendRouteFor(routeCode);
    if (_activeFilter.has(rc)) return false;
    const idx = legendRoutes.indexOf(rc);
    _activeFilter.add(rc);
    if (idx >= 0 && legendRows[idx]) {
        _applyRowVisible(legendRows[idx], rc, true);
    } else {
        // Defensive: an unknown route with no legend row — clear the body
        // class so the marker can render, without touching row state.
        document.body.classList.remove(`hide-route-${rc}`);
    }
    return true;
}

// ── Mobile bottom-sheet drag state ────────────────────────────────────────────
let sheetDragActive   = false;
let sheetDragStartY   = 0;
let sheetDragLastY    = 0;
let sheetDragLastTime = 0;
let sheetVelocityY    = 0; // px/ms, positive = downward (dismiss direction)
const SHEET_DISMISS_RATIO    = 0.30; // drag past 30% of sheet height → dismiss
const SHEET_VELOCITY_DISMISS = 0.4;  // px/ms fast-flick threshold → always dismiss

/**
 * Wire all UI interactions: legend collapse/expand, route filter toggles, mobile
 * bottom-sheet drag gestures, search bar autocomplete, and the locate button.
 * Must be called once after DOM is ready.
 */
export function initUI() {
    showMini = isMobile(); // Mobile starts minimized; desktop starts expanded
    adjustMiniDisplay();

    const closeLegend = () => {
        // Reset drag state so stale sheetDragActive / is-dragging can't leak
        // across interactions when the X button's touchend stops propagation
        // before handle's onTouchEnd has a chance to clean up.
        sheetDragActive = false;
        document.getElementById('legend-container')?.classList.remove('is-dragging');
        showMini = true;
        adjustMiniDisplay();
    };
    document.getElementById('legend-close-btn')?.addEventListener('click', closeLegend);
    const closeBtn = document.getElementById('sheet-close-btn');
    // Stop touchstart from bubbling to the handle so it can't set sheetDragActive.
    closeBtn?.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    closeBtn?.addEventListener('click', e => { e.stopPropagation(); closeLegend(); });
    closeBtn?.addEventListener('touchend', e => { e.stopPropagation(); closeLegend(); }, { passive: true });

    document.getElementById('legend-mini')?.addEventListener('click', () => {
        showMini = false;
        adjustMiniDisplay();
    });

    window.addEventListener('resize', () => {
        sheetDragActive = false; // abort any in-flight drag on resize
        // showMini state is preserved across resize
        adjustMiniDisplay();
    });

    // Translation is handled by each browser's built-in feature (Chrome / Edge
    // / Safari menu, iOS Safari AA menu, Android Chrome menu). The previous
    // in-app translate link was removed in favour of the native flow — no JS
    // wiring is needed; alert bodies are wrapped <p lang="en"> so translators
    // can identify the source language.

    // Cache and wire up legend rows (filtering + a11y).
    // _applyRowVisible is module-scoped (see above) so ensureRouteVisible shares it.
    // Filter mode is session-only (not persisted); each load starts with all routes visible.

    // Show all routes and exit filter mode (shared by Show All button and empty-selection path).
    const _showAll = () => {
        _activeFilter = null;
        legendRows.forEach((r, i) => { if (legendRoutes[i]) _applyRowVisible(r, legendRoutes[i], true); });
    };

    legendRows = Array.from(document.querySelectorAll('.legend-row'));
    legendRoutes = legendRows.map(r => r.getAttribute('data-route') || '');
    legendRows.forEach(row => {
        const route = row.getAttribute('data-route');
        if (!route) return;

        // A11y
        row.setAttribute('tabindex', '0');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', 'true');
        const imgAlt = row.querySelector('img')?.alt || `Route ${route}`;
        row.setAttribute('aria-label', imgAlt.replace(/ icon$/i, ''));
        row.style.cursor = 'pointer';

        const toggleRow = () => {
            if (_activeFilter === null) {
                // Enter filter mode — show only this route, dim all others.
                _activeFilter = new Set([route]);
                legendRows.forEach((r, i) => {
                    const rc = legendRoutes[i];
                    if (rc) _applyRowVisible(r, rc, rc === route);
                });
            } else if (_activeFilter.has(route)) {
                // Deselect — remove from filter.
                _activeFilter.delete(route);
                _applyRowVisible(row, route, false);
                if (_activeFilter.size === 0) {
                    // Nothing left selected → exit filter mode.
                    _showAll();
                    return;
                }
            } else {
                // Add to filter.
                _activeFilter.add(route);
                _applyRowVisible(row, route, true);
            }
        };

        row.addEventListener('click', toggleRow);
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(); }
        });
    });

    // Mobile swipe-to-dismiss bottom sheet
    initSwipeSheet();

    // Station Search
    const searchInput = document.getElementById('station-search');
    const searchResults = document.getElementById('search-results');
    const searchClearBtn = document.getElementById('search-clear-btn');
    if (searchInput && searchResults) {
        // a11y: mark the results container as a listbox
        searchResults.setAttribute('role', 'listbox');
        searchInput.setAttribute('aria-autocomplete', 'list');
        searchInput.setAttribute('aria-haspopup', 'listbox');

        // Single show/hide path so the combobox's aria-expanded stays in sync
        // with the .hidden class at every call site (was never toggled before,
        // leaving screen-reader users with a permanently-collapsed combobox).
        // Collapsing also clears the active-descendant so a stale id can't point
        // at a removed option.
        const setResultsVisible = (visible) => {
            searchResults.classList.toggle('hidden', !visible);
            searchInput.setAttribute('aria-expanded', String(visible));
            if (!visible) clearActiveOption();
        };

        // ── Active-descendant management ─────────────────────────────────────
        // The WAI-ARIA combobox pattern keeps DOM focus on the INPUT and points
        // aria-activedescendant at the active option's id (rather than roving
        // real focus into the listbox). This lets the user keep typing to refine
        // the query while an option is highlighted, and avoids focus escaping the
        // input as options are re-rendered on each keystroke.
        const optionId = (i) => `search-opt-${i}`;

        const clearActiveOption = () => {
            searchInput.removeAttribute('aria-activedescendant');
            searchResults
                .querySelectorAll('[role="option"].active')
                .forEach((el) => {
                    el.classList.remove('active');
                    el.setAttribute('aria-selected', 'false');
                });
        };

        // Highlight the option at `idx` (or clear when idx < 0), update
        // aria-activedescendant, and scroll it into view.
        const setActiveOption = (idx) => {
            const options = [...searchResults.querySelectorAll('[role="option"]')];
            clearActiveOption();
            if (idx < 0 || idx >= options.length) return;
            const opt = options[idx];
            opt.classList.add('active');
            opt.setAttribute('aria-selected', 'true');
            searchInput.setAttribute('aria-activedescendant', opt.id);
            opt.scrollIntoView({ block: 'nearest' });
        };

        // Keyboard navigation for search results
        searchInput.addEventListener('keydown', (e) => {
            const options = [...searchResults.querySelectorAll('[role="option"]')];
            if (e.key === 'Escape') {
                // Only CONSUME Escape when the suggestion list is actually open:
                // dismiss it and stop the document-level handler from ALSO closing
                // an active pinned popup (station/vehicle/bike/micro). When the
                // list is already closed, let Escape propagate so that handler can
                // dismiss the popup as expected.
                if (!searchResults.classList.contains('hidden')) {
                    setResultsVisible(false);
                    e.stopPropagation();
                }
                return;
            }
            if (!options.length) return;
            const active = searchResults.querySelector('[role="option"].active');
            const currentIdx = active ? options.indexOf(active) : -1;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveOption(nextActiveIndex(currentIdx, options.length, 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveOption(nextActiveIndex(currentIdx, options.length, -1));
            } else if (e.key === 'Enter' && active) {
                e.preventDefault();
                active.click();
            }
        });

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                searchResults.innerHTML = '';
                setResultsVisible(false);
                if (searchClearBtn) searchClearBtn.style.display = 'none';
                return;
            }

            if (searchClearBtn) searchClearBtn.style.display = 'block';

            const { results: matches, overflow } = matchSearch(query, {
                groups: stationGroups,
                markers: window.vehicleMarkers ?? {},
                nowSec: Date.now() / 1000,
            });

            if (matches.length > 0) {
                const hint = overflow > 0
                    ? `<div class="search-more-hint">and ${overflow} more — keep typing to narrow</div>`
                    : '';
                searchResults.innerHTML = matches
                    .map((r, i) => _renderSearchOption(r, i, optionId))
                    .join('') + hint;
                // New result set → drop any stale active-descendant pointer.
                clearActiveOption();
                setResultsVisible(true);
            } else {
                // Names the searchable universe: only rail and G/J Line vehicles
                // have markers on this map, so "no results" for a local bus
                // number is expected, not a failure the rider should retry.
                searchResults.innerHTML =
                    '<div class="search-no-results">No stations or vehicles found<br><span class="search-no-results-sub">Vehicle search covers rail and G/J Line cars in service now</span></div>';
                clearActiveOption();
                setResultsVisible(true);
            }
            _announceResults(matches.length, overflow);
        });

        searchResults.addEventListener('click', (e) => {
            // Must match the OPTION, not any div: rows now contain child
            // elements (badge, main label, sub-line), and closest('div') would
            // return one of those and lose the data attributes.
            const opt = e.target.closest('[role="option"]');
            if (!opt) return;
            const kind = opt.getAttribute('data-kind');
            const id   = opt.getAttribute('data-id');
            const map  = window.map;

            const dismiss = (labelText) => {
                searchInput.value = labelText;
                searchResults.innerHTML = '';
                setResultsVisible(false);
            };

            if (kind === 'vehicle') {
                _goToVehicle(map, id, opt.getAttribute('data-route'),
                    opt.querySelector('.search-opt-main')?.textContent ?? id, dismiss);
                return;
            }

            const group = stationGroups.find(g => g.normName === id);
            if (group) {
                if (map) {
                    // Taking over the camera — pause any active vehicle-follow.
                    document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
                    map.flyTo({ center: [group.lon, group.lat], zoom: 14 });
                    openStationByGroup(map, group);
                }
                dismiss(group.displayName);
            }
        });

        // Close search on click outside
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target) && (!searchClearBtn || !searchClearBtn.contains(e.target))) {
                setResultsVisible(false);
            }
        });

        // Clear button
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchResults.innerHTML = '';
                setResultsVisible(false);
                searchClearBtn.style.display = 'none';
                searchInput.focus();
            });
        }
    }
}

// Returns true for any viewport that uses the bottom-sheet layout.
// Must match the @media (max-width: 1280px) breakpoint in index-style.css
// where #legend-mini is hidden and the sheet peek/drag UI takes over.
function isMobile() {
    return window.innerWidth <= VIEWPORT_BREAKPOINT_TABLET;
}

function adjustMiniDisplay() {
    const container = document.getElementById('legend-container');
    const mini = document.getElementById('legend-mini');
    if (!container || !mini) return;
    // Clear any live-drag inline style so CSS transitions take over cleanly
    container.style.transform = '';
    container.classList.remove('is-dragging');
    container.classList.toggle('hidden', showMini);
    mini.classList.toggle('hidden', !showMini);
    // Lift the map attribution ⓘ above the open sheet so the required
    // "© LA Metro, Esri" credit (a tile-license obligation — see js/map.js) is
    // never covered. `--sheet-lift` feeds the bottom-right control's `bottom`
    // in the ≤1280px media query; when peeked or on desktop we remove it so the
    // rule falls back to the 44px peek-handle height.
    if (!showMini && isMobile()) {
        document.documentElement.style.setProperty('--sheet-lift', `${container.offsetHeight + 8}px`);
    } else {
        document.documentElement.style.removeProperty('--sheet-lift');
    }
}

/**
 * Mobile swipe-to-dismiss bottom sheet.
 * Drag handle always participates. Content area only when scrolled to top.
 * Velocity-aware snap: fast flick OR drag > 30% height → dismiss.
 */
let _swipeInitialized = false;
function initSwipeSheet() {
    // Idempotence guard: each call attaches three touch listeners on the legend
    // content area (touchstart/touchmove/touchend). Without this gate, a second
    // call (dev hot-reload, future SPA re-route) would accumulate duplicate
    // listeners — a single touch event would then fire the handlers N times.
    if (_swipeInitialized) return;
    const container = document.getElementById('legend-container');
    const handle    = document.getElementById('sheet-handle');
    const legend    = document.getElementById('legend');
    if (!container || !handle || !legend) return;
    _swipeInitialized = true;

    function onTouchStart(e) {
        if (!isMobile()) return;
        const isHandle = handle.contains(e.target);
        // On the scrollable content: only engage drag when content is at top
        if (!isHandle && legend.scrollTop > 0) return;

        sheetDragActive   = true;
        sheetDragStartY   = e.touches[0].clientY;
        sheetDragLastY    = sheetDragStartY;
        sheetDragLastTime = Date.now();
        sheetVelocityY    = 0;
        container.classList.add('is-dragging');
    }

    function onTouchMove(e) {
        if (!isMobile() || !sheetDragActive) return;
        const y   = e.touches[0].clientY;
        const now = Date.now();
        const dt  = now - sheetDragLastTime;
        if (dt > 0) sheetVelocityY = (y - sheetDragLastY) / dt;
        sheetDragLastY    = y;
        sheetDragLastTime = now;

        const delta = Math.max(0, y - sheetDragStartY); // downward only
        if (delta > 10) e.preventDefault();             // dead-zone: don't suppress click on micro-movement
        container.style.transform = `translateY(${delta}px)`;
    }

    function onTouchEnd() {
        if (!isMobile() || !sheetDragActive) return;
        sheetDragActive = false;
        container.classList.remove('is-dragging');

        const delta  = sheetDragLastY - sheetDragStartY;
        const thresh = container.offsetHeight * SHEET_DISMISS_RATIO;
        const isTap  = Math.abs(delta) < 10; // < 10px movement = treat as tap, not drag

        if (sheetVelocityY > SHEET_VELOCITY_DISMISS || delta > thresh) {
            // Dismiss: let CSS hidden class slide it out
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else if (isTap && showMini) {
            // Tap on peek handle → open sheet. Handle in touchend rather than
            // click so it fires reliably even when touchmove suppressed the click.
            container.style.transform = '';
            showMini = false;
            adjustMiniDisplay();
        } else if (isTap && !showMini) {
            // Tap on handle while sheet is open → close back to mini.
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else {
            // Snap back: clear inline transform, force reflow to re-enable transition
            container.style.transform = '';
            void container.offsetHeight; // trigger reflow → CSS transition fires
        }
    }

    // Content-area variant: never closes on tap (tapping a legend row should not
    // dismiss the sheet). Only drag-to-dismiss applies here.
    function onContentTouchEnd() {
        if (!isMobile() || !sheetDragActive) return;
        sheetDragActive = false;
        container.classList.remove('is-dragging');

        const delta  = sheetDragLastY - sheetDragStartY;
        const thresh = container.offsetHeight * SHEET_DISMISS_RATIO;

        if (sheetVelocityY > SHEET_VELOCITY_DISMISS || delta > thresh) {
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else {
            // Snap back — do NOT treat as a tap-to-close
            container.style.transform = '';
            void container.offsetHeight;
        }
    }

    function onTouchCancel() {
        sheetDragActive = false;
        container.classList.remove('is-dragging');
        container.style.transform = '';
    }

    // Desktop fallback: open on click (touch devices use onTouchEnd isTap path above)
    handle.addEventListener('click', () => {
        if (!('ontouchstart' in window) && isMobile() && showMini) { showMini = false; adjustMiniDisplay(); }
    });

    // Handle: always drag-able
    handle.addEventListener('touchstart',  onTouchStart,  { passive: true  });
    handle.addEventListener('touchmove',   onTouchMove,   { passive: false });
    handle.addEventListener('touchend',    onTouchEnd,    { passive: true  });
    handle.addEventListener('touchcancel', onTouchCancel, { passive: true  });

    // Content area: drag only when scrolled to top; tapping a row must NOT close the sheet.
    legend.addEventListener('touchstart',  onTouchStart,      { passive: true  });
    legend.addEventListener('touchmove',   onTouchMove,       { passive: false });
    legend.addEventListener('touchend',    onContentTouchEnd, { passive: true  });
    legend.addEventListener('touchcancel', onTouchCancel,     { passive: true  });
}

// Resolves the first time removeLoadingScreen() runs (WS connected, or the
// 15 s global fallback in api.js). Consumers that must not act until the
// loading splash is gone — e.g. the startup auto-locate station popup, which
// would otherwise render over the loader — await this. Resolves immediately
// for any consumer that imports it after the screen is already removed.
let _loadingDoneResolve;
export const loadingDone = new Promise(resolve => { _loadingDoneResolve = resolve; });

/**
 * Fade out and remove the loading overlay. Safe to call multiple times — removes
 * the element from the DOM after the CSS fade-out transition completes.
 */
export function removeLoadingScreen() {
    const loadingScreen = document.getElementById('loading');
    if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => loadingScreen.remove(), 500);
    }
    // Signal any awaiters (idempotent — the resolve is a no-op after the first).
    _loadingDoneResolve?.();
    _loadingDoneResolve = null;
}

/**
 * Display a transient toast notification at the bottom of the viewport.
 * Styling lives in the `.toast` rule in styles/index-style.css (and inherits
 * dark-mode automatically). Auto-dismisses after `duration` ms (default 4 s).
 *
 * @param {string} message            Text to display
 * @param {Object} [opts]
 * @param {'info'|'error'} [opts.severity='info']  'error' uses dark high-contrast variant
 * @param {number}         [opts.duration=4000]    Visible duration before fade-out (ms)
 */
export function showToast(message, { severity = 'info', duration = 4000 } = {}) {
    // Single-toast policy: replace any existing one so rapid calls don't stack.
    document.getElementById('toast-notice')?.remove();
    const toast = document.createElement('div');
    toast.id = 'toast-notice';
    toast.className = severity === 'error' ? 'toast toast--error' : 'toast';
    toast.setAttribute('role', severity === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, duration);
    setTimeout(() => toast.remove(), duration + 500);
}

/**
 * Refresh the legend data panel (vehicle counts per route, average age).
 * Throttled to at most once per second to avoid excessive DOM updates on
 * rapid WebSocket bursts.
 * @param {Object} markers Live vehicle markers object from markers.js
 */
export function updateDataPanel(markers) {
    const _now = Date.now();
    if (_now - _panelLastUpdated < 1000) return;
    _panelLastUpdated = _now;

    const counts = {};
    let total = 0;

    for (const id in markers) {
        const route = markers[id].route_code;
        counts[route] = (counts[route] || 0) + 1;
        total++;
    }

    for (const id of ['total-count-badge', 'total-count-badge-mobile']) {
        const totalEl = document.getElementById(id);
        if (!totalEl) continue;
        const prevCount = totalEl.textContent;
        totalEl.textContent = total;
        if (prevCount !== String(total)) {
            totalEl.classList.remove('pulse');
            void totalEl.offsetWidth;
            totalEl.classList.add('pulse');
        }
    }

    // Compute max count for proportional bar widths
    const maxCount = Math.max(1, ...legendRoutes.map(r => counts[r] || 0));

    legendRows.forEach((row, i) => {
        const route = legendRoutes[i];
        const count = counts[route] || 0;

        const countBadge = row.querySelector('.count-badge');
        if (countBadge) countBadge.textContent = count > 0 ? count : '';

        const barFill = row.querySelector('.bar-fill');
        if (barFill) barFill.style.width = `${Math.round((count / maxCount) * 100)}%`;

        row.classList.toggle('collapsed', count === 0 && !row.dataset.persistent);
    });

}

let _lastUpdateTimeSec = -1;
/** Update the "Updated at HH:MM:SS" timestamp displayed in the legend footer. */
export function updateUpdateTime() {
    // Called on EVERY accepted vehicle frame (~170/s). The label only changes once
    // per second, and toLocaleTimeString builds an Intl.DateTimeFormat each call —
    // so gate on the epoch-second and skip the getElementById + format + write for
    // the other ~169 frames. (updateDataPanel next door is already 1 s-throttled.)
    const sec = Math.floor(Date.now() / 1000);
    if (sec === _lastUpdateTimeSec) return;
    _lastUpdateTimeSec = sec;
    const updateTimeDiv = document.getElementById('update-time');
    if (updateTimeDiv) {
        // Fixed en-US locale — page text is English, browser translators
        // handle conversion to the rider's language at render time. Seconds
        // are shown so a rider can tell at a glance how recently the feed
        // ticked (a frozen clock = a stalled feed).
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        updateTimeDiv.textContent = `Updated at ${time}`;
    }
}

/**
 * Update the connection status dot and label in the legend.
 * @param {'connected'|'connecting'|'error'|'offline'} status
 */
export function setConnectionStatus(status) {
    const dot = document.getElementById('connection-status-dot');
    const label = document.getElementById('update-time');
    if (!dot) return;
    // The dot is color-only; on touch the `title` tooltip is unreachable, so
    // mirror each state into an aria-label (with role=img) too — a screen
    // reader then announces "Live feed connected" rather than nothing.
    dot.setAttribute('role', 'img');
    const setState = (text) => { dot.title = text; dot.setAttribute('aria-label', text); };
    dot.classList.remove('connected', 'disconnected');
    switch (status) {
        case 'connected':
            dot.classList.add('connected');
            setState('Live feed connected');
            break;
        case 'connecting':
            setState('Connecting');
            if (label && label.textContent === '') label.textContent = 'Connecting...';
            break;
        case 'error':
        case 'offline':
            dot.classList.add('disconnected');
            setState('Live feed disconnected');
            if (label) label.textContent = 'Reconnecting...';
            break;
    }
}

/**
 * Build the inner HTML for a vehicle marker popup.
 *
 * Single options object (was a 12-positional-arg signature — #250). Add a new
 * field as an opts key rather than threading another positional through every
 * call site.
 *
 * @param {Object} opts
 * @param {string} opts.routeCode          e.g. "801"
 * @param {string|number} opts.vehicleId   Feed vehicle ID
 * @param {string} opts.vehicleLabel       Display prefix ("Train ", "Bus ", etc.)
 * @param {number} opts.timestamp          Unix seconds of last GPS fix
 * @param {string|number|null} opts.stopId Current/next stop ID
 * @param {number|string|null} opts.currentStatus GTFS-RT currentStatus
 * @param {number|null} opts.directionId   0 or 1
 * @param {string|null} opts.tripId        GTFS trip ID
 * @param {number|null} opts.currentStopSequence
 * @param {number|null} [opts.secToNextStop] Pre-computed seconds to next stop
 * @param {number|null} [opts.boardingDepSecs] Seconds until boarding departure (origin only)
 * @param {string|null} [opts.etaSource] Debug: which tier produced the ETA
 *   ('gtfs-rt' | 'calc' | 'stopped' | 'none'). Rendered only when the
 *   `mlm_debug_eta` localStorage flag is set.
 * @returns {string} HTML string
 */
export function getPopupHTML({
    routeCode, vehicleId, vehicleLabel, timestamp, stopId, currentStatus,
    directionId, tripId, currentStopSequence,
    secToNextStop = null, boardingDepSecs = null, etaSource = null,
} = {}) {
    const stopKey  = stopId != null ? String(stopId) : null;
    const stopInfo = stopKey && window.masterStopsData?.[stopKey];
    const stopName = stopInfo ? cleanStationName(stopInfo.name) : null;

    const statusLabel = boardingDepSecs !== null ? 'Boarding'
        : isStoppedAt(currentStatus) ? 'At stop'
        : isArrivingAt(currentStatus) ? 'Arriving'
        : 'Next stop';

    // Trip data
    const tripInfo   = tripId ? window.masterTripsData?.[String(tripId)] : null;

    // Shared cascade with the station-popup row labels — see
    // predictions.resolveTripDestination. Schedule-derived terminus first
    // (authoritative), then live trip.dest, then last-stop, then live-feed
    // fallback. Previously this cascade was reimplemented inline with the
    // structural step LAST, which produced different labels than the station
    // popup for the same trip.
    const cleanedDest = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
    const destination = directionId != null
        ? resolveTripDestination(routeCode, Number(directionId), tripId, tripInfo, cleanedDest)
        : cleanedDest;

    // Route accent color
    const accentColor = routeHexColors[routeCode] ?? '#888';
    const iconSrc     = routeIcons[routeCode] || '';
    // Meaningful alt text on the route icon — the icon (+ accent bar) is the
    // ONLY route signal in the popup (no text route label), so "route" told a
    // screen reader nothing. "E Line" for rail/BRT, "Route 720" for buses.
    const iconAlt     = ROUTE_LETTER[routeCode] ? `${ROUTE_LETTER[routeCode]} Line` : `Route ${routeCode}`;

    // Cardinal direction letter (N/S/E/W) from the static direction-label table.
    // Shown as a subtle suffix on the destination header so riders can quickly
    // orient the vehicle relative to the line map.
    const dirLabel = directionId != null ? routeDirectionLabels[routeCode]?.[directionId] : null;
    const cardinalLetter = dirLabel ? dirLabel.charAt(0) : null;
    const cardinalHTML = cardinalLetter ? `<span class="pv2-cardinal" aria-hidden="true">\u00b7 ${esc(cardinalLetter)}</span>` : '';

    const lastTrainBadge = tripInfo?.isLast ? `<span class="last-train-badge veh-last-train">Last Train</span>` : '';
    // The destination is the popup's heading \u2014 promoted to <h3> (margin reset
    // in CSS) so screen-reader users can skip-by-heading into a vehicle popup,
    // matching the station popup's <h3> name. The badge-only fallback (no
    // resolved destination) stays a <div> \u2014 a bare "Last Train" chip isn't a
    // heading.
    const destHTML = destination
        ? `<h3 class="pv2-dest"><span class="pv2-dest-name"><span aria-hidden="true">\u2192</span> ${esc(destination)}</span>${cardinalHTML}${lastTrainBadge}</h3>`
        : lastTrainBadge
            ? `<div class="pv2-dest">${lastTrainBadge}</div>`
            : '';

    // Next stop / boarding section
    let etaStr = null;
    let etaIsNow = false;
    if (boardingDepSecs !== null) {
        // "<1m" not "30s": same sub-minute vocabulary as the next-stop pill and
        // stations.js, so no ETA surface shows the "30s" token (misreadable as
        // "30 minutes"). Under 30s the pill is suppressed — the "Boarding" status
        // label carries it and a sub-30s departure countdown is too jittery.
        etaStr = boardingDepSecs < 30 ? null
               : boardingDepSecs < 60 ? 'Departs <1m'
               : `Departs ${Math.round(boardingDepSecs / 60)}m`;
    } else if (secToNextStop != null) {
        // "Now" is reserved for a vehicle actually AT the stop (STOPPED_AT). An
        // in-transit vehicle — even a few seconds out — reads "<1m" so the
        // sub-minute state always shows on approach. Previously "Now" owned
        // everything under 30s, so when the ETA leaped from >=60s straight into
        // that band — a trip_updates re-broadcast, a calc/GTFS source swap, or
        // the IN_TRANSIT_TO -> STOPPED_AT flip — the popup jumped "1m" -> "Now"
        // and the rider never saw "<1m". Gating "Now" on STOPPED_AT makes every
        // approach pass through "<1m" first. ("<1m" over "30s" also rules out
        // the "30s"/"30m" misread; matches stations.js _formatArrivalPill so
        // every ETA surface shares one vocabulary.)
        if (isStoppedAt(currentStatus)) {
            etaStr = 'Now';
            etaIsNow = true;
        } else if (secToNextStop < 60) {
            etaStr = '<1m';
        } else {
            // The "m" suffix is universal (Spanish riders see "5m" as fine).
            // Round to nearest to match Metro's platform countdowns — see _formatArrivalPill.
            etaStr = Math.round(secToNextStop / 60) + 'm';
        }
    }
    // Debug-only ETA-source tag. Toggle from the console:
    //   localStorage.mlm_debug_eta = '1'   (then reopen the popup)
    //   delete localStorage.mlm_debug_eta  (to hide again)
    // Shows whether the ETA came from GTFS-RT trip_updates ([RT]) or the
    // schedule/distance calc fallback ([calc]) — answers "the train is right
    // there but says 3m: bad feed prediction, or a real queued wait?".
    let etaDebugHTML = '';
    try {
        if (etaSource && typeof localStorage !== 'undefined' && localStorage.getItem('mlm_debug_eta') === '1') {
            const tagLabel = etaSource === 'gtfs-rt' ? 'RT' : etaSource;
            etaDebugHTML = `<span class="pv2-eta-src" data-src="${esc(etaSource)}">[${esc(tagLabel)}]</span>`;
        }
    } catch { /* localStorage blocked (private mode) — no debug tag, no crash */ }

    // Spoken/hover form of the ETA pill — same shared helper the station rows
    // use, so "5m" / "Departs <1m" read as full phrases to a screen reader and
    // on hover. isLast is NOT passed here: the vehicle popup shows last-train
    // status as a header badge, not on the next-stop pill.
    const etaTitle = etaStr ? esc(pillTitle(etaStr)) : '';
    const stopSection = stopName ? `
        <div class="pv2-section">
            <div class="pv2-label">${esc(statusLabel)}</div>
            <div class="pv2-stop-row">
                <span class="pv2-stop">${esc(stopName)}</span>
                ${etaStr ? `<span class="arr-time-pill${etaIsNow ? ' now' : ''}" role="img" aria-label="${etaTitle}" title="${etaTitle}">${esc(etaStr)}</span>` : ''}
                ${etaDebugHTML}
            </div>
        </div>` : '';

    // Footer: seconds since last update (color-coded dot) · vehicle id
    const secsSince = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    const vehicleHTML = `${esc(vehicleLabel)}${esc(String(vehicleId))}`;
    // Single-escaped form for the title attribute. esc()-ing vehicleHTML (already
    // escaped) would double-escape — "&" would render as "&amp;amp;" in the tooltip.
    const vehicleTitle = esc(`${vehicleLabel}${String(vehicleId)}`);
    const tier = getFreshnessTierFromAge(secsSince);
    // Tier labels for the freshness dot's ARIA name — the dot itself is
    // color-only, so without these labels a screen-reader user has no signal
    // about data freshness. Phrasing matches the popup's overall vocabulary.
    const tierAria = tier === 'live'  ? 'Data fresh'
                   : tier === 'stale' ? 'Data stale'
                   :                    'Data expired';

    return `
    <div class="pv2-card">
        <div class="pv2-accent" style="background:${accentColor}"></div>
        <div class="pv2-header">
            <img class="pv2-icon" src="${esc(iconSrc)}" alt="${esc(iconAlt)}">
            <div class="pv2-header-text">
                ${destHTML}
            </div>
        </div>
        ${stopSection}
        <div class="pv2-footer">
            <span class="pv2-time" data-ts="${timestamp}"><span class="pv2-dot" data-tier="${tier}" role="img" aria-label="${tierAria}"></span><span class="pv2-secs">${secsSince}s ago</span></span>
            <span class="pv2-vehicle" title="${vehicleTitle}">${vehicleHTML}</span>
        </div>
        <div class="pv2-actions">
            <button type="button" class="pv2-follow-btn" aria-pressed="false" aria-label="Follow this vehicle — the map will track it as it moves">
                <svg class="pv2-follow-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="1.5" x2="12" y2="5" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="19" x2="12" y2="22.5" stroke="currentColor" stroke-width="1.6"/><line x1="1.5" y1="12" x2="5" y2="12" stroke="currentColor" stroke-width="1.6"/><line x1="19" y1="12" x2="22.5" y2="12" stroke="currentColor" stroke-width="1.6"/></svg>
                <span class="pv2-follow-label">Follow</span>
            </button>
        </div>
    </div>`;
}

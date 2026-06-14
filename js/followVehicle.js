/**
 * followVehicle.js — "pin & follow" a vehicle.
 *
 * Click Follow on a vehicle's popup and the map camera tracks it as it moves,
 * surviving tab-backgrounding, app-switch, and full reload (the followed
 * trip_id is persisted to localStorage and re-acquired when the feed returns).
 *
 * STRICTLY READ-ONLY w.r.t. the motion engine: this module only reads
 * `marker.getLngLat()` and pans the camera. It NEVER touches the glide, the
 * spike gates, the feed, or any marker state — so it cannot regress the
 * "trust the feed" / no-extrapolation invariants. Isolation is the safety.
 *
 * UX contract:
 *  - The camera lerp-chases the followed marker (smooth, premium); under
 *    prefers-reduced-motion it snaps (the chase easing is decorative).
 *  - A manual pan PAUSES follow (we never fight the user); a "tap to resume"
 *    chip lets them re-grab it. Follow HOLDS the user's zoom — it only pans.
 *  - If the vehicle leaves the feed for longer than the reacquire grace
 *    (covers a normal suspend/resume snapshot), follow ends with a toast.
 */
import { routeHexColors, FALLBACK_ROUTE_COLOR, ROUTE_LETTER } from './config.js';
import { showToast } from './ui.js';

const STORAGE_KEY        = 'mlm_follow_vehicle';
// Grace before declaring the vehicle gone — long enough to ride out the
// hidden-tab feed suspend (60 s) + the resume snapshot, and a cold reload's
// first WS frame, without dropping follow on a brief absence.
const REACQUIRE_GRACE_MS = 35_000;
// A persisted follow older than this is NOT restored — the followed vehicle's
// trip has almost certainly ended (and its trip_id retired) while the app was
// closed, so reopening hours later should start fresh, not hunt for a ghost.
// The timestamp tracks "last foregrounded while following" (refreshed on
// background), so a quick step-away still restores; only a long absence drops.
// (End-of-line detection can't cover this — the trip ends while the app is
// closed, with nothing running to clear the follow.)
const FOLLOW_RESTORE_MAX_AGE_MS = 30 * 60_000;   // 30 min
// Camera RETARGET cadence. We deliberately do NOT setCenter every animation
// frame: each programmatic move fires `moveend`, and bikeshare.js re-scans the
// whole viewport on moveend — at 60 fps that's a churn storm on low-end phones.
// Instead we easeTo the latest position every CHASE_MS and let MapLibre do the
// smooth in-between (one moveend per ease, ~4/s). The ease duration matches the
// cadence so chained eases read as continuous motion.
const CHASE_MS           = 280;
// Zoom used when a RESTORED follow focuses on its vehicle (reload / app-return).
// Moderate on purpose — the vehicle plus a few blocks of context, not a tight
// zoom; matches the app's own auto-locate zoom.
const FOLLOW_RESTORE_ZOOM = 14;

let _map         = null;
let _key         = null;   // followed markerKey (trip_id) or null
let _paused      = false;
let _timer       = null;
let _missingSince = null;  // ms when the marker went absent, or null when present
let _restorePending = false; // a persisted follow is restoring; focus the vehicle on first acquire
let _chipEl      = null;

function _reduceMotion() {
    return typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
}
function _marker() { return _key ? window.vehicleMarkers?.[_key] : null; }

// Followed-vehicle highlight — the same ring the station-hover proximity
// highlight uses, but a follow-OWNED class (`.follow-highlight`) so the two
// systems never clobber each other's marker classes. We track the element so
// we can move the ring when the marker's element is recreated (suspend/resume,
// trip re-creation) and clear it on stop.
let _highlightedEl = null;
function _setFollowHighlight(el) {
    if (_highlightedEl === el) return;
    _clearFollowHighlight();
    if (el) { el.classList.add('follow-highlight'); _highlightedEl = el; }
}
function _clearFollowHighlight() {
    _highlightedEl?.classList?.remove('follow-highlight');
    _highlightedEl = null;
}
function _persist(key) {
    try {
        if (key) localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, ts: Date.now() }));
        else localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage blocked (private mode) — follow just won't survive reload */ }
}
// Refresh the persisted timestamp to "now" while actively following — called on
// backgrounding so the restore-age clock measures time AWAY, not time since the
// follow first started (a 90-min trip you watch the whole time still restores).
function _touchPersist() { if (_key) _persist(_key); }

/**
 * Wire the module to the map and restore any persisted follow.
 * @param {maplibregl.Map} map
 */
export function initFollow(map) {
    _map = map;
    // A user pan PAUSES follow (don't fight them). 'dragstart' fires only for
    // user gestures — our own setCenter calls never trigger it.
    map.on('dragstart', () => { if (_key && !_paused) pauseFollow(); });
    // Restore across reload / PWA resume. The marker won't exist yet on a cold
    // load; the tick re-acquires it within the grace window once the feed lands.
    const saved = _readPersisted();
    if (saved) {
        _key = saved.key; _paused = false; _missingSince = Date.now(); _restorePending = true;
        _ensureChip(); _updateChip(); _scheduleTick();
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { _touchPersist(); return; }    // backgrounding — stamp "now"
        // Returning: re-prime promptly (feeds reconnect, snapshot re-creates markers).
        if (_key && !_paused) { _missingSince ??= Date.now(); _scheduleTick(); }
    });
    // pagehide is the more reliable "app is going away" signal on mobile PWAs.
    window.addEventListener('pagehide', _touchPersist);
}

/**
 * Read the persisted follow, dropping it when stale (older than the max age) or
 * malformed/legacy (the pre-timestamp plain-string format). Returns {key} or null.
 */
function _readPersisted() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* legacy plain-string format */ }
    if (!parsed || typeof parsed.key !== 'string' || typeof parsed.ts !== 'number'
        || Date.now() - parsed.ts > FOLLOW_RESTORE_MAX_AGE_MS) {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        return null;
    }
    return { key: parsed.key };
}

/** Toggle following the given markerKey (trip_id). */
export function toggleFollow(key) {
    if (!key) return;
    if (_key === key) stopFollow();
    else startFollow(key);
}

function startFollow(key) {
    // A user-initiated follow is never a restore (they're already looking at
    // the vehicle at their chosen zoom — don't zoom or re-popup).
    _key = key; _paused = false; _missingSince = null; _restorePending = false;
    _persist(key);
    _setFollowHighlight(_marker()?.getElement?.());   // immediate ring on the picked vehicle
    _ensureChip(); _updateChip();
    _cancelTick(); _scheduleTick();
}

/** Stop following entirely (clears persistence + chip + highlight). */
export function stopFollow() {
    _key = null; _paused = false; _missingSince = null; _restorePending = false;
    _persist(null);
    _clearFollowHighlight();
    _cancelTick();
    _removeChip();
}

/** True while a persisted follow is restoring and hasn't focused its vehicle
 *  yet — main.js suppresses the startup nearest-station popup when so. */
export function hasPendingRestore() { return _restorePending; }

function pauseFollow()  { _paused = true;  _cancelTick(); _updateChip(); }
function resumeFollow() { _paused = false; _missingSince = null; _updateChip(); _scheduleTick(); }

/** True when `key` is the currently-followed marker. */
export function isFollowingKey(key) { return _key != null && _key === key; }

/**
 * Reflect follow state onto the `.pv2-follow-btn` inside a freshly-rendered
 * popup (the popup HTML is rebuilt every refresh, so callers re-run this).
 * @param {Element|null} rootEl  The popup container element.
 * @param {string} key           This popup's markerKey.
 */
export function decorateFollowButton(rootEl, key) {
    const btn = rootEl?.querySelector?.('.pv2-follow-btn');
    if (!btn) return;
    const on = isFollowingKey(key);
    btn.classList.toggle('is-following', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = btn.querySelector('.pv2-follow-label');
    if (label) label.textContent = on ? 'Following' : 'Follow';
}

// ── camera chase loop ───────────────────────────────────────────────────────

function _scheduleTick() {
    if (_timer != null || !_key || _paused || typeof setTimeout === 'undefined') return;
    _timer = setTimeout(_tick, CHASE_MS);
}
function _cancelTick() {
    if (_timer != null && typeof clearTimeout !== 'undefined') clearTimeout(_timer);
    _timer = null;
}

function _tick() {
    _timer = null;
    if (!_key || _paused) return;
    const m = _marker();
    if (!m) {
        _clearFollowHighlight();        // element is gone while absent
        _missingSince ??= Date.now();
        if (Date.now() - _missingSince > REACQUIRE_GRACE_MS) { _vehicleGone(); return; }
        _updateChip();                  // show "Reconnecting…"
    } else {
        if (_missingSince != null) { _missingSince = null; _updateChip(); }
        _setFollowHighlight(m.getElement?.());   // re-applies if the element was recreated
        if (_restorePending) { _restorePending = false; _restoreFocus(m); }
        else _chase(m);
    }
    _scheduleTick();
}

/**
 * First acquisition of a RESTORED follow (reload / app-return): the map is at
 * the default whole-network view with no popup, so focus it on the vehicle —
 * a moderate zoom-in and the vehicle's OWN popup, in place of the startup
 * nearest-station popup (which main.js suppresses while a restore is pending).
 * Instant (jumpTo) — there's no prior view the rider is attached to.
 */
function _restoreFocus(m) {
    _map?.jumpTo?.({ center: m.getLngLat(), zoom: FOLLOW_RESTORE_ZOOM });
    const pop = m.getPopup?.();
    if (pop && !pop.isOpen?.()) m.togglePopup?.();
}

function _chase(m) {
    if (!_map?.getCenter) return;
    const t = m.getLngLat();
    const c = _map.getCenter();
    // Skip when already centered (parked vehicle) so we don't fire a needless
    // moveend → bikeshare viewport re-scan every cadence.
    if (Math.abs(t.lng - c.lng) < 1e-6 && Math.abs(t.lat - c.lat) < 1e-6) return;
    if (_reduceMotion()) {
        _map.jumpTo?.({ center: t });                 // ease is decorative → snap
    } else {
        // Linear ease over the cadence so back-to-back eases read as one smooth
        // continuous pan that tracks the gliding marker.
        _map.easeTo?.({ center: t, duration: CHASE_MS, easing: (x) => x });
    }
}

function _vehicleGone() {
    const wasRestore = _restorePending;
    stopFollow();
    if (wasRestore) {
        // A restored follow whose vehicle never came back (it ended its trip
        // while the rider was away) — fall back to the normal startup locate
        // rather than a confusing "what vehicle?" toast on a fresh load.
        try { document.dispatchEvent(new CustomEvent('requestAutoLocate')); } catch { /* no DOM */ }
    } else {
        try { showToast('That vehicle is no longer in the live feed', { severity: 'info' }); }
        catch { /* ui not ready — silent */ }
    }
}

// ── chip UI ─────────────────────────────────────────────────────────────────

function _routeLabel(rc) {
    if (!rc) return 'vehicle';
    return ROUTE_LETTER[rc] ? `${ROUTE_LETTER[rc]} Line` : `Route ${rc}`;
}

function _ensureChip() {
    if (_chipEl) return;
    const el = document.createElement('div');
    el.className = 'follow-chip';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
        '<span class="follow-chip-dot" aria-hidden="true"></span>' +
        '<span class="follow-chip-label"></span>' +
        '<button type="button" class="follow-chip-stop" aria-label="Stop following">✕</button>';
    el.querySelector('.follow-chip-stop').addEventListener('click', (e) => { e.stopPropagation(); stopFollow(); });
    // Tapping the chip body resumes a paused follow.
    el.addEventListener('click', () => { if (_paused) resumeFollow(); });
    (typeof document !== 'undefined' ? document.body : null)?.appendChild(el);
    _chipEl = el;
}

function _updateChip() {
    if (!_chipEl) return;
    const m = _marker();
    const rc = m?.route_code ?? m?.properties?.route_code ?? null;
    _chipEl.querySelector('.follow-chip-dot').style.background = routeHexColors[rc] ?? FALLBACK_ROUTE_COLOR;
    const route = _routeLabel(rc);
    _chipEl.classList.toggle('is-paused', _paused);
    _chipEl.classList.toggle('is-reconnecting', !_paused && _missingSince != null);
    const label = _chipEl.querySelector('.follow-chip-label');
    label.textContent = _paused            ? `Paused · ${route} — tap to resume`
                      : _missingSince != null ? `Reconnecting to ${route}…`
                      :                         `Following ${route}`;
}

function _removeChip() {
    _chipEl?.remove();
    _chipEl = null;
}

// Test-only surface (no production reader): drive one tick + inspect state
// without a real rAF loop.
export const _followInternals = {
    tick: _tick,
    state: () => ({ key: _key, paused: _paused, missingSince: _missingSince, restorePending: _restorePending, chip: !!_chipEl }),
    reset: () => { _cancelTick(); _key = null; _paused = false; _missingSince = null; _restorePending = false; _removeChip(); _clearFollowHighlight(); },
};

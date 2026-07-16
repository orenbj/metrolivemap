/**
 * js/popups.js — single-active-popup coordinator.
 *
 * Enforces "only one tooltip open at a time" across the five INDEPENDENT popup
 * owners that otherwise each tracked their own MapLibre popup and never closed
 * one another: vehicle markers (markers.js), station arrivals (stations.js),
 * Metro Bike Share (bikeshare.js), Metro Micro zones (microzones.js), and the
 * alerts panel (alertsPanel.js). Before this, e.g. a bike popup and a
 * vehicle/station popup could both be open and overlap.
 *
 * Owners register their OWN canonical close function — NOT the popup instance —
 * so the correct per-type teardown runs. This matters: the station closer also
 * clears vehicle highlights and restores keyboard focus; a bare popup.remove()
 * would skip both and strand state. The coordinator just decides WHEN to close;
 * each owner decides HOW.
 *
 * Leaf module: no imports, so every owner can import it without a circular
 * dependency (markers ⇄ stations would otherwise cycle through main.js).
 */

let _activeClose = null;
let _activeIsPinned = null;   // optional () => boolean for the active popup

/**
 * Register the just-opened popup as the single active one, first closing any
 * other currently-open popup via its own close function.
 *
 * Call this immediately AFTER the popup is shown (added to the map / toggled
 * open), passing the owner's canonical close function.
 *
 * @param {() => void} closeFn  The owner's full teardown for the popup it just
 *   opened. Must have stable identity per logical popup so notifyPopupClosed()
 *   can match it.
 * @param {(() => boolean)} [isPinnedFn]  Optional predicate reporting whether
 *   THIS popup is currently PINNED (a persistent, click-opened popup — not a
 *   transient hover preview). Evaluated lazily by isActivePopupPinned() so it
 *   reflects live pin state even if the popup is pinned after it opens. Owners
 *   without a hover/pin distinction (always pinned) pass `() => true`; omit for
 *   an always-transient popup.
 */
export function setActivePopup(closeFn, isPinnedFn = null) {
    if (typeof closeFn !== 'function') return;
    const prev = _activeClose;
    // Record the newcomer FIRST. When prev() runs below, the closing popup's own
    // 'close' handler calls notifyPopupClosed(prevFn); by then _activeClose is
    // already the new fn, so that notify is a no-op and the new registration
    // survives. (Set-then-close, not close-then-set.)
    _activeClose = closeFn;
    _activeIsPinned = typeof isPinnedFn === 'function' ? isPinnedFn : null;
    if (prev && prev !== closeFn) {
        // A teardown error in the outgoing popup must never block the incoming
        // one — swallow it so the new popup still becomes the active one.
        try { prev(); } catch { /* best-effort close */ }
    }
}

/**
 * True when the currently-active popup reports itself PINNED (click-opened /
 * persistent), false when it's a transient hover preview or nothing is open.
 *
 * Hover-preview OPEN paths query this BEFORE opening so a preview from one owner
 * never evicts a PINNED popup owned by ANOTHER owner (the cross-owner gap: each
 * owner only guarded its own hover against its own pin). A predicate error or a
 * missing predicate is treated as "not pinned" so a bug can never wedge a popup
 * permanently un-evictable.
 *
 * @returns {boolean}
 */
export function isActivePopupPinned() {
    try { return _activeIsPinned ? Boolean(_activeIsPinned()) : false; }
    catch { return false; }
}

/**
 * A popup owner calls this from its OWN 'close' handler so the coordinator drops
 * its pointer when that popup closes by any means (× button, map click, Escape,
 * direct remove()). Guarded by identity so a stale closer never clears a newer
 * registration.
 *
 * @param {() => void} closeFn  The same function reference passed to setActivePopup.
 */
export function notifyPopupClosed(closeFn) {
    if (_activeClose === closeFn) { _activeClose = null; _activeIsPinned = null; }
}

/**
 * Close whatever popup is currently active via its own canonical close fn (so
 * per-type teardown — vehicle-highlight clear, focus restore — runs). No-op when
 * nothing is open. Used by the global Escape handler: MapLibre 5.24 popups do NOT
 * self-close on Escape, so map popups (vehicle/station/bike/micro) relied on the
 * × button until this was wired. Returns true if a popup was closed.
 *
 * @returns {boolean}
 */
export function closeActivePopup() {
    const fn = _activeClose;
    if (typeof fn !== 'function') return false;
    // fn() runs the owner's teardown, which calls notifyPopupClosed() and clears
    // _activeClose. Swallow a teardown error so a caller (keydown handler) can't throw.
    try { fn(); } catch { /* best-effort close */ }
    return true;
}

/** Test hook: force-clear the registry without invoking the active closer. */
export function _resetActivePopup() { _activeClose = null; _activeIsPinned = null; }

/**
 * js/popups.js — single-active-popup coordinator.
 *
 * Enforces "only one tooltip open at a time" across the four INDEPENDENT popup
 * owners that otherwise each tracked their own MapLibre popup and never closed
 * one another: vehicle markers (markers.js), station arrivals (stations.js),
 * Metro Bike Share (bikeshare.js), and Metro Micro zones (microzones.js).
 * Before this, e.g. a bike popup and a vehicle/station popup could both be open
 * and overlap.
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
 */
export function setActivePopup(closeFn) {
    if (typeof closeFn !== 'function') return;
    const prev = _activeClose;
    // Record the newcomer FIRST. When prev() runs below, the closing popup's own
    // 'close' handler calls notifyPopupClosed(prevFn); by then _activeClose is
    // already the new fn, so that notify is a no-op and the new registration
    // survives. (Set-then-close, not close-then-set.)
    _activeClose = closeFn;
    if (prev && prev !== closeFn) {
        // A teardown error in the outgoing popup must never block the incoming
        // one — swallow it so the new popup still becomes the active one.
        try { prev(); } catch { /* best-effort close */ }
    }
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
    if (_activeClose === closeFn) _activeClose = null;
}

/** Test hook: force-clear the registry without invoking the active closer. */
export function _resetActivePopup() { _activeClose = null; }

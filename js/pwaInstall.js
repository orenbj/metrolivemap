/**
 * pwaInstall.js — "Add Metro Live Map to your home screen" affordance.
 *
 * Browsers no longer pop an automatic install prompt (the abuse-prone mini-
 * infobar was removed). To actively invite installation we:
 *   1. Register the installability-only service worker (sw.js) so Chromium
 *      will fire `beforeinstallprompt` at all.
 *   2. Capture that event, suppress the (absent) native UI, and reveal our own
 *      dismissible banner with an Install button that calls the saved prompt.
 *   3. On iOS Safari — which NEVER fires `beforeinstallprompt` — show a one-off
 *      text hint pointing at Share → Add to Home Screen instead.
 *
 * A dismissal is remembered in localStorage so we never nag. The whole module
 * is best-effort: every browser-API touch is guarded so a privacy-locked or
 * unsupported environment silently degrades to "no banner."
 */

const DISMISS_KEY = 'mlm_pwa_install_dismissed';

// ── Pure environment helpers (exported for tests) ─────────────────────────────

/** True when the page is already running as an installed standalone app. */
export function isStandalone() {
    try {
        return window.matchMedia?.('(display-mode: standalone)')?.matches === true
            || window.navigator.standalone === true; // iOS Safari legacy flag
    } catch {
        return false;
    }
}

/** True on iOS / iPadOS (iPadOS 13+ masquerades as desktop Safari). */
export function isIos() {
    const ua = navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua)
        || (/macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

/**
 * True only in iOS *Safari* — Add-to-Home-Screen is unavailable in the iOS
 * Chrome/Firefox/Edge skins (they wrap WebKit but expose no A2HS), so showing
 * them the Share-sheet hint would be wrong.
 */
export function isIosSafari() {
    if (!isIos()) return false;
    return !/crios|fxios|edgios|opios|gsa/i.test(navigator.userAgent || '');
}

export function wasDismissed(storage = safeLocalStorage()) {
    try { return storage?.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export function setDismissed(storage = safeLocalStorage()) {
    try { storage?.setItem(DISMISS_KEY, '1'); } catch { /* quota / privacy mode */ }
}

function safeLocalStorage() {
    try { return window.localStorage; } catch { return null; }
}

// ── Banner UI ─────────────────────────────────────────────────────────────────

let _deferredPrompt = null;   // stashed beforeinstallprompt event
let _banner = null;           // the DOM element, built lazily
let _bannerReady = false;     // true once initPwaInstall has wired the UI

// Capture beforeinstallprompt at MODULE-IMPORT time (main.js imports this module
// early, before the data fetches), NOT only inside initPwaInstall which runs
// after dataPromise resolves. On a warm return visit the SW is already active and
// the manifest cached, so Chromium can fire beforeinstallprompt right after
// `load` — BEFORE initPwaInstall would attach its listener — and the event (and
// thus the whole install banner for the session) would be silently lost. The
// early handler only STASHES the event; it shows the banner only once the UI is
// ready (initPwaInstall sets _bannerReady and shows any already-stashed prompt).
function _onBeforeInstallPrompt(e) {
    e.preventDefault();          // suppress any native mini-UI
    _deferredPrompt = e;
    if (_bannerReady && !wasDismissed()) showBanner({ iosHint: false });
    _notifyOfferChange();
}
if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', _onBeforeInstallPrompt);
}

function buildBanner({ iosHint }) {
    const banner = document.createElement('div');
    banner.className = 'pwa-install-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Install Metro Live Map');

    const text = document.createElement('span');
    text.className = 'pwa-install-text';
    text.textContent = iosHint
        ? 'Install Metro Live Map: tap Share, then “Add to Home Screen.”'
        : 'Add Metro Live Map to your home screen.';
    banner.appendChild(text);

    const actions = document.createElement('span');
    actions.className = 'pwa-install-actions';

    // The Install button only makes sense when we hold a real prompt event.
    if (!iosHint) {
        const install = document.createElement('button');
        install.type = 'button';
        install.className = 'pwa-install-btn';
        install.textContent = 'Install';
        install.addEventListener('click', onInstallClick);
        actions.appendChild(install);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pwa-install-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss install prompt');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => { setDismissed(); hideBanner(); });
    actions.appendChild(dismiss);

    banner.appendChild(actions);
    return banner;
}

// The banner sits above the map chrome (z-index 450). It is offset to clear the
// legend sheet and the attribution (see the .pwa-install-banner rule in the
// mobile block of index-style.css), but a hint the rider never dismisses should
// still not occupy that band for the rest of the session. Auto-hide after this
// long WITHOUT remembering the dismissal, so the offer returns next visit.
const BANNER_AUTO_HIDE_MS = 15000;
let _bannerAutoHideTimer = null;

function showBanner(opts) {
    if (_banner || !document.body) return;
    _banner = buildBanner(opts);
    document.body.appendChild(_banner);
    // Next frame: add the visible class so the CSS slide-in transition runs.
    requestAnimationFrame(() => _banner?.classList.add('pwa-install-banner--visible'));
    clearTimeout(_bannerAutoHideTimer);
    _bannerAutoHideTimer = setTimeout(hideBanner, BANNER_AUTO_HIDE_MS);
}

function hideBanner() {
    clearTimeout(_bannerAutoHideTimer);
    _bannerAutoHideTimer = null;
    if (!_banner) return;
    const el = _banner;
    _banner = null;
    el.classList.remove('pwa-install-banner--visible');
    // Remove after the transition so it doesn't linger in the a11y tree.
    setTimeout(() => el.remove(), 300);
}

async function onInstallClick() {
    const prompt = _deferredPrompt;
    _deferredPrompt = null;
    hideBanner();
    if (!prompt) return;
    try {
        prompt.prompt();
        await prompt.userChoice;        // {outcome: 'accepted' | 'dismissed'}
    } catch { /* user gesture lost / already handled — nothing to do */ }
    _notifyOfferChange();   // the event is single-use; the offer is now gone
}

// ── The persistent offer (a missed banner must be recoverable) ────────────────
//
// The banner auto-hides after BANNER_AUTO_HIDE_MS and the × remembers the
// dismissal, so a rider who looked away or tapped × had NO way back to the
// install other than reloading the page — reported from a phone. These three
// exports let the map chrome carry an always-available entry point, so the
// banner stays a one-off nudge rather than the only route.
//
// Deliberately NOT gated on `wasDismissed()`: dismissing the nudge means "stop
// interrupting me", not "never let me install". That distinction is the whole
// point of this API.

const _offerListeners = new Set();

function _notifyOfferChange() {
    const avail = hasInstallOffer();
    for (const cb of _offerListeners) {
        try { cb(avail); } catch { /* a broken listener must not break the rest */ }
    }
}

/**
 * Is there an install we can actually offer RIGHT NOW?
 *
 * False once installed, and false on Chromium until `beforeinstallprompt` has
 * fired — a button that opens nothing is worse than no button. The prompt event
 * is single-use per spec, so this also goes false after the rider declines the
 * native dialog; Chromium re-fires it on a later visit.
 * @returns {boolean}
 */
export function hasInstallOffer() {
    if (isStandalone()) return false;
    return !!_deferredPrompt || isIosSafari();
}

/**
 * Subscribe to changes in `hasInstallOffer()`. Calls back immediately with the
 * current value, then on every change. `beforeinstallprompt` can fire long
 * after the map chrome mounts, so a control cannot just read the value once.
 * @param {(available: boolean) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onInstallOfferChange(cb) {
    _offerListeners.add(cb);
    // Guarded like the notify path: this runs inside the control's `onAdd`, so
    // an unguarded throw here would abort mounting the whole map control rather
    // than just failing one subscriber.
    try { cb(hasInstallOffer()); } catch { /* a broken listener is its own problem */ }
    return () => _offerListeners.delete(cb);
}

/**
 * Act on the offer: fire the native prompt where we hold one, else show the
 * manual Share -> Add to Home Screen hint (iOS Safari, which never fires the
 * event). Must be called from a real user gesture or Chromium drops the prompt.
 * @returns {Promise<'prompted'|'ios-hint'|'unavailable'>}
 */
export async function requestInstall() {
    if (_deferredPrompt) { await onInstallClick(); return 'prompted'; }
    if (isIosSafari()) {
        hideBanner();                       // re-show even if it was dismissed
        showBanner({ iosHint: true });
        return 'ios-hint';
    }
    return 'unavailable';
}

/**
 * Test-only reset. The stashed `beforeinstallprompt` event, the banner node and
 * the offer subscribers are all module state, and CI runs a shuffled pass — a
 * test that dispatches the event otherwise leaves a live prompt behind and the
 * next file's "nothing to offer" case passes or fails depending on order.
 */
export function _resetInstallStateForTest() {
    _deferredPrompt = null;
    _offerListeners.clear();
    _banner?.remove();          // drop the node too, not just the reference
    _banner = null;
    _bannerReady = false;
    clearTimeout(_bannerAutoHideTimer);
    _bannerAutoHideTimer = null;
}

// ── Wiring ────────────────────────────────────────────────────────────────────

/**
 * Register the service worker and wire the install affordances. Safe to call
 * once at startup; no-ops in unsupported environments and when already
 * installed or previously dismissed.
 */
export function initPwaInstall() {
    if (isStandalone()) return; // already installed — never prompt

    // Register the installability-only worker. Relative path so it resolves
    // under the GitHub Pages subpath (/metrolivemap/) and at a bare root alike.
    // initPwaInstall runs after the data fetches resolve, which can be AFTER the
    // window 'load' event — so register immediately if load already happened,
    // else wait for it. Adding a 'load' listener post-load would never fire and
    // would silently prevent SW registration (and thus the whole install prompt).
    if ('serviceWorker' in navigator) {
        const register = () =>
            navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
        if (document.readyState === 'complete') register();
        else window.addEventListener('load', register, { once: true });
    }

    // The beforeinstallprompt capture itself is attached at module-import time
    // (see _onBeforeInstallPrompt above) so a warm-load event fired before this
    // runs isn't lost. Mark the UI ready and surface any already-stashed prompt.
    _bannerReady = true;
    if (_deferredPrompt && !wasDismissed()) showBanner({ iosHint: false });

    // Hide + remember once installed (also covers the browser-menu install path).
    window.addEventListener('appinstalled', () => {
        _deferredPrompt = null;
        setDismissed();
        hideBanner();
        _notifyOfferChange();
    });

    // iOS Safari never fires beforeinstallprompt — offer the manual hint once,
    // after a short delay so it doesn't collide with the startup splash.
    if (isIosSafari() && !wasDismissed()) {
        setTimeout(() => {
            if (!isStandalone() && !wasDismissed()) showBanner({ iosHint: true });
        }, 4000);
    }
}

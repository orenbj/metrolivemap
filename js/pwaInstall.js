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

function showBanner(opts) {
    if (_banner || !document.body) return;
    _banner = buildBanner(opts);
    document.body.appendChild(_banner);
    // Next frame: add the visible class so the CSS slide-in transition runs.
    requestAnimationFrame(() => _banner?.classList.add('pwa-install-banner--visible'));
}

function hideBanner() {
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

    // Android / desktop Chromium: the real installability event.
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();          // suppress any native mini-UI
        _deferredPrompt = e;
        if (!wasDismissed()) showBanner({ iosHint: false });
    });

    // Hide + remember once installed (also covers the browser-menu install path).
    window.addEventListener('appinstalled', () => {
        _deferredPrompt = null;
        setDismissed();
        hideBanner();
    });

    // iOS Safari never fires beforeinstallprompt — offer the manual hint once,
    // after a short delay so it doesn't collide with the startup splash.
    if (isIosSafari() && !wasDismissed()) {
        setTimeout(() => {
            if (!isStandalone() && !wasDismissed()) showBanner({ iosHint: true });
        }, 4000);
    }
}

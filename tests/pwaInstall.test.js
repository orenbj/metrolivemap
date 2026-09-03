/**
 * Tests for the pure environment helpers in js/pwaInstall.js — the platform
 * detection and dismissal-persistence logic that decides whether (and which)
 * install affordance to show. The event-wiring side of the module needs a real
 * `beforeinstallprompt`, which jsdom can't emit, so it's exercised by manual QA;
 * here we pin down the branching logic that's easy to get subtly wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isIos, isIosSafari, isStandalone, wasDismissed, setDismissed,
         hasInstallOffer, onInstallOfferChange, requestInstall,
         _resetInstallStateForTest } from '../js/pwaInstall.js';

const realUA = navigator.userAgent;
const realTouch = navigator.maxTouchPoints;
const realStandalone = navigator.standalone;
const realMatchMedia = window.matchMedia;

function setUA(ua, { maxTouchPoints = 0 } = {}) {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1';
const IPADOS_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: realUA, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: realTouch, configurable: true });
    Object.defineProperty(navigator, 'standalone', { value: realStandalone, configurable: true });
    window.matchMedia = realMatchMedia;
    try { window.localStorage.clear(); } catch { /* shim */ }
});

describe('isIos', () => {
    it('detects iPhone', () => { setUA(IPHONE_SAFARI); expect(isIos()).toBe(true); });
    it('detects iPadOS masquerading as desktop Safari (Mac UA + touch)', () => {
        setUA(IPADOS_SAFARI, { maxTouchPoints: 5 });
        expect(isIos()).toBe(true);
    });
    it('does not flag a real touchless Mac', () => {
        setUA(IPADOS_SAFARI, { maxTouchPoints: 0 });
        expect(isIos()).toBe(false);
    });
    it('does not flag Android', () => { setUA(ANDROID_CHROME); expect(isIos()).toBe(false); });
});

describe('isIosSafari', () => {
    it('true for iPhone Safari', () => { setUA(IPHONE_SAFARI); expect(isIosSafari()).toBe(true); });
    it('false for iOS Chrome (CriOS) — no Add to Home Screen there', () => {
        setUA(IPHONE_CHROME);
        expect(isIosSafari()).toBe(false);
    });
    it('false for desktop Chrome', () => { setUA(DESKTOP_CHROME); expect(isIosSafari()).toBe(false); });
});

describe('isStandalone', () => {
    it('true when display-mode: standalone matches', () => {
        window.matchMedia = vi.fn().mockReturnValue({ matches: true });
        expect(isStandalone()).toBe(true);
    });
    it('true when iOS legacy navigator.standalone flag is set', () => {
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
        expect(isStandalone()).toBe(true);
    });
    it('false in a normal browser tab', () => {
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
        Object.defineProperty(navigator, 'standalone', { value: false, configurable: true });
        expect(isStandalone()).toBe(false);
    });
});

describe('dismissal persistence', () => {
    beforeEach(() => { try { window.localStorage.clear(); } catch { /* shim */ } });

    it('wasDismissed is false until setDismissed is called', () => {
        expect(wasDismissed()).toBe(false);
        setDismissed();
        expect(wasDismissed()).toBe(true);
    });

    it('tolerates a throwing storage without crashing', () => {
        const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
        expect(() => setDismissed(throwing)).not.toThrow();
        expect(wasDismissed(throwing)).toBe(false);
    });
});

/**
 * The manifest itself. `orientation` is the one member here that can override a
 * setting the user made on their own device, so it gets a regression guard —
 * it is a one-word change that is invisible in review and only reproducible on
 * a real phone.
 */
describe('manifest.json — orientation must not override the device', () => {
    // Vitest runs from the repo root; import.meta.url is not a file: URL under
    // the jsdom environment, so resolve from cwd instead.
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

    it('declares NO orientation, so the OS rotation lock is respected', () => {
        // `"orientation": "any"` reads like "we don't care", but per the Web App
        // Manifest spec it is an explicit orientation LOCK of type "any" — it
        // tells the platform the app supports every orientation, and an
        // installed PWA then rotates freely even when the user has auto-rotate
        // switched OFF on their phone. Reported on a real device.
        //
        // Omitting the member entirely is what yields "follow the platform
        // default", i.e. obey the user's rotation lock. Do NOT "fix" this by
        // setting "portrait" — that overrides the user in the other direction
        // and would break landscape on a tablet.
        expect(manifest.orientation).toBeUndefined();
    });

    it('still declares the members installability depends on', () => {
        expect(manifest.display).toBe('standalone');
        expect(manifest.start_url).toBeTruthy();
        expect(manifest.icons?.length).toBeGreaterThan(0);
        expect(manifest.icons.some(i => i.purpose === 'maskable')).toBe(true);
    });
});

describe('a missed install banner stays recoverable', () => {
    // The banner auto-hides after 15 s and its × is remembered, so before this
    // the ONLY route back to an install was reloading the page — reported from
    // a phone. The map chrome now carries a persistent entry point, driven by
    // this API.

    beforeEach(() => {
        _resetInstallStateForTest();
        setUA(ANDROID_CHROME);
        window.matchMedia = vi.fn(() => ({ matches: false }));   // not standalone
        try { localStorage.removeItem('mlm_pwa_install_dismissed'); } catch { /* blocked */ }
    });
    afterEach(() => { _resetInstallStateForTest(); });

    it('offers nothing on Chromium until beforeinstallprompt has fired', () => {
        // A button that opens nothing is worse than no button.
        expect(hasInstallOffer()).toBe(false);
    });

    it('offers the manual hint on iOS Safari, which never fires the event', () => {
        setUA(IPHONE_SAFARI, { maxTouchPoints: 5 });
        expect(hasInstallOffer()).toBe(true);
    });

    it('never offers an install once the app IS installed', () => {
        setUA(IPHONE_SAFARI, { maxTouchPoints: 5 });
        window.matchMedia = vi.fn(() => ({ matches: true }));    // standalone
        expect(hasInstallOffer()).toBe(false);
    });

    it('STILL offers after the banner was dismissed — the key behaviour', () => {
        // Dismissing the nudge means "stop interrupting me", not "never let me
        // install". Gating the affordance on wasDismissed() would recreate the
        // exact dead end being fixed.
        setUA(IPHONE_SAFARI, { maxTouchPoints: 5 });
        setDismissed();
        expect(wasDismissed(), 'precondition: the dismissal is recorded').toBe(true);
        expect(hasInstallOffer(), 'a dismissed nudge must not disable the button').toBe(true);
    });

    it('subscribers are called immediately with the current value', () => {
        setUA(IPHONE_SAFARI, { maxTouchPoints: 5 });
        const cb = vi.fn();
        const off = onInstallOfferChange(cb);
        // beforeinstallprompt can fire long after the map chrome mounts, so a
        // control that read the value once would never light up.
        expect(cb).toHaveBeenCalledWith(true);
        off();
    });

    it('unsubscribing actually stops the callbacks', () => {
        const cb = vi.fn();
        onInstallOfferChange(cb)();      // subscribe, then immediately unsubscribe
        cb.mockClear();
        window.dispatchEvent(new Event('beforeinstallprompt'));
        expect(cb).not.toHaveBeenCalled();
    });

    it('one broken subscriber does not break the others', () => {
        const bad = vi.fn(() => { throw new Error('boom'); });
        const good = vi.fn();
        const offBad = onInstallOfferChange(bad);
        const offGood = onInstallOfferChange(good);
        good.mockClear();
        expect(() => window.dispatchEvent(new Event('beforeinstallprompt'))).not.toThrow();
        expect(good).toHaveBeenCalled();
        offBad(); offGood();
    });

    it('reports unavailable rather than throwing when there is nothing to offer', async () => {
        setUA(ANDROID_CHROME);
        await expect(requestInstall()).resolves.toBe('unavailable');
    });

    it('shows the manual hint on iOS even after a dismissal', async () => {
        setUA(IPHONE_SAFARI, { maxTouchPoints: 5 });
        setDismissed();
        await expect(requestInstall()).resolves.toBe('ios-hint');
        expect(document.querySelector('.pwa-install-banner'),
            'the hint must actually appear').toBeTruthy();
        document.querySelector('.pwa-install-banner')?.remove();
    });
});

describe('the install control is wired into the map chrome', () => {
    // hasInstallOffer() being correct says nothing about whether anything USES
    // it — the wiring gap this review has now found six times.
    const SRC = readFileSync('js/map.js', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    it('adds a control to the map', () => {
        expect(SRC).toMatch(/addControl\(new InstallControl\(\)/);
    });

    it('drives its visibility from the subscription, not a one-time read', () => {
        expect(SRC).toMatch(/onInstallOfferChange\(/);
        expect(SRC).toMatch(/hidden = !available/);
    });

    it('acts on a click', () => {
        expect(SRC).toMatch(/requestInstall\(\)/);
    });

    it('the comment stripping is real (guards the assertions above)', () => {
        expect(SRC).not.toMatch(/reported from a phone/);
        expect(SRC.length).toBeLessThan(readFileSync('js/map.js', 'utf8').length);
    });
});

describe('manifest colours match the app, not white', () => {
    const m = JSON.parse(readFileSync('manifest.json', 'utf8'));

    it('theme_color is not white', () => {
        // On Android the INSTALLED app paints its status bar from this value,
        // and the page's <meta name="theme-color"> does not override it in
        // standalone — so #ffffff put a white band above a dark map for the
        // whole session (reported from a phone, and it survived the meta fix).
        expect(m.theme_color.toLowerCase()).not.toBe('#ffffff');
    });

    it('theme_color matches the dark background the page paints', () => {
        // The status-bar strip and the page under it are painted by two
        // different mechanisms; a mismatch shows as a visible seam.
        const css = readFileSync('styles/index-style.css', 'utf8');
        const dark = css.match(/body\.dark-mode\s*\{[^}]*background-color:\s*([^;]+)/)[1].trim();
        expect(m.theme_color.toLowerCase()).toBe(dark.toLowerCase());
    });

    it('background_color matches too, so the launch splash does not flash white', () => {
        expect(m.background_color.toLowerCase()).toBe(m.theme_color.toLowerCase());
    });
});

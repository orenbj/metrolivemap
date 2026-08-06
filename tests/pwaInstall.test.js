/**
 * Tests for the pure environment helpers in js/pwaInstall.js — the platform
 * detection and dismissal-persistence logic that decides whether (and which)
 * install affordance to show. The event-wiring side of the module needs a real
 * `beforeinstallprompt`, which jsdom can't emit, so it's exercised by manual QA;
 * here we pin down the branching logic that's easy to get subtly wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isIos, isIosSafari, isStandalone, wasDismissed, setDismissed } from '../js/pwaInstall.js';

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

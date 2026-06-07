/**
 * Tests for the pure environment helpers in js/pwaInstall.js — the platform
 * detection and dismissal-persistence logic that decides whether (and which)
 * install affordance to show. The event-wiring side of the module needs a real
 * `beforeinstallprompt`, which jsdom can't emit, so it's exercised by manual QA;
 * here we pin down the branching logic that's easy to get subtly wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

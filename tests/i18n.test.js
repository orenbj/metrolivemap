/**
 * Tests for the i18n shim. Covers:
 *   - Synchronous t() lookup with English baseline
 *   - Spanish translations and fallback to English on missing key
 *   - Hard fallback to the raw key when neither dict has it (developer signal)
 *   - {var} interpolation, including numeric values
 *   - setLang persists to localStorage and updates document.documentElement.lang
 *   - onLangChange listeners fire on switch, not on no-op same-lang setLang
 *   - pickInitialLang prefers localStorage over navigator.language
 *
 * Dictionaries are mocked so the suite doesn't depend on fetch — i18n.js's
 * _loadDict goes through global fetch which we stub per-test.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initI18n, setLang, getLang, t, onLangChange, pickInitialLang, _resetForTest } from '../js/i18n.js';

const enDict = {
    'popup.eta.now':            'Now',
    'popup.eta.departs_m':      'Departs {m}m',
    'popup.status.boarding':    'Boarding',
    'access.elevator':          'Elevator outage',
    'alert.effect.DETOUR':      'Detour',
};
const esDict = {
    'popup.eta.now':            'Ahora',
    'popup.eta.departs_m':      'Sale en {m} min',
    'popup.status.boarding':    'Abordando',
    'access.elevator':          'Ascensor fuera de servicio',
    // 'alert.effect.DETOUR' intentionally omitted — tests english fallback
};

function _mockFetch(map) {
    return vi.fn(url => {
        const lang = String(url).match(/(\w+)\.json$/)?.[1];
        const body = map[lang];
        if (!body) return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });
}

// jsdom wraps localStorage in a Proxy that rejects direct property assignment,
// so we replace the whole object via defineProperty for the duration of the
// suite and restore afterward — matches the pattern in scheduleCalibration.test.js.
let _originalLocalStorageDescriptor;

beforeEach(() => {
    _resetForTest();
    _originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const fake = {
        store: {},
        getItem(k)    { return this.store[k] ?? null; },
        setItem(k, v) { this.store[k] = v; },
        removeItem(k) { delete this.store[k]; },
        clear()       { this.store = {}; },
    };
    Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
    global.fetch = _mockFetch({ en: enDict, es: esDict });
    // Default navigator.language to en — individual tests override.
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    document.documentElement.lang = '';
});

afterEach(() => {
    vi.restoreAllMocks();
    if (_originalLocalStorageDescriptor) {
        Object.defineProperty(window, 'localStorage', _originalLocalStorageDescriptor);
    }
});

describe('initI18n + t()', () => {
    it('loads English baseline by default', async () => {
        await initI18n();
        expect(getLang()).toBe('en');
        expect(t('popup.eta.now')).toBe('Now');
        expect(t('popup.status.boarding')).toBe('Boarding');
    });

    it('sets document.documentElement.lang on init', async () => {
        await initI18n();
        expect(document.documentElement.lang).toBe('en');
    });

    it('returns the raw key when both dicts lack it (developer signal)', async () => {
        await initI18n();
        expect(t('missing.nonsense.key')).toBe('missing.nonsense.key');
    });

    it('interpolates {var} placeholders', async () => {
        await initI18n();
        expect(t('popup.eta.departs_m', { m: 5 })).toBe('Departs 5m');
    });

    it('passes through string interpolation values unchanged', async () => {
        await initI18n();
        expect(t('popup.eta.departs_m', { m: '12' })).toBe('Departs 12m');
    });

    it('renders empty string for null/undefined interpolation values', async () => {
        await initI18n();
        expect(t('popup.eta.departs_m', { m: null })).toBe('Departs m');
    });
});

describe('Spanish translations + fallback', () => {
    it('returns Spanish strings after setLang("es")', async () => {
        await initI18n();
        await setLang('es');
        expect(getLang()).toBe('es');
        expect(t('popup.eta.now')).toBe('Ahora');
        expect(t('access.elevator')).toBe('Ascensor fuera de servicio');
    });

    it('falls back to English when Spanish lacks a key', async () => {
        await initI18n();
        await setLang('es');
        // 'alert.effect.DETOUR' is missing from esDict — must surface English,
        // never the raw key, so an in-progress translation doesn't look broken.
        expect(t('alert.effect.DETOUR')).toBe('Detour');
    });

    it('updates document.documentElement.lang on setLang', async () => {
        await initI18n();
        await setLang('es');
        expect(document.documentElement.lang).toBe('es');
    });

    it('ignores unsupported languages (no-op)', async () => {
        await initI18n();
        await setLang('fr');
        expect(getLang()).toBe('en');
    });

    it('is a no-op when setLang is called with the current language', async () => {
        await initI18n();
        const before = global.fetch.mock.calls.length;
        await setLang('en');
        // No additional fetch beyond the initial en dict load.
        expect(global.fetch.mock.calls.length).toBe(before);
    });
});

describe('persistence and pickInitialLang', () => {
    it('persists setLang choice to localStorage', async () => {
        await initI18n();
        await setLang('es');
        expect(localStorage.getItem('metro-livemap.lang')).toBe('es');
    });

    it('pickInitialLang prefers localStorage over navigator.language', () => {
        localStorage.setItem('metro-livemap.lang', 'en');
        Object.defineProperty(navigator, 'language', { value: 'es-MX', configurable: true });
        expect(pickInitialLang()).toBe('en');
    });

    it('pickInitialLang falls through to navigator.language when no saved pref', () => {
        Object.defineProperty(navigator, 'language', { value: 'es-MX', configurable: true });
        expect(pickInitialLang()).toBe('es');
    });

    it('pickInitialLang defaults to en for unsupported navigator.language', () => {
        Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
        expect(pickInitialLang()).toBe('en');
    });

    it('pickInitialLang ignores an unsupported saved value', () => {
        localStorage.setItem('metro-livemap.lang', 'fr');
        Object.defineProperty(navigator, 'language', { value: 'es-MX', configurable: true });
        expect(pickInitialLang()).toBe('es');
    });
});

describe('onLangChange listeners', () => {
    it('fires on a real language switch', async () => {
        await initI18n();
        const spy = vi.fn();
        onLangChange(spy);
        await setLang('es');
        expect(spy).toHaveBeenCalledWith('es');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire on a no-op same-lang setLang', async () => {
        await initI18n();
        const spy = vi.fn();
        onLangChange(spy);
        await setLang('en'); // current
        expect(spy).not.toHaveBeenCalled();
    });

    it('unsubscribe stops further notifications', async () => {
        await initI18n();
        const spy = vi.fn();
        const off = onLangChange(spy);
        off();
        await setLang('es');
        expect(spy).not.toHaveBeenCalled();
    });

    it('isolates listener errors (one throwing listener does not block others)', async () => {
        await initI18n();
        const goodSpy = vi.fn();
        onLangChange(() => { throw new Error('boom'); });
        onLangChange(goodSpy);
        // Should not throw; should still call the good listener.
        await setLang('es');
        expect(goodSpy).toHaveBeenCalledWith('es');
    });
});

describe('graceful degradation on fetch failure', () => {
    it('initI18n with failing fetch leaves t() as a key passthrough', async () => {
        global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
        await initI18n();
        // No dict loaded — every key is its own value, but the app keeps running.
        expect(t('popup.eta.now')).toBe('popup.eta.now');
    });

    it('setLang with failing fetch leaves caller in the new lang but with empty dict (falls back to en)', async () => {
        // First initialize normally so we have the English fallback dict.
        await initI18n();
        // Then make the next fetch fail.
        global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 503 }));
        await setLang('es');
        expect(getLang()).toBe('es');
        // English fallback still works because _fallback was loaded earlier.
        expect(t('popup.eta.now')).toBe('Now');
    });
});

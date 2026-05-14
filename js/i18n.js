/**
 * i18n.js — minimal Spanish/English translation shim for rider-critical UI strings.
 *
 * Design:
 *   - Flat dictionary keyed by dot-separated path (e.g. 'popup.status.boarding').
 *   - Two static JSONs in /i18n: en.json (canonical) and es.json. Missing keys
 *     in es.json fall back to en.json, then to the key itself — so a missed
 *     translation degrades to English, never to "undefined".
 *   - Synchronous t() lookup — the dict is loaded once at boot before any
 *     translatable code runs.
 *   - Persisted to localStorage. Initial language picked from saved preference,
 *     else from navigator.language ('es*' → 'es', else 'en').
 *   - Listeners notified on setLang for components that need to re-render.
 *
 * Why no library: ~35 P0 strings, no plural-rule edge cases, no nesting needed.
 * A library would add 50 KB of bytes and a new CSP entry for ~250 LoC of behavior
 * we can write ourselves. Matches the no-build vanilla aesthetic of the rest
 * of the codebase.
 *
 * Out of scope for v1: toasts, search placeholders, legend chrome, map control
 * aria-labels, alert feed body translation (the LACMTA feed is English-only —
 * we mark it `lang="en"` so screen readers handle it correctly, but we cannot
 * translate Metro's wording without a server-side pipeline).
 */

const STORAGE_KEY = 'metro-livemap.lang';
const SUPPORTED   = new Set(['en', 'es']);
const DEFAULT_LANG = 'en';

let _lang     = DEFAULT_LANG;
let _dict     = {};        // active dict (flat: key → string)
let _fallback = {};        // en dict, used when active is es and key is missing
const _listeners = new Set();

/**
 * Resolve the initial language from localStorage, then navigator.language.
 * Exported so tests can call it deterministically.
 * @returns {'en'|'es'}
 */
export function pickInitialLang() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && SUPPORTED.has(saved)) return saved;
    } catch { /* private mode / quota */ }
    const nav = (navigator?.language ?? '').toLowerCase();
    return nav.startsWith('es') ? 'es' : 'en';
}

/**
 * Fetch /i18n/{lang}.json and return its parsed dictionary. Returns {} on any
 * failure so a CDN hiccup degrades to "untranslated" rather than crashing boot.
 */
async function _loadDict(lang) {
    try {
        const res = await fetch(`./i18n/${lang}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.warn(`[i18n] Failed to load ${lang}.json:`, err);
        return {};
    }
}

/**
 * Initialize i18n. Must be awaited before any code that calls t() runs.
 * Loads the English dictionary first (always — used as fallback), then the
 * active language if different.
 */
export async function initI18n() {
    _fallback = await _loadDict('en');
    _lang     = pickInitialLang();
    _dict     = _lang === 'en' ? _fallback : await _loadDict(_lang);
    if (typeof document !== 'undefined') document.documentElement.lang = _lang;
}

/**
 * Change the active language. Fetches the new dictionary, updates
 * document.documentElement.lang, persists the choice, and notifies listeners.
 *
 * Awaiting is optional — callers that want immediate consistency should await;
 * the language-toggle UI can fire-and-forget since listeners re-render.
 * @param {'en'|'es'} lang
 */
export async function setLang(lang) {
    if (!SUPPORTED.has(lang) || lang === _lang) return;
    _lang = lang;
    _dict = lang === 'en' ? _fallback : await _loadDict(lang);
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    _listeners.forEach(fn => { try { fn(lang); } catch (e) { console.warn('[i18n] listener error:', e); } });
}

/** @returns {'en'|'es'} */
export function getLang() { return _lang; }

/**
 * Translate a key with optional variable interpolation. Falls back to the
 * English dict, then to the key itself, so an untranslated string degrades
 * gracefully to its English value (and a missing key shows up as the raw
 * dot-path — easy to find and fix).
 *
 * Interpolation uses `{name}` syntax: t('popup.departs_m', { m: 5 }) →
 * "Departs 5m" (en) / "Sale en 5m" (es).
 * @param {string} key
 * @param {Object<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
    const raw = _dict[key] ?? _fallback[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? String(vars[k]) : '');
}

/**
 * Register a callback fired after every successful setLang call. The callback
 * receives the new language code. Returns an unsubscribe function.
 *
 * Typical use: re-render an open popup or the legend chrome when language
 * changes. Implementations should be defensive against missing DOM (the
 * popup may have closed between subscription and call).
 * @param {(lang: 'en'|'es') => void} fn
 * @returns {() => boolean}
 */
export function onLangChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

/** Test-only: reset module state so each test starts clean. */
export function _resetForTest() {
    _lang = DEFAULT_LANG;
    _dict = {};
    _fallback = {};
    _listeners.clear();
}

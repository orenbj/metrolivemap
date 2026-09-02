/**
 * The installed PWA's status bar must match the theme the app is showing.
 *
 * Reported from a real device: a white status-bar strip sitting above a dark
 * map, for the whole session. Two independent causes, either of which produces
 * it on its own:
 *
 *  1. index.html ships two `theme-color` metas switched by
 *     `prefers-color-scheme`. That is only right while the app follows the OS —
 *     but the app has its own dark-mode toggle persisted in
 *     `localStorage.darkMode`, so a rider on a light-mode phone who turns on
 *     dark mode (or the reverse) resolved the wrong one, permanently.
 *  2. Neither `html` nor `body` declared a `background-color`, so the viewport
 *     canvas fell back to the UA default WHITE. `#map` is only `height: 100%`
 *     and does not paint the safe-area strips, so on iOS — where
 *     `apple-mobile-web-app-status-bar-style: black-translucent` puts page
 *     content *under* a transparent status bar — that white showed through.
 *
 * Both are silent: nothing throws, and neither reproduces in a desktop browser
 * tab, which is why this shipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS  = readFileSync('styles/index-style.css', 'utf8');
const HTML = readFileSync('index.html', 'utf8');

/** Value of `prop` in the first rule whose selector matches `selector` exactly. */
function declIn(selector, prop) {
    // Anchor on a line start so a longer selector ending in the same text
    // (e.g. `body.dark-mode .thing`) can't satisfy a check about `body`.
    const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const block = CSS.match(re)?.[2];
    if (!block) return null;
    const m = block.match(new RegExp(`(^|[;\\n])\\s*${prop}\\s*:\\s*([^;]+)`));
    return m ? m[2].trim() : null;
}

describe('the page paints its own background (the safe-area strips)', () => {
    it('body declares a background-color rather than inheriting UA white', () => {
        expect(declIn('body', 'background-color'),
            'without this the status-bar strip renders UA-default white').toBeTruthy();
    });

    it('dark mode overrides it', () => {
        expect(declIn('body.dark-mode', 'background-color')).toBeTruthy();
    });

    it('the dark background matches the dark theme-color exactly', () => {
        // The strip and the page under it are painted by two different
        // mechanisms; any mismatch shows as a visible seam on a real device.
        const css = declIn('body.dark-mode', 'background-color').toLowerCase();
        const js = readFileSync('js/map.js', 'utf8')
            .match(/THEME_COLOR_DARK\s*=\s*'([^']+)'/)[1].toLowerCase();
        expect(css).toBe(js);
    });

    it('the light background matches the light theme-color exactly', () => {
        const css = declIn('body', 'background-color').toLowerCase();
        const js = readFileSync('js/map.js', 'utf8')
            .match(/THEME_COLOR_LIGHT\s*=\s*'([^']+)'/)[1].toLowerCase();
        expect(css).toBe(js);
    });

    it('html declares none, so body background propagates to the canvas', () => {
        // If html ever gets its own background, propagation stops and the
        // safe-area strips go back to whatever html says.
        expect(declIn('html', 'background-color'),
            'setting this breaks background propagation to the viewport canvas').toBeNull();
    });
});

describe('theme-color follows the APP theme, not just the OS', () => {
    let map;

    beforeEach(async () => {
        vi.resetModules();
        document.head.innerHTML = `
            <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
            <meta name="theme-color" content="#1e1e1e" media="(prefers-color-scheme: dark)">`;
        document.body.className = '';
        try { localStorage.removeItem('darkMode'); } catch { /* blocked */ }
        map = await import('../js/map.js');
    });
    afterEach(() => { try { localStorage.removeItem('darkMode'); } catch { /* blocked */ } });

    const colors = () => [...document.querySelectorAll('meta[name="theme-color"]')]
        .map(m => m.getAttribute('content').toLowerCase());

    it('sets BOTH metas to the dark color when the app is dark', () => {
        // Both, deliberately: whichever media query the OS matches then yields
        // the same answer, so the OS preference stops overriding the rider's
        // own choice. Leaving one at the light value is the actual bug.
        map._applyThemeColorForTest(true);
        expect(new Set(colors()).size, 'the two metas must not disagree').toBe(1);
        expect(colors()[0]).toBe('#1e1e1e');
    });

    it('sets BOTH metas to the light color when the app is light', () => {
        map._applyThemeColorForTest(false);
        expect(new Set(colors()).size).toBe(1);
        expect(colors()[0]).toBe('#ffffff');
    });

    it('the reported case: OS light, app toggled dark, no white bar left behind', () => {
        map._applyThemeColorForTest(false);              // start matching a light OS
        expect(colors()).toContain('#ffffff');
        map._applyThemeColorForTest(true);               // rider turns on dark mode
        expect(colors(), 'a light meta surviving here IS the white status bar')
            .not.toContain('#ffffff');
    });

    it('is reversible — turning dark mode back off restores the light color', () => {
        map._applyThemeColorForTest(true);
        map._applyThemeColorForTest(false);
        expect(colors().every(c => c === '#ffffff')).toBe(true);
    });
});

describe('the static markup still gives a correct pre-JS default', () => {
    it('keeps both media-scoped metas for the common app-follows-OS case', () => {
        expect(HTML).toMatch(/theme-color"[^>]*media="\(prefers-color-scheme: light\)"/);
        expect(HTML).toMatch(/theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/);
    });

    it('still opts into the safe-area viewport the strips come from', () => {
        expect(HTML).toMatch(/viewport-fit=cover/);
    });
});

describe('the helper is actually WIRED IN (not merely correct)', () => {
    // A correct function says nothing about whether anything calls it: deleting
    // either call site below left every behavioural test above green. Asserted
    // against source text with the comments stripped, because the explanatory
    // comments here name the very calls being searched for — an indexOf over
    // the raw file matches the prose and passes a deletion.
    const RAW = readFileSync('js/map.js', 'utf8');
    const SRC = RAW
        .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')    // line comments (not `://`)
        // Drop the DECLARATION. Its parameter is also named `isDark`, so
        // `_applyThemeColor(isDark)` matched the function signature itself and
        // the toggle-wiring assertion passed with the call site deleted — the
        // test passing for the wrong reason, caught by mutation.
        .replace(/function\s+_applyThemeColor\s*\([^)]*\)/, '')
        .replace(/_applyThemeColorForTest\s*=\s*_applyThemeColor/, '');

    it('runs at init, so a returning dark-mode rider never sees a white bar', () => {
        expect(SRC).toMatch(/_applyThemeColor\(savedDark\)/);
    });

    it('runs on the dark-mode toggle, so the bar changes with the map', () => {
        expect(SRC).toMatch(/_applyThemeColor\(isDark\)/);
    });

    it('the comment-stripping is real (guards the assertions above)', () => {
        // If stripping ever silently no-ops, both assertions could pass on
        // prose alone — the exact failure mode that let two "pinned" script-tag
        // claims through earlier in this review.
        expect(SRC).not.toMatch(/Status-bar \/ browser-chrome colors/);
        expect(SRC.length).toBeLessThan(RAW.length);
        expect(SRC, 'the declaration must be stripped, or it satisfies the call assertions')
            .not.toMatch(/function\s+_applyThemeColor/);
    });
});

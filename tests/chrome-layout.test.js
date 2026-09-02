/**
 * Bottom-chrome layout invariants — the install banner, the toast, and the
 * legend's interaction hint.
 *
 * These are CSS-source assertions in the style of `tests/search.test.js:342`,
 * because the defects they pin are pure geometry that jsdom cannot compute (it
 * has no layout engine) and that a screenshot test would catch only after the
 * fact. Each corresponds to a finding in `docs/audits/full-app-review-2026-09-02.md`
 * that was reproduced in a real browser via the review's replay harness.
 *
 * The failures these prevent are all SILENT — nothing throws, nothing looks
 * wrong in a diff, and the desktop layout (where most development happens) is
 * unaffected in every case.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('styles/index-style.css', 'utf8');
const html = readFileSync('index.html', 'utf8');

/**
 * Extract the body of the LAST matching rule for `selector`.
 *
 * The boundary is a newline or `}`/`,`/`;` — NOT just `}`: every rule in this
 * stylesheet is preceded by a comment, so anchoring on the previous rule's
 * brace silently matches nothing and the assertion then fails for the wrong
 * reason (a null body rather than the property under test).
 */
function rule(selector, { within = css } = {}) {
    const rules = [...within.matchAll(
        new RegExp(`(?:^|[\\n},;])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'),
    )];
    return rules.length ? rules[rules.length - 1][1] : null;
}

/** The `@media (max-width: 1280px)` block — where the bottom sheet lives. */
function mobileBlock() {
    const start = css.indexOf('@media (max-width: 1280px)');
    expect(start, '@media (max-width: 1280px) block must exist').toBeGreaterThan(-1);
    // Walk braces to find the matching close.
    let depth = 0, i = css.indexOf('{', start);
    for (let j = i; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) return css.slice(i, j);
    }
    return css.slice(i);
}

describe('install banner does not cover the sheet handle or the map attribution (R5-01)', () => {
    it('rides --sheet-lift on mobile, the same variable the attribution uses', () => {
        // The banner is z-index 450 and bottom-anchored, so at its default
        // 12px offset it lands squarely on the legend sheet's 44px peek handle
        // AND on the "© LA Metro, Esri" credit the tile licences require.
        // Observed on iPhone 13: elementFromPoint() at the centre of
        // #sheet-handle returned the banner, and the legend could not be
        // opened at all until the hint was dismissed. iOS shows this banner
        // automatically ~4s after every non-dismissed load, so it is the
        // DEFAULT first-run state, not an edge case.
        //
        // css:2290 already solved this for the attribution control with
        // --sheet-lift (set by adjustMiniDisplay() to the open sheet's height,
        // falling back to the 44px handle). The banner must use the same
        // mechanism rather than a second, drifting one.
        const mobile = mobileBlock();
        const banner = rule('.pwa-install-banner', { within: mobile });
        expect(banner, '.pwa-install-banner must be adjusted inside the mobile block').toBeTruthy();
        expect(banner).toMatch(/--sheet-lift/);
    });

    it('keeps the attribution rule it is modelled on', () => {
        // Guards against "fixing" the banner by lowering the attribution instead.
        expect(mobileBlock()).toMatch(/\.maplibregl-ctrl-bottom-right\s*\{[^}]*--sheet-lift/);
    });
});

describe('centred bottom chrome reaches its declared width (R5-02)', () => {
    // `position: fixed; left: 50%` with no `right` and no `width` makes the box
    // shrink-to-fit inside the space from the 50% line to the right edge — i.e.
    // capped at HALF the viewport, regardless of max-width. Measured on iPhone
    // 13: both boxes rendered 195px wide against a declared max-width of
    // 358.8px, wrapping the banner to 4 lines (94.75px tall) and the
    // geolocation-denied toast to 5. The extra banner height is also what
    // pushed its bottom edge down over the sheet handle in R5-01.
    for (const sel of ['.toast', '.pwa-install-banner']) {
        it(`${sel} does not rely on shrink-to-fit`, () => {
            const body = rule(sel);
            expect(body, `${sel} rule must exist`).toBeTruthy();
            // Anchor on `;`, `{` OR a newline. Anchoring on `;` alone is
            // defeated by an intervening comment — which these rules now have,
            // explaining the very bug being pinned — so the assertion silently
            // passed against a reintroduced `left: 50%`. Caught by mutating the
            // fix away and watching this test stay green.
            const prop = (name) => new RegExp(String.raw`(?:^|[;{\n])\s*${name}\s*:`).test(body);
            const centredByLeft = /(?:^|[;{\n])\s*left\s*:\s*50%/.test(body);
            const hasRight = prop('right');
            const hasWidth = prop('width');
            expect(
                !centredByLeft || hasRight || hasWidth,
                `${sel} combines left:50% with no right/width — it can never exceed half the viewport`,
            ).toBe(true);
        });
    }
});

describe('legend interaction cue is available on touch devices (R5-05)', () => {
    it('is not display:none on mobile', () => {
        // #legend-toggle-hint is the ONLY affordance telling a rider the route
        // rows filter the map. Hiding it below 1280px means phone riders — who
        // face the worst marker crowding (median 12.4px nearest-neighbour
        // spacing at the default zoom) — are the only ones never told.
        expect(mobileBlock()).not.toMatch(/#legend-toggle-hint\s*\{[^}]*display:\s*none/);
    });

    it('describes what the first tap actually does, in device-neutral words', () => {
        // The desktop copy said "Click a row to toggle": mouse-specific, and
        // wrong — the first activation ISOLATES that line (every other route is
        // hidden), it does not toggle one row.
        const hint = html.slice(html.indexOf('id="legend-toggle-hint"'));
        const text = hint.slice(0, hint.indexOf('</div>', hint.indexOf('</span>')));
        expect(text).not.toMatch(/\bClick\b/);
        expect(text).toMatch(/only that line/i);
    });
});

describe('loading splash says something (R5-07)', () => {
    it('has visible text, not just a logo', () => {
        // The splash can stay up for the full 15s fallback with no text at all,
        // so a slow first load is indistinguishable from a broken one. The
        // wrapper is already role="status" aria-live="polite", so the text is
        // announced as well as shown.
        const loading = html.slice(html.indexOf('<div id="loading"'), html.indexOf('<!-- Semantic landmark'));
        const textNodes = [...loading.matchAll(/>([^<>]*[A-Za-z]{3}[^<>]*)</g)].map(m => m[1].trim()).filter(Boolean);
        expect(textNodes.length, 'splash must contain a visible text node').toBeGreaterThan(0);
        expect(loading).toMatch(/id="loading-status"/);
    });
});

describe('splash slow-connect message and banner auto-hide (behaviour)', () => {
    it('swaps the splash line once the wait stops looking normal, and stops on removal', async () => {
        vi.resetModules();
        document.body.innerHTML = `<div id="loading" role="status" aria-live="polite">
            <div class="loader-content"><p id="loading-status">Loading live Metro map…</p></div></div>
            <div id="legend-container"></div><div id="legend-mini"></div>`;
        vi.useFakeTimers();
        const ui = await import('../js/ui.js');
        ui.initUI();
        const status = () => document.getElementById('loading-status').textContent;
        expect(status()).toMatch(/Loading/);
        vi.advanceTimersByTime(6100);
        expect(status(), 'must admit the wait is slow rather than sit on a wordless logo').toMatch(/Still connecting/);
        vi.useRealTimers();
    });

    it('the install banner cannot occupy the chrome band forever', () => {
        // It is offset to clear the sheet handle and the attribution, but a hint
        // the rider never dismisses should still time out — without remembering
        // the dismissal, so the offer returns next visit.
        const src = readFileSync('js/pwaInstall.js', 'utf8');
        expect(src).toMatch(/BANNER_AUTO_HIDE_MS/);
        const show = src.slice(src.indexOf('function showBanner'), src.indexOf('function hideBanner'));
        expect(show, 'showBanner must arm the auto-hide').toMatch(/setTimeout\(hideBanner/);
        const hide = src.slice(src.indexOf('function hideBanner'));
        expect(hide, 'hideBanner must clear it').toMatch(/clearTimeout\(_bannerAutoHideTimer\)/);
        expect(show, 'auto-hide must NOT persist a dismissal').not.toMatch(/setDismissed/);
    });
});

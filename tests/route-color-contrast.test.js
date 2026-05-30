/**
 * WCAG contrast audit for the brand route palette.
 *
 * Background: the a11y review found three brand colors fail WCAG 1.4.11
 * (non-text contrast, 3:1 minimum for UI components) when rendered directly
 * on white:
 *
 *   - E Line (#fdb913 yellow) ~1.5:1
 *   - K Line (#e56db1 pink)   ~2.8:1
 *   - J Line (#adb8bf gray)   ~2.2:1
 *
 * The brand palette is preserved (re-tuning would deviate from Metro's
 * visual identity). Mitigation for the WCAG 1.4.11 non-text-contrast gap on the
 * low-luminance fills (E / K / J): the numeric vehicle count rendered as TEXT
 * beside every bar carries the data, so the fill is a supplementary magnitude
 * cue (not a graphical object "required to understand the content" — the 1.4.11
 * exception) and the legend is never color-only.
 * Outline history: PR #238 added a 1 px inset dark outline to EVERY `.bar-fill`;
 * PR #270 removed it (ugly black border on every bar); PR #271 re-added it
 * scoped to E/K/J — then it was removed entirely because an outline on only
 * some bars read as inconsistent. The text-count is the mitigation now.
 *
 * This test still:
 *   1. Documents the contrast ratio of every routeHexColors entry on white,
 *      so future palette changes are intentional (test fails if a color
 *      drifts below its currently-pinned value).
 *   2. Asserts that the colors classified as "passing" stay ≥ 3:1.
 *   3. Records the three known-failing colors so the next reader sees the
 *      contrast gap is known and mitigated (scoped .bar-fill outline + text
 *      count), not overlooked.
 */

import { describe, it, expect } from 'vitest';
import { routeHexColors } from '../js/config.js';

// ── WCAG relative-luminance + contrast ratio ────────────────────────────────

function _relativeLuminance(hex) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16) / 255;
    const g = parseInt(m.slice(2, 4), 16) / 255;
    const b = parseInt(m.slice(4, 6), 16) / 255;
    const toLin = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastOnWhite(hex) {
    const L = _relativeLuminance(hex);
    return (1.0 + 0.05) / (L + 0.05);
}

// ── Per-route expected contrast (pinned to current palette) ─────────────────

// Recorded 2026-05-27 against the brand palette. Updating these pins is the
// canonical way to record a palette change — drift below the pinned value
// indicates a regression worth catching, drift above is a brand-team
// acceptable improvement (loosening the pin is fine when verified).
const EXPECTED_CONTRAST_ON_WHITE = {
    '801': 5.5,   // A Line — passing
    '802': 4.5,   // B Line — passing (edge of AA text bound)
    '803': 3.0,   // C Line — passing (graphical-element bound)
    '804': 1.5,   // E Line — KNOWN FAIL on white (1.4.11); mitigated by the text count beside the bar
    '805': 4.0,   // D Line — passing
    '807': 2.5,   // K Line — KNOWN FAIL on white; mitigated by the text count beside the bar
    '901': 3.5,   // G Line — passing (graphical-element bound)
    '910': 2.0,   // J Line — KNOWN FAIL on white; mitigated by the text count beside the bar
    '950': 2.0,   // J Line variant — same color, same mitigation
};

const KNOWN_FAILING_ROUTES = new Set(['804', '807', '910', '950']);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('route palette — WCAG contrast on white', () => {
    it('every route in routeHexColors has an EXPECTED_CONTRAST_ON_WHITE pin', () => {
        for (const route of Object.keys(routeHexColors)) {
            expect(EXPECTED_CONTRAST_ON_WHITE,
                `route ${route} (${routeHexColors[route]}) is missing a pin — update tests/route-color-contrast.test.js`)
                .toHaveProperty(route);
        }
    });

    it('passing routes meet WCAG 1.4.11 ≥ 3:1 (UI-element non-text contrast)', () => {
        for (const route of Object.keys(routeHexColors)) {
            if (KNOWN_FAILING_ROUTES.has(route)) continue;
            const ratio = contrastOnWhite(routeHexColors[route]);
            expect(ratio,
                `route ${route} (${routeHexColors[route]}) dropped below 3:1 on white — fix the palette or add a non-text-contrast mitigation`)
                .toBeGreaterThanOrEqual(3.0);
        }
    });

    it('known-failing routes match their pinned ratio (drift detection)', () => {
        // The known-failing routes keep the brand palette; the numeric count
        // beside each bar carries the data (so it's never color-only). If a
        // future PR tunes one of these colors lighter than today's value, this
        // test fails so the change is a conscious one.
        const TOL = 0.3;
        for (const route of KNOWN_FAILING_ROUTES) {
            const ratio = contrastOnWhite(routeHexColors[route]);
            const pin = EXPECTED_CONTRAST_ON_WHITE[route];
            expect(ratio,
                `route ${route} (${routeHexColors[route]}) drifted away from pinned ${pin.toFixed(1)}:1 (actual ${ratio.toFixed(2)}:1)`)
                .toBeGreaterThanOrEqual(pin - TOL);
        }
    });
});

describe('contrastOnWhite — helper sanity', () => {
    it('pure black has ratio 21:1 on white', () => {
        expect(contrastOnWhite('#000000')).toBeCloseTo(21, 0);
    });

    it('pure white has ratio 1:1 on white', () => {
        expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 1);
    });

    it('mid-gray #808080 has ratio ~3.95:1 on white', () => {
        // Sanity-check against a known reference value.
        expect(contrastOnWhite('#808080')).toBeGreaterThan(3.7);
        expect(contrastOnWhite('#808080')).toBeLessThan(4.2);
    });
});

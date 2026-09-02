/**
 * The live-capture harness must not pollute its own findings.
 *
 * `scripts/review-live-snapshot.js` records `consoleErrors` and
 * `failedRequests` from the live site, and a reviewer reads those to judge
 * whether the deployed app is healthy. Anything the HARNESS itself causes to
 * appear there is worse than noise — it reads exactly like a site defect.
 *
 * That is not hypothetical. The first real capture reported, in all six
 * contexts, a `connect-src` CSP violation and a failed request for the Google
 * Fonts stylesheet. It looked like the live site had lost its typeface. It had
 * not: axe-core's CSSOM preload XHRs every cross-origin stylesheet so it can
 * analyse it, an XHR is governed by `connect-src`, and the app's CSP correctly
 * does not list fonts.googleapis.com there — the sheet loads under `style-src`
 * as a `<link>`, which is a different directive entirely. axe's fetch was
 * refused and the refusal was attributed to the page.
 *
 * Measured against the real axe build and the real CSP: with preload on, the
 * scan issues 1 blocked font request and logs both the CSP error and axe's
 * "Couldn't load preload assets" warning; with `preload: false` it issues none
 * and logs nothing — and finds the SAME violations either way, because the only
 * cross-origin sheet is Google Fonts, which carries @font-face rules and no
 * colour information.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('scripts/review-live-snapshot.js', 'utf8');

/** The harness source with comments stripped — the explanatory comment above
 *  the axe call names `preload: false`, so a raw match would pass on prose. */
const CODE = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the axe scan does not fetch cross-origin stylesheets', () => {
    it('passes preload: false to axe.run', () => {
        expect(CODE).toMatch(/axe\.run\([^)]*preload:\s*false/);
    });

    it('the comment stripping is real (guards the assertion above)', () => {
        // Without this, the paragraph explaining `preload: false` satisfies the
        // match on its own and deleting the option passes.
        expect(CODE).not.toMatch(/Couldn't load preload assets/);
        expect(CODE.length).toBeLessThan(SRC.length);
    });

    it('still requests violations only, so the scan stays cheap', () => {
        expect(CODE).toMatch(/resultTypes:\s*\[\s*'violations'\s*\]/);
    });
});

describe('the harness records the signals a reviewer reads', () => {
    // If these ever stop being captured, a capture looks clean because nothing
    // is watching — the failure mode this whole review keeps finding.
    it.each(['consoleErrors', 'failedRequests', 'pageErrors', 'badResponses'])(
        'captures %s', (key) => {
            expect(CODE).toContain(key);
        });

    it('listens passively rather than re-requesting anything itself', () => {
        // The harness must never issue its own requests to the site's origins:
        // that is exactly how the axe artifact above became indistinguishable
        // from a site defect.
        expect(CODE).toMatch(/page\.on\('requestfailed'/);
        expect(CODE, 'no harness-issued fetch of a site resource')
            .not.toMatch(/page\.request\.(get|fetch)\(/);
    });
});

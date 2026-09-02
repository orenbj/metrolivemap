/**
 * The CSP is load-bearing and nothing pinned it (R4-01, R10-04).
 *
 * Two silent-failure modes, both of which look identical to a working app in
 * every existing test and in ordinary use:
 *
 *  1. The inline frame-buster in index.html is allowed by a sha256 in
 *     `script-src`. Edit that script at all — harden it, add a comment, let a
 *     formatter reflow it — without recomputing the digest, and CSP blocks it.
 *     The page then looks and behaves exactly the same, while the app's ONLY
 *     clickjacking defense is gone. (`frame-ancestors` cannot help: the spec
 *     ignores it when delivered via <meta>, and GitHub Pages cannot set
 *     headers — see the comment at the top of index.html.)
 *  2. A host quietly dropped from a directive breaks the feature that needs it
 *     with no test failure. `lacmta.github.io` in `img-src` is the sharpest
 *     case: there is no `onerror` handler on any route-icon <img>, so losing it
 *     renders the browser's broken-image glyph in every station popup row,
 *     search result and alert tooltip.
 *
 * This file reads the shipped index.html rather than a fixture — the artifact
 * that actually deploys is the only thing worth asserting about.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HTML = readFileSync('index.html', 'utf8');

const CSP = HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];

/** Inline <script> bodies — those with no `src` attribute. */
const INLINE_SCRIPTS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);

const sha256 = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;

/** The value of one CSP directive, or null when absent. */
function directive(name) {
    const m = CSP.match(new RegExp(`(^|;)\\s*${name}\\s+([^;]+)`));
    return m ? m[2].trim() : null;
}

describe('the CSP meta is present and parseable', () => {
    it('ships a Content-Security-Policy meta', () => {
        expect(CSP, 'GitHub Pages cannot set headers — the meta IS the policy').toBeTruthy();
    });

    it('keeps the directives that have no default-src fallback', () => {
        // form-action and base-uri do NOT inherit from default-src.
        expect(directive('default-src')).toBe("'none'");
        expect(directive('form-action')).toBe("'none'");
        expect(directive('base-uri')).toBe("'self'");
        expect(directive('object-src')).toBe("'none'");
    });
});

describe('every inline script is allowed by a matching hash (R4-01)', () => {
    it('there is exactly one inline script — the frame-buster', () => {
        // If a second one appears, it needs its own hash, and this test should
        // fail loudly rather than silently covering only the first.
        expect(INLINE_SCRIPTS).toHaveLength(1);
        expect(INLINE_SCRIPTS[0]).toMatch(/window\.self !== window\.top/);
    });

    it('its sha256 appears in script-src', () => {
        // Recompute from the file as it ships. A stale hash here means the
        // frame-buster is blocked at runtime and nothing else changes.
        const src = directive('script-src');
        for (const body of INLINE_SCRIPTS) {
            expect(src, `no hash in script-src matches this inline script.
Recompute it and update index.html:

    ${sha256(body)}
`).toContain(sha256(body));
        }
    });

    it('script-src does not fall back to unsafe-inline', () => {
        // 'unsafe-inline' would make the hash decorative and re-open the hole
        // the hash exists to close.
        expect(directive('script-src')).not.toContain("'unsafe-inline'");
    });

    it('the frame-buster still actually busts frames', () => {
        // A hash pinned to a script that no longer does anything is worse than
        // no test: it reports the defense as intact.
        const body = INLINE_SCRIPTS[0];
        expect(body).toMatch(/window\.top\.location\s*=/);
        expect(body, 'the hide fallback is what covers a silently-refused navigation')
            .toMatch(/display\s*=\s*'none'|display\s*=\s*"none"/);
    });
});

describe('every runtime host is allowed by the directive it needs', () => {
    // Explicit host -> directive table rather than a scrape of js/. Several
    // hosts in the source are ordinary link targets (apps.apple.com,
    // play.google.com, www.metro.net) which need no directive at all, and one
    // is deliberately in img-src ONLY. A scrape would either demand entries
    // those links do not need, or quietly accept the wrong directive.
    const CASES = [
        ['connect-src', 'wss://api.metro.net',  'the two live GTFS-RT WebSocket feeds'],
        ['connect-src', 'gbfs.bcycle.com',      'Metro Bike Share station info + status'],
        ['connect-src', 'basemaps.cartocdn.com', 'the CARTO basemap style.json is FETCHED, not just imaged'],
        ['connect-src', 'tiles.arcgis.com',     'ESRI source metadata'],
        ['img-src',     'basemaps.cartocdn.com', 'CARTO raster/vector tiles'],
        ['img-src',     'tiles.arcgis.com',     'the ESRI rail overlay tiles'],
        ['img-src',     'lacmta.github.io',     'route icon SVGs — no onerror fallback exists (R10-04)'],
        ['font-src',    'fonts.gstatic.com',    'Google Fonts files'],
        ['style-src',   'fonts.googleapis.com', 'the Google Fonts stylesheet'],
        ['worker-src',  'blob:',                'sw.js registration (installability)'],
        ['manifest-src', "'self'",              'manifest.json — does not fall back to default-src'],
    ];

    for (const [dir, host, why] of CASES) {
        it(`${dir} allows ${host} (${why})`, () => {
            expect(directive(dir), `${dir} is missing entirely`).toBeTruthy();
            expect(directive(dir)).toContain(host);
        });
    }

    it('the alerts Lambda origins are both allowed to connect', () => {
        const connect = directive('connect-src');
        const lambdas = [...HTML.matchAll(/https:\/\/[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws/g)]
            .map(m => m[0]);
        expect(lambdas.length, 'both alert feeds must appear in the policy').toBe(2);
        for (const l of lambdas) expect(connect).toContain(l);
    });

    it('lacmta.github.io is NOT in connect-src', () => {
        // Deliberate, and documented in index.html: nothing fetches or XHRs
        // that origin, so keeping it out removes an exfiltration surface. A
        // future edit that "tidies" it into connect-src should have to argue
        // for it.
        expect(directive('connect-src')).not.toContain('lacmta.github.io');
    });

    it('the removed analytics hosts have not crept back in', () => {
        // GTM/GA4 were removed for a GDPR consent gap; re-adding them requires
        // a consent flow, not just a CSP entry.
        expect(CSP).not.toContain('googletagmanager.com');
        expect(CSP).not.toContain('google-analytics.com');
    });
});

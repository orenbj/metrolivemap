/**
 * Fix age must be sampled on a fix's FIRST delivery only.
 *
 * `scripts/audit-feeds.js` is the source of truth for "what does Metro's feed
 * actually do", and docs/STATUS.md quotes its fix-age figure to argue about the
 * motion model underground. Until 2026-09 it sampled age on EVERY message.
 *
 * Metro re-broadcasts an unchanged fix many times, and each repeat is older than
 * the last, so an unfiltered sample answers "how long does Metro keep repeating
 * a fix" rather than "how stale is a fix when it arrives". On a live AM-peak
 * capture the same frames gave B/D p90 of 348/268 s unfiltered versus 8/42 s on
 * first delivery — an order of magnitude, and inflated worst exactly where
 * re-broadcast is heaviest (underground), which is what made the tunnel look
 * uniquely latent when it is not.
 *
 * The subtle part is ORDERING: `isNewFix` compares against `prev.lastTs`, which
 * the very next lines overwrite with the current ts. Computing it one line later
 * makes it permanently false-y in the way that matters and silently restores the
 * old behaviour.
 *
 * These are SOURCE assertions, which are weaker than behavioural ones. The
 * script opens its WebSocket connections at module load, so importing it in a
 * test starts real network connections — the per-message ingest would have to be
 * extracted into a pure function to be driven directly, which is a larger change
 * than this fix warranted. Flagged rather than hidden.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const RAW = readFileSync('scripts/audit-feeds.js', 'utf8');
// The header explains the bug at length and names every identifier below, so a
// raw match would pass on prose alone.
const SRC = RAW
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('fix age is sampled once per distinct fix', () => {
    it('gates the age sample on isNewFix', () => {
        expect(SRC).toMatch(/if\s*\(tsValid && isNewFix\)/);
    });

    it('computes isNewFix BEFORE prev.lastTs is overwritten', () => {
        // The whole correctness of the flag is this ordering.
        const decl = SRC.indexOf('const isNewFix');
        const overwrite = SRC.indexOf('prev.lastTs = ts');
        expect(decl, 'isNewFix must be declared').toBeGreaterThan(-1);
        expect(overwrite, 'the overwrite must still exist').toBeGreaterThan(-1);
        expect(decl, 'reading lastTs after the overwrite always compares ts to itself')
            .toBeLessThan(overwrite);
    });

    it('compares against the previous timestamp rather than assuming novelty', () => {
        expect(SRC).toMatch(/const isNewFix = !prev \|\| ts !== prev\.lastTs/);
    });

    it('counts re-broadcasts instead of discarding them silently', () => {
        // The ratio is the signal that would expose this regressing again, so
        // it is reported rather than dropped.
        expect(SRC).toMatch(/rebroadcastFrames\+\+/);
        expect(SRC).toMatch(/rebroadcastFrames:\s*0/);          // initialised per route
        expect(SRC).toMatch(/rebroadcastFrames:\s*r\.rebroadcastFrames/); // in the JSON out
    });

    it('reports how many samples the percentiles rest on', () => {
        // p90 over 3 samples and p90 over 3000 are not the same claim.
        expect(SRC).toMatch(/ageSamples:\s*ages\.length/);
    });

    it('the comment stripping is real (guards the assertions above)', () => {
        expect(SRC).not.toMatch(/how long Metro keeps REPEATING/);
        expect(SRC.length).toBeLessThan(RAW.length);
    });
});

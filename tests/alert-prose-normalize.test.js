/**
 * Stage-1 normalizers for alert-tooltip prose. See the audit at
 * docs/alert-copy-audit-2026-05.md for the corpus these tests pin against.
 *
 * Each case below is grounded in a real verbatim sample from the
 * 2026-05-16 LACMTA feed pull. The "before" strings are reproduced exactly
 * as published (capitalization, punctuation, whitespace); the "after"
 * strings reflect the canonical normalized form.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAlertProse, buildAlertTooltipText } from '../js/alerts.js';

const a = (header, description) => ({ header, description });

describe('normalizeAlertProse — Stage 1', () => {
    describe('title-case ALL-CAPS headers', () => {
        it('lowercases shouting station names but capitalizes each word', () => {
            const out = normalizeAlertProse(a('PERSHING SQUARE STATION', ''));
            expect(out.header).toBe('Pershing Square Station');
        });

        it('preserves single-letter Metro line codes', () => {
            expect(normalizeAlertProse(a('E LINE', '')).header).toBe('E Line');
            expect(normalizeAlertProse(a('K LINE', '')).header).toBe('K Line');
            expect(normalizeAlertProse(a('B/D LINES', '')).header).toBe('B/D Lines');
        });

        it('keeps allowlisted acronyms uppercase', () => {
            expect(normalizeAlertProse(a('LAX ADA RAMP', '')).header)
                .toBe('LAX ADA Ramp');
            expect(normalizeAlertProse(a('USC STATION', '')).header)
                .toBe('USC Station');
            expect(normalizeAlertProse(a('DTLA DETOUR', '')).header)
                .toBe('DTLA Detour');
        });

        it('handles ordinal-ish digit+letter tokens', () => {
            // "37TH ST/USC STATION" appears in real accessibility alerts.
            expect(normalizeAlertProse(a('37TH ST/USC STATION', '')).header)
                .toBe('37th St/USC Station');
        });

        it('leaves mixed-case headers unchanged', () => {
            expect(normalizeAlertProse(a('G Line', '')).header).toBe('G Line');
            expect(normalizeAlertProse(a('Wilshire/Fairfax Station', '')).header)
                .toBe('Wilshire/Fairfax Station');
        });

        it('skips short or empty headers safely', () => {
            expect(normalizeAlertProse(a('', '')).header).toBe('');
            expect(normalizeAlertProse(a('X', '')).header).toBe('X');
            // length<4 guard keeps very short tokens untouched
            expect(normalizeAlertProse(a('ETA', '')).header).toBe('ETA');
        });

        it('handles the "LINE 92 DETOUR" / "LINE 28" patterns', () => {
            expect(normalizeAlertProse(a('LINE 92 DETOUR', '')).header)
                .toBe('Line 92 Detour');
            expect(normalizeAlertProse(a('LINE 28', '')).header)
                .toBe('Line 28');
        });
    });

    describe('whitespace normalization', () => {
        it('trims leading and trailing whitespace from headers', () => {
            expect(normalizeAlertProse(a(' G Line', '')).header).toBe('G Line');
            expect(normalizeAlertProse(a('LINE 28 ', '')).header).toBe('Line 28');
            expect(normalizeAlertProse(a('  LINE 92 DETOUR  ', '')).header)
                .toBe('Line 92 Detour');
        });

        it('collapses internal double-spaces', () => {
            expect(normalizeAlertProse(a('LINE  92  DETOUR', '')).header)
                .toBe('Line 92 Detour');
        });

        it('preserves paragraph breaks in body but collapses tabs/spaces', () => {
            const body = 'Buses are detouring.\n\nToward Sylmar, stops will not be served.';
            expect(normalizeAlertProse(a('LINE 92 DETOUR', body)).body)
                .toBe('Buses are detouring.\n\nToward Sylmar, stops will not be served.');
        });

        it('collapses 3+ consecutive newlines down to a single paragraph break', () => {
            const body = 'First.\n\n\n\nSecond.';
            expect(normalizeAlertProse(a('X', body)).body).toBe('First.\n\nSecond.');
        });
    });

    describe('am/pm canonicalization', () => {
        it.each([
            ['9pm',      '9 pm'],
            ['9 pm',     '9 pm'],
            ['9 p.m.',   '9 pm'],
            ['9:00 PM',  '9:00 pm'],
            ['9:30PM',   '9:30 pm'],
            ['8am',      '8 am'],
            ['8 a.m.',   '8 am'],
            ['12:00 AM', '12:00 am'],
        ])('normalizes "%s" → "%s"', (input, expected) => {
            const out = normalizeAlertProse(a('X', `Open from ${input} daily`));
            expect(out.body).toBe(`Open from ${expected} daily`);
        });

        it('canonicalizes a real "From Open to 9pm" Metro string', () => {
            // From the C/K Lines headway alert in the audit (corpus 2026-05-16).
            const body = 'From Open to 9pm, C and K Line trains will run every 13 minutes.';
            const out = normalizeAlertProse(a('C/K LINES', body));
            expect(out.body).toBe(
                'From Open to 9 pm, C and K Line trains will run every 13 minutes.'
            );
        });

        it('handles mixed formats within a single body', () => {
            const body = 'Closure from 8 p.m. Monday to 6am Friday.';
            const out = normalizeAlertProse(a('X', body));
            expect(out.body).toBe('Closure from 8 pm Monday to 6 am Friday.');
        });
    });

    describe('drop body lede that repeats the header', () => {
        it('strips a body that exactly repeats the header (case-insensitive)', () => {
            const out = normalizeAlertProse(a('PERSHING SQUARE STATION', 'Pershing Square Station'));
            expect(out.header).toBe('Pershing Square Station');
            expect(out.body).toBe('');
        });

        it('strips a body prefix that repeats the (normalized) header', () => {
            const out = normalizeAlertProse(a(
                'WILSHIRE/FAIRFAX STATION',
                'Wilshire/Fairfax Station: Elevators are currently out of service.'
            ));
            expect(out.header).toBe('Wilshire/Fairfax Station');
            expect(out.body).toBe('Elevators are currently out of service.');
        });

        it('leaves body intact when it does NOT start with the header', () => {
            const out = normalizeAlertProse(a(
                'LINE 92 DETOUR',
                'Buses are detouring from Main St to Cesar E Chavez Ave.'
            ));
            expect(out.body).toBe('Buses are detouring from Main St to Cesar E Chavez Ave.');
        });
    });

    describe('null/undefined safety', () => {
        it('returns empty strings for null alert', () => {
            expect(normalizeAlertProse(null)).toEqual({ header: '', body: '' });
        });
        it('returns empty strings for undefined fields', () => {
            expect(normalizeAlertProse({})).toEqual({ header: '', body: '' });
            expect(normalizeAlertProse({ header: undefined })).toEqual({ header: '', body: '' });
        });
    });

    describe('integration: buildAlertTooltipText uses normalized strings', () => {
        it('puts cleaned header into the prefixed title line', () => {
            const out = buildAlertTooltipText('Elevator', a(
                'WILSHIRE/FAIRFAX STATION',
                'Wilshire/Fairfax Station: Elevators are currently out of service.'
            ));
            expect(out).toBe('Elevator: Wilshire/Fairfax Station\n\nElevators are currently out of service.');
        });

        it('omits body line when normalizer fully dropped it', () => {
            const out = buildAlertTooltipText('Issue', a('PERSHING SQUARE STATION', 'PERSHING SQUARE STATION'));
            expect(out).toBe('Issue: Pershing Square Station');
        });

        it('canonicalizes am/pm inside an end-to-end real-corpus string', () => {
            // "B LINE" with the bus-bridge body from the audit, abbreviated.
            const out = buildAlertTooltipText('Service issue', a(
                'B LINE',
                'From Friday, May 15 at 9 pm through Monday, May 18 at 4 am, bus shuttles will replace train service.'
            ));
            expect(out).toBe(
                'Service issue: B Line\n\n'
                + 'From Friday, May 15 at 9 pm through Monday, May 18 at 4 am, '
                + 'bus shuttles will replace train service.'
            );
        });
    });
});

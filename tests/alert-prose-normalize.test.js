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
            // Content chosen to avoid Stage-2 skipped-stops promotion (no
            // "will not be served") so this stays a pure whitespace test.
            const body = 'Trains every 16 minutes.\n\nShared track at three stations.';
            expect(normalizeAlertProse(a('LINE 92 DETOUR', body)).body)
                .toBe('Trains every 16 minutes.\n\nShared track at three stations.');
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

    describe('strip "due to <reason>" trailing boilerplate', () => {
        it('drops "due to construction." from the last paragraph', () => {
            const body = 'Buses are detouring from Main St to Cesar E Chavez Ave until 6 pm Saturday, May 16 due to construction.';
            const out = normalizeAlertProse(a('LINE 92 DETOUR', body));
            expect(out.body).toBe(
                'Buses are detouring from Main St to Cesar E Chavez Ave until 6 pm Saturday, May 16.'
            );
        });

        it('drops "due to maintenance." across the common variants', () => {
            const cases = [
                'due to construction',
                'due to maintenance',
                'due to an event',
                'due to an emergency',
                'due to an incident',
                'due to a technical problem',
                'due to a mechanical issue',
                'due to police activity',
            ];
            for (const tail of cases) {
                const out = normalizeAlertProse(a('X', `Trains delayed ${tail}.`));
                expect(out.body, `tail "${tail}"`).toBe('Trains delayed.');
            }
        });

        it('strips boilerplate from paragraph 1 when paragraph 2 is the lede', () => {
            const body = (
                'Buses are detouring from Main St to Grand Ave until 6 pm due to construction.\n\n'
                + 'Toward Sylmar Metrolink, stops Temple / Spring and Temple / Hill will not be served.'
            );
            const out = normalizeAlertProse(a('LINE 92 DETOUR', body));
            // After Stage 2 the skipped-stops paragraph leads, and the
            // demoted geography paragraph no longer carries "due to construction".
            expect(out.body).toBe(
                'Toward Sylmar Metrolink, stops Temple / Spring and Temple / Hill will not be served.\n\n'
                + 'Buses are detouring from Main St to Grand Ave until 6 pm.'
            );
        });

        it('leaves an in-prose "due to" mid-paragraph alone', () => {
            const body = 'Delays due to single-tracking are expected through Friday.';
            const out = normalizeAlertProse(a('X', body));
            expect(out.body).toBe('Delays due to single-tracking are expected through Friday.');
        });
    });

    describe('promote skipped-stops paragraph', () => {
        it('reorders so "will not be served" leads', () => {
            const body = (
                'Buses are detouring from Main St to Grand Ave.\n\n'
                + 'Toward Sylmar, stops Temple / Spring will not be served.'
            );
            const out = normalizeAlertProse(a('LINE 92 DETOUR', body));
            expect(out.body.split('\n\n')[0]).toMatch(/will not be served/);
        });

        it('preserves order within each group when multiple paragraphs skip', () => {
            const body = (
                'Buses are detouring.\n\n'
                + 'Toward A, stops 1 will not be served.\n\n'
                + 'Toward B, stops 2 will not be served.'
            );
            const out = normalizeAlertProse(a('X', body));
            const paras = out.body.split('\n\n');
            expect(paras[0]).toContain('Toward A');
            expect(paras[1]).toContain('Toward B');
            expect(paras[2]).toContain('detouring');
        });

        it('leaves single-paragraph bodies alone', () => {
            const body = 'Toward Sylmar, stops Temple will not be served.';
            const out = normalizeAlertProse(a('X', body));
            expect(out.body).toBe(body);
        });

        it('no-op when no paragraph matches the skipped-stops pattern', () => {
            const body = 'Trains every 16 minutes.\n\nShared track at three stations.';
            const out = normalizeAlertProse(a('X', body));
            expect(out.body).toBe('Trains every 16 minutes.\n\nShared track at three stations.');
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

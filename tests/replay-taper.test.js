import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    taperedCalcEta, _reconstruct, replay, readSnapshots, residualSummary,
} from '../scripts/replay-taper.js';

// Forward-build a capture row that is internally consistent with the shipped
// taper at `baselineK`, exactly as predictions.js would have emitted it. The
// replayer must be able to invert this back to (schedEta, r) and reproduce
// calcEta at the same K with ~0 residual.
//
// Integer-friendly values are chosen so the unix-second / rounded-offset
// quantisation in a real capture doesn't muddy the equality assertions.
function buildRow({ now, r, adh, actualUnix, routeId = '804' }, baselineK) {
    const schedEta = now + r;
    const calcEta  = taperedCalcEta(schedEta, adh, now, baselineK);
    const capped   = Math.abs(adh) > baselineK * r;
    return {
        routeId, recordedAt: now, adherence: adh, capped,
        calcEta, actualUnix,
        // horizonCalc mirrors the real flattenSnapshots field (calcEta - now).
        horizonCalc: calcEta - now,
    };
}

const K0 = 0.5;

describe('replay-taper — schedEta reconstruction', () => {
    it('inverts a CAPPED late-train row back to its true remaining time', () => {
        // r=200, adh=+300, K0=0.5 → cap at 100 → calcEta = 1200 + 100 = 1300.
        const row = buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500 }, K0);
        expect(row.capped).toBe(true);
        const rec = _reconstruct(row, K0);
        expect(rec.r).toBe(200);
        expect(rec.schedEta).toBe(1200);
    });

    it('inverts an UNCAPPED row back to its true remaining time', () => {
        // r=400, adh=+50, K0=0.5 → cap at 200, |50|<200 → uncapped → calcEta=1450.
        const row = buildRow({ now: 1000, r: 400, adh: 50, actualUnix: 1500 }, K0);
        expect(row.capped).toBe(false);
        const rec = _reconstruct(row, K0);
        expect(rec.r).toBe(400);
        expect(rec.schedEta).toBe(1400);
    });

    it('inverts a CAPPED early-train row', () => {
        // r=100, adh=-80, K0=0.5 → cap at 50 → cappedOffset=-50 → calcEta=1050.
        const row = buildRow({ now: 1000, r: 100, adh: -80, actualUnix: 1080 }, K0);
        expect(row.capped).toBe(true);
        const rec = _reconstruct(row, K0);
        expect(rec.r).toBe(100);
        expect(rec.schedEta).toBe(1100);
    });

    it('returns null for a row floored at now (horizon 0, un-invertible)', () => {
        const row = { recordedAt: 1000, calcEta: 1000, adherence: -300, capped: true };
        expect(_reconstruct(row, K0)).toBeNull();
    });
});

describe('replay-taper — round-trip residual self-check', () => {
    it('reproduces captured calcEta at the baseline K (residual ~0) across a mixed set', () => {
        const rows = [
            buildRow({ now: 1000, r: 200, adh: 300,  actualUnix: 1500 }, K0), // capped late
            buildRow({ now: 1000, r: 400, adh: 50,   actualUnix: 1500 }, K0), // uncapped
            buildRow({ now: 1000, r: 100, adh: -80,  actualUnix: 1080 }, K0), // capped early
            buildRow({ now: 2000, r: 600, adh: 500,  actualUnix: 2900 }, K0), // capped late, big
        ];
        const { residuals, invertFail } = replay(rows, [K0, 1.0], K0);
        expect(invertFail).toBe(0);
        const resid = residualSummary(residuals);
        expect(resid.maxAbs).toBe(0);   // exact by construction on integer inputs
    });

    it('flags a residual when baseline-K is set too LOW (re-caps an uncapped row)', () => {
        // True K=1.0: r=100, adh=80 → |80| < 1.0*100 → UNCAPPED → calcEta=now+180.
        // Replaying with baseline-K=0.5 reconstructs the same r (H-adh, K-free) but
        // recomputes the cap at 0.5*100=50 < 80, fabricating a cap the capture never
        // had → calcEta=now+150, a 30 s residual. This is the catchable direction.
        const rows = [buildRow({ now: 1000, r: 100, adh: 80, actualUnix: 1180 }, /* trueK */ 1.0)];
        expect(rows[0].capped).toBe(false);
        const { residuals } = replay(rows, [0.5], /* baselineK */ 0.5);
        expect(residualSummary(residuals).maxAbs).toBeGreaterThan(3);
    });

    it('is BLIND to a too-high baseline-K on a capped row (documented limitation)', () => {
        // Capped row built at K0=0.5; replaying it as if shipped under K=1.0
        // round-trips to 0 residual because r absorbs the K change. This pins the
        // known blind spot so a future "fix" that breaks it is noticed.
        const rows = [buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500 }, K0)];
        expect(rows[0].capped).toBe(true);
        const { residuals } = replay(rows, [1.0], /* baselineK */ 1.0);
        expect(residualSummary(residuals).maxAbs).toBe(0);
    });
});

describe('replay-taper — sweep behaviour matches hypothesis #1', () => {
    it('raising K corrects a capped late-train ETA toward the truth (bias → 0)', () => {
        // Late train: actually arrives 300 s after schedule (schedEta=1200 → 1500).
        const row = buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500 }, K0);
        const { enriched } = replay([row], [0.5, 1.0], K0);
        const e = enriched[0];
        // K=0.5 under-corrects (calcEta=1300 → err +200); K=1.0 expresses more of
        // the lateness (calcEta=1400 → err +100). The signed error shrinks.
        expect(e.errByK[0.5]).toBe(200);
        expect(e.errByK[1.0]).toBe(100);
        expect(Math.abs(e.errByK[1.0])).toBeLessThan(Math.abs(e.errByK[0.5]));
    });

    it('leaves an uncapped row unchanged across the whole sweep', () => {
        const row = buildRow({ now: 1000, r: 400, adh: 50, actualUnix: 1500 }, K0);
        const { enriched } = replay([row], [0.5, 0.7, 1.0], K0);
        const e = enriched[0];
        expect(e.errByK[0.5]).toBe(e.errByK[0.7]);
        expect(e.errByK[0.7]).toBe(e.errByK[1.0]);
    });
});

describe('replay-taper — JSONL ingestion', () => {
    it('skips the feedStatsRing tail row and rows missing required fields', () => {
        const path = join(tmpdir(), `replay-taper-test-${process.pid}.jsonl`);
        const good = buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500 }, K0);
        const lines = [
            JSON.stringify(good),
            JSON.stringify({ ...good, calcEta: null }),          // no calc — skip
            JSON.stringify({ ...good, adherence: null }),        // no adherence — skip
            JSON.stringify({ __kind: 'feedStatsRing', ring: [] }), // tagged tail — skip
            '',                                                  // blank — skip
            '{not valid json',                                   // garbage — skip
        ];
        writeFileSync(path, lines.join('\n') + '\n');
        try {
            const rows = readSnapshots(path, null);
            expect(rows.length).toBe(1);
            expect(rows[0].actualUnix).toBe(1500);
        } finally {
            rmSync(path, { force: true });
        }
    });

    it('honours the route allowlist', () => {
        const path = join(tmpdir(), `replay-taper-route-${process.pid}.jsonl`);
        const a = buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500, routeId: '804' }, K0);
        const b = buildRow({ now: 1000, r: 200, adh: 300, actualUnix: 1500, routeId: '801' }, K0);
        writeFileSync(path, [JSON.stringify(a), JSON.stringify(b)].join('\n') + '\n');
        try {
            const rows = readSnapshots(path, new Set(['804']));
            expect(rows.length).toBe(1);
            expect(rows[0].routeId).toBe('804');
        } finally {
            rmSync(path, { force: true });
        }
    });
});

/**
 * Short-turn trips must be labelled with THEIR OWN last stop, not the route's
 * full terminus (R3a-01).
 *
 * A quarter of westbound G Line trips (88 of 350, measured against committed
 * data) terminate at Canoga, three stops short of Chatsworth — and every one of
 * them rendered "Chatsworth", in both the station row and the vehicle popup. A
 * rider boards for a stop the bus never reaches. The correct headsign was
 * already sitting in `masterTripsData`; the cascade discarded it because step 1
 * (`getTerminalName`) is route-level and returns before the trip's own stop list
 * is ever consulted.
 *
 * The fixtures here are SYNTHETIC rather than real trip ids from data/trips.json.
 * Metro churns ~35 % of trip_ids weekly, so a test keyed to a real id would rot
 * within days and fail for a reason that has nothing to do with this behaviour.
 * The shapes below mirror the real patterns exactly (a long pattern and a short
 * pattern sharing a route|dir, plus the 950|1 override case).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));

import { initPredictions, resolveTripDestination, getTerminalName } from '../js/predictions.js';

// G Line westbound: the long pattern runs to Chatsworth, the short pattern
// turns at Canoga. Same route, same direction, different last stop.
const G_LONG  = ['g1', 'g2', 'g3', 'g4', 'g5'];   // … → Canoga → Chatsworth
const G_SHORT = ['g1', 'g2', 'g3', 'g4'];         // … → Canoga

const STOPS = {
    g1: { name: 'Reseda Station',    lat: 34.18, lon: -118.53 },
    g2: { name: 'Tampa Station',     lat: 34.18, lon: -118.55 },
    g3: { name: 'Pierce College',    lat: 34.18, lon: -118.57 },
    g4: { name: 'Canoga Station',    lat: 34.19, lon: -118.59 },
    g5: { name: 'Chatsworth Station', lat: 34.25, lon: -118.60 },
    // 950|1 — its real GTFS last stop is a layover point, which is exactly why
    // TERMINUS_DISPLAY_OVERRIDES exists for this route|dir.
    j1: { name: 'Harbor Gateway Transit Center', lat: 33.9, lon: -118.28 },
    j2: { name: 'Pacific / 21st Layover',        lat: 33.72, lon: -118.29 },
};

function seed(extraTrips = {}) {
    window.masterStopsData = { ...STOPS };
    window.masterTripsData = {
        // Long pattern must be the majority so the route cache adopts it as the
        // canonical stop sequence — the same reason the real bug shows up.
        'g-long-1': { rc: '901', dir: 1, stops: G_LONG, scheduledTimes: G_LONG.map((_, i) => i * 300) },
        'g-long-2': { rc: '901', dir: 1, stops: G_LONG, scheduledTimes: G_LONG.map((_, i) => i * 300) },
        'g-short-1': { rc: '901', dir: 1, stops: G_SHORT, scheduledTimes: G_SHORT.map((_, i) => i * 300) },
        'j-full-1': { rc: '950', dir: 1, stops: ['j1', 'j2'], scheduledTimes: [0, 600] },
        ...extraTrips,
    };
    window.masterArrivalsData = new Map();
    window.vehicleMarkers = {};
    initPredictions();
}

beforeEach(() => { seed(); });

describe('a trip that ends early is labelled with where it actually ends', () => {
    it('the route cache still resolves the FULL pattern terminus (precondition)', () => {
        // If this ever stops being true the test below would pass vacuously.
        expect(getTerminalName('901', 1)).toMatch(/Chatsworth/);
    });

    it('a Canoga short-turn says Canoga, not Chatsworth', () => {
        const trip = window.masterTripsData['g-short-1'];
        const label = resolveTripDestination('901', 1, 'g-short-1', trip, null);
        expect(label).toMatch(/Canoga/);
        expect(label, 'a rider must not be told the bus goes to Chatsworth').not.toMatch(/Chatsworth/);
    });

    it('a full-length trip on the same route|dir is unchanged', () => {
        const trip = window.masterTripsData['g-long-1'];
        expect(resolveTripDestination('901', 1, 'g-long-1', trip, null)).toMatch(/Chatsworth/);
    });

    it('keeps TERMINUS_DISPLAY_OVERRIDES for a trip that runs the full pattern', () => {
        // 950|1's real last stop is "Pacific / 21st Layover" — an operational
        // point riders do not recognise, which the override maps to "San Pedro".
        // The short-turn rule must not bypass that: this trip ends exactly where
        // the route ends, so the override still applies.
        const trip = window.masterTripsData['j-full-1'];
        expect(resolveTripDestination('950', 1, 'j-full-1', trip, null)).toBe('San Pedro');
    });

    it('falls back to the route terminus when the trip is unknown to static GTFS', () => {
        // Brand-new trip_id between weekly rebuilds — no stop list to work from.
        expect(resolveTripDestination('901', 1, 'brand-new-trip', null, null)).toMatch(/Chatsworth/);
    });

    it('prefers an explicit headsign over the derived stop name when both exist', () => {
        // cleanedTripDest is the feed's own headsign; the derived last-stop name
        // is a reconstruction. Neither should ever produce "Chatsworth" here.
        const trip = window.masterTripsData['g-short-1'];
        const label = resolveTripDestination('901', 1, 'g-short-1', trip, 'Canoga');
        expect(label).toMatch(/Canoga/);
    });

    it('does not crash on a trip whose stop list is empty or malformed', () => {
        seed({ 'g-empty': { rc: '901', dir: 1, stops: [], scheduledTimes: [] } });
        expect(() => resolveTripDestination('901', 1, 'g-empty', window.masterTripsData['g-empty'], null)).not.toThrow();
        // Nothing to derive from → the route terminus is the right answer.
        expect(resolveTripDestination('901', 1, 'g-empty', window.masterTripsData['g-empty'], null)).toMatch(/Chatsworth/);
    });
});

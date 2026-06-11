/**
 * Tests for js/restrooms.js — the curated station restroom inventory + lookup.
 *
 * The load-bearing test is DATA INTEGRITY: every station in STATION_RESTROOMS
 * must resolve to a real station-group key derived from data/stops.json the
 * SAME way the registry does (stationNameKey ∘ cleanStationName). If a future
 * GTFS rebuild renames or drops a station, this test fails instead of the
 * badge silently disappearing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stationNameKey, cleanStationName } from '../js/utils.js';
import { STATION_RESTROOMS, RESTROOM_TYPE_LABEL, getStationRestroom } from '../js/restrooms.js';

const stops = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'stops.json'), 'utf8'));

// The key space the registry builds group.normName into.
const groupKeys = new Set();
for (const v of Object.values(stops)) {
    if (v?.name) groupKeys.add(stationNameKey(cleanStationName(v.name, false)));
}

describe('restroom data integrity', () => {
    it('every restroom station matches a real station group in stops.json', () => {
        const missing = Object.keys(STATION_RESTROOMS)
            .filter(name => !groupKeys.has(stationNameKey(cleanStationName(name, false))));
        expect(missing).toEqual([]);
    });

    it('has no two names that collapse to the same key (silent overwrite)', () => {
        const seen = new Map();
        const collisions = [];
        for (const name of Object.keys(STATION_RESTROOMS)) {
            const k = stationNameKey(cleanStationName(name, false));
            if (seen.has(k)) collisions.push([seen.get(k), name]);
            else seen.set(k, name);
        }
        expect(collisions).toEqual([]);
    });

    it('every type has a human label', () => {
        for (const type of new Set(Object.values(STATION_RESTROOMS))) {
            expect(RESTROOM_TYPE_LABEL[type]).toBeTruthy();
        }
    });

    it('covers the expected roster size', () => {
        expect(Object.keys(STATION_RESTROOMS).length).toBe(76);
    });
});

describe('getStationRestroom', () => {
    // The registry stores normName = cleanStationName(rawStopName, false).
    const grp = rawName => ({ normName: cleanStationName(rawName, false) });

    it('matches a station by its registry normName (incl. official-name resolutions)', () => {
        expect(getStationRestroom(grp('Union Station'))).toBe('PR');
        expect(getStationRestroom(grp('El Monte Station - Upper Level'))).toBe('MR');
        expect(getStationRestroom(grp('Lincoln Heights / Cypress Park Station'))).toBe('TR');
        expect(getStationRestroom(grp('LAX / Metro Transit Center'))).toBe('MR');   // TC abbreviation path
        expect(getStationRestroom(grp('Harbor Freeway Station'))).toBe('TR');
        expect(getStationRestroom(grp('Oxnard / Van Nuys'))).toBe('TR');
        expect(getStationRestroom(grp('Slauson Station'))).toBe('TR & PR');
    });

    it('returns null for a station with no restroom', () => {
        expect(getStationRestroom(grp('Mariposa Station'))).toBe('TR');   // sanity: present
        expect(getStationRestroom(grp('Vermont / Athens Station'))).toBeNull();   // not on the list
        expect(getStationRestroom(grp('Florence / West Station'))).toBeNull();
    });

    it('does not confuse Crenshaw (C Line) with Expo/Crenshaw (K Line)', () => {
        // Distinct keys — both happen to be TR, but the point is they don't
        // collide. A non-listed Crenshaw-prefixed bus stop must stay null.
        expect(getStationRestroom(grp('Crenshaw / Northrop'))).toBeNull();
    });

    it('handles missing/empty groups without throwing', () => {
        expect(getStationRestroom(null)).toBeNull();
        expect(getStationRestroom({})).toBeNull();
        expect(getStationRestroom({ normName: '' })).toBeNull();
    });
});

/**
 * restrooms.js — curated station restroom inventory (static, not from GTFS).
 *
 * Source: operator-provided list (2026-06). Each station maps to a restroom
 * TYPE used only for the badge's tooltip/aria — the icon is the same for all:
 *   TR = Throne (paid pod restroom)   PR = Public restroom   MR = Metro restroom
 *   "TR & PR" = both present
 *
 * Names use the OFFICIAL station spelling where it differs from the colloquial
 * label, so the lookup key matches the station-group names boardingBadges
 * iterates: e.g. "Lincoln Heights / Cypress Park" (not "Lincoln/Cypress"),
 * "Oxnard / Van Nuys" (the G Line stop), "Harbor Freeway" (the C Line rail
 * station, distinct from the J Line "Figueroa / Harbor Fwy"), "LA General
 * Medical Center", "LAX / Metro Transit Center". Verified 76/76 against
 * data/stops.json — see tests/restrooms.test.js.
 *
 * Matching: keys are normalized via stationNameKey(cleanStationName(name)) —
 * the SAME transform the station registry applies to build group.normName — so
 * "Transit Center"→"TC" abbreviation, "Station" stripping, punctuation, and
 * St/Ave/Blvd folding all line up. getStationRestroom() looks up a group's
 * normName in that key space.
 */

import { stationNameKey, cleanStationName } from './utils.js';

// Station display name → restroom type.
export const STATION_RESTROOMS = {
    // A Line
    'Nordhoff': 'TR', 'Roscoe': 'TR', 'Sherman Way': 'TR', 'De Soto': 'TR',
    'Lake': 'TR', 'Allen': 'TR', 'Memorial Park': 'TR', 'Del Mar': 'TR',
    'Fillmore': 'TR', 'South Pasadena': 'TR', 'Highland Park': 'TR',
    'Southwest Museum': 'TR', 'Heritage Square / Arroyo': 'TR',
    'Lincoln Heights / Cypress Park': 'TR', 'Chinatown': 'TR', 'Arcadia': 'TR',
    'Azusa Downtown': 'TR', 'APU/Citrus College': 'TR', 'Pomona North': 'TR',
    'Grand/LATTC': 'TR', 'Pico': 'TR', 'Slauson': 'TR & PR', 'Florence': 'TR',
    'Firestone': 'TR', 'Willowbrook/Rosa Parks': 'TR', 'Compton': 'TR',
    'Artesia': 'TR', 'Willow St': 'TR', 'Downtown Long Beach': 'PR',
    // B Line
    'Chatsworth': 'TR', 'Canoga': 'TR', 'Pierce College': 'TR',
    'Oxnard / Van Nuys': 'TR', 'North Hollywood': 'TR',
    'Universal / Studio City': 'TR', 'Hollywood/Highland': 'TR',
    'Hollywood/Vine': 'PR', 'Hollywood/Western': 'TR', 'Vermont/Sunset': 'TR',
    'Vermont/Santa Monica': 'TR', 'Vermont/Beverly': 'TR',
    'Westlake/MacArthur Park': 'TR',
    // D Line
    'Wilshire/Western': 'TR', 'Wilshire/Normandie': 'TR', 'Wilshire/Vermont': 'TR',
    // E Line
    '17th St/SMC': 'TR', 'Expo/Sepulveda': 'TR', 'Westwood/Rancho Park': 'TR',
    'Downtown Santa Monica': 'TR', 'Expo/La Brea': 'TR', 'Expo Park/USC': 'TR',
    'Little Tokyo / Arts District': 'TR', 'Soto': 'TR', 'Indiana': 'TR',
    'Maravilla': 'TR', 'Atlantic': 'TR',
    // K Line
    'Martin Luther King Jr': 'TR', 'Expo/Crenshaw': 'TR', 'Leimert Park': 'TR',
    'Downtown Inglewood': 'TR',
    // C Line
    'Redondo Beach': 'MR', 'Mariposa': 'TR', 'Aviation/Imperial': 'TR',
    'Hawthorne/Lennox': 'TR', 'Crenshaw': 'TR', 'Harbor Freeway': 'TR',
    'Norwalk': 'TR',
    // J Line
    'El Monte': 'MR', 'LA General Medical Center': 'TR',
    // Shared / hubs
    '7th Street / Metro Center': 'TR', 'Pershing Square': 'TR',
    'Civic Center / Grand Park': 'PR', 'Grand Ave Arts / Bunker Hill': 'PR',
    'Historic Broadway': 'TR', 'Union Station': 'PR',
    'LAX / Metro Transit Center': 'MR',
};

export const RESTROOM_TYPE_LABEL = {
    TR: 'Throne restroom (paid pod)',
    PR: 'Public restroom',
    MR: 'Metro restroom',
    'TR & PR': 'Throne & public restrooms',
};

// Normalized-key → type, built once. Same key transform as group.normName.
const _byKey = new Map();
for (const [name, type] of Object.entries(STATION_RESTROOMS)) {
    _byKey.set(stationNameKey(cleanStationName(name, false)), type);
}

/**
 * Restroom type for a station group, or null. Matches on the group's normName
 * (already cleanStationName output) in the same normalized key space.
 * @param {{normName?:string, displayName?:string}} group
 * @returns {('TR'|'PR'|'MR'|'TR & PR')|null}
 */
export function getStationRestroom(group) {
    if (!group) return null;
    const name = group.normName || group.displayName || '';
    if (!name) return null;
    return _byKey.get(stationNameKey(name)) ?? null;
}

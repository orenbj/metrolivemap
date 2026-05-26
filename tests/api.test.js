import { vi, describe, it, expect, beforeEach } from 'vitest';

// markers.js touches MapLibre and DOM — stub it so api.js loads cleanly and
// we can assert which features make it past processAndUpdate's validation gate.
const _seenFeatures = [];
vi.mock('../js/markers.js', () => ({
    processVehicleData: vi.fn((data) => { _seenFeatures.push(...(data?.features ?? [])); }),
}));
vi.mock('../js/ui.js', () => ({
    showToast:           vi.fn(),
    updateDataPanel:     vi.fn(),
    getPopupHTML:        vi.fn(() => ''),
    cleanDestination:    s => s,
    updateUpdateTime:    vi.fn(),
    setConnectionStatus: vi.fn(),
    initUI:              vi.fn(),
    removeLoadingScreen: vi.fn(),
}));

import { processAndUpdate } from '../js/api.js';
import { makeRawVehicleFrame } from './_fixtures/markers.js';

beforeEach(() => {
    _seenFeatures.length = 0;
});

describe('processAndUpdate — validation gates', () => {
    it('passes a well-formed frame through', () => {
        const data = makeRawVehicleFrame();
        processAndUpdate(data, /* map */ null);
        expect(_seenFeatures).toHaveLength(1);
        expect(_seenFeatures[0].properties.vehicle_id).toBe('V1');
        expect(_seenFeatures[0].properties.trip_id).toBe('TR-A-1');
    });

    it('drops frames missing position', () => {
        const data = makeRawVehicleFrame();
        delete data.vehicle.position;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('drops frames with non-finite latitude', () => {
        const data = makeRawVehicleFrame();
        data.vehicle.position.latitude = NaN;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('drops frames with non-finite longitude', () => {
        const data = makeRawVehicleFrame();
        data.vehicle.position.longitude = Infinity;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('drops frames missing trip.tripId', () => {
        const data = makeRawVehicleFrame();
        delete data.vehicle.trip.tripId;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('drops frames whose timestamp is not a finite number', () => {
        const data = makeRawVehicleFrame();
        data.vehicle.timestamp = 'not-a-number';
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('drops frames whose timestamp is in the future beyond FUTURE_TS_GRACE_MS', () => {
        // Future timestamps would otherwise pass Number.isFinite() and break
        // every downstream `now - ts` age check (collapses to 0 = "fresh"),
        // letting a phantom train DR-extrapolate forward until the frame ages
        // out. 60 s in the future is well past the 5 s clock-skew grace.
        const data = makeRawVehicleFrame();
        data.vehicle.timestamp = Math.floor(Date.now() / 1000) + 60;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(0);
    });

    it('accepts frames within the FUTURE_TS_GRACE_MS clock-skew window', () => {
        // Routine 1–2 s clock skew between Metro and the user's browser must
        // not drop healthy frames. 2 s in the future is well inside the 5 s
        // grace.
        const data = makeRawVehicleFrame();
        data.vehicle.timestamp = Math.floor(Date.now() / 1000) + 2;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(1);
    });
});

describe('processAndUpdate — normalization', () => {
    it('converts millisecond timestamps to seconds', () => {
        const ms = 1_700_000_000_000;
        const data = makeRawVehicleFrame({ timestamp: ms });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.timestamp).toBe(Math.floor(ms / 1000));
    });

    it('keeps second-resolution timestamps untouched', () => {
        const sec = 1_700_000_000;
        const data = makeRawVehicleFrame({ timestamp: sec });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.timestamp).toBe(sec);
    });

    it('clamps negative speed to 0', () => {
        const data = makeRawVehicleFrame({ speed: -3 });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.position_speed).toBe(0);
    });

    it('clamps non-finite speed to 0', () => {
        const data = makeRawVehicleFrame({ speed: NaN });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.position_speed).toBe(0);
    });

    it('clamps implausibly high speed to 50 m/s', () => {
        const data = makeRawVehicleFrame({ speed: 999 });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.position_speed).toBe(50);
    });

    it('preserves a normal speed reading', () => {
        const data = makeRawVehicleFrame({ speed: 12.5 });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.position_speed).toBe(12.5);
    });

    it('preserves coordinate order in the GeoJSON Feature (lng, lat)', () => {
        const data = makeRawVehicleFrame({ lng: -118.3, lat: 34.05 });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].geometry.coordinates).toEqual([-118.3, 34.05]);
        expect(_seenFeatures[0].properties.position_longitude).toBe(-118.3);
        expect(_seenFeatures[0].properties.position_latitude).toBe(34.05);
    });

    it('forwards route_code from the wrapping frame onto the feature', () => {
        const data = makeRawVehicleFrame({ routeCode: '901' });
        processAndUpdate(data, null);
        expect(_seenFeatures[0].properties.route_code).toBe('901');
    });

    it('null-safes optional fields (currentStatus, stopId, bearing) without crashing', () => {
        const data = makeRawVehicleFrame();
        delete data.vehicle.currentStatus;
        delete data.vehicle.stopId;
        delete data.vehicle.position.bearing;
        processAndUpdate(data, null);
        expect(_seenFeatures).toHaveLength(1);
        expect(_seenFeatures[0].properties.currentStatus).toBeNull();
        expect(_seenFeatures[0].properties.stopId).toBeNull();
        expect(_seenFeatures[0].properties.position_bearing).toBeNull();
    });
});

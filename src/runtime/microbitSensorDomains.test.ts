import {
  MICROBIT_BUILTIN_SENSOR_DOMAINS,
  clampMicrobitNumericSensor,
  makeDefaultMicrobitSensorSnapshot,
  normalizeMicrobitSensorSnapshot,
} from './microbitSensorDomains';

describe('micro:bit sensor domains', () => {
  it('defines documented domains for currently modeled and planned built-in sensors', () => {
    expect(MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel).toMatchObject({ min: 0, max: 255 });
    expect(MICROBIT_BUILTIN_SENSOR_DOMAINS.soundLevel).toMatchObject({ min: 0, max: 255 });
    expect(MICROBIT_BUILTIN_SENSOR_DOMAINS.compassHeading).toMatchObject({ min: 0, max: 359 });
    expect(MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticForceX).toMatchObject({ min: -2000, max: 2000 });
    expect(MICROBIT_BUILTIN_SENSOR_DOMAINS.accelerationXMg).toMatchObject({ min: -2048, max: 2047 });
  });

  it('clamps numeric sensor values to domain bounds', () => {
    expect(clampMicrobitNumericSensor('lightLevel', -1)).toBe(0);
    expect(clampMicrobitNumericSensor('lightLevel', 999)).toBe(255);
    expect(clampMicrobitNumericSensor('compassHeading', 361)).toBe(359);
    expect(clampMicrobitNumericSensor('magneticForceX', -2500)).toBe(-2000);
  });

  it('builds deterministic typed placeholder snapshots for unimplemented sensors', () => {
    const snapshot = makeDefaultMicrobitSensorSnapshot();
    expect(snapshot).toEqual({
      lightLevel: 0,
      soundLevel: 0,
      temperatureC: 20,
      compassHeading: 0,
      magneticForceX: 0,
      magneticForceY: 45,
      magneticForceZ: 0,
      magneticFieldStrength: 45,
      accelerationXMg: 0,
      accelerationYMg: 0,
      accelerationZMg: 1024,
      logoTouched: false,
    });
  });

  it('normalizes partial snapshots into full, typed, bounded snapshots', () => {
    const normalized = normalizeMicrobitSensorSnapshot({
      lightLevel: 999,
      soundLevel: -50,
      compassHeading: 720,
      magneticForceX: 2500,
      accelerationZMg: -9999,
      logoTouched: true,
    });

    expect(normalized.lightLevel).toBe(255);
    expect(normalized.soundLevel).toBe(0);
    expect(normalized.compassHeading).toBe(359);
    expect(normalized.magneticForceX).toBe(2000);
    expect(normalized.accelerationZMg).toBe(-2048);
    expect(normalized.logoTouched).toBe(true);
    expect(normalized.temperatureC).toBe(20);
  });
});

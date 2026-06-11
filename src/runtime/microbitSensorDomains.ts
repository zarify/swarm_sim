export interface NumericSensorDomain {
  kind: 'number';
  min: number;
  max: number;
  defaultValue: number;
  unit: string;
  notes: string;
}

export interface BooleanSensorDomain {
  kind: 'boolean';
  defaultValue: boolean;
  notes: string;
}

export const MICROBIT_BUILTIN_SENSOR_DOMAINS = {
  // MakeCode input.lightLevel(): 0..255 (relative brightness, not lux).
  lightLevel: {
    kind: 'number',
    min: 0,
    max: 255,
    defaultValue: 0,
    unit: 'level',
    notes: 'Ambient light level reported by MakeCode input.lightLevel().',
  },
  // MakeCode input.soundLevel(): 0..255 (relative microphone level, not dB).
  soundLevel: {
    kind: 'number',
    min: 0,
    max: 255,
    defaultValue: 0,
    unit: 'level',
    notes: 'Microphone level reported by MakeCode input.soundLevel().',
  },
  // MakeCode input.temperature(): degrees Celsius within the simulator/editor control range.
  temperatureC: {
    kind: 'number',
    min: -5,
    max: 50,
    defaultValue: 20,
    unit: 'degC',
    notes: 'Board temperature in Celsius as used by input.temperature() and the MakeCode editor controls.',
  },
  // MakeCode input.compassHeading(): 0..359 degrees.
  compassHeading: {
    kind: 'number',
    min: 0,
    max: 359,
    defaultValue: 0,
    unit: 'degrees',
    notes: 'Compass heading in degrees as used by input.compassHeading().',
  },
  // MakeCode input.magneticForce(Dimension.*): microteslas.
  magneticForceX: {
    kind: 'number',
    min: -2000,
    max: 2000,
    defaultValue: 0,
    unit: 'uT',
    notes: 'Magnetic field X axis in microteslas as used by input.magneticForce(Dimension.X).',
  },
  magneticForceY: {
    kind: 'number',
    min: -2000,
    max: 2000,
    defaultValue: 45,
    unit: 'uT',
    notes: 'Magnetic field Y axis in microteslas as used by input.magneticForce(Dimension.Y).',
  },
  magneticForceZ: {
    kind: 'number',
    min: -2000,
    max: 2000,
    defaultValue: 0,
    unit: 'uT',
    notes: 'Magnetic field Z axis in microteslas; the 2D canvas keeps this at zero.',
  },
  magneticFieldStrength: {
    kind: 'number',
    min: 0,
    max: 2000,
    defaultValue: 45,
    unit: 'uT',
    notes: 'Magnetic field strength in microteslas.',
  },
  // MakeCode input.acceleration(Dimension.*): milli-g, ±2g on micro:bit.
  accelerationXMg: {
    kind: 'number',
    min: -2048,
    max: 2047,
    defaultValue: 0,
    unit: 'mg',
    notes: 'Accelerometer X in milli-g (input.acceleration).',
  },
  accelerationYMg: {
    kind: 'number',
    min: -2048,
    max: 2047,
    defaultValue: 0,
    unit: 'mg',
    notes: 'Accelerometer Y in milli-g (input.acceleration).',
  },
  accelerationZMg: {
    kind: 'number',
    min: -2048,
    max: 2047,
    defaultValue: 1024,
    unit: 'mg',
    notes: 'Accelerometer Z in milli-g; defaults near 1g at rest.',
  },
  // MakeCode input.logoIsPressed(): boolean touch state.
  logoTouched: {
    kind: 'boolean',
    defaultValue: false,
    notes: 'Logo touch sensor state (input.logoIsPressed()).',
  },
} as const satisfies Record<string, NumericSensorDomain | BooleanSensorDomain>;

export type MicrobitBuiltinSensorId = keyof typeof MICROBIT_BUILTIN_SENSOR_DOMAINS;
export type MicrobitNumericSensorId = {
  [K in MicrobitBuiltinSensorId]: (typeof MICROBIT_BUILTIN_SENSOR_DOMAINS)[K] extends NumericSensorDomain
    ? K
    : never;
}[MicrobitBuiltinSensorId];

export interface MicrobitSensorSnapshot {
  lightLevel: number;
  soundLevel: number;
  temperatureC: number;
  compassHeading: number;
  magneticForceX: number;
  magneticForceY: number;
  magneticForceZ: number;
  magneticFieldStrength: number;
  accelerationXMg: number;
  accelerationYMg: number;
  accelerationZMg: number;
  logoTouched: boolean;
}

export function clampMicrobitNumericSensor(sensorId: MicrobitNumericSensorId, value: number): number {
  const domain = MICROBIT_BUILTIN_SENSOR_DOMAINS[sensorId];
  if (domain.kind !== 'number') {
    throw new Error(`Expected numeric micro:bit sensor domain for ${sensorId}`);
  }
  if (!Number.isFinite(value)) {
    return domain.defaultValue;
  }
  return Math.min(domain.max, Math.max(domain.min, Math.round(value)));
}

export function makeDefaultMicrobitSensorSnapshot(): MicrobitSensorSnapshot {
  return {
    lightLevel: MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.defaultValue,
    soundLevel: MICROBIT_BUILTIN_SENSOR_DOMAINS.soundLevel.defaultValue,
    temperatureC: MICROBIT_BUILTIN_SENSOR_DOMAINS.temperatureC.defaultValue,
    compassHeading: MICROBIT_BUILTIN_SENSOR_DOMAINS.compassHeading.defaultValue,
    magneticForceX: MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticForceX.defaultValue,
    magneticForceY: MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticForceY.defaultValue,
    magneticForceZ: MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticForceZ.defaultValue,
    magneticFieldStrength: MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticFieldStrength.defaultValue,
    accelerationXMg: MICROBIT_BUILTIN_SENSOR_DOMAINS.accelerationXMg.defaultValue,
    accelerationYMg: MICROBIT_BUILTIN_SENSOR_DOMAINS.accelerationYMg.defaultValue,
    accelerationZMg: MICROBIT_BUILTIN_SENSOR_DOMAINS.accelerationZMg.defaultValue,
    logoTouched: MICROBIT_BUILTIN_SENSOR_DOMAINS.logoTouched.defaultValue,
  };
}

export function normalizeMicrobitSensorSnapshot(
  partial: Partial<MicrobitSensorSnapshot>,
): MicrobitSensorSnapshot {
  const defaults = makeDefaultMicrobitSensorSnapshot();
  return {
    lightLevel: clampMicrobitNumericSensor('lightLevel', partial.lightLevel ?? defaults.lightLevel),
    soundLevel: clampMicrobitNumericSensor('soundLevel', partial.soundLevel ?? defaults.soundLevel),
    temperatureC: clampMicrobitNumericSensor('temperatureC', partial.temperatureC ?? defaults.temperatureC),
    compassHeading: clampMicrobitNumericSensor(
      'compassHeading',
      partial.compassHeading ?? defaults.compassHeading,
    ),
    magneticForceX: clampMicrobitNumericSensor(
      'magneticForceX',
      partial.magneticForceX ?? defaults.magneticForceX,
    ),
    magneticForceY: clampMicrobitNumericSensor(
      'magneticForceY',
      partial.magneticForceY ?? defaults.magneticForceY,
    ),
    magneticForceZ: clampMicrobitNumericSensor(
      'magneticForceZ',
      partial.magneticForceZ ?? defaults.magneticForceZ,
    ),
    magneticFieldStrength: clampMicrobitNumericSensor(
      'magneticFieldStrength',
      partial.magneticFieldStrength ?? defaults.magneticFieldStrength,
    ),
    accelerationXMg: clampMicrobitNumericSensor(
      'accelerationXMg',
      partial.accelerationXMg ?? defaults.accelerationXMg,
    ),
    accelerationYMg: clampMicrobitNumericSensor(
      'accelerationYMg',
      partial.accelerationYMg ?? defaults.accelerationYMg,
    ),
    accelerationZMg: clampMicrobitNumericSensor(
      'accelerationZMg',
      partial.accelerationZMg ?? defaults.accelerationZMg,
    ),
    logoTouched: partial.logoTouched ?? defaults.logoTouched,
  };
}

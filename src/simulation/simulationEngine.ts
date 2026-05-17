import type { DeviceId, EnvironmentSource, Point, SwarmProject } from '../domain/project';
import {
  MICROBIT_BUILTIN_SENSOR_DOMAINS,
  clampMicrobitNumericSensor,
} from '../runtime/microbitSensorDomains';
import type { RuntimeRadioPacket } from '../runtime/runtimeAdapter';

export type SimulationMode = 'idle' | 'running' | 'paused';
export type DeviceLifecycleState = 'stopped' | 'running' | 'paused';
export type RadioBlockReason = 'group-mismatch' | 'channel-mismatch' | 'out-of-range';

export interface SimulationOptions {
  defaultRadioRangeRadius?: number;
  minRadioRangeRadius?: number;
  maxRadioRangeRadius?: number;
  maxSignalStrength?: number;
}

export interface DeviceRadioState {
  group: number;
  channel: number;
  signalStrength?: number;
  rangeRadius: number;
}

export interface EnvironmentSensorState {
  lightLevel: number;
  soundLevel: number;
}

export interface DeviceButtonState {
  A: boolean;
  B: boolean;
}

export interface DeviceRuntimeState {
  deviceId: DeviceId;
  lifecycle: DeviceLifecycleState;
  position: Point;
  radio: DeviceRadioState;
  buttons: DeviceButtonState;
  sensors: EnvironmentSensorState;
}

export interface RadioLink {
  sourceDeviceId: DeviceId;
  targetDeviceId: DeviceId;
  distance: number;
  rangeRadius: number;
  groupMatches: boolean;
  channelMatches: boolean;
  canCommunicate: boolean;
}

export interface BlockedRadioTarget {
  deviceId: DeviceId;
  reason: RadioBlockReason;
  distance: number;
  targetGroup: number;
  targetChannel: number;
}

export interface RadioMessageEvent {
  id: string;
  sequence: number;
  timestampMs: number;
  senderId: DeviceId;
  data: Uint8Array;
  group: number;
  channel: number;
  signalStrength?: number;
  rangeRadius: number;
  recipients: DeviceId[];
  blockedTargets: BlockedRadioTarget[];
}

export interface DeviceLogEvent {
  id: string;
  sequence: number;
  timestampMs: number;
  deviceId: DeviceId;
  type:
    | 'lifecycle'
    | 'button-input'
    | 'radio-sent'
    | 'radio-received'
    | 'radio-blocked'
    | 'serial-output'
    | 'runtime-error';
  message: string;
}

export interface SimulationState {
  projectId: string;
  mode: SimulationMode;
  clockMs: number;
  sequence: number;
  devices: Record<DeviceId, DeviceRuntimeState>;
  environmentSources: EnvironmentSource[];
  radioLinks: RadioLink[];
  radioEvents: RadioMessageEvent[];
  deviceLogs: DeviceLogEvent[];
  options: Required<SimulationOptions>;
}

const DEFAULT_OPTIONS: Required<SimulationOptions> = {
  defaultRadioRangeRadius: 160,
  minRadioRangeRadius: 40,
  maxRadioRangeRadius: 240,
  maxSignalStrength: 7,
};
const DEFAULT_RADIO_GROUP = 0;
const DEFAULT_RADIO_CHANNEL = 7;
const SENSOR_MAX_LEVEL = MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.max;

export function createSimulationState(
  project: SwarmProject,
  options: SimulationOptions = {},
): SimulationState {
  const resolvedOptions = resolveOptions(options);
  const devices = Object.fromEntries(
    project.devices.map((device) => {
      const runtime: DeviceRuntimeState = {
        deviceId: device.id,
        lifecycle: 'stopped',
        position: clonePoint(device.position),
        radio: {
          group: DEFAULT_RADIO_GROUP,
          channel: DEFAULT_RADIO_CHANNEL,
          rangeRadius: resolvedOptions.defaultRadioRangeRadius,
        },
        buttons: { A: false, B: false },
        sensors: calculateEnvironmentSensors(device.position, project.environmentSources),
      };

      return [device.id, runtime];
    }),
  );

  const state: SimulationState = {
    projectId: project.id,
    mode: 'idle',
    clockMs: 0,
    sequence: 0,
    devices,
    environmentSources: project.environmentSources.map(cloneEnvironmentSource),
    radioLinks: [],
    radioEvents: [],
    deviceLogs: [],
    options: resolvedOptions,
  };

  return recalculateDerivedState(state);
}

export function startSimulation(state: SimulationState): SimulationState {
  assertMode(state, ['idle'], 'start');
  const next = withMode(state, 'running', 'running');
  return appendLifecycleLog(next, 'Simulation started');
}

export function pauseSimulation(state: SimulationState): SimulationState {
  assertMode(state, ['running'], 'pause');
  const next = withMode(state, 'paused', 'paused');
  return appendLifecycleLog(next, 'Simulation paused');
}

export function resumeSimulation(state: SimulationState): SimulationState {
  assertMode(state, ['paused'], 'resume');
  const next = withMode(state, 'running', 'running');
  return appendLifecycleLog(next, 'Simulation resumed');
}

export function resetSimulation(project: SwarmProject, options: SimulationOptions = {}): SimulationState {
  return createSimulationState(project, options);
}

export function reconcileSimulationProject(
  state: SimulationState,
  project: SwarmProject,
): SimulationState {
  const reset = createSimulationState(project, state.options);
  const devices = Object.fromEntries(
    Object.entries(reset.devices).map(([deviceId, resetDevice]) => {
      const previousDevice = state.devices[deviceId];
      return [
        deviceId,
        previousDevice
          ? {
              ...resetDevice,
              lifecycle: previousDevice.lifecycle,
              radio: previousDevice.radio,
              buttons: previousDevice.buttons,
            }
          : resetDevice,
      ];
    }),
  );

  return recalculateDerivedState({
    ...reset,
    mode: state.mode,
    clockMs: state.clockMs,
    sequence: state.sequence,
    devices,
    radioEvents: state.radioEvents,
    deviceLogs: state.deviceLogs,
  });
}

export function advanceSimulation(state: SimulationState, deltaMs: number): SimulationState {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new Error(`Simulation delta must be a non-negative finite number: ${deltaMs}`);
  }

  if (state.mode !== 'running' || deltaMs === 0) {
    return state;
  }

  return {
    ...state,
    clockMs: state.clockMs + deltaMs,
  };
}

export function moveDevice(
  state: SimulationState,
  deviceId: DeviceId,
  position: Point,
): SimulationState {
  assertPoint(position, 'position');
  const device = requireDevice(state, deviceId);
  const devices = {
    ...state.devices,
    [deviceId]: {
      ...device,
      position: clonePoint(position),
      sensors: calculateEnvironmentSensors(position, state.environmentSources),
    },
  };

  return recalculateDerivedState({ ...state, devices });
}

export function setDeviceRadioConfig(
  state: SimulationState,
  deviceId: DeviceId,
  radio: Partial<Pick<DeviceRadioState, 'group' | 'channel' | 'signalStrength'>>,
): SimulationState {
  const device = requireDevice(state, deviceId);
  const nextRadio: DeviceRadioState = {
    ...device.radio,
    ...normalizeRadioConfig(radio, state.options),
  };
  nextRadio.rangeRadius = radioRangeForSignalStrength(nextRadio.signalStrength, state.options);

  const devices = {
    ...state.devices,
    [deviceId]: {
      ...device,
      radio: nextRadio,
    },
  };

  return recalculateDerivedState({ ...state, devices });
}

export function setDeviceButton(
  state: SimulationState,
  deviceId: DeviceId,
  button: keyof DeviceButtonState,
  pressed: boolean,
): SimulationState {
  const device = requireDevice(state, deviceId);
  const sequence = state.sequence + 1;
  const devices = {
    ...state.devices,
    [deviceId]: {
      ...device,
      buttons: {
        ...device.buttons,
        [button]: pressed,
      },
    },
  };

  return {
    ...state,
    sequence,
    devices,
    deviceLogs: [
      ...state.deviceLogs,
      {
        id: `log-${sequence}-${deviceId}-button-${button}`,
        sequence,
        timestampMs: state.clockMs,
        deviceId,
        type: 'button-input',
        message: `Button ${button} ${pressed ? 'pressed' : 'released'}`,
      },
    ],
  };
}

export function appendDeviceRuntimeLog(
  state: SimulationState,
  deviceId: DeviceId,
  type: Extract<DeviceLogEvent['type'], 'serial-output' | 'runtime-error'>,
  message: string,
): SimulationState {
  requireDevice(state, deviceId);
  const sequence = state.sequence + 1;

  return {
    ...state,
    sequence,
    deviceLogs: [
      ...state.deviceLogs,
      {
        id: `log-${sequence}-${deviceId}-${type}`,
        sequence,
        timestampMs: state.clockMs,
        deviceId,
        type,
        message,
      },
    ],
  };
}

export function routeRadioPacket(
  state: SimulationState,
  senderId: DeviceId,
  packet: RuntimeRadioPacket,
): SimulationState {
  const sender = requireDevice(state, senderId);
  const group = packet.group ?? sender.radio.group;
  const channel = packet.channel ?? sender.radio.channel;
  const signalStrength = packet.signalStrength ?? sender.radio.signalStrength;
  assertByteRange(group, 'radio group');
  assertChannel(channel);
  if (signalStrength !== undefined) {
    assertSignalStrength(signalStrength, state.options);
  }

  const rangeRadius = radioRangeForSignalStrength(signalStrength, state.options);
  const recipients: DeviceId[] = [];
  const blockedTargets: BlockedRadioTarget[] = [];

  for (const device of Object.values(state.devices)) {
    if (device.deviceId === senderId) {
      continue;
    }

    const distance = distanceBetween(sender.position, device.position);
    const blockReason = getRadioBlockReason(device, group, channel, distance, rangeRadius);
    if (blockReason) {
      blockedTargets.push({
        deviceId: device.deviceId,
        reason: blockReason,
        distance,
        targetGroup: device.radio.group,
        targetChannel: device.radio.channel,
      });
    } else {
      recipients.push(device.deviceId);
    }
  }

  const sequence = state.sequence + 1;
  const event: RadioMessageEvent = {
    id: `radio-${sequence}`,
    sequence,
    timestampMs: state.clockMs,
    senderId,
    data: new Uint8Array(packet.data),
    group,
    channel,
    ...(signalStrength === undefined ? {} : { signalStrength }),
    rangeRadius,
    recipients,
    blockedTargets,
  };
  const logs = makeRadioLogs(event);

  return {
    ...state,
    sequence,
    radioEvents: [...state.radioEvents, event],
    deviceLogs: [...state.deviceLogs, ...logs],
  };
}

export function radioRangeForSignalStrength(
  signalStrength: number | undefined,
  options: Required<SimulationOptions> = DEFAULT_OPTIONS,
): number {
  if (signalStrength === undefined) {
    return options.defaultRadioRangeRadius;
  }

  assertSignalStrength(signalStrength, options);
  const normalized = signalStrength / options.maxSignalStrength;
  return (
    options.minRadioRangeRadius +
    normalized * (options.maxRadioRangeRadius - options.minRadioRangeRadius)
  );
}

export function calculateEnvironmentSensors(
  position: Point,
  environmentSources: EnvironmentSource[],
): EnvironmentSensorState {
  assertPoint(position, 'position');
  let lightLevel = 0;
  let soundLevel = 0;

  for (const source of environmentSources) {
    const contribution = calculateSourceContribution(position, source);
    if (source.type === 'light') {
      lightLevel = Math.max(lightLevel, contribution);
    } else {
      soundLevel = Math.max(soundLevel, contribution);
    }
  }

  return {
    lightLevel: clampMicrobitNumericSensor('lightLevel', lightLevel),
    soundLevel: clampMicrobitNumericSensor('soundLevel', soundLevel),
  };
}

function recalculateDerivedState(state: SimulationState): SimulationState {
  return {
    ...state,
    radioLinks: calculateRadioLinks(state.devices, state.options),
  };
}

function calculateRadioLinks(
  devices: Record<DeviceId, DeviceRuntimeState>,
  options: Required<SimulationOptions>,
): RadioLink[] {
  const runtimes = Object.values(devices);
  const links: RadioLink[] = [];

  for (const source of runtimes) {
    for (const target of runtimes) {
      if (source.deviceId === target.deviceId) {
        continue;
      }

      const rangeRadius = radioRangeForSignalStrength(source.radio.signalStrength, options);
      const distance = distanceBetween(source.position, target.position);
      const groupMatches = source.radio.group === target.radio.group;
      const channelMatches = source.radio.channel === target.radio.channel;

      links.push({
        sourceDeviceId: source.deviceId,
        targetDeviceId: target.deviceId,
        distance,
        rangeRadius,
        groupMatches,
        channelMatches,
        canCommunicate: groupMatches && channelMatches && distance <= rangeRadius,
      });
    }
  }

  return links;
}

function withMode(
  state: SimulationState,
  mode: SimulationMode,
  lifecycle: DeviceLifecycleState,
): SimulationState {
  return {
    ...state,
    mode,
    devices: Object.fromEntries(
      Object.entries(state.devices).map(([deviceId, device]) => [
        deviceId,
        { ...device, lifecycle },
      ]),
    ),
  };
}

function appendLifecycleLog(state: SimulationState, message: string): SimulationState {
  const logs = Object.values(state.devices).map((device) => ({
    id: `log-${state.sequence + 1}-${device.deviceId}`,
    sequence: state.sequence + 1,
    timestampMs: state.clockMs,
    deviceId: device.deviceId,
    type: 'lifecycle' as const,
    message,
  }));

  return {
    ...state,
    sequence: state.sequence + 1,
    deviceLogs: [...state.deviceLogs, ...logs],
  };
}

function makeRadioLogs(event: RadioMessageEvent): DeviceLogEvent[] {
  const logs: DeviceLogEvent[] = [
    {
      id: `log-${event.sequence}-${event.senderId}-sent`,
      sequence: event.sequence,
      timestampMs: event.timestampMs,
      deviceId: event.senderId,
      type: 'radio-sent',
      message: `Sent radio packet to ${event.recipients.length} recipient(s)`,
    },
  ];

  event.recipients.forEach((deviceId) => {
    logs.push({
      id: `log-${event.sequence}-${deviceId}-received`,
      sequence: event.sequence,
      timestampMs: event.timestampMs,
      deviceId,
      type: 'radio-received',
      message: `Received radio packet from ${event.senderId}`,
    });
  });
  event.blockedTargets.forEach((target) => {
    logs.push({
      id: `log-${event.sequence}-${target.deviceId}-blocked`,
      sequence: event.sequence,
      timestampMs: event.timestampMs,
      deviceId: target.deviceId,
      type: 'radio-blocked',
      message:
        `Blocked radio packet from ${event.senderId}: ${target.reason}` +
        ` (sender g${event.group}/ch${event.channel} -> target g${target.targetGroup}/ch${target.targetChannel})`,
    });
  });

  return logs;
}

function getRadioBlockReason(
  target: DeviceRuntimeState,
  group: number,
  channel: number,
  distance: number,
  rangeRadius: number,
): RadioBlockReason | undefined {
  if (target.radio.group !== group) {
    return 'group-mismatch';
  }

  if (target.radio.channel !== channel) {
    return 'channel-mismatch';
  }

  if (distance > rangeRadius) {
    return 'out-of-range';
  }

  return undefined;
}

function normalizeRadioConfig(
  radio: Partial<Pick<DeviceRadioState, 'group' | 'channel' | 'signalStrength'>>,
  options: Required<SimulationOptions>,
): Partial<Pick<DeviceRadioState, 'group' | 'channel' | 'signalStrength'>> {
  if (radio.group !== undefined) {
    assertByteRange(radio.group, 'radio group');
  }

  if (radio.channel !== undefined) {
    assertChannel(radio.channel);
  }

  if (radio.signalStrength !== undefined) {
    assertSignalStrength(radio.signalStrength, options);
  }

  return radio;
}

function calculateSourceContribution(position: Point, source: EnvironmentSource): number {
  assertPoint(source.position, `environment source ${source.id} position`);

  if (!Number.isFinite(source.radius) || source.radius <= 0) {
    return 0;
  }

  if (!Number.isFinite(source.intensity)) {
    throw new Error(`environment source ${source.id} intensity must be a finite number`);
  }

  const distance = distanceBetween(position, source.position);
  if (distance > source.radius) {
    return 0;
  }

  const intensity = clamp(source.intensity, 0, 1);
  return (1 - distance / source.radius) * intensity * SENSOR_MAX_LEVEL;
}

function resolveOptions(options: SimulationOptions): Required<SimulationOptions> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };

  if (resolved.minRadioRangeRadius < 0) {
    throw new Error('Minimum radio range radius must be non-negative');
  }

  if (resolved.maxRadioRangeRadius < resolved.minRadioRangeRadius) {
    throw new Error('Maximum radio range radius must be greater than or equal to minimum radius');
  }

  if (resolved.defaultRadioRangeRadius < 0) {
    throw new Error('Default radio range radius must be non-negative');
  }

  if (!Number.isInteger(resolved.maxSignalStrength) || resolved.maxSignalStrength <= 0) {
    throw new Error('Maximum signal strength must be a positive integer');
  }

  return resolved;
}

function assertMode(
  state: SimulationState,
  allowedModes: SimulationMode[],
  action: string,
): void {
  if (!allowedModes.includes(state.mode)) {
    throw new Error(`Cannot ${action} simulation while mode is ${state.mode}`);
  }
}

function requireDevice(state: SimulationState, deviceId: DeviceId): DeviceRuntimeState {
  const device = state.devices[deviceId];
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  return device;
}

function assertPoint(point: Point, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label} must contain finite x and y coordinates`);
  }
}

function assertByteRange(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} must be an integer between 0 and 255`);
  }
}

function assertChannel(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 83) {
    throw new Error('radio channel must be an integer between 0 and 83');
  }
}

function assertSignalStrength(value: number, options: Required<SimulationOptions>): void {
  if (!Number.isInteger(value) || value < 0 || value > options.maxSignalStrength) {
    throw new Error(`radio signal strength must be an integer between 0 and ${options.maxSignalStrength}`);
  }
}

function distanceBetween(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function cloneEnvironmentSource(source: EnvironmentSource): EnvironmentSource {
  return {
    ...source,
    position: clonePoint(source.position),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

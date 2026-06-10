import { createBlankProject, type SwarmProject } from '../domain/project';
import { FEATURE_FLAGS } from '../runtime/featureFlags';
import {
  appendDeviceRuntimeLog,
  advanceSimulation,
  clearDeviceSoundEmitter,
  createSimulationState,
  moveDevice,
  pauseSimulation,
  radioRangeForSignalStrength,
  reconcileSimulationProject,
  resetSimulation,
  resumeSimulation,
  routeRadioPacket,
  setDeviceButton,
  setDeviceRadioConfig,
  setDeviceSoundEmitter,
  startSimulation,
} from './simulationEngine';

describe('simulation engine', () => {
  it('runs, pauses, resumes, advances time, and resets deterministically', () => {
    const project = makeProject();
    const initial = createSimulationState(project);
    const running = advanceSimulation(startSimulation(initial), 250);
    const paused = advanceSimulation(pauseSimulation(running), 500);
    const resumed = advanceSimulation(resumeSimulation(paused), 100);
    const reset = resetSimulation(project);

    expect(running.mode).toBe('running');
    expect(running.clockMs).toBe(250);
    expect(Object.values(running.devices).every((device) => device.lifecycle === 'running')).toBe(
      true,
    );
    expect(paused.mode).toBe('paused');
    expect(paused.clockMs).toBe(250);
    expect(resumed.clockMs).toBe(350);
    expect(reset).toEqual(initial);
  });

  it('routes radio packets by group, channel, and sender range', () => {
    const project = makeProject();
    let state = createSimulationState(project, {
      defaultRadioRangeRadius: 160,
      minRadioRangeRadius: 40,
      maxRadioRangeRadius: 240,
    });
    state = setDeviceRadioConfig(state, 'device-a', { group: 42, channel: 7 });
    state = setDeviceRadioConfig(state, 'device-b', { group: 42, channel: 7 });
    state = setDeviceRadioConfig(state, 'device-c', { group: 41, channel: 7 });
    state = setDeviceRadioConfig(state, 'device-d', { group: 42, channel: 8 });
    state = setDeviceRadioConfig(state, 'device-e', { group: 42, channel: 7 });

    const routed = routeRadioPacket(state, 'device-a', {
      data: new TextEncoder().encode('ping'),
      group: 42,
      channel: 7,
    });

    expect(routed.radioEvents).toHaveLength(1);
    expect(routed.radioEvents[0]?.recipients).toEqual(['device-b']);
    expect(routed.radioEvents[0]?.receivedPackets).toEqual([
      expect.objectContaining({
        deviceId: 'device-b',
        distance: 50,
        rssi: -45,
      }),
    ]);
    expect(routed.radioEvents[0]?.blockedTargets.map((target) => target.reason)).toEqual([
      'group-mismatch',
      'channel-mismatch',
      'out-of-range',
    ]);
    expect(routed.deviceLogs.some((log) => log.type === 'radio-received')).toBe(true);
  });

  it('records button input state and per-device logs', () => {
    const state = setDeviceButton(createSimulationState(makeProject()), 'device-a', 'A', true);

    expect(state.devices['device-a']?.buttons.A).toBe(true);
    expect(state.deviceLogs.at(-1)).toMatchObject({
      deviceId: 'device-a',
      type: 'button-input',
      message: 'Button A pressed',
    });
  });

  it('records runtime serial and error logs from adapters', () => {
    let state = createSimulationState(makeProject());

    state = appendDeviceRuntimeLog(state, 'device-a', 'serial-output', 'mp-receive');
    state = appendDeviceRuntimeLog(state, 'device-a', 'sound-output', 'Sound output started');
    state = appendDeviceRuntimeLog(state, 'device-a', 'runtime-error', 'simulator fault');

    expect(state.deviceLogs.slice(-3)).toMatchObject([
      { deviceId: 'device-a', type: 'serial-output', message: 'mp-receive' },
      { deviceId: 'device-a', type: 'sound-output', message: 'Sound output started' },
      { deviceId: 'device-a', type: 'runtime-error', message: 'simulator fault' },
    ]);
  });

  it('preserves observability state while reconciling project topology changes', () => {
    const project = makeProject();
    let state = createSimulationState(project);
    state = setDeviceRadioConfig(state, 'device-a', { group: 42, signalStrength: 0 });
    state = setDeviceRadioConfig(state, 'device-b', { group: 42 });
    state = setDeviceButton(state, 'device-a', 'A', true);
    state = routeRadioPacket(state, 'device-a', { data: new TextEncoder().encode('ping') });

    const reconciled = reconcileSimulationProject(state, {
      ...project,
      devices: [
        ...project.devices,
        { id: 'device-new', name: 'New', position: { x: 30, y: 0 } },
      ],
      environmentSources: [
        {
          id: 'light-new',
          type: 'light',
          name: 'Light New',
          position: { x: 30, y: 0 },
          radius: 120,
          intensity: 1,
        },
      ],
    });

    expect(reconciled.deviceLogs).toEqual(state.deviceLogs);
    expect(reconciled.radioEvents).toEqual(state.radioEvents);
    expect(reconciled.devices['device-a']?.buttons.A).toBe(true);
    expect(reconciled.devices['device-a']?.radio.group).toBe(42);
    expect(reconciled.devices['device-new']?.sensors.lightLevel).toBe(255);
    const linkToNewDevice = reconciled.radioLinks.find(
      (link) => link.sourceDeviceId === 'device-a' && link.targetDeviceId === 'device-new',
    );
    expect(linkToNewDevice).toBeDefined();
    expect(linkToNewDevice?.groupMatches).toBe(false);
  });

  it('maps signal strength to radio radius and recalculates links when devices move', () => {
    const project = makeProject();
    let state = createSimulationState(project, {
      minRadioRangeRadius: 40,
      maxRadioRangeRadius: 240,
    });

    expect(radioRangeForSignalStrength(0, state.options)).toBe(40);
    expect(radioRangeForSignalStrength(7, state.options)).toBe(240);

    state = setDeviceRadioConfig(state, 'device-a', { group: 42, signalStrength: 0 });
    state = setDeviceRadioConfig(state, 'device-b', { group: 42 });
    expect(linkFromAToB(state)?.canCommunicate).toBe(false);

    state = moveDevice(state, 'device-b', { x: 30, y: 0 });
    expect(linkFromAToB(state)?.canCommunicate).toBe(true);
  });

  it('computes recipient RSSI from tx power-derived range and distance', () => {
    const project = makeProject();
    let state = createSimulationState(project, {
      minRadioRangeRadius: 40,
      maxRadioRangeRadius: 240,
    });
    state = setDeviceRadioConfig(state, 'device-a', { group: 42, signalStrength: 7 });
    state = setDeviceRadioConfig(state, 'device-b', { group: 42 });

    state = moveDevice(state, 'device-b', { x: 0, y: 0 });
    const closeRssi = routeRadioPacket(state, 'device-a', {
      data: new TextEncoder().encode('ping'),
    }).radioEvents[0]?.receivedPackets[0]?.rssi;
    expect(closeRssi).toBe(-45);

    state = moveDevice(state, 'device-b', { x: 84, y: 0 });
    const touchingRssi = routeRadioPacket(state, 'device-a', {
      data: new TextEncoder().encode('ping'),
    }).radioEvents[0]?.receivedPackets[0]?.rssi;
    expect(touchingRssi).toBe(-45);

    state = moveDevice(state, 'device-b', { x: 240, y: 0 });
    const edgeRssi = routeRadioPacket(state, 'device-a', {
      data: new TextEncoder().encode('ping'),
    }).radioEvents[0]?.receivedPackets[0]?.rssi;
    expect(edgeRssi).toBe(-75);

    state = moveDevice(state, 'device-b', { x: 100, y: 0 });
    const lowPowerState = setDeviceRadioConfig(state, 'device-a', { signalStrength: 3 });
    const highPowerState = setDeviceRadioConfig(state, 'device-a', { signalStrength: 7 });
    const lowPowerRssi = routeRadioPacket(lowPowerState, 'device-a', {
      data: new TextEncoder().encode('ping'),
    }).radioEvents[0]?.receivedPackets[0]?.rssi;
    const highPowerRssi = routeRadioPacket(highPowerState, 'device-a', {
      data: new TextEncoder().encode('ping'),
    }).radioEvents[0]?.receivedPackets[0]?.rssi;
    expect(highPowerRssi).toBeGreaterThan(lowPowerRssi ?? Number.NEGATIVE_INFINITY);
  });

  it('calculates light and sound levels from environmental source radius and intensity', () => {
    const state = createSimulationState(makeProject());

    expect(state.devices['device-a']?.sensors).toMatchObject({ lightLevel: 255, soundLevel: 0 });
    expect(state.devices['device-b']?.sensors.lightLevel).toBe(128);
    expect(state.devices['device-c']?.sensors.soundLevel).toBe(128);
    expect(state.devices['device-e']?.sensors).toMatchObject({ lightLevel: 0, soundLevel: 0 });
  });

  it('projects transient runtime sound to nearby devices without self-hearing and clears it', () => {
    let state = createSimulationState(makeProject());

    state = setDeviceSoundEmitter(state, 'device-a', 255);

    expect(state.soundEmitters['device-a']).toMatchObject({
      deviceId: 'device-a',
      level: 255,
      radius: 220,
    });
    expect(state.devices['device-a']?.sensors.soundLevel).toBe(0);
    expect(state.devices['device-b']?.sensors.soundLevel).toBe(197);
    expect(state.devices['device-c']?.sensors.soundLevel).toBe(197);

    state = clearDeviceSoundEmitter(state, 'device-a');

    expect(state.soundEmitters['device-a']).toBeUndefined();
    expect(state.devices['device-b']?.sensors.soundLevel).toBe(0);
    expect(state.devices['device-c']?.sensors.soundLevel).toBe(128);
  });

  it('keeps sound merge semantics at max contribution instead of summing sources', () => {
    const state = setDeviceSoundEmitter(createSimulationState(makeProject()), 'device-a', 64);

    expect(state.devices['device-c']?.sensors.soundLevel).toBe(128);
  });

  it('recomputes runtime sound pickup when an emitting device moves', () => {
    let state = setDeviceSoundEmitter(createSimulationState(makeProject()), 'device-a', 255);

    expect(state.devices['device-b']?.sensors.soundLevel).toBe(197);

    state = moveDevice(state, 'device-a', { x: 500, y: 500 });

    expect(state.soundEmitters['device-a']?.position).toEqual({ x: 500, y: 500 });
    expect(state.devices['device-b']?.sensors.soundLevel).toBe(0);
  });

  it('projects magnet sources into fixed canvas-aligned magnetic readings', () => {
    const state = createSimulationState({
      ...makeProject(),
      devices: [
        { id: 'device-a', name: 'A', position: { x: 80, y: 0 } },
        { id: 'device-b', name: 'B', position: { x: 0, y: 80 } },
      ],
      environmentSources: [
        {
          id: 'magnet-1',
          type: 'magnet',
          name: 'Magnet 1',
          position: { x: 0, y: 0 },
          radius: 160,
          angleDeg: 0,
          strengthMicroTesla: 100,
        },
      ],
    });

    if (FEATURE_FLAGS.magnet) {
      expect(state.devices['device-a']?.sensors).toMatchObject({
        magneticForceX: 100,
        magneticForceY: 45,
        magneticForceZ: 0,
        magneticFieldStrength: 110,
      });
      expect(state.devices['device-b']?.sensors.magneticForceX).toBe(-50);
      return;
    }

    expect(state.devices['device-a']?.sensors).toMatchObject({
      magneticForceX: 0,
      magneticForceY: 45,
      magneticForceZ: 0,
      magneticFieldStrength: 45,
    });
    expect(state.devices['device-b']?.sensors.magneticForceX).toBe(0);
  });

  it('surfaces invalid lifecycle transitions and input values', () => {
    const state = createSimulationState(makeProject());

    expect(() => pauseSimulation(state)).toThrow('Cannot pause simulation while mode is idle');
    expect(() => advanceSimulation(state, -1)).toThrow('Simulation delta must be a non-negative');
    expect(() => setDeviceRadioConfig(state, 'device-a', { channel: 84 })).toThrow(
      'radio channel must be an integer between 0 and 83',
    );
  });

  it('rejects non-finite environment source intensity instead of producing NaN sensors', () => {
    expect(() =>
      createSimulationState({
        ...makeProject(),
        environmentSources: [
          {
            id: 'bad-light',
            type: 'light',
            name: 'Bad Light',
            position: { x: 0, y: 0 },
            radius: 100,
            intensity: Number.NaN,
          },
        ],
      }),
    ).toThrow('environment source bad-light intensity must be a finite number');
  });
});

function linkFromAToB(state: ReturnType<typeof createSimulationState>) {
  return state.radioLinks.find(
    (link) => link.sourceDeviceId === 'device-a' && link.targetDeviceId === 'device-b',
  );
}

function makeProject(): SwarmProject {
  return {
    ...createBlankProject({
      id: 'project-1',
      name: 'Radio swarm',
      now: '2026-05-16T04:20:00.000Z',
    }),
    devices: [
      { id: 'device-a', name: 'A', position: { x: 0, y: 0 } },
      { id: 'device-b', name: 'B', position: { x: 50, y: 0 } },
      { id: 'device-c', name: 'C', position: { x: 0, y: 50 } },
      { id: 'device-d', name: 'D', position: { x: 60, y: 0 } },
      { id: 'device-e', name: 'E', position: { x: 500, y: 500 } },
    ],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        name: 'Light 1',
        position: { x: 0, y: 0 },
        radius: 100,
        intensity: 1,
      },
      {
        id: 'sound-1',
        type: 'sound',
        name: 'Sound 1',
        position: { x: 0, y: 100 },
        radius: 100,
        intensity: 1,
      },
    ],
  };
}

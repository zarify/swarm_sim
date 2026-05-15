import { createBlankProject, type SwarmProject } from '../domain/project';
import {
  advanceSimulation,
  createSimulationState,
  moveDevice,
  pauseSimulation,
  radioRangeForSignalStrength,
  resetSimulation,
  resumeSimulation,
  routeRadioPacket,
  setDeviceRadioConfig,
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
    expect(routed.radioEvents[0]?.blockedTargets.map((target) => target.reason)).toEqual([
      'group-mismatch',
      'channel-mismatch',
      'out-of-range',
    ]);
    expect(routed.deviceLogs.some((log) => log.type === 'radio-received')).toBe(true);
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

  it('calculates light and sound levels from environmental source radius and intensity', () => {
    const state = createSimulationState(makeProject());

    expect(state.devices['device-a']?.sensors).toEqual({ lightLevel: 255, soundLevel: 0 });
    expect(state.devices['device-b']?.sensors.lightLevel).toBe(128);
    expect(state.devices['device-c']?.sensors.soundLevel).toBe(128);
    expect(state.devices['device-e']?.sensors).toEqual({ lightLevel: 0, soundLevel: 0 });
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
        position: { x: 0, y: 0 },
        radius: 100,
        intensity: 1,
      },
      {
        id: 'sound-1',
        type: 'sound',
        position: { x: 0, y: 100 },
        radius: 100,
        intensity: 1,
      },
    ],
  };
}

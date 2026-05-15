import { createBlankProject, type SwarmProject } from '../domain/project';
import { deserializeProject, serializeProject } from '../domain/projectSerialization';
import {
  createSimulationState,
  moveDevice,
  resetSimulation,
  routeRadioPacket,
  setDeviceRadioConfig,
} from '../simulation/simulationEngine';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';
import microPythonBeaconHex from '../../hex_files/mp_beacon.hex?raw';

const now = '2026-05-16T04:20:00.000Z';
const encoder = new TextEncoder();

describe('MVP acceptance coverage', () => {
  it('exports and imports a portable project containing both provided HEX artifacts', () => {
    const project = makeTenDeviceProject();
    const reopened = deserializeProject(serializeProject(project));

    expect(reopened).toMatchObject({
      id: project.id,
      name: project.name,
      devices: project.devices,
      environmentSources: project.environmentSources,
    });
    expect(reopened.devices).toHaveLength(10);
    expect(reopened.artifacts.map((artifact) => artifact.runtimeSource)).toEqual([
      'makecode-pxt',
      'micropython',
    ]);
    expect(reopened.artifacts.map((artifact) => [...artifact.bytes])).toEqual(
      project.artifacts.map((artifact) => [...artifact.bytes]),
    );
  });

  it('routes radio across 10 devices and immediately reflects movement out of range', () => {
    let state = createSimulationState(makeTenDeviceProject(), { defaultRadioRangeRadius: 170 });
    for (const deviceId of Object.keys(state.devices)) {
      state = setDeviceRadioConfig(state, deviceId, { group: 42, channel: 7 });
    }

    const beforeMove = routeRadioPacket(state, 'device-1', {
      data: encoder.encode('ping'),
      group: 42,
      channel: 7,
    });
    state = moveDevice(state, 'device-10', { x: 720, y: 420 });
    const afterMove = routeRadioPacket(state, 'device-1', {
      data: encoder.encode('ping'),
      group: 42,
      channel: 7,
    });

    expect(beforeMove.radioEvents[0]?.recipients).toHaveLength(9);
    expect(afterMove.radioEvents[0]?.recipients).not.toContain('device-10');
    expect(afterMove.radioEvents[0]?.blockedTargets).toContainEqual(
      expect.objectContaining({ deviceId: 'device-10', reason: 'out-of-range' }),
    );
  });

  it('reopens and resets deterministically from serialized project data', () => {
    const reopened = deserializeProject(serializeProject(makeTenDeviceProject()));
    const initial = createSimulationState(reopened);
    const changed = routeRadioPacket(
      moveDevice(initial, 'device-2', { x: 480, y: 80 }),
      'device-1',
      { data: encoder.encode('ping') },
    );
    const reset = resetSimulation(reopened);

    expect(changed).not.toEqual(initial);
    expect(reset).toEqual(initial);
  });
});

function makeTenDeviceProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'acceptance-project', name: 'Acceptance swarm', now }),
    artifacts: [
      {
        id: 'artifact-makecode',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: encoder.encode(makeCodeBeaconHex),
        createdAt: now,
      },
      {
        id: 'artifact-micropython',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: encoder.encode(microPythonBeaconHex),
        createdAt: now,
      },
    ],
    devices: Array.from({ length: 10 }, (_, index) => ({
      id: `device-${index + 1}`,
      name: `Node ${index + 1}`,
      position: {
        x: 100 + (index % 5) * 35,
        y: 100 + Math.floor(index / 5) * 35,
      },
      programArtifactId: index % 2 === 0 ? 'artifact-makecode' : 'artifact-micropython',
    })),
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        position: { x: 130, y: 130 },
        radius: 180,
        intensity: 0.75,
      },
      {
        id: 'sound-1',
        type: 'sound',
        position: { x: 210, y: 130 },
        radius: 160,
        intensity: 0.65,
      },
    ],
  };
}

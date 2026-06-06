import { createBlankProject, type SwarmProject } from '../domain/project';
import { decodeProjectBundle, encodeProjectBundle } from '../domain/projectBundle';
import { loadProjectRuntimePrograms } from '../runtime/programLoader';
import type { RuntimeProgram } from '../runtime/runtimeAdapter';
import {
  createSimulationState,
  moveDevice,
  resetSimulation,
  routeRadioPacket,
  setDeviceRadioConfig,
} from '../simulation/simulationEngine';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';
import microPythonBeaconHex from '../../hex_files/mp_beacon.hex?raw';
import { decompress } from 'lzma';

const now = '2026-05-16T04:20:00.000Z';
const encoder = new TextEncoder();
const makeCodeBeaconBytes = encoder.encode(makeCodeBeaconHex);
const microPythonBeaconBytes = encoder.encode(microPythonBeaconHex);

describe('MVP acceptance coverage', () => {
  it('exports and imports a portable project containing both provided HEX artifacts', async () => {
    const project = makeTenDeviceProject();
    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

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
    expect(equalBytes(reopened.artifacts[0]?.bytes, project.artifacts[0]?.bytes)).toBe(true);
    expect(equalBytes(reopened.artifacts[1]?.bytes, project.artifacts[1]?.bytes)).toBe(true);
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

  it('reopens and resets deterministically from serialized project data', async () => {
    const reopened = await decodeProjectBundle(await encodeProjectBundle(makeTenDeviceProject()));
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

  it('prepares mixed MakeCode and MicroPython runtime programs from real fixture HEX artifacts', async () => {
    const flashed: RuntimeProgram[] = [];
    const results = await loadProjectRuntimePrograms(makeTwoDeviceProject(), {
      decompressLzma: (bytes) =>
        new Promise((resolve, reject) => {
          decompress(bytes, (result, error) => {
            if (error) {
              reject(error);
              return;
            }
            if (typeof result !== 'string') {
              reject(new Error('Expected LZMA output to be decoded source text'));
              return;
            }
            resolve(result);
          });
        }),
      createAdapter: ({ runtimeSource }) => ({
        name: `${runtimeSource} acceptance adapter`,
        source: runtimeSource,
        evaluateArtifact: () => ({
          artifactKind: 'hex',
          runtimeSource,
          sourceEvidence: [],
          canExecuteNow: true,
          verdict: 'acceptance adapter',
          capabilities: [],
        }),
        flash: async (program) => {
          flashed.push(program);
        },
        reset: async () => {},
        stop: async () => {},
        setButton: async () => {},
        setSensor: async () => {},
        sendRadio: async () => {},
        onEvent: () => () => {},
      }),
    });
    expect(results).toHaveLength(2);
    expect(flashed.map((program) => program.source)).toContain('makecode-pxt');
    expect(flashed.map((program) => program.source)).toContain('micropython');
    const makeCodeProgram = flashed.find((program) => program.source === 'makecode-pxt');
    expect(makeCodeProgram).toBeDefined();
    if (makeCodeProgram?.source !== 'makecode-pxt') {
      throw new Error('Expected MakeCode runtime program');
    }
    expect(makeCodeProgram.sourceFiles?.['main.ts']).toContain('radio.sendString("ping")');
  }, 20000);
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
        bytes: makeCodeBeaconBytes,
        createdAt: now,
      },
      {
        id: 'artifact-micropython',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: microPythonBeaconBytes,
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
        name: 'Light 1',
        position: { x: 130, y: 130 },
        radius: 180,
        intensity: 0.75,
      },
      {
        id: 'sound-1',
        type: 'sound',
        name: 'Sound 1',
        position: { x: 210, y: 130 },
        radius: 160,
        intensity: 0.65,
      },
    ],
  };
}

function makeTwoDeviceProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'acceptance-runtime-project', name: 'Acceptance runtime', now }),
    artifacts: [
      {
        id: 'artifact-makecode',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: makeCodeBeaconBytes,
        createdAt: now,
      },
      {
        id: 'artifact-micropython',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: microPythonBeaconBytes,
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-mc',
        name: 'MakeCode',
        position: { x: 120, y: 120 },
        programArtifactId: 'artifact-makecode',
      },
      {
        id: 'device-mp',
        name: 'MicroPython',
        position: { x: 220, y: 120 },
        programArtifactId: 'artifact-micropython',
      },
    ],
    environmentSources: [],
  };
}

function equalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

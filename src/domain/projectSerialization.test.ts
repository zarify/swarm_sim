import { createBlankProject, type SwarmProject } from './project';
import { deserializeProject, serializeProject } from './projectSerialization';

const now = '2026-05-16T04:20:00.000Z';

describe('project serialization', () => {
  it('creates a blank schema-versioned project', () => {
    const project = createBlankProject({ id: 'project-1', name: 'Radio swarm', now });

    expect(project).toMatchObject({
      schemaVersion: 1,
      id: 'project-1',
      name: 'Radio swarm',
      createdAt: now,
      updatedAt: now,
      devices: [],
      artifacts: [],
      environmentSources: [],
    });
  });

  it('round-trips a self-contained project with artifact bytes', () => {
    const project = makeProject();
    const roundTripped = deserializeProject(serializeProject(project));

    expect(roundTripped).toEqual(project);
    expect([...roundTripped.artifacts[0]!.bytes]).toEqual([1, 2, 3, 255]);
  });

  it('rejects unsupported schema versions', () => {
    const serialized = serializeProject(makeProject()).replace('"schemaVersion": 1', '"schemaVersion": 99');

    expect(() => deserializeProject(serialized)).toThrow('Unsupported project schema version: 99');
  });

  it('rejects invalid environment source types', () => {
    const serialized = serializeProject(makeProject()).replace('"type": "light"', '"type": "heat"');

    expect(() => deserializeProject(serialized)).toThrow('Invalid environment source type: heat');
  });

  it('rejects malformed project JSON shape', () => {
    expect(() => deserializeProject('{"schemaVersion":1,"devices":[]}')).toThrow(
      'Expected id to be a non-empty string',
    );
  });
});

function makeProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'project-1', name: 'Radio swarm', now }),
    updatedAt: '2026-05-16T04:21:00.000Z',
    artifacts: [
      {
        id: 'artifact-1',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: new Uint8Array([1, 2, 3, 255]),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-1',
        name: 'Beacon A',
        position: { x: 120, y: 80 },
        programArtifactId: 'artifact-1',
      },
    ],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        position: { x: 40, y: 20 },
        radius: 160,
        intensity: 0.8,
      },
    ],
  };
}

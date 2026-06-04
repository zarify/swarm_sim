import { createBlankProject, type SwarmProject } from './project';
import { deserializeProject, serializeProject } from './projectSerialization';

const now = '2026-05-16T04:20:00.000Z';

describe('project serialization', () => {
  it('creates a blank schema-versioned project', () => {
    const project = createBlankProject({ id: 'project-1', name: 'Radio swarm', now });

    expect(project).toMatchObject({
      schemaVersion: 3,
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
    const serialized = serializeProject(makeProject()).replace('"schemaVersion": 3', '"schemaVersion": 99');

    expect(() => deserializeProject(serialized)).toThrow('Unsupported project schema version: 99');
  });

  it('rejects invalid environment source types', () => {
    const serialized = serializeProject(makeProject()).replace('"type": "light"', '"type": "heat"');

    expect(() => deserializeProject(serialized)).toThrow('Invalid environment source type: heat');
  });

  it('fills fallback names for legacy environment sources without name', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      environmentSources: Array<Record<string, unknown>>;
    };
    delete parsed.environmentSources[0]?.name;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.environmentSources[0]?.name).toBe('Light 1');
  });

  it('migrates schema v1 projects to the current schema version', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 1;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(3);
    expect(deserialized.environmentSources[0]?.type).toBe('light');
  });

  it('migrates schema v2 projects to the current schema version', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 2;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(3);
    expect(deserialized.devices[0]?.editableProgram).toBeDefined();
  });

  it('round-trips magnet sources and editable programs in schema v3 projects', () => {
    const project: SwarmProject = {
      ...makeProject(),
      environmentSources: [
        {
          id: 'magnet-1',
          type: 'magnet',
          name: 'Magnet 1',
          position: { x: 20, y: 30 },
          radius: 200,
          angleDeg: 90,
          strengthMicroTesla: 180,
        },
      ],
    };

    expect(deserializeProject(serializeProject(project))).toEqual(project);
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
        editableProgram: {
          runtimeSource: 'makecode-pxt',
          baseArtifactId: 'artifact-1',
          revision: 2,
          updatedAt: '2026-05-16T04:22:00.000Z',
          sourceFiles: {
            'main.ts': 'radio.sendString("ping")',
            'pxt.json': '{"name":"mc_beacon"}',
          },
          projectMetadata: {
            editor: 'tsprj',
          },
        },
      },
    ],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        name: 'Light 1',
        position: { x: 40, y: 20 },
        radius: 160,
        intensity: 0.8,
      },
    ],
  };
}

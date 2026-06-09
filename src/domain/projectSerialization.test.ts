import { createBlankProject, type SwarmProject } from './project';
import { deserializeProject, serializeProject } from './projectSerialization';

const now = '2026-05-16T04:20:00.000Z';

describe('project serialization', () => {
  it('creates a blank schema-versioned project', () => {
    const project = createBlankProject({ id: 'project-1', name: 'Radio swarm', now });

    expect(project).toMatchObject({
      schemaVersion: 8,
      id: 'project-1',
      name: 'Radio swarm',
      createdAt: now,
      updatedAt: now,
      viewOptions: {
        showRadioRange: true,
      },
      devices: [],
      artifacts: [],
      environmentSources: [],
    });
  });

  it('round-trips a self-contained project with persisted extracted artifact programs', () => {
    const project = makeProject();
    const roundTripped = deserializeProject(serializeProject(project));

    expect(roundTripped).toEqual(project);
    expect(roundTripped.artifacts[0]).toMatchObject({
      runtimeSource: 'makecode-pxt',
      program: {
        runtimeSource: 'makecode-pxt',
        sourceFiles: {
          'main.ts': 'radio.sendString("ping")',
        },
      },
    });
  });

  it('deserializes legacy byte-backed artifacts from older schema payloads', () => {
    const legacyProject = {
      ...makeProject(),
      schemaVersion: 6,
      artifacts: [
        {
          id: 'artifact-legacy',
          name: 'legacy.hex',
          artifactKind: 'hex',
          runtimeSource: 'micropython',
          bytesBase64: 'AQID/w==',
          createdAt: now,
        },
      ],
      devices: [
        {
          id: 'device-1',
          name: 'Beacon A',
          position: { x: 120, y: 80 },
          programArtifactId: 'artifact-legacy',
        },
      ],
    };

    expect(deserializeProject(JSON.stringify(legacyProject))).toMatchObject({
      schemaVersion: 8,
      artifacts: [
        {
          id: 'artifact-legacy',
          runtimeSource: 'micropython',
          bytes: new Uint8Array([1, 2, 3, 255]),
        },
      ],
    });
  });

  it('rejects unsupported schema versions', () => {
    const serialized = serializeProject(makeProject()).replace('"schemaVersion": 8', '"schemaVersion": 99');

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
    expect(deserialized.schemaVersion).toBe(8);
    expect(deserialized.environmentSources[0]?.type).toBe('light');
  });

  it('migrates schema v2 projects to the current schema version', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 2;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(8);
    expect(deserialized.devices[0]?.editableProgram).toBeDefined();
  });

  it('migrates schema v3 projects to the current schema version with unlocked defaults', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 3;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(8);
    expect(deserialized.devices[0]?.locked).toBeUndefined();
  });

  it('migrates schema v4 projects to the current schema version with unlocked position defaults', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 4;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(8);
    expect(deserialized.devices[0]?.positionPinned).toBeUndefined();
  });

  it('migrates schema v5 projects to the current schema version', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 5;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(8);
  });

  it('migrates schema v7 projects to the current schema version with default view options', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.schemaVersion = 7;
    delete parsed.viewOptions;

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.schemaVersion).toBe(8);
    expect(deserialized.viewOptions.showRadioRange).toBe(true);
  });

  it('round-trips custom canvas instructions', () => {
    const project = {
      ...makeProject(),
      instructionsMarkdown: '# Lesson\n\n- Press `A`\n- Watch the log',
    } satisfies SwarmProject;

    expect(deserializeProject(serializeProject(project))).toEqual(project);
  });

  it('normalizes blank instructions to the default quick-start state', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as Record<string, unknown>;
    parsed.instructionsMarkdown = ' \n\n ';

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.instructionsMarkdown).toBeUndefined();
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

  it('drops persisted editable source from locked devices during deserialization', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      devices: Array<Record<string, unknown>>;
    };
    parsed.devices[0] = {
      ...parsed.devices[0],
      locked: true,
    };

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.devices[0]).toMatchObject({
      locked: true,
      programArtifactId: 'artifact-1',
    });
    expect(deserialized.devices[0]?.editableProgram).toBeUndefined();
  });

  it('round-trips persisted view options and node pinning', () => {
    const project: SwarmProject = {
      ...makeProject(),
      viewOptions: {
        showRadioRange: false,
      },
      devices: [
        {
          id: 'device-locked',
          name: 'Mystery node',
          position: { x: 120, y: 80 },
          locked: true,
          positionPinned: true,
          programArtifactId: 'artifact-1',
        },
        {
          id: 'device-2',
          name: 'Free node',
          position: { x: 200, y: 120 },
          positionPinned: true,
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
          locked: true,
          positionPinned: true,
        },
      ],
    };

    expect(deserializeProject(serializeProject(project))).toEqual(project);
  });

  it('migrates legacy locked-device position locking into pinned state', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      schemaVersion: number;
      devices: Array<Record<string, unknown>>;
    };
    parsed.schemaVersion = 7;
    parsed.devices[0] = {
      ...parsed.devices[0],
      locked: true,
      positionLocked: true,
    };

    const deserialized = deserializeProject(JSON.stringify(parsed));
    expect(deserialized.devices[0]).toMatchObject({
      locked: true,
      positionPinned: true,
    });
  });

  it('rejects malformed locked flags', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      devices: Array<Record<string, unknown>>;
    };
    parsed.devices[0] = {
      ...parsed.devices[0],
      locked: 'yes',
    };

    expect(() => deserializeProject(JSON.stringify(parsed))).toThrow(
      'Expected device.locked to be a boolean',
    );
  });

  it('rejects malformed legacy position-locked flags', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      devices: Array<Record<string, unknown>>;
    };
    parsed.devices[0] = {
      ...parsed.devices[0],
      locked: true,
      positionLocked: 'yes',
    };

    expect(() => deserializeProject(JSON.stringify(parsed))).toThrow(
      'Expected device.positionLocked to be a boolean',
    );
  });

  it('rejects position locking on unlocked devices', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      devices: Array<Record<string, unknown>>;
    };
    parsed.devices[0] = {
      ...parsed.devices[0],
      positionLocked: true,
    };

    expect(() => deserializeProject(JSON.stringify(parsed))).toThrow(
      'device.positionLocked requires device.locked to be true',
    );
  });

  it('rejects malformed position-pinned flags', () => {
    const parsed = JSON.parse(serializeProject(makeProject())) as {
      devices: Array<Record<string, unknown>>;
    };
    parsed.devices[0] = {
      ...parsed.devices[0],
      positionPinned: 'yes',
    };

    expect(() => deserializeProject(JSON.stringify(parsed))).toThrow(
      'Expected device.positionPinned to be a boolean',
    );
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
        program: {
          runtimeSource: 'makecode-pxt',
          sourceFiles: {
            'main.ts': 'radio.sendString("ping")',
            'pxt.json': '{"name":"mc_beacon"}',
          },
          projectMetadata: {
            editor: 'tsprj',
          },
        },
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

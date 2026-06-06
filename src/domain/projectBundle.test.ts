import { createBlankProject, type SwarmProject } from './project';
import { decodeProjectBundle, encodeProjectBundle } from './projectBundle';

const now = '2026-05-18T04:20:00.000Z';
const encoder = new TextEncoder();

describe('project bundle codec', () => {
  it('round-trips projects and deduplicates repeated artifact bytes', async () => {
    const project = makeProjectWithDuplicateArtifacts();

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.devices.map((device) => device.programArtifactId)).toEqual(['artifact-a', 'artifact-a']);
    expect(reopened.artifacts).toHaveLength(1);
    expect(reopened.artifacts[0]?.id).toBe('artifact-a');
    expect(reopened.artifacts[0]?.runtimeSource).toBe('micropython');
    expect([...reopened.artifacts[0]!.bytes]).toEqual([...encoder.encode(':10000000ABCDEF')]);
  });

  it('rejects legacy json payloads', async () => {
    const legacyBytes = encoder.encode('{"schemaVersion":1}');

    await expect(decodeProjectBundle(legacyBytes)).rejects.toThrow('Unsupported canvas bundle format');
  });

  it('round-trips mixed MakeCode and MicroPython artifact assignments', async () => {
    const project = makeMixedRuntimeProject();

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    const artifactsById = new Map(reopened.artifacts.map((artifact) => [artifact.id, artifact]));
    expect(reopened.devices.map((device) => device.programArtifactId)).toEqual([
      'artifact-mc',
      'artifact-mp',
    ]);
    expect(artifactsById.get('artifact-mc')?.runtimeSource).toBe('makecode-pxt');
    expect(artifactsById.get('artifact-mp')?.runtimeSource).toBe('micropython');
    expect([...artifactsById.get('artifact-mc')!.bytes]).toEqual([...encoder.encode(':10000000MAKECODE')]);
    expect([...artifactsById.get('artifact-mp')!.bytes]).toEqual([...encoder.encode(':10000000MICROPY')]);
  });

  it('round-trips custom instructions inside canvas bundles', async () => {
    const project: SwarmProject = {
      ...makeMixedRuntimeProject(),
      instructionsMarkdown: '# Class activity\n\n1. Flash both nodes\n2. Compare results',
    };

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.instructionsMarkdown).toBe(project.instructionsMarkdown);
  });

  it('round-trips locked devices without restoring editable source', async () => {
    const project: SwarmProject = {
      ...createBlankProject({ id: 'project-3', name: 'Locked bundle', now }),
      artifacts: [
        {
          id: 'artifact-locked',
          name: 'locked.hex',
          artifactKind: 'hex',
          runtimeSource: 'micropython',
          bytes: encoder.encode(':10000000LOCKED'),
          createdAt: now,
        },
      ],
      devices: [
        {
          id: 'device-locked',
          name: 'Mystery node',
          locked: true,
          positionLocked: true,
          position: { x: 120, y: 80 },
          programArtifactId: 'artifact-locked',
        },
      ],
    };

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.devices[0]).toMatchObject({
      id: 'device-locked',
      locked: true,
      positionLocked: true,
      programArtifactId: 'artifact-locked',
    });
    expect(reopened.devices[0]?.editableProgram).toBeUndefined();
  });
});

function makeProjectWithDuplicateArtifacts(): SwarmProject {
  const bytes = encoder.encode(':10000000ABCDEF');
  return {
    ...createBlankProject({ id: 'project-1', name: 'Bundle test', now }),
    artifacts: [
      {
        id: 'artifact-a',
        name: 'shared.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes,
        createdAt: now,
      },
      {
        id: 'artifact-b',
        name: 'shared-copy.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: new Uint8Array(bytes),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 10, y: 20 },
        programArtifactId: 'artifact-a',
      },
      {
        id: 'device-2',
        name: 'Node 2',
        position: { x: 30, y: 40 },
        programArtifactId: 'artifact-b',
      },
    ],
  };
}

function makeMixedRuntimeProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'project-2', name: 'Mixed runtime bundle', now }),
    artifacts: [
      {
        id: 'artifact-mc',
        name: 'mc.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: encoder.encode(':10000000MAKECODE'),
        createdAt: now,
      },
      {
        id: 'artifact-mp',
        name: 'mp.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: encoder.encode(':10000000MICROPY'),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-a',
        name: 'Node A',
        position: { x: 40, y: 40 },
        programArtifactId: 'artifact-mc',
      },
      {
        id: 'device-b',
        name: 'Node B',
        position: { x: 80, y: 80 },
        programArtifactId: 'artifact-mp',
      },
    ],
  };
}

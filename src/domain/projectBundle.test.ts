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

import { createBlankProject, type SwarmProject } from './project';
import { decodeProjectBundle, encodeProjectBundle } from './projectBundle';

const now = '2026-05-18T04:20:00.000Z';
const encoder = new TextEncoder();

describe('project bundle codec', () => {
  it('round-trips projects and deduplicates repeated extracted artifact programs', async () => {
    const project = makeProjectWithDuplicateArtifacts();

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.devices.map((device) => device.programArtifactId)).toEqual(['artifact-a', 'artifact-a']);
    expect(reopened.artifacts).toHaveLength(1);
    expect(reopened.artifacts[0]?.id).toBe('artifact-a');
    expect(reopened.artifacts[0]?.runtimeSource).toBe('micropython');
    expect(reopened.artifacts[0]).toMatchObject({
      program: {
        runtimeSource: 'micropython',
        filesystemBase64: {
          'main.py': btoa('print("ABCDEF")'),
        },
      },
    });
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
    expect(artifactsById.get('artifact-mc')).toMatchObject({
      program: {
        runtimeSource: 'makecode-pxt',
        sourceFiles: {
          'main.ts': 'basic.showString("MC")',
        },
      },
    });
    expect(artifactsById.get('artifact-mp')).toMatchObject({
      program: {
        runtimeSource: 'micropython',
        filesystemBase64: {
          'main.py': btoa('print("MP")'),
        },
      },
    });
  });

  it('round-trips custom instructions inside canvas bundles', async () => {
    const project: SwarmProject = {
      ...makeMixedRuntimeProject(),
      instructionsMarkdown: '# Class activity\n\n1. Flash both nodes\n2. Compare results',
    };

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.instructionsMarkdown).toBe(project.instructionsMarkdown);
  });

  it('round-trips view options and locked source pinning inside canvas bundles', async () => {
    const project: SwarmProject = {
      ...makeMixedRuntimeProject(),
      viewOptions: {
        showRadioRange: false,
      },
      environmentSources: [
        {
          id: 'light-1',
          type: 'light',
          name: 'Light 1',
          position: { x: 140, y: 90 },
          radius: 200,
          intensity: 0.75,
          locked: true,
          positionPinned: true,
        },
      ],
    };

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.viewOptions).toEqual(project.viewOptions);
    expect(reopened.environmentSources).toEqual(project.environmentSources);
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
          positionPinned: true,
          position: { x: 120, y: 80 },
          programArtifactId: 'artifact-locked',
        },
      ],
    };

    const reopened = await decodeProjectBundle(await encodeProjectBundle(project));

    expect(reopened.devices[0]).toMatchObject({
      id: 'device-locked',
      locked: true,
      positionPinned: true,
      programArtifactId: 'artifact-locked',
    });
    expect(reopened.devices[0]?.editableProgram).toBeUndefined();
  });
});

function makeProjectWithDuplicateArtifacts(): SwarmProject {
  const bytes = encoder.encode(makeMicroPythonHex('print("ABCDEF")'));
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
        bytes: encoder.encode(makeMakeCodeHex({ 'main.ts': 'basic.showString("MC")' })),
        createdAt: now,
      },
      {
        id: 'artifact-mp',
        name: 'mp.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: encoder.encode(makeMicroPythonHex('print("MP")')),
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

function makeMakeCodeHex(sourceFiles: Record<string, string>): string {
  const metadata = encoder.encode('{}');
  const sourceText = encoder.encode(JSON.stringify(sourceFiles));
  const header = new Uint8Array(16);
  header.set([0x41, 0x14, 0x0e, 0x2f, 0xb8, 0x2f, 0xa2, 0xbb]);
  writeUInt16LE(header, 8, metadata.length);
  writeUInt32LE(header, 10, sourceText.length);

  return [
    makeHexRecord(0x0000, 0x0e, [...header]),
    ...chunkBytes(new Uint8Array([...metadata, ...sourceText]), 16).map((chunk, index) =>
      makeHexRecord(0x0010 + index * 16, 0x0e, [...chunk]),
    ),
    makeHexRecord(0x0000, 0x01, []),
  ].join('\n');
}

function makeMicroPythonHex(mainPy: string): string {
  const filename = encoder.encode('main.py');
  const source = encoder.encode(mainPy);
  const chunk = new Uint8Array(128).fill(0xff);
  const dataStart = 3 + filename.length;
  chunk[0] = 0xfe;
  chunk[1] = dataStart + source.length - 1;
  chunk[2] = filename.length;
  chunk.set(filename, 3);
  chunk.set(source, dataStart);

  return [
    ...chunkBytes(chunk, 16).map((record, index) => makeHexRecord(index * 16, 0x00, [...record])),
    makeHexRecord(0x0000, 0x01, []),
  ].join('\n');
}

function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function writeUInt16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUInt32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const byteCount = data.length;
  const bytes = [
    byteCount,
    (address >> 8) & 0xff,
    address & 0xff,
    recordType,
    ...data,
  ];
  const checksum = ((~bytes.reduce((sum, byte) => sum + byte, 0) + 1) & 0xff) >>> 0;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

import { createBlankProject, type SwarmProject } from '../domain/project';
import type { MicrobitRuntimeAdapter, RuntimeProgram } from './runtimeAdapter';
import { loadProjectRuntimePrograms } from './programLoader';

const now = '2026-05-16T05:20:00.000Z';
const encoder = new TextEncoder();

describe('project runtime program loading', () => {
  it('extracts assigned HEX artifacts and flashes each prepared program through a matching adapter', async () => {
    const flashed: RuntimeProgram[] = [];
    const results = await loadProjectRuntimePrograms(makeProject(), {
      createAdapter: ({ runtimeSource }) => makeAdapter(runtimeSource, flashed),
    });

    expect(results.map((result) => result.status)).toEqual(['loaded', 'loaded', 'skipped']);
    expect(flashed.map((program) => program.source)).toEqual(['makecode-pxt', 'micropython']);

    const makeCode = results[0]?.program;
    expect(makeCode?.source).toBe('makecode-pxt');
    if (makeCode?.source !== 'makecode-pxt') {
      throw new Error('Expected MakeCode program');
    }
    expect(makeCode.sourceFiles?.['main.ts']).toContain('radio.sendString("ping")');

    const microPython = results[1]?.program;
    expect(microPython?.source).toBe('micropython');
    if (microPython?.source !== 'micropython') {
      throw new Error('Expected MicroPython program');
    }
    expect(new TextDecoder().decode(microPython.filesystem['main.py'])).toContain(
      'radio.send("ping")',
    );
  });

  it('prepares a runtime program without flashing when no adapter is supplied', async () => {
    const results = await loadProjectRuntimePrograms(makeProject());

    expect(results[0]).toMatchObject({
      status: 'prepared',
      runtimeSource: 'makecode-pxt',
      diagnostic: 'Runtime program extracted; no adapter was provided for flashing',
    });
  });

  it('fails loudly when artifact metadata disagrees with extracted source', async () => {
    const project = {
      ...makeProject(),
      artifacts: [
        {
          id: 'artifact-mp',
          name: 'mp_beacon.hex',
          artifactKind: 'hex',
          runtimeSource: 'makecode-pxt',
          bytes: encoder.encode(makeMicroPythonHex('radio.send("ping")')),
          createdAt: now,
        },
      ],
      devices: [{ id: 'device-mismatch', name: 'Mismatch', position: { x: 0, y: 0 }, programArtifactId: 'artifact-mp' }],
    } satisfies SwarmProject;

    const results = await loadProjectRuntimePrograms(project);

    expect(results[0]).toMatchObject({
      status: 'failed',
      runtimeSource: 'micropython',
      diagnostic:
        'Artifact metadata says makecode-pxt, but HEX source extraction found micropython',
    });
  });

  it('reports adapter factory failures per device instead of aborting the whole project load', async () => {
    const results = await loadProjectRuntimePrograms(makeProject(), {
      createAdapter: ({ runtimeSource }) => {
        if (runtimeSource === 'makecode-pxt') {
          throw new Error('MakeCode adapter unavailable');
        }

        return makeAdapter(runtimeSource, []);
      },
    });

    expect(results.map((result) => result.status)).toEqual(['failed', 'loaded', 'skipped']);
    expect(results[0]).toMatchObject({
      status: 'failed',
      runtimeSource: 'makecode-pxt',
      diagnostic: 'MakeCode adapter unavailable',
    });
  });

  it('prefers persisted editable device programs over re-extracting artifact bytes', async () => {
    const flashed: RuntimeProgram[] = [];
    const project = makeProject();
    project.devices[0] = {
      ...project.devices[0]!,
      editableProgram: {
        runtimeSource: 'makecode-pxt',
        baseArtifactId: 'artifact-mc',
        revision: 1,
        updatedAt: now,
        sourceFiles: {
          'main.ts': 'radio.sendString("edited")',
          'pxt.json': '{"name":"edited"}',
        },
      },
    };
    project.devices[1] = {
      ...project.devices[1]!,
      editableProgram: {
        runtimeSource: 'micropython',
        baseArtifactId: 'artifact-mp',
        revision: 3,
        updatedAt: now,
        files: {
          'main.py': 'radio.send("edited")',
        },
      },
    };

    const results = await loadProjectRuntimePrograms(project, {
      createAdapter: ({ runtimeSource }) => makeAdapter(runtimeSource, flashed),
    });

    expect(results.map((result) => result.status)).toEqual(['loaded', 'loaded', 'skipped']);
    const makeCode = flashed[0];
    expect(makeCode?.source).toBe('makecode-pxt');
    if (makeCode?.source !== 'makecode-pxt') {
      throw new Error('Expected edited MakeCode program');
    }
    expect(makeCode.sourceFiles?.['main.ts']).toContain('edited');

    const microPython = flashed[1];
    expect(microPython?.source).toBe('micropython');
    if (microPython?.source !== 'micropython') {
      throw new Error('Expected edited MicroPython program');
    }
    expect(new TextDecoder().decode(microPython.filesystem['main.py'])).toContain('edited');
  });

  it('ignores persisted editable source for locked devices and reloads from the assigned HEX', async () => {
    const flashed: RuntimeProgram[] = [];
    const project = makeProject();
    project.devices[0] = {
      ...project.devices[0]!,
      locked: true,
      editableProgram: {
        runtimeSource: 'makecode-pxt',
        baseArtifactId: 'artifact-mc',
        revision: 1,
        updatedAt: now,
        sourceFiles: {
          'main.ts': 'radio.sendString("edited")',
        },
      },
    };

    const results = await loadProjectRuntimePrograms(project, {
      createAdapter: ({ runtimeSource }) => makeAdapter(runtimeSource, flashed),
    });

    expect(results[0]).toMatchObject({
      status: 'loaded',
      runtimeSource: 'makecode-pxt',
    });
    const makeCode = flashed[0];
    expect(makeCode?.source).toBe('makecode-pxt');
    if (makeCode?.source !== 'makecode-pxt') {
      throw new Error('Expected MakeCode program');
    }
    expect(makeCode.sourceFiles?.['main.ts']).toContain('ping');
    expect(makeCode.sourceFiles?.['main.ts']).not.toContain('edited');
  });

  it('loads locked devices from persisted extracted artifact programs without raw HEX bytes', async () => {
    const flashed: RuntimeProgram[] = [];
    const project = makeProject();
    project.artifacts[0] = {
      id: 'artifact-mc',
      name: 'mc_beacon.hex',
      artifactKind: 'hex',
      runtimeSource: 'makecode-pxt',
      program: {
        runtimeSource: 'makecode-pxt',
        sourceFiles: {
          'main.ts': 'radio.sendString("persisted")',
        },
      },
      createdAt: now,
    };
    project.artifacts[1] = {
      id: 'artifact-mp',
      name: 'mp_beacon.hex',
      artifactKind: 'hex',
      runtimeSource: 'micropython',
      program: {
        runtimeSource: 'micropython',
        filesystemBase64: {
          'main.py': btoa('radio.send("persisted")'),
        },
      },
      createdAt: now,
    };
    project.devices[0] = {
      ...project.devices[0]!,
      locked: true,
    };
    project.devices[1] = {
      ...project.devices[1]!,
      locked: true,
    };

    const results = await loadProjectRuntimePrograms(project, {
      createAdapter: ({ runtimeSource }) => makeAdapter(runtimeSource, flashed),
    });

    expect(results.map((result) => result.status)).toEqual(['loaded', 'loaded', 'skipped']);
    expect(flashed[0]).toMatchObject({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': 'radio.sendString("persisted")',
      },
    });
    expect(flashed[1]?.source).toBe('micropython');
    if (flashed[1]?.source !== 'micropython') {
      throw new Error('Expected MicroPython program');
    }
    expect(new TextDecoder().decode(flashed[1].filesystem['main.py'])).toContain('persisted');
  });
});

function makeProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'runtime-load-project', name: 'Runtime loading', now }),
    artifacts: [
      {
        id: 'artifact-mc',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: encoder.encode(makeMakeCodeHex({ 'main.ts': 'radio.sendString("ping")' })),
        createdAt: now,
      },
      {
        id: 'artifact-mp',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: encoder.encode(makeMicroPythonHex('radio.send("ping")')),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-mc',
        name: 'MakeCode node',
        position: { x: 100, y: 100 },
        programArtifactId: 'artifact-mc',
      },
      {
        id: 'device-mp',
        name: 'MicroPython node',
        position: { x: 160, y: 100 },
        programArtifactId: 'artifact-mp',
      },
      {
        id: 'device-empty',
        name: 'Empty node',
        position: { x: 220, y: 100 },
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
  bytes[offset + 1] = value >> 8;
}

function writeUInt32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, recordType, ...data];
  const checksum = (-bytes.reduce((total, byte) => total + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function makeAdapter(
  source: Exclude<RuntimeProgram['source'], undefined>,
  flashed: RuntimeProgram[],
): MicrobitRuntimeAdapter {
  return {
    name: `${source} test adapter`,
    source,
    evaluateArtifact: () => ({
      artifactKind: 'hex',
      runtimeSource: source,
      sourceEvidence: [],
      canExecuteNow: true,
      verdict: 'test adapter',
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
  };
}

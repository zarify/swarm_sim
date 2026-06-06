import { extractHexSource } from './sourceExtraction';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('HEX source extraction', () => {
  it('extracts the MicroPython filesystem from an embedded filesystem HEX artifact', async () => {
    const extracted = await extractHexSource(
      'mp_beacon.hex',
      encoder.encode(makeMicroPythonHex('from microbit import *\nradio.config(group=42)\nradio.send("ping")\nprint("mp-receive")\n')),
    );

    expect(extracted.runtimeSource).toBe('micropython');
    if (extracted.runtimeSource !== 'micropython') {
      throw new Error('Expected MicroPython extraction');
    }

    const mainPy = extracted.program.filesystem['main.py'];
    expect(mainPy).toBeDefined();
    const source = decoder.decode(mainPy);

    expect(source).toContain('from microbit import *');
    expect(source).toContain('radio.config(group=42)');
    expect(source).toContain('radio.send("ping")');
    expect(source).toContain('print("mp-receive")');
  });

  it('extracts the MakeCode project file map from embedded PXT source metadata', async () => {
    const extracted = await extractHexSource('mc_beacon.hex', encoder.encode(makeMakeCodeHex()), {
      decompressLzma: async (bytes) => {
        expect([...bytes]).toEqual([0x01, 0x02, 0x03, 0x04]);
        return JSON.stringify({
          'pxt.json': '{ "name": "mc_beacon" }',
          'main.ts': 'radio.setGroup(42)\nradio.sendString("ping")\nserial.writeLine("mc-receive")\n',
        });
      },
    });

    expect(extracted.runtimeSource).toBe('makecode-pxt');
    if (extracted.runtimeSource !== 'makecode-pxt') {
      throw new Error('Expected MakeCode extraction');
    }

    expect(extracted.program.projectMetadata).toMatchObject({
      compression: 'LZMA',
      headerSize: 0,
    });
    expect(extracted.program.sourceFiles?.['pxt.json']).toContain('"name": "mc_beacon"');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('radio.setGroup(42)');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('radio.sendString("ping")');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('serial.writeLine("mc-receive")');
  });

  it('surfaces the required MakeCode decompressor instead of silently returning metadata only', async () => {
    await expect(extractHexSource('mc_beacon.hex', encoder.encode(makeMakeCodeHex()))).rejects.toThrow(
      'MakeCode embedded source uses LZMA compression',
    );
  });

  it('rejects malformed MicroPython filesystem chunks with invalid final data offsets', async () => {
    const chunk = new Uint8Array(128).fill(0xff);
    const filename = [...'main.py'].map((character) => character.charCodeAt(0));
    chunk[0] = 0xfe;
    chunk[1] = 9;
    chunk[2] = filename.length;
    chunk.set(filename, 3);

    const malformedHex = [
      ...Array.from({ length: 8 }, (_, index) =>
        makeHexRecord(index * 16, 0x00, [...chunk.subarray(index * 16, index * 16 + 16)]),
      ),
      makeHexRecord(0x0000, 0x01, []),
    ].join('\n');

    await expect(extractHexSource('malformed.hex', encoder.encode(malformedHex))).rejects.toThrow(
      'No embedded MicroPython or MakeCode source found',
    );
  });

  it('extracts MicroPython files when terminal chunk metadata uses full-chunk sentinel values', async () => {
    const extracted = await extractHexSource(
      'mp_datalog.hex',
      encoder.encode(makeTerminalSentinelMicroPythonHex()),
    );

    expect(extracted.runtimeSource).toBe('micropython');
    if (extracted.runtimeSource !== 'micropython') {
      throw new Error('Expected MicroPython extraction');
    }

    const mainPy = extracted.program.filesystem['main.py'];
    expect(mainPy).toBeDefined();
    const source = decoder.decode(mainPy);

    expect(source).toContain('import log');
    expect(source).toContain('log.set_labels');
    expect(source).toContain('log.add');
  });
});

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, recordType, ...data];
  const checksum = (-bytes.reduce((total, byte) => total + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function makeMakeCodeHex(): string {
  const metadata = encoder.encode(JSON.stringify({ compression: 'LZMA', headerSize: 0 }));
  const compressedText = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const header = new Uint8Array(16);
  header.set([0x41, 0x14, 0x0e, 0x2f, 0xb8, 0x2f, 0xa2, 0xbb]);
  writeUInt16LE(header, 8, metadata.length);
  writeUInt32LE(header, 10, compressedText.length);

  return [
    makeHexRecord(0x0000, 0x0e, [...header]),
    ...chunkBytes(new Uint8Array([...metadata, ...compressedText]), 16).map((chunk, index) =>
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

function makeTerminalSentinelMicroPythonHex(): string {
  const sourcePrefix = 'import log\nlog.set_labels("temp")\nlog.add({"temp": 1})\n';
  const sourceCapacity = 128 - (3 + 'main.py'.length) - 1;
  const paddedSource = `${sourcePrefix}${'#'.repeat(sourceCapacity - sourcePrefix.length)}`;
  const filename = encoder.encode('main.py');
  const source = encoder.encode(paddedSource);
  const firstChunk = new Uint8Array(128).fill(0xff);
  const secondChunk = new Uint8Array(128).fill(0xff);
  const dataStart = 3 + filename.length;

  firstChunk[0] = 0xfe;
  firstChunk[1] = 0;
  firstChunk[2] = filename.length;
  firstChunk.set(filename, 3);
  firstChunk.set(source, dataStart);
  firstChunk[127] = 2;
  secondChunk[0] = 1;

  return [
    ...Array.from({ length: 8 }, (_, index) =>
      makeHexRecord(index * 16, 0x00, [...firstChunk.subarray(index * 16, index * 16 + 16)]),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      makeHexRecord(0x0080 + index * 16, 0x00, [...secondChunk.subarray(index * 16, index * 16 + 16)]),
    ),
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

function writeUInt16LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUInt32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

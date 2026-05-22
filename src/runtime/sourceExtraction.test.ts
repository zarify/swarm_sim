import { decompress } from 'lzma';
import { extractHexSource, type LzmaDecompressor } from './sourceExtraction';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';
import microPythonBeaconHex from '../../hex_files/mp_beacon.hex?raw';
import microPythonDataLogHex from '../../hex_files/mp_datalog.hex?raw';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const decompressLzma: LzmaDecompressor = (bytes) =>
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
  });

describe('HEX source extraction', () => {
  it('extracts the MicroPython filesystem from the Foundation editor HEX fixture', async () => {
    const extracted = await extractHexSource('mp_beacon.hex', encoder.encode(microPythonBeaconHex));

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
  }, 15000);

  it('extracts the MakeCode project file map from the PXT HEX fixture', async () => {
    const extracted = await extractHexSource('mc_beacon.hex', encoder.encode(makeCodeBeaconHex), {
      decompressLzma,
    });

    expect(extracted.runtimeSource).toBe('makecode-pxt');
    if (extracted.runtimeSource !== 'makecode-pxt') {
      throw new Error('Expected MakeCode extraction');
    }

    expect(extracted.program.projectMetadata).toMatchObject({
      name: 'mc_beacon',
      eURL: 'https://makecode.microbit.org/',
      pxtTarget: 'microbit',
      editor: 'blocksprj',
    });
    expect(extracted.program.sourceFiles?.['pxt.json']).toContain('"name": "mc_beacon"');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('radio.setGroup(42)');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('radio.sendString("ping")');
    expect(extracted.program.sourceFiles?.['main.ts']).toContain('serial.writeLine("mc-receive")');
  });

  it('surfaces the required MakeCode decompressor instead of silently returning metadata only', async () => {
    await expect(
      extractHexSource('mc_beacon.hex', encoder.encode(makeCodeBeaconHex)),
    ).rejects.toThrow('MakeCode embedded source uses LZMA compression');
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
    const extracted = await extractHexSource('mp_datalog.hex', encoder.encode(microPythonDataLogHex));

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

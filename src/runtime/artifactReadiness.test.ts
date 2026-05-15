import {
  decodeIntelHexData,
  decodeIntelHexSegments,
  detectArtifactKind,
  evaluateArtifactRuntimeReadiness,
} from './artifactReadiness';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';
import microPythonBeaconHex from '../../hex_files/mp_beacon.hex?raw';

const encoder = new TextEncoder();

describe('artifact runtime readiness', () => {
  it('detects micro:bit hex artifacts by extension without guessing runtime source', () => {
    expect(detectArtifactKind('radio-swarm.hex')).toBe('hex');
  });

  it('does not infer MicroPython from user-controlled filename text', () => {
    expect(detectArtifactKind('radio-swarm-python.hex')).toBe('hex');
  });

  it('blocks unsupported artifact names', () => {
    const readiness = evaluateArtifactRuntimeReadiness('notes.txt');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.artifactKind).toBe('unsupported');
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.sourceEvidence).toEqual([]);
    expect(readiness.capabilities.every((capability) => capability.state === 'blocked')).toBe(
      true,
    );
  });

  it('does not mark hex artifacts executable before byte-level adapter checks are proven', () => {
    const readiness = evaluateArtifactRuntimeReadiness('radio-swarm.hex');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.sourceEvidence).toEqual([]);
    expect(readiness.verdict).toBe('Needs byte-level runtime adapter');
    expect(readiness.capabilities.every((capability) => capability.state === 'blocked')).toBe(true);
  });

  it('blocks UF2 because it is not a proven micro:bit artifact target', () => {
    const readiness = evaluateArtifactRuntimeReadiness('radio-swarm.uf2');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.artifactKind).toBe('unsupported');
  });

  it('parses Intel HEX data records with checksum validation', () => {
    const decoded = decodeIntelHexData(':10010000214601360121470136007EFE09D2190140\n:00000001FF');

    expect([...decoded.slice(0, 4)]).toEqual([0x21, 0x46, 0x01, 0x36]);
  });

  it('keeps non-contiguous Intel HEX data in separate decoded segments', () => {
    const fragmentedHex = [
      makeHexRecord(0x0000, 0x00, asciiBytes('Micro')),
      makeHexRecord(0x0100, 0x00, asciiBytes('Python')),
      makeHexRecord(0x0000, 0x01, []),
    ].join('\n');

    const segments = decodeIntelHexSegments(fragmentedHex);
    const readiness = evaluateArtifactRuntimeReadiness('fragmented.hex', encoder.encode(fragmentedHex));

    expect(segments).toHaveLength(2);
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.verdict).toBe('Unknown HEX runtime source');
  });

  it('honors extended linear addresses when joining contiguous records', () => {
    const segmentedHex = [
      makeHexRecord(0x0000, 0x04, [0x00, 0x01]),
      makeHexRecord(0x0000, 0x00, asciiBytes('Micro')),
      makeHexRecord(0x0005, 0x00, asciiBytes('Python')),
      makeHexRecord(0x0000, 0x01, []),
    ].join('\n');

    const segments = decodeIntelHexSegments(segmentedHex);
    const readiness = evaluateArtifactRuntimeReadiness('micropython.hex', encoder.encode(segmentedHex));

    expect(segments).toHaveLength(1);
    expect(segments[0]?.startAddress).toBe(0x10000);
    expect(readiness.runtimeSource).toBe('micropython');
  });

  it('preserves Intel HEX write-order precedence for out-of-order overlaps', () => {
    const overlappingHex = [
      makeHexRecord(0x0005, 0x00, asciiBytes('xxxxx')),
      makeHexRecord(0x0000, 0x00, asciiBytes('MicroPython')),
      makeHexRecord(0x0000, 0x01, []),
    ].join('\n');

    const readiness = evaluateArtifactRuntimeReadiness(
      'micropython.hex',
      encoder.encode(overlappingHex),
    );

    expect(readiness.runtimeSource).toBe('micropython');
  });

  it('reports invalid Intel HEX checksums without marking the artifact executable', () => {
    const readiness = evaluateArtifactRuntimeReadiness('broken.hex', encoder.encode(':00000001FE'));

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.verdict).toBe('Invalid Intel HEX');
    expect(readiness.diagnostic).toContain('invalid checksum');
  });

  it('detects the MakeCode beacon fixture from decoded HEX bytes', () => {
    const readiness = evaluateArtifactRuntimeReadiness(
      'mc_beacon.hex',
      encoder.encode(makeCodeBeaconHex),
    );

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.runtimeSource).toBe('makecode-pxt');
    expect(readiness.sourceEvidence).toContain('PXT marker pxT!x');
    expect(readiness.verdict).toBe('Detected makecode-pxt; runtime adapter still required');
  });

  it('detects the MicroPython beacon fixture from decoded HEX bytes', () => {
    const readiness = evaluateArtifactRuntimeReadiness(
      'mp_beacon.hex',
      encoder.encode(microPythonBeaconHex),
    );

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.runtimeSource).toBe('micropython');
    expect(readiness.sourceEvidence).toContain('MicroPython marker');
    expect(readiness.verdict).toBe('Detected micropython; runtime adapter still required');
  });
});

function asciiBytes(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, recordType, ...data];
  const checksum = (-bytes.reduce((total, byte) => total + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

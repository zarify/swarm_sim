import type {
  ArtifactKind,
  CapabilityState,
  RequiredRuntimeCapabilityId,
  RuntimeCapability,
  RuntimeReadiness,
} from './types';
import { REQUIRED_RUNTIME_CAPABILITY_IDS, RUNTIME_CAPABILITY_LABELS } from './types';

export const ARTIFACT_EXTENSION_HINT =
  'Spike accepts micro:bit .hex files for runtime/source evaluation; execution remains disabled until simulator adapters prove the required hooks.';

export function detectArtifactKind(filename: string): ArtifactKind {
  const normalized = filename.trim().toLowerCase();

  if (normalized.endsWith('.hex')) {
    return 'hex';
  }

  return 'unsupported';
}

export function evaluateArtifactRuntimeReadiness(
  filename: string,
  fileBytes?: Uint8Array,
): RuntimeReadiness {
  const artifactKind = detectArtifactKind(filename);

  switch (artifactKind) {
    case 'hex':
      if (fileBytes) {
        return evaluateHexBytes(artifactKind, fileBytes);
      }

      return {
        artifactKind,
        runtimeSource: 'unknown',
        sourceEvidence: [],
        canExecuteNow: false,
        verdict: 'Needs byte-level runtime adapter',
        capabilities: makeCapabilities('blocked'),
      };
    case 'unsupported':
      return {
        artifactKind,
        runtimeSource: 'unknown',
        sourceEvidence: [],
        canExecuteNow: false,
        verdict: 'Unsupported extension',
        capabilities: makeCapabilities('blocked'),
      };
  }
}

function evaluateHexBytes(artifactKind: 'hex', fileBytes: Uint8Array): RuntimeReadiness {
  try {
    const decodedSegments = decodeIntelHexSegments(new TextDecoder().decode(fileBytes));
    const detection = detectRuntimeSource(decodedSegments);

    return {
      artifactKind,
      runtimeSource: detection.runtimeSource,
      sourceEvidence: detection.sourceEvidence,
      canExecuteNow: false,
      verdict:
        detection.runtimeSource === 'unknown'
          ? 'Unknown HEX runtime source'
          : `Detected ${detection.runtimeSource}; runtime adapter still required`,
      capabilities: makeCapabilities('blocked'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Intel HEX parse error';

    return {
      artifactKind,
      runtimeSource: 'unknown',
      sourceEvidence: [],
      canExecuteNow: false,
      verdict: 'Invalid Intel HEX',
      capabilities: makeCapabilities('blocked'),
      diagnostic: message,
    };
  }
}

export interface IntelHexSegment {
  startAddress: number;
  bytes: Uint8Array;
}

export function decodeIntelHexData(hexText: string): Uint8Array {
  const segments = decodeIntelHexSegments(hexText);
  const byteCount = segments.reduce((total, segment) => total + segment.bytes.length, 0);
  const decoded = new Uint8Array(byteCount);
  let offset = 0;

  for (const segment of segments) {
    decoded.set(segment.bytes, offset);
    offset += segment.bytes.length;
  }

  return decoded;
}

export function decodeIntelHexSegments(hexText: string): IntelHexSegment[] {
  const records: IntelHexSegment[] = [];
  const lines = hexText.split(/\r?\n/);
  let baseAddress = 0;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (!line.startsWith(':')) {
      throw new Error(`Line ${lineNumber} is not an Intel HEX record`);
    }

    const byteCount = parseHexByte(line.slice(1, 3), lineNumber, 'byte count');
    const addressHigh = parseHexByte(line.slice(3, 5), lineNumber, 'address high byte');
    const addressLow = parseHexByte(line.slice(5, 7), lineNumber, 'address low byte');
    const recordType = parseHexByte(line.slice(7, 9), lineNumber, 'record type');
    const expectedLength = 11 + byteCount * 2;

    if (line.length !== expectedLength) {
      throw new Error(
        `Line ${lineNumber} has ${line.length} characters, expected ${expectedLength}`,
      );
    }

    const recordData: number[] = [];
    for (let offset = 0; offset < byteCount; offset += 1) {
      recordData.push(
        parseHexByte(line.slice(9 + offset * 2, 11 + offset * 2), lineNumber, 'data byte'),
      );
    }

    const checksum = parseHexByte(
      line.slice(9 + byteCount * 2, 11 + byteCount * 2),
      lineNumber,
      'checksum',
    );
    const sum =
      byteCount +
      addressHigh +
      addressLow +
      recordType +
      recordData.reduce((total, byte) => total + byte, 0) +
      checksum;

    if ((sum & 0xff) !== 0) {
      throw new Error(`Line ${lineNumber} has an invalid checksum`);
    }

    switch (recordType) {
      case 0x00:
        records.push({
          startAddress: baseAddress + ((addressHigh << 8) | addressLow),
          bytes: new Uint8Array(recordData),
        });
        break;
      case 0x01:
        return mergeIntelHexSegments(records);
      case 0x02:
        assertExtendedAddressRecord(recordData, lineNumber, 'extended segment address');
        baseAddress = (((recordData[0] ?? 0) << 8) | (recordData[1] ?? 0)) * 16;
        break;
      case 0x04:
        assertExtendedAddressRecord(recordData, lineNumber, 'extended linear address');
        baseAddress = (((recordData[0] ?? 0) << 8) | (recordData[1] ?? 0)) * 65536;
        break;
      default:
        break;
    }
  }

  return mergeIntelHexSegments(records);
}

function detectRuntimeSource(decodedData: IntelHexSegment[]): Pick<
  RuntimeReadiness,
  'runtimeSource' | 'sourceEvidence'
> {
  const segmentTexts = decodedData.map((segment) => bytesToAscii(segment.bytes));
  const hasMicroPython = segmentTexts.some((decodedText) => decodedText.includes('MicroPython'));
  const hasPxtMarker = segmentTexts.some((decodedText) => decodedText.includes('pxT!x'));

  if (hasMicroPython && !hasPxtMarker) {
    return { runtimeSource: 'micropython', sourceEvidence: ['MicroPython marker'] };
  }

  if (hasPxtMarker && !hasMicroPython) {
    return { runtimeSource: 'makecode-pxt', sourceEvidence: ['PXT marker pxT!x'] };
  }

  if (hasMicroPython && hasPxtMarker) {
    return {
      runtimeSource: 'unknown',
      sourceEvidence: ['conflicting MicroPython and PXT markers'],
    };
  }

  return { runtimeSource: 'unknown', sourceEvidence: [] };
}

function mergeIntelHexSegments(records: IntelHexSegment[]): IntelHexSegment[] {
  const memory = new Map<number, number>();

  for (const record of records) {
    record.bytes.forEach((byte, offset) => {
      memory.set(record.startAddress + offset, byte);
    });
  }

  const orderedAddresses = [...memory.keys()].sort((left, right) => left - right);
  const segments: IntelHexSegment[] = [];

  for (const address of orderedAddresses) {
    const byte = memory.get(address);

    if (byte === undefined) {
      continue;
    }

    const current = segments.at(-1);
    if (!current) {
      segments.push({ startAddress: address, bytes: new Uint8Array([byte]) });
      continue;
    }

    const currentEnd = current.startAddress + current.bytes.length;
    if (address !== currentEnd) {
      segments.push({ startAddress: address, bytes: new Uint8Array([byte]) });
      continue;
    }

    const merged = new Uint8Array(current.bytes.length + 1);
    merged.set(current.bytes);
    merged.set([byte], current.bytes.length);
    current.bytes = merged;
  }

  return segments;
}

function assertExtendedAddressRecord(
  recordData: number[],
  lineNumber: number,
  label: string,
): void {
  if (recordData.length !== 2) {
    throw new Error(`Line ${lineNumber} has invalid ${label} length`);
  }
}

function parseHexByte(value: string, lineNumber: number, label: string): number {
  if (!/^[\da-fA-F]{2}$/.test(value)) {
    throw new Error(`Line ${lineNumber} has invalid ${label}`);
  }

  return Number.parseInt(value, 16);
}

function bytesToAscii(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let output = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return output;
}

function makeCapabilities(state: CapabilityState): RuntimeCapability[] {
  return REQUIRED_RUNTIME_CAPABILITY_IDS.map((id: RequiredRuntimeCapabilityId) => ({
    id,
    name: RUNTIME_CAPABILITY_LABELS[id],
    state,
  }));
}

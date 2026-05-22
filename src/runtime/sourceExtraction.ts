import type { MakeCodeRuntimeProgram, MicroPythonRuntimeProgram } from './runtimeAdapter';
import { decodeIntelHexSegments, type IntelHexSegment } from './artifactReadiness';

export type LzmaDecompressor = (bytes: Uint8Array) => Promise<string>;

export interface ExtractHexSourceOptions {
  decompressLzma?: LzmaDecompressor;
}

export type ExtractedHexSource =
  | {
      runtimeSource: 'micropython';
      program: MicroPythonRuntimeProgram;
    }
  | {
      runtimeSource: 'makecode-pxt';
      program: MakeCodeRuntimeProgram;
    };

interface RawPxtEmbeddedSource {
  metadata: Record<string, unknown>;
  compressedText: Uint8Array;
}

interface IntelHexRecord {
  recordType: number;
  data: Uint8Array;
}

const PXT_SOURCE_MAGIC = new Uint8Array([0x41, 0x14, 0x0e, 0x2f, 0xb8, 0x2f, 0xa2, 0xbb]);
const MICROBIT_FS_CHUNK_SIZE = 128;
const MICROBIT_FS_FILE_START = 0xfe;
const MICROBIT_FS_UNUSED = 0xff;
const MICROBIT_FS_FREED = 0x00;
const MICROBIT_FS_PERSISTENT_DATA = 0xfd;
const MICROBIT_FS_MAX_CHUNKS = 252;
const TEXT_DECODER = new TextDecoder();

export async function extractHexSource(
  filename: string,
  artifactBytes: Uint8Array,
  options: ExtractHexSourceOptions = {},
): Promise<ExtractedHexSource> {
  const hexText = TEXT_DECODER.decode(artifactBytes);
  const segments = decodeIntelHexSegments(hexText);
  const pxtSource = extractRawPxtEmbeddedSourceFromHexText(hexText) ?? extractRawPxtEmbeddedSource(segments);

  if (pxtSource) {
    return {
      runtimeSource: 'makecode-pxt',
      program: {
        source: 'makecode-pxt',
        sourceFiles: await decodePxtSourceFiles(pxtSource, options),
        projectMetadata: pxtSource.metadata,
        artifact: { filename, bytes: artifactBytes },
      },
    };
  }

  const microPythonFiles = extractMicroPythonFilesystem(segments);
  if (Object.keys(microPythonFiles).length > 0) {
    return {
      runtimeSource: 'micropython',
      program: {
        source: 'micropython',
        filesystem: microPythonFiles,
        artifact: { filename, bytes: artifactBytes },
      },
    };
  }

  throw new Error('No embedded MicroPython or MakeCode source found in HEX artifact');
}

function extractRawPxtEmbeddedSourceFromHexText(hexText: string): RawPxtEmbeddedSource | undefined {
  let sourceBytes: Uint8Array | undefined;
  let metadataLength = 0;
  let remainingBytes = 0;
  let writeOffset = 0;

  for (const [index, rawLine] of hexText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const record = parseIntelHexRecord(line, index + 1);
    if (record.recordType !== 0x00 && record.recordType !== 0x0e) {
      continue;
    }

    if (!sourceBytes && record.data.length >= 16 && matchesAt(record.data, PXT_SOURCE_MAGIC, 0)) {
      metadataLength = readUInt16LE(record.data, 8);
      const textLength = readUInt32LE(record.data, 10);
      remainingBytes = metadataLength + textLength;
      sourceBytes = new Uint8Array(remainingBytes);
      writeOffset = 0;
      continue;
    }

    if (!sourceBytes || remainingBytes <= 0) {
      continue;
    }

    const bytesToCopy = Math.min(remainingBytes, record.data.length);
    sourceBytes.set(record.data.subarray(0, bytesToCopy), writeOffset);
    writeOffset += bytesToCopy;
    remainingBytes -= bytesToCopy;
    if (remainingBytes === 0) {
      const metadata = parseRecordJson(
        TEXT_DECODER.decode(sourceBytes.subarray(0, metadataLength)),
        'PXT embedded source metadata',
      );

      return {
        metadata,
        compressedText: sourceBytes.slice(metadataLength),
      };
    }
  }

  return undefined;
}

function extractRawPxtEmbeddedSource(segments: IntelHexSegment[]): RawPxtEmbeddedSource | undefined {
  for (const segment of segments) {
    const bytes = segment.bytes;
    for (let offset = 0; offset <= bytes.length - 16; offset += 16) {
      if (!matchesAt(bytes, PXT_SOURCE_MAGIC, offset)) {
        continue;
      }

      const metadataLength = readUInt16LE(bytes, offset + 8);
      const textLength = readUInt32LE(bytes, offset + 10);
      const metadataStart = offset + 16;
      const textStart = metadataStart + metadataLength;
      const textEnd = textStart + textLength;

      if (textEnd > bytes.length) {
        continue;
      }

      const metadataText = TEXT_DECODER.decode(bytes.subarray(metadataStart, textStart));
      const metadata = parseRecordJson(metadataText, 'PXT embedded source metadata');

      return {
        metadata,
        compressedText: bytes.slice(textStart, textEnd),
      };
    }
  }

  return undefined;
}

async function decodePxtSourceFiles(
  rawSource: RawPxtEmbeddedSource,
  options: ExtractHexSourceOptions,
): Promise<Record<string, string>> {
  const compression = rawSource.metadata.compression;
  let sourceText: string;

  if (compression === 'LZMA') {
    if (!options.decompressLzma) {
      throw new Error('MakeCode embedded source uses LZMA compression; no decompressor was provided');
    }

    sourceText = await options.decompressLzma(rawSource.compressedText);
  } else if (compression === undefined || compression === null || compression === '') {
    sourceText = TEXT_DECODER.decode(rawSource.compressedText);
  } else {
    throw new Error(`Unsupported MakeCode embedded source compression: ${String(compression)}`);
  }

  const headerSize = parseOptionalNonNegativeInteger(rawSource.metadata.headerSize, 'headerSize');
  const legacyMetaSize = parseOptionalNonNegativeInteger(rawSource.metadata.metaSize, 'metaSize');
  const embeddedHeaderSize = headerSize ?? legacyMetaSize ?? 0;
  const embeddedHeaderText = sourceText.slice(0, embeddedHeaderSize);
  const filesText = sourceText.slice(embeddedHeaderSize);

  if (embeddedHeaderText.length > 0) {
    Object.assign(
      rawSource.metadata,
      parseRecordJson(embeddedHeaderText, 'PXT compressed source header'),
    );
  }

  return parseStringRecordJson(filesText, 'PXT source file map');
}

function extractMicroPythonFilesystem(segments: IntelHexSegment[]): Record<string, Uint8Array> {
  const memory = buildMemoryMap(segments);
  const startChunks = findMicroPythonStartChunks(memory);
  const files: Record<string, Uint8Array> = {};

  for (const startAddress of startChunks) {
    const parsed = parseMicroPythonFileAt(memory, startAddress);
    if (!parsed) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(files, parsed.filename)) {
      throw new Error(`Found multiple MicroPython files named: ${parsed.filename}`);
    }

    files[parsed.filename] = parsed.bytes;
  }

  return files;
}

function findMicroPythonStartChunks(memory: Map<number, number>): number[] {
  const addresses = [...memory.keys()].sort((left, right) => left - right);
  const startChunks: number[] = [];

  for (const address of addresses) {
    if (address % MICROBIT_FS_CHUNK_SIZE !== 0) {
      continue;
    }

    if (memory.get(address) !== MICROBIT_FS_FILE_START) {
      continue;
    }

    const filenameLength = memory.get(address + 2);
    if (filenameLength === undefined || filenameLength === 0 || filenameLength > 120) {
      continue;
    }

    const filename = bytesToUtf8(readMemoryRange(memory, address + 3, filenameLength));
    if (isPlausibleMicroPythonFilename(filename)) {
      startChunks.push(address);
    }
  }

  return startChunks;
}

function parseMicroPythonFileAt(
  memory: Map<number, number>,
  startAddress: number,
): { filename: string; bytes: Uint8Array } | undefined {
  const startChunk = readMicroPythonChunk(memory, startAddress);
  if (!startChunk || startChunk[0] !== MICROBIT_FS_FILE_START) {
    return undefined;
  }

  const endOffset = startChunk[1] ?? 0;
  const filenameLength = startChunk[2] ?? 0;
  const filename = bytesToUtf8(startChunk.subarray(3, 3 + filenameLength));
  const firstChunkDataStart = 3 + filenameLength;

  for (let startChunkIndex = 1; startChunkIndex <= MICROBIT_FS_MAX_CHUNKS; startChunkIndex += 1) {
    const baseAddress = startAddress - (startChunkIndex - 1) * MICROBIT_FS_CHUNK_SIZE;
    const parsed = parseMicroPythonFileWithBase(
      memory,
      baseAddress,
      startChunkIndex,
      filename,
      firstChunkDataStart,
      endOffset,
    );

    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseMicroPythonFileWithBase(
  memory: Map<number, number>,
  baseAddress: number,
  startChunkIndex: number,
  filename: string,
  firstChunkDataStart: number,
  endOffset: number,
): { filename: string; bytes: Uint8Array } | undefined {
  let currentIndex = startChunkIndex;
  let currentChunk = readMicroPythonChunk(memory, chunkAddress(baseAddress, currentIndex));
  let chunkDataStart = firstChunkDataStart;
  const fileBytes: number[] = [];
  const visited = new Set<number>();

  while (currentChunk) {
    if (visited.has(currentIndex)) {
      return undefined;
    }
    visited.add(currentIndex);

    const nextIndex = currentChunk[127] ?? MICROBIT_FS_UNUSED;
    if (nextIndex === MICROBIT_FS_UNUSED) {
      if (endOffset === 0) {
        return { filename, bytes: new Uint8Array(fileBytes) };
      }
      if (endOffset < chunkDataStart || endOffset > 126) {
        return undefined;
      }

      appendBytes(fileBytes, currentChunk.subarray(chunkDataStart, 1 + endOffset));
      return { filename, bytes: new Uint8Array(fileBytes) };
    }

    if (nextIndex <= 0 || nextIndex > MICROBIT_FS_MAX_CHUNKS) {
      return undefined;
    }

    appendBytes(fileBytes, currentChunk.subarray(chunkDataStart, 127));

    const nextChunk = readMicroPythonChunk(memory, chunkAddress(baseAddress, nextIndex));
    if (!nextChunk || nextChunk[0] !== currentIndex) {
      return undefined;
    }

    currentIndex = nextIndex;
    currentChunk = nextChunk;
    chunkDataStart = 1;
  }

  return undefined;
}

function buildMemoryMap(segments: IntelHexSegment[]): Map<number, number> {
  const memory = new Map<number, number>();

  for (const segment of segments) {
    segment.bytes.forEach((byte, offset) => {
      memory.set(segment.startAddress + offset, byte);
    });
  }

  return memory;
}

function readMicroPythonChunk(
  memory: Map<number, number>,
  address: number,
): Uint8Array | undefined {
  const chunk = readMemoryRange(memory, address, MICROBIT_FS_CHUNK_SIZE);
  const marker = chunk[0];

  if (
    marker === undefined ||
    marker === MICROBIT_FS_UNUSED ||
    marker === MICROBIT_FS_FREED ||
    marker === MICROBIT_FS_PERSISTENT_DATA
  ) {
    return undefined;
  }

  return chunk;
}

function readMemoryRange(memory: Map<number, number>, startAddress: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  for (let offset = 0; offset < length; offset += 1) {
    bytes[offset] = memory.get(startAddress + offset) ?? MICROBIT_FS_UNUSED;
  }

  return bytes;
}

function chunkAddress(baseAddress: number, chunkIndex: number): number {
  return baseAddress + (chunkIndex - 1) * MICROBIT_FS_CHUNK_SIZE;
}

function appendBytes(target: number[], bytes: Uint8Array): void {
  for (const byte of bytes) {
    target.push(byte);
  }
}

function isPlausibleMicroPythonFilename(filename: string): boolean {
  return /^[A-Za-z0-9_.-]+\.py$/.test(filename);
}

function matchesAt(bytes: Uint8Array, pattern: Uint8Array, offset: number): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (bytes[offset + index] !== pattern[index]) {
      return false;
    }
  }

  return true;
}

function parseIntelHexRecord(line: string, lineNumber: number): IntelHexRecord {
  if (!line.startsWith(':')) {
    throw new Error(`Line ${lineNumber} is not an Intel HEX record`);
  }

  const byteCount = parseHexByte(line.slice(1, 3), lineNumber, 'byte count');
  const addressHigh = parseHexByte(line.slice(3, 5), lineNumber, 'address high byte');
  const addressLow = parseHexByte(line.slice(5, 7), lineNumber, 'address low byte');
  const recordType = parseHexByte(line.slice(7, 9), lineNumber, 'record type');
  const expectedLength = 11 + byteCount * 2;

  if (line.length !== expectedLength) {
    throw new Error(`Line ${lineNumber} has ${line.length} characters, expected ${expectedLength}`);
  }

  const data = new Uint8Array(byteCount);
  for (let offset = 0; offset < byteCount; offset += 1) {
    data[offset] = parseHexByte(
      line.slice(9 + offset * 2, 11 + offset * 2),
      lineNumber,
      'data byte',
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
    [...data].reduce((total, byte) => total + byte, 0) +
    checksum;

  if ((sum & 0xff) !== 0) {
    throw new Error(`Line ${lineNumber} has an invalid checksum`);
  }

  return { recordType, data };
}

function parseHexByte(value: string, lineNumber: number, label: string): number {
  if (!/^[\da-fA-F]{2}$/.test(value)) {
    throw new Error(`Line ${lineNumber} has invalid ${label}`);
  }

  return Number.parseInt(value, 16);
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function parseRecordJson(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function parseStringRecordJson(value: string, label: string): Record<string, string> {
  const parsed = parseRecordJson(value, label);
  const files: Record<string, string> = {};

  for (const [filename, content] of Object.entries(parsed)) {
    if (typeof content !== 'string') {
      throw new Error(`${label} entry ${filename} must be a string`);
    }

    files[filename] = content;
  }

  return files;
}

function parseOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`PXT embedded source ${label} must be a non-negative integer`);
  }

  return value;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

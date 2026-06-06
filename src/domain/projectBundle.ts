import type { SwarmProject } from './project';
import { deserializeProject, serializeProject } from './projectSerialization';
import { deduplicateProjectArtifacts } from './projectArtifacts';

const BUNDLE_MAGIC = new Uint8Array([0x53, 0x57, 0x41, 0x52, 0x4d]); // SWARM
const BUNDLE_VERSION = 2;
const BUNDLE_HEADER_LENGTH = BUNDLE_MAGIC.length + 2;

const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export async function encodeProjectBundle(project: SwarmProject): Promise<Uint8Array> {
  const normalized = deduplicateProjectArtifacts(project);
  const serializedProject = serializeProject(normalized);
  const payload = TEXT_ENCODER.encode(serializedProject);
  const compressed = await compressPayload(payload);

  const bundle = new Uint8Array(BUNDLE_HEADER_LENGTH + compressed.bytes.byteLength);
  bundle.set(BUNDLE_MAGIC, 0);
  bundle[BUNDLE_MAGIC.length] = BUNDLE_VERSION;
  bundle[BUNDLE_MAGIC.length + 1] = compressed.method;
  bundle.set(compressed.bytes, BUNDLE_HEADER_LENGTH);
  return bundle;
}

export async function decodeProjectBundle(bundleBytes: Uint8Array): Promise<SwarmProject> {
  if (bundleBytes.byteLength < BUNDLE_HEADER_LENGTH || !hasBundleMagic(bundleBytes)) {
    throw new Error('Unsupported canvas bundle format');
  }

  const version = bundleBytes[BUNDLE_MAGIC.length];
  if (version === undefined) {
    throw new Error('Unsupported canvas bundle format');
  }
  if (version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported canvas bundle version: ${version}`);
  }

  const method = bundleBytes[BUNDLE_MAGIC.length + 1];
  if (method === undefined) {
    throw new Error('Unsupported canvas bundle format');
  }
  const payload = bundleBytes.slice(BUNDLE_HEADER_LENGTH);
  const decompressed = await decompressPayload(payload, method);
  return deserializeProject(TEXT_DECODER.decode(decompressed));
}

interface CompressionResult {
  method: number;
  bytes: Uint8Array;
}

async function compressPayload(payload: Uint8Array): Promise<CompressionResult> {
  if (!canUseBundleCompression()) {
    return { method: COMPRESSION_NONE, bytes: payload };
  }

  const stream = bytesToStream(payload).pipeThrough(new CompressionStream('gzip'));
  const compressed = await readStreamBytes(stream);
  return { method: COMPRESSION_GZIP, bytes: compressed };
}

async function decompressPayload(payload: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === COMPRESSION_NONE) {
    return payload;
  }

  if (method !== COMPRESSION_GZIP) {
    throw new Error(`Unsupported canvas bundle compression method: ${method}`);
  }

  if (!canUseBundleCompression()) {
    throw new Error('This browser cannot open compressed canvas bundles');
  }

  const stream = bytesToStream(payload).pipeThrough(new DecompressionStream('gzip'));
  return readStreamBytes(stream);
}

function canUseBundleCompression(): boolean {
  const isJsdom =
    typeof navigator !== 'undefined' && /\bjsdom\b/i.test(navigator.userAgent);
  return (
    !isJsdom &&
    typeof CompressionStream === 'function' &&
    typeof DecompressionStream === 'function'
  );
}

function hasBundleMagic(bytes: Uint8Array): boolean {
  for (let index = 0; index < BUNDLE_MAGIC.length; index += 1) {
    if (bytes[index] !== BUNDLE_MAGIC[index]) {
      return false;
    }
  }
  return true;
}

async function readStreamBytes(stream: ReadableStream<BufferSource>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    const chunk = toUint8Array(value);
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes).buffer);
      controller.close();
    },
  });
}

function toUint8Array(value: BufferSource): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

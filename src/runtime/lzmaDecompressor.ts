import type { LzmaDecompressor } from './sourceExtraction';

interface LzmaWorkerModule {
  LZMA_WORKER?: {
    decompress: (
      byteArray: Uint8Array,
      onFinish: (result: string | Uint8Array | null, error?: unknown) => void,
      onProgress?: (percent: number) => void,
    ) => void;
  };
}

const textDecoder = new TextDecoder();

export const decompressLzmaSource: LzmaDecompressor = async (bytes) => {
  const lzmaWorkerModule = (await import('lzma/src/lzma_worker.js')) as unknown as LzmaWorkerModule;
  const decompress = lzmaWorkerModule.LZMA_WORKER?.decompress;
  if (typeof decompress !== 'function') {
    throw new Error('LZMA worker module does not expose a decompress function');
  }

  return new Promise((resolve, reject) => {
    decompress(bytes, (result, error) => {
      if (error) {
        reject(normalizeError(error));
        return;
      }

      const decoded = normalizeLzmaText(result);
      if (decoded === undefined) {
        reject(new Error('Expected LZMA output to be decoded source text'));
        return;
      }

      resolve(decoded);
    });
  });
};

function normalizeLzmaText(result: unknown): string | undefined {
  if (typeof result === 'string') {
    return result;
  }

  if (result instanceof Uint8Array) {
    return textDecoder.decode(result);
  }

  if (Array.isArray(result) && result.every((item) => Number.isFinite(item))) {
    return textDecoder.decode(new Uint8Array(result));
  }

  return undefined;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'LZMA decompression failed');
}

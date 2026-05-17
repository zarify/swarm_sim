declare module 'lzma' {
  export function decompress(
    byteArray: Uint8Array,
    onFinish: (result: string | Uint8Array | null, error?: unknown) => void,
    onProgress?: (percent: number) => void,
  ): void;
}

declare module 'lzma/src/lzma_worker.js' {
  export const LZMA_WORKER: {
    decompress: (
      byteArray: Uint8Array,
      onFinish: (result: string | Uint8Array | null, error?: unknown) => void,
      onProgress?: (percent: number) => void,
    ) => void;
  };
}

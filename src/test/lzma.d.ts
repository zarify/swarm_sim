declare module 'lzma' {
  export function decompress(
    byteArray: Uint8Array,
    onFinish: (result: string | Uint8Array | null, error?: unknown) => void,
    onProgress?: (percent: number) => void,
  ): void;
}

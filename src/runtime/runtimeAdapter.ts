import type { RuntimeReadiness } from './types';

export interface MicrobitRuntimeAdapter {
  readonly name: string;
  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness;
}

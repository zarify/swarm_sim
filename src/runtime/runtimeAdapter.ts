import type { RuntimeReadiness, RuntimeSource } from './types';

export interface RuntimeArtifact {
  filename: string;
  bytes: Uint8Array;
}

export type RuntimeFilesystem = Record<string, Uint8Array>;

export interface MicroPythonRuntimeProgram {
  source: 'micropython';
  filesystem: RuntimeFilesystem;
  artifact?: RuntimeArtifact;
}

export interface MakeCodeRuntimeProgram {
  source: 'makecode-pxt';
  simulatorJavaScript?: string;
  sourceFiles?: Record<string, string>;
  projectMetadata?: Record<string, unknown>;
  artifact?: RuntimeArtifact;
}

export type RuntimeProgram = MicroPythonRuntimeProgram | MakeCodeRuntimeProgram;

export interface RuntimeRadioPacket {
  data: Uint8Array;
  group?: number;
  channel?: number;
  signalStrength?: number;
}

export type RuntimeAdapterEvent =
  | { type: 'display-change'; pixels: number[] }
  | { type: 'radio-output'; packet: RuntimeRadioPacket }
  | { type: 'serial-output'; data: string }
  | { type: 'internal-error'; error: Error };

export type RuntimeAdapterUnsubscribe = () => void;

export interface MicrobitRuntimeAdapter {
  readonly name: string;
  readonly source: Exclude<RuntimeSource, 'unknown'>;
  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness;
  flash(program: RuntimeProgram): Promise<void>;
  reset(): Promise<void>;
  stop(): Promise<void>;
  setButton(button: 'A' | 'B', pressed: boolean): Promise<void>;
  setSensor(sensor: 'lightLevel' | 'soundLevel', value: number): Promise<void>;
  sendRadio(packet: RuntimeRadioPacket): Promise<void>;
  onEvent(listener: (event: RuntimeAdapterEvent) => void): RuntimeAdapterUnsubscribe;
}

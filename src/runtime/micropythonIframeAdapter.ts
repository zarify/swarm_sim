import { evaluateArtifactRuntimeReadiness } from './artifactReadiness';
import type {
  MicrobitRuntimeAdapter,
  MicroPythonRuntimeProgram,
  RuntimeAdapterEvent,
  RuntimeAdapterUnsubscribe,
  RuntimeProgram,
  RuntimeRadioPacket,
} from './runtimeAdapter';
import type { RuntimeReadiness } from './types';

type ButtonId = 'buttonA' | 'buttonB';
type SensorId = 'lightLevel' | 'soundLevel';

interface PostMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface MessageEventTargetLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface MicroPythonIframeRuntimeAdapterOptions {
  targetWindow: PostMessageTarget;
  targetOrigin: string;
  eventTarget?: MessageEventTargetLike;
  messageSource?: MessageEventSource | null;
  name?: string;
}

export class MicroPythonIframeRuntimeAdapter implements MicrobitRuntimeAdapter {
  readonly source = 'micropython';
  readonly name: string;

  private readonly targetWindow: PostMessageTarget;
  private readonly targetOrigin: string;
  private readonly eventTarget?: MessageEventTargetLike;
  private readonly messageSource?: MessageEventSource | null;
  private readonly listeners = new Set<(event: RuntimeAdapterEvent) => void>();
  private readonly handleMessage = (event: MessageEvent) => this.receiveMessage(event);
  private lastProgram?: MicroPythonRuntimeProgram;

  constructor(options: MicroPythonIframeRuntimeAdapterOptions) {
    this.name = options.name ?? 'micro:bit Foundation MicroPython iframe';
    this.targetWindow = options.targetWindow;
    this.targetOrigin = parseTrustedOrigin(options.targetOrigin);
    this.eventTarget = options.eventTarget;
    this.messageSource = this.eventTarget ? requireMessageSource(options.messageSource) : options.messageSource;
    this.eventTarget?.addEventListener('message', this.handleMessage);
  }

  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness {
    return evaluateArtifactRuntimeReadiness(filename, bytes);
  }

  async flash(program: RuntimeProgram): Promise<void> {
    assertMicroPythonProgram(program);
    this.lastProgram = program;
    this.postFlash(program);
  }

  async reset(): Promise<void> {
    this.post({ kind: 'reset' });
  }

  async stop(): Promise<void> {
    this.post({ kind: 'stop' });
  }

  async setButton(button: 'A' | 'B', pressed: boolean): Promise<void> {
    this.postSetValue(button === 'A' ? 'buttonA' : 'buttonB', pressed ? 1 : 0);
  }

  async setSensor(sensor: 'lightLevel' | 'soundLevel', value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 255) {
      throw new Error(`MicroPython simulator sensor value must be 0-255: ${value}`);
    }

    this.postSetValue(sensor, value);
  }

  async sendRadio(packet: RuntimeRadioPacket): Promise<void> {
    this.post({ kind: 'radio_input', data: packet.data });
  }

  onEvent(listener: (event: RuntimeAdapterEvent) => void): RuntimeAdapterUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.eventTarget?.removeEventListener('message', this.handleMessage);
    this.listeners.clear();
  }

  private postFlash(program: MicroPythonRuntimeProgram): void {
    this.post({ kind: 'flash', filesystem: program.filesystem });
  }

  private postSetValue(id: ButtonId | SensorId, value: number): void {
    this.post({ kind: 'set_value', id, value });
  }

  private post(message: unknown): void {
    this.targetWindow.postMessage(message, this.targetOrigin);
  }

  private receiveMessage(event: MessageEvent): void {
    if (event.origin !== this.targetOrigin) {
      return;
    }

    if (event.source !== this.messageSource) {
      return;
    }

    const data = event.data;
    if (!isRecord(data) || typeof data.kind !== 'string') {
      return;
    }

    switch (data.kind) {
      case 'request_flash':
        if (this.lastProgram) {
          this.postFlash(this.lastProgram);
        }
        break;
      case 'radio_output':
        try {
          this.emit({ type: 'radio-output', packet: { data: normalizeBytes(data.data) } });
        } catch (error) {
          this.emit({ type: 'internal-error', error: normalizeError(error) });
        }
        break;
      case 'serial_output':
        this.emit({ type: 'serial-output', data: typeof data.data === 'string' ? data.data : '' });
        break;
      case 'internal_error':
        this.emit({ type: 'internal-error', error: normalizeError(data.error) });
        break;
      default:
        break;
    }

  }

  private emit(event: RuntimeAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function encodeMicroPythonRadioString(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const packet = new Uint8Array(encoded.length + 3);
  packet.set([0x01, 0x00, 0x01]);
  packet.set(encoded, 3);
  return packet;
}

export function decodeMicroPythonRadioString(data: Uint8Array): string | undefined {
  if (data[0] !== 0x01 || data[1] !== 0x00 || data[2] !== 0x01) {
    return undefined;
  }

  return new TextDecoder().decode(data.subarray(3));
}

function assertMicroPythonProgram(program: RuntimeProgram): asserts program is MicroPythonRuntimeProgram {
  if (program.source !== 'micropython') {
    throw new Error(`MicroPython iframe adapter cannot flash ${program.source} programs`);
  }
}

function normalizeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }

  throw new Error('MicroPython simulator radio_output did not contain byte data');
}

function parseTrustedOrigin(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '*') {
    throw new Error('MicroPython iframe adapter requires an explicit trusted target origin');
  }

  return new URL(trimmed).origin;
}

function requireMessageSource(value: MessageEventSource | null | undefined): MessageEventSource {
  if (!value) {
    throw new Error('MicroPython iframe adapter requires a trusted message source when listening');
  }

  return value;
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(typeof value === 'string' ? value : 'MicroPython simulator internal error');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

import { evaluateArtifactRuntimeReadiness } from './artifactReadiness';
import { normalizeRuntimeDisplayPixels } from './displayPixels';
import { MICROBIT_BUILTIN_SENSOR_DOMAINS } from './microbitSensorDomains';
import type {
  MakeCodeRuntimeProgram,
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeAdapterUnsubscribe,
  RuntimeProgram,
  RuntimeRadioPacket,
} from './runtimeAdapter';
import type { RuntimeReadiness } from './types';

interface PostMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface MessageEventTargetLike {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface RunnerLoadResultMessage {
  type: 'swarm-load-result';
  requestId?: string;
  ok?: boolean;
  error?: string;
}

interface RunnerRuntimeEventMessage {
  type: 'swarm-runtime-event';
  eventType?: string;
  payload?: Record<string, unknown>;
}

export interface MakeCodeIframeRuntimeAdapterOptions {
  targetWindow: PostMessageTarget;
  targetOrigin: string;
  eventTarget?: MessageEventTargetLike;
  messageSource?: MessageEventSource | null;
  initialReady?: boolean;
  readyTimeoutMs?: number;
  loadTimeoutMs?: number;
  name?: string;
}

export class MakeCodeIframeRuntimeAdapter implements MicrobitRuntimeAdapter {
  readonly source = 'makecode-pxt';
  readonly name: string;

  private readonly targetWindow: PostMessageTarget;
  private readonly targetOrigin: string;
  private readonly eventTarget?: MessageEventTargetLike;
  private readonly messageSource?: MessageEventSource | null;
  private readonly readyTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly listeners = new Set<(event: RuntimeAdapterEvent) => void>();
  private readonly pendingLoads = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly handleMessage = (event: MessageEvent) => this.receiveMessage(event);
  private ready = false;
  private loadSequence = 0;
  private resolveReady?: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private sawInvalidDisplayFrame = false;

  constructor(options: MakeCodeIframeRuntimeAdapterOptions) {
    this.name = options.name ?? 'MakeCode iframe runtime';
    this.targetWindow = options.targetWindow;
    this.targetOrigin = parseTrustedOrigin(options.targetOrigin);
    this.eventTarget = options.eventTarget;
    this.messageSource = this.eventTarget ? requireMessageSource(options.messageSource) : options.messageSource;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 12000;
    if (!this.eventTarget || options.initialReady) {
      this.markReady();
    }
    this.eventTarget?.addEventListener('message', this.handleMessage);
  }

  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness {
    return evaluateArtifactRuntimeReadiness(filename, bytes);
  }

  async flash(program: RuntimeProgram): Promise<void> {
    assertMakeCodeProgram(program);
    this.sawInvalidDisplayFrame = false;
    await this.waitUntilReady();
    const requestId = `swarm-load-${++this.loadSequence}`;
    await new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this.pendingLoads.delete(requestId);
        reject(new Error('Timed out waiting for MakeCode runtime to load program'));
      }, this.loadTimeoutMs);
      this.pendingLoads.set(requestId, {
        resolve: () => {
          globalThis.clearTimeout(timeoutId);
          resolve();
        },
        reject: (error) => {
          globalThis.clearTimeout(timeoutId);
          reject(error);
        },
      });
      this.post({
        type: 'swarm-load-program',
        requestId,
        sourceFiles: program.sourceFiles ?? {},
      });
    });
  }

  async reset(): Promise<void> {
    this.sawInvalidDisplayFrame = false;
    this.post({ type: 'swarm-reset-runtime' });
  }

  async stop(): Promise<void> {
    this.sawInvalidDisplayFrame = false;
    this.post({ type: 'swarm-stop-runtime' });
  }

  async setButton(button: 'A' | 'B', pressed: boolean): Promise<void> {
    this.post({ type: 'swarm-set-button', button, pressed });
  }

  async setSensor(sensor: 'lightLevel' | 'soundLevel', value: number): Promise<void> {
    const domain = MICROBIT_BUILTIN_SENSOR_DOMAINS[sensor];
    if (!Number.isFinite(value) || value < domain.min || value > domain.max) {
      throw new Error(
        `MakeCode simulator sensor value for ${sensor} must be ${domain.min}-${domain.max}: ${value}`,
      );
    }
    this.post({ type: 'swarm-set-sensor', sensor, value: Math.round(value) });
  }

  async sendRadio(packet: RuntimeRadioPacket): Promise<void> {
    this.post({
      type: 'swarm-radio-input',
      packet: {
        data: [...packet.data],
        group: packet.group,
        channel: packet.channel,
        signalStrength: packet.signalStrength,
      },
    });
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
    for (const pending of this.pendingLoads.values()) {
      pending.reject(new Error('MakeCode iframe runtime adapter disposed while load was pending'));
    }
    this.pendingLoads.clear();
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
    if (!isRecord(event.data) || typeof event.data.type !== 'string') {
      return;
    }
    if (event.data.type === 'swarm-runner-ready') {
      this.markReady();
      return;
    }
    if (event.data.type === 'swarm-load-result') {
      this.handleLoadResult(event.data as unknown as RunnerLoadResultMessage);
      return;
    }
    if (event.data.type === 'swarm-runtime-event') {
      this.handleRuntimeEvent(event.data as unknown as RunnerRuntimeEventMessage);
    }
  }

  private handleLoadResult(message: RunnerLoadResultMessage): void {
    const requestId = message.requestId;
    if (!requestId) {
      return;
    }
    const pending = this.pendingLoads.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingLoads.delete(requestId);
    if (message.ok) {
      pending.resolve();
      return;
    }
    pending.reject(new Error(message.error || 'MakeCode runtime failed to load program'));
  }

  private handleRuntimeEvent(message: RunnerRuntimeEventMessage): void {
    const payload = message.payload ?? {};
    switch (message.eventType) {
      case 'serial': {
        const data = typeof payload.data === 'string' ? payload.data : '';
        this.emit({ type: 'serial-output', data });
        break;
      }
      case 'radio': {
        try {
          const packet = normalizeRadioPacketPayload(payload);
          this.emit({ type: 'radio-output', packet });
        } catch (error) {
          this.emit({ type: 'internal-error', error: normalizeError(error) });
        }
        break;
      }
      case 'radio-config': {
        const config = normalizeRadioConfigPayload(payload);
        if (config.group !== undefined || config.channel !== undefined || config.signalStrength !== undefined) {
          this.emit({ type: 'radio-config-change', config });
        }
        break;
      }
      case 'display': {
        const pixels = normalizeRuntimeDisplayPixels(payload.pixels);
        if (!pixels) {
          if (!this.sawInvalidDisplayFrame) {
            this.sawInvalidDisplayFrame = true;
            this.emit({ type: 'internal-error', error: new Error('MakeCode runtime emitted invalid LED data') });
          }
          break;
        }
        this.sawInvalidDisplayFrame = false;
        this.emit({ type: 'display-change', pixels });
        break;
      }
      case 'sound': {
        const level = Number(payload.level);
        this.emit({ type: 'sound-output', level: Number.isFinite(level) ? level : 0 });
        break;
      }
      case 'internal-error': {
        const messageText = typeof payload.message === 'string' ? payload.message : 'MakeCode runtime internal error';
        this.emit({ type: 'internal-error', error: new Error(messageText) });
        break;
      }
      default:
        break;
    }
  }

  private emit(event: RuntimeAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private markReady(): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    this.resolveReady?.();
  }

  private waitUntilReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        reject(new Error('MakeCode simulator runner did not become ready before timeout'));
      }, this.readyTimeoutMs);
      this.readyPromise.then(() => {
        globalThis.clearTimeout(timeoutId);
        resolve();
      }, reject);
    });
  }
}

function normalizeRadioPacketPayload(payload: Record<string, unknown>): RuntimeRadioPacket {
  const data = normalizeBytes(payload.data);
  const group = toOptionalInteger(payload.group);
  const channel = toOptionalInteger(payload.channel);
  const signalStrength = toOptionalInteger(payload.signalStrength);
  return {
    data,
    ...(group === undefined ? {} : { group }),
    ...(channel === undefined ? {} : { channel }),
    ...(signalStrength === undefined ? {} : { signalStrength }),
  };
}

function normalizeRadioConfigPayload(payload: Record<string, unknown>): {
  group?: number;
  channel?: number;
  signalStrength?: number;
} {
  const group = toOptionalBoundedInteger(payload.group, 0, 255);
  const channel = toOptionalBoundedInteger(payload.channel, 0, 83);
  const signalStrength = toOptionalBoundedInteger(
    payload.signalStrength ?? payload.power,
    0,
    255,
  );
  return {
    ...(group === undefined ? {} : { group }),
    ...(channel === undefined ? {} : { channel }),
    ...(signalStrength === undefined ? {} : { signalStrength }),
  };
}

function toOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.round(numeric);
}

function toOptionalBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  const numeric = toOptionalInteger(value);
  if (numeric === undefined || numeric < min || numeric > max) {
    return undefined;
  }
  return numeric;
}

function assertMakeCodeProgram(program: RuntimeProgram): asserts program is MakeCodeRuntimeProgram {
  if (program.source !== 'makecode-pxt') {
    throw new Error(`MakeCode iframe adapter cannot flash ${program.source} programs`);
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
    return new Uint8Array(value.map((entry) => Number(entry) & 0xff));
  }
  throw new Error('MakeCode simulator radio event did not contain byte data');
}

function parseTrustedOrigin(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '*') {
    throw new Error('MakeCode iframe adapter requires an explicit trusted target origin');
  }
  return new URL(trimmed).origin;
}

function requireMessageSource(value: MessageEventSource | null | undefined): MessageEventSource {
  if (!value) {
    throw new Error('MakeCode iframe adapter requires a trusted message source when listening');
  }
  return value;
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : 'MakeCode runtime internal error');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

import { evaluateArtifactRuntimeReadiness } from './artifactReadiness';
import { MICROBIT_BUILTIN_SENSOR_DOMAINS } from './microbitSensorDomains';
import type {
  MakeCodeRuntimeProgram,
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeAdapterUnsubscribe,
  RuntimeProgram,
  RuntimeRadioPacket,
  RuntimeSensorId,
} from './runtimeAdapter';
import type { RuntimeReadiness } from './types';

interface ParsedMakeCodeProgram {
  radioGroup?: number;
  outboundMessages: string[];
  onReceiveSerialOutput?: string;
  onReceiveEcho: boolean;
  displayPixels?: number[];
  onReceiveDisplayPixels?: number[];
  displaySequence: number[][];
  buttonHandlers: Partial<Record<ButtonBinding, ParsedButtonAction>>;
  emitsSound: boolean;
}

type ButtonBinding = 'A' | 'B' | 'AB';

interface ParsedButtonAction {
  outboundMessages: string[];
  serialOutputs: string[];
  displaySequence: number[][];
  barGraphSensors: SensorName[];
  serialValueSensors: { name: string; sensor: SensorName }[];
  radioValueSensors: { name: string; sensor: SensorName }[];
  emitsSound: boolean;
}

type SensorName = RuntimeSensorId;

export interface MakeCodeRuntimeAdapterOptions {
  name?: string;
  tickIntervalMs?: number;
}

export class MakeCodeRuntimeAdapter implements MicrobitRuntimeAdapter {
  readonly source = 'makecode-pxt';
  readonly name: string;

  private readonly listeners = new Set<(event: RuntimeAdapterEvent) => void>();
  private readonly tickIntervalMs: number;
  private radioIntervalId?: number;
  private soundIntervalId?: number;
  private displayIntervalId?: number;
  private deferredDisplayTimeoutIds: number[] = [];
  private parsedProgram?: ParsedMakeCodeProgram;
  private lastProgram?: MakeCodeRuntimeProgram;
  private buttonState: Record<'A' | 'B', boolean> = { A: false, B: false };
  private sensors: Record<SensorName, number> = makeDefaultSensorValues();
  private displayHoldUntilMs = 0;

  constructor(options: MakeCodeRuntimeAdapterOptions = {}) {
    this.name = options.name ?? 'MakeCode runtime adapter';
    this.tickIntervalMs = options.tickIntervalMs ?? 1200;
  }

  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness {
    return evaluateArtifactRuntimeReadiness(filename, bytes);
  }

  async flash(program: RuntimeProgram): Promise<void> {
    assertMakeCodeProgram(program);
    this.lastProgram = program;
    this.parsedProgram = parseMakeCodeProgram(program);
    this.buttonState = { A: false, B: false };
    this.sensors = makeDefaultSensorValues();
    this.displayHoldUntilMs = 0;
    this.stopTicker();
    this.emitInitialDisplay();
    this.startActivityTickers();
  }

  async reset(): Promise<void> {
    this.stopTicker();
    if (this.lastProgram) {
      await this.flash(this.lastProgram);
    }
  }

  async stop(): Promise<void> {
    this.stopTicker();
  }

  async setButton(button: 'A' | 'B', pressed: boolean): Promise<void> {
    const parsed = this.parsedProgram;
    if (!parsed) {
      return;
    }

    const previouslyBothPressed = this.buttonState.A && this.buttonState.B;
    this.buttonState = {
      ...this.buttonState,
      [button]: pressed,
    };

    if (!pressed) {
      return;
    }

    this.runButtonAction(parsed.buttonHandlers[button], parsed.radioGroup);

    const bothPressed = this.buttonState.A && this.buttonState.B;
    if (!previouslyBothPressed && bothPressed) {
      this.runButtonAction(parsed.buttonHandlers.AB, parsed.radioGroup);
    }
  }

  async setSensor(sensor: RuntimeSensorId, value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return;
    }
    const domain = MICROBIT_BUILTIN_SENSOR_DOMAINS[sensor];
    this.sensors[sensor] = Math.max(domain.min, Math.min(domain.max, Math.round(value)));
  }

  async sendRadio(packet: RuntimeRadioPacket): Promise<void> {
    const parsed = this.parsedProgram;
    if (!parsed) {
      return;
    }

    const received = decodeMakeCodeRadioString(packet.data);
    if (!received) {
      return;
    }

    if (parsed.onReceiveDisplayPixels) {
      this.displayHoldUntilMs = Date.now() + DISPLAY_OVERRIDE_HOLD_MS;
      this.emit({ type: 'display-change', pixels: parsed.onReceiveDisplayPixels });
    }

    if (parsed.onReceiveSerialOutput) {
      this.emit({ type: 'serial-output', data: parsed.onReceiveSerialOutput });
    } else if (parsed.onReceiveEcho) {
      this.emit({ type: 'serial-output', data: received });
    }
  }

  onEvent(listener: (event: RuntimeAdapterEvent) => void): RuntimeAdapterUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.stopTicker();
    this.listeners.clear();
  }

  private emitInitialDisplay(): void {
    const pixels = this.parsedProgram?.displayPixels;
    if (!pixels) {
      return;
    }
    this.emit({ type: 'display-change', pixels });
  }

  private startActivityTickers(): void {
    const parsed = this.parsedProgram;
    if (!parsed) {
      return;
    }

    if (parsed.outboundMessages.length > 0) {
      let messageIndex = 0;
      const emitMessage = () => {
        const message = parsed.outboundMessages[messageIndex % parsed.outboundMessages.length];
        if (message === undefined) {
          return;
        }
        messageIndex += 1;
        this.emit({
          type: 'radio-output',
          packet: {
            data: encodeMakeCodeRadioString(message),
            group: parsed.radioGroup,
          },
        });
      };

      emitMessage();
      this.radioIntervalId = globalThis.setInterval(emitMessage, this.tickIntervalMs) as unknown as number;
    }

    if (parsed.emitsSound) {
      this.emitSoundPulse();
      this.soundIntervalId = globalThis.setInterval(this.emitSoundPulse, this.tickIntervalMs) as unknown as number;
    }

    if (parsed.displaySequence.length > 1) {
      let displayIndex = 1;
      const emitDisplayStep = () => {
        const pixels = parsed.displaySequence[displayIndex % parsed.displaySequence.length];
        if (Date.now() < this.displayHoldUntilMs) {
          return;
        }
        if (pixels) {
          this.emit({ type: 'display-change', pixels });
          displayIndex += 1;
        }
      };
      const displayTickMs = Math.max(300, Math.floor(this.tickIntervalMs / 3));
      this.displayIntervalId = globalThis.setInterval(emitDisplayStep, displayTickMs) as unknown as number;
    }
  }

  private stopTicker(): void {
    if (this.radioIntervalId !== undefined) {
      globalThis.clearInterval(this.radioIntervalId);
      this.radioIntervalId = undefined;
    }

    if (this.soundIntervalId !== undefined) {
      globalThis.clearInterval(this.soundIntervalId);
      this.soundIntervalId = undefined;
    }

    if (this.displayIntervalId !== undefined) {
      globalThis.clearInterval(this.displayIntervalId);
      this.displayIntervalId = undefined;
    }

    this.clearDeferredDisplays();
  }

  private readonly emitSoundPulse = (): void => {
    this.emit({ type: 'sound-output', level: 9 });
  };

  private runButtonAction(action: ParsedButtonAction | undefined, radioGroup?: number): void {
    if (!action) {
      return;
    }

    this.queueDisplaySequence(action.displaySequence);

    for (const sensor of action.barGraphSensors) {
      this.emit({ type: 'display-change', pixels: sensorLevelToBarGraphPixels(this.sensors[sensor]) });
    }

    for (const message of action.outboundMessages) {
      this.emit({
        type: 'radio-output',
        packet: {
          data: encodeMakeCodeRadioString(message),
          group: radioGroup,
        },
      });
    }

    for (const serial of action.serialOutputs) {
      this.emit({ type: 'serial-output', data: serial });
    }

    for (const actionSensor of action.serialValueSensors) {
      const value = this.sensors[actionSensor.sensor];
      this.emit({ type: 'serial-output', data: `${actionSensor.name}:${value}` });
    }

    for (const actionSensor of action.radioValueSensors) {
      const value = this.sensors[actionSensor.sensor];
      this.emit({
        type: 'radio-output',
        packet: {
          data: encodeMakeCodeRadioString(`${actionSensor.name}:${value}`),
          group: radioGroup,
        },
      });
    }

    if (action.emitsSound) {
      this.emitSoundPulse();
    }
  }

  private queueDisplaySequence(sequence: number[][]): void {
    if (sequence.length === 0) {
      return;
    }

    for (const [index, pixels] of sequence.entries()) {
      if (index === 0) {
        this.emit({ type: 'display-change', pixels });
        continue;
      }

      const timeoutId = globalThis.setTimeout(() => {
        this.emit({ type: 'display-change', pixels });
      }, index * 180) as unknown as number;
      this.deferredDisplayTimeoutIds.push(timeoutId);
    }
  }

  private clearDeferredDisplays(): void {
    for (const timeoutId of this.deferredDisplayTimeoutIds) {
      globalThis.clearTimeout(timeoutId);
    }
    this.deferredDisplayTimeoutIds = [];
  }

  private emit(event: RuntimeAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function encodeMakeCodeRadioString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeMakeCodeRadioString(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function makeDefaultSensorValues(): Record<SensorName, number> {
  return {
    lightLevel: 0,
    soundLevel: 0,
    temperatureC: 20,
    magneticForceX: 0,
    magneticForceY: 45,
    magneticForceZ: 0,
  };
}

function assertMakeCodeProgram(program: RuntimeProgram): asserts program is MakeCodeRuntimeProgram {
  if (program.source !== 'makecode-pxt') {
    throw new Error(`MakeCode runtime adapter cannot flash ${program.source} programs`);
  }
}

function parseMakeCodeProgram(program: MakeCodeRuntimeProgram): ParsedMakeCodeProgram {
  const mainTs = program.sourceFiles?.['main.ts'] ?? '';
  const radioGroup = parseOptionalInteger(mainTs, /radio\.setGroup\(\s*(\d+)\s*\)/);
  const onReceiveMatch = mainTs.match(
    /radio\.onReceivedString\(\s*function\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{([\s\S]*?)\}\s*\)/,
  );
  const onReceiveParam = onReceiveMatch?.[1];
  const onReceiveBody = onReceiveMatch?.[2] ?? '';
  const onReceiveSerialOutput = parseFirstCapture(
    onReceiveBody,
    /serial\.writeLine\(\s*(['"`])([\s\S]*?)\1\s*\)/,
  )?.[1];
  const onReceiveEcho = onReceiveParam
    ? new RegExp(`serial\\.writeLine\\(\\s*${onReceiveParam}\\s*\\)`).test(onReceiveBody)
    : false;
  const mainWithoutOnReceive = onReceiveMatch ? mainTs.replace(onReceiveMatch[0], '') : mainTs;
  const { buttonHandlers, sourceWithoutHandlers } = parseButtonHandlers(mainWithoutOnReceive);
  const outboundMessages = parseAllStringLiterals(
    sourceWithoutHandlers,
    /radio\.sendString\(\s*(['"`])([\s\S]*?)\1\s*\)/g,
  );
  const displaySequence = parseDisplaySequence(sourceWithoutHandlers);
  const emitsSound = /music\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(sourceWithoutHandlers);

  return {
    radioGroup,
    outboundMessages,
    onReceiveSerialOutput,
    onReceiveEcho,
    displayPixels: displaySequence[0],
    onReceiveDisplayPixels: parseDisplayPixels(onReceiveBody),
    displaySequence,
    buttonHandlers,
    emitsSound,
  };
}

function parseButtonHandlers(mainTs: string): {
  buttonHandlers: Partial<Record<ButtonBinding, ParsedButtonAction>>;
  sourceWithoutHandlers: string;
} {
  const handlers: Partial<Record<ButtonBinding, ParsedButtonAction>> = {};
  let sourceWithoutHandlers = mainTs;
  const buttonPattern =
    /input\.onButtonPressed\(\s*Button\.([A-Za-z]+)\s*,\s*function\s*\(\s*\)\s*\{([\s\S]*?)\}\s*\)/g;

  for (let match = buttonPattern.exec(mainTs); match; match = buttonPattern.exec(mainTs)) {
    const button = normalizeButtonBinding(match[1]);
    const body = match[2] ?? '';
    const sourceText = match[0];
    sourceWithoutHandlers = sourceWithoutHandlers.replace(sourceText, '');
    if (!button) {
      continue;
    }

    const nextAction: ParsedButtonAction = {
      outboundMessages: parseAllStringLiterals(
        body,
        /radio\.sendString\(\s*(['"`])([\s\S]*?)\1\s*\)/g,
      ),
      serialOutputs: parseAllStringLiterals(
        body,
        /serial\.writeLine\(\s*(['"`])([\s\S]*?)\1\s*\)/g,
      ),
      displaySequence: parseDisplaySequence(body),
      barGraphSensors: parseBarGraphSensors(body),
      serialValueSensors: parseValueSensorCalls(body, /serial\.writeValue\(/g),
      radioValueSensors: parseValueSensorCalls(body, /radio\.sendValue\(/g),
      emitsSound: /music\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(body),
    };

    const existing = handlers[button];
    handlers[button] = existing
      ? {
          outboundMessages: [...existing.outboundMessages, ...nextAction.outboundMessages],
          serialOutputs: [...existing.serialOutputs, ...nextAction.serialOutputs],
          displaySequence: [...existing.displaySequence, ...nextAction.displaySequence],
          barGraphSensors: [...existing.barGraphSensors, ...nextAction.barGraphSensors],
          serialValueSensors: [...existing.serialValueSensors, ...nextAction.serialValueSensors],
          radioValueSensors: [...existing.radioValueSensors, ...nextAction.radioValueSensors],
          emitsSound: existing.emitsSound || nextAction.emitsSound,
        }
      : nextAction;
  }

  return {
    buttonHandlers: handlers,
    sourceWithoutHandlers,
  };
}

function parseOptionalInteger(value: string, pattern: RegExp): number | undefined {
  const matched = value.match(pattern)?.[1];
  if (!matched) {
    return undefined;
  }
  return Number.parseInt(matched, 10);
}

function parseAllStringLiterals(value: string, pattern: RegExp): string[] {
  const values: string[] = [];
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (match[2]) {
      values.push(match[2]);
    }
  }
  return values;
}

function parseBarGraphSensors(value: string): SensorName[] {
  const sensors: SensorName[] = [];
  const pattern =
    /(led|basic)\.plotBarGraph\(\s*input\.(soundLevel|lightLevel|temperature)\(\s*\)\s*,\s*([0-9]+)\s*\)/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const sensor = toSensorName(match[2]);
    if (!sensor) {
      continue;
    }
    sensors.push(sensor);
  }
  return sensors;
}

function parseValueSensorCalls(value: string, callPattern: RegExp): { name: string; sensor: SensorName }[] {
  const actions: { name: string; sensor: SensorName }[] = [];
  const fullPattern = new RegExp(
    `${callPattern.source}\\s*\\s*(['"\`])([\\s\\S]*?)\\1\\s*,\\s*input\\.(soundLevel|lightLevel|temperature)\\(\\s*\\)\\s*\\)`,
    'g',
  );
  for (let match = fullPattern.exec(value); match; match = fullPattern.exec(value)) {
    const label = match[2];
    const sensor = toSensorName(match[3]);
    if (!label || !sensor) {
      continue;
    }
    actions.push({ name: label, sensor });
  }
  return actions;
}

function toSensorName(value: string | undefined): SensorName | undefined {
  if (value === 'lightLevel' || value === 'soundLevel') {
    return value;
  }
  if (value === 'temperature') {
    return 'temperatureC';
  }
  return undefined;
}

function sensorLevelToBarGraphPixels(value: number): number[] {
  const clamped = Math.max(0, Math.min(255, value));
  const litPixels = Math.round((clamped / 255) * 25);
  const pixels = [...CLEAR_PIXELS];
  for (let index = 0; index < litPixels; index += 1) {
    const column = Math.floor(index / 5);
    const rowFromBottom = index % 5;
    const row = 4 - rowFromBottom;
    const pixelIndex = row * 5 + column;
    pixels[pixelIndex] = 9;
  }
  return pixels;
}

function normalizeButtonBinding(value: string | undefined): ButtonBinding | undefined {
  const normalized = value?.toUpperCase();
  if (normalized === 'A' || normalized === 'B' || normalized === 'AB') {
    return normalized;
  }
  return undefined;
}

function parseDisplayPixels(mainTs: string): number[] | undefined {
  return parseDisplaySequence(mainTs)[0];
}

function parseDisplaySequence(mainTs: string): number[][] {
  const sequence: number[][] = [];
  const displayPattern =
    /basic\.showIcon\(\s*IconNames\.([A-Za-z0-9_]+)\s*\)|basic\.showArrow\(\s*ArrowNames\.([A-Za-z0-9_]+)\s*\)|basic\.showLeds\(\s*`([\s\S]*?)`\s*\)|basic\.clearScreen\(\s*\)/g;

  for (let match = displayPattern.exec(mainTs); match; match = displayPattern.exec(mainTs)) {
    const iconName = match[1];
    const arrowName = match[2];
    const ledsBody = match[3];
    if (iconName) {
      const pixels = iconToPixels(iconName);
      if (pixels) {
        sequence.push(pixels);
      }
      continue;
    }
    if (arrowName) {
      const pixels = arrowToPixels(arrowName);
      if (pixels) {
        sequence.push(pixels);
      }
      continue;
    }
    if (ledsBody) {
      const pixels = ledsTextToPixels(ledsBody);
      if (pixels) {
        sequence.push(pixels);
      }
      continue;
    }
    sequence.push(CLEAR_PIXELS);
  }

  return sequence;
}

function parseFirstCapture(value: string, pattern: RegExp): string[] | undefined {
  const match = value.match(pattern);
  if (!match) {
    return undefined;
  }
  return match.slice(1);
}

function ledsTextToPixels(value: string): number[] | undefined {
  const rows = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (rows.length !== 5 || rows.some((line) => line.length !== 5)) {
    return undefined;
  }

  return rows.flatMap((row) => [...row].map((character) => (character === '#' ? 9 : 0)));
}

function iconToPixels(iconName: string): number[] | undefined {
  const icon = ICON_PIXELS[iconName];
  if (!icon) {
    return undefined;
  }
  return icon;
}

function arrowToPixels(arrowName: string): number[] | undefined {
  const arrow = ARROW_PIXELS[arrowName];
  if (!arrow) {
    return undefined;
  }
  return arrow;
}

const CLEAR_PIXELS = Array.from({ length: 25 }, () => 0);

const ICON_PIXELS: Record<string, number[]> = {
  Happy: [
    0, 0, 0, 0, 0,
    0, 9, 0, 9, 0,
    0, 0, 0, 0, 0,
    9, 0, 0, 0, 9,
    0, 9, 9, 9, 0,
  ],
  Surprised: [
    0, 9, 9, 9, 0,
    9, 0, 0, 0, 9,
    9, 0, 9, 0, 9,
    9, 0, 0, 0, 9,
    0, 9, 9, 9, 0,
  ],
  Heart: [
    0, 9, 0, 9, 0,
    9, 9, 9, 9, 9,
    9, 9, 9, 9, 9,
    0, 9, 9, 9, 0,
    0, 0, 9, 0, 0,
  ],
  SmallHeart: [
    0, 0, 0, 0, 0,
    0, 9, 0, 9, 0,
    0, 9, 9, 9, 0,
    0, 0, 9, 0, 0,
    0, 0, 0, 0, 0,
  ],
  Square: [
    9, 9, 9, 9, 9,
    9, 0, 0, 0, 9,
    9, 0, 0, 0, 9,
    9, 0, 0, 0, 9,
    9, 9, 9, 9, 9,
  ],
};

const ARROW_PIXELS: Record<string, number[]> = {
  North: [
    0, 0, 9, 0, 0,
    0, 9, 9, 9, 0,
    9, 0, 9, 0, 9,
    0, 0, 9, 0, 0,
    0, 0, 9, 0, 0,
  ],
  South: [
    0, 0, 9, 0, 0,
    0, 0, 9, 0, 0,
    9, 0, 9, 0, 9,
    0, 9, 9, 9, 0,
    0, 0, 9, 0, 0,
  ],
  East: [
    0, 0, 9, 0, 0,
    0, 0, 0, 9, 0,
    9, 9, 9, 9, 9,
    0, 0, 0, 9, 0,
    0, 0, 9, 0, 0,
  ],
  West: [
    0, 0, 9, 0, 0,
    0, 9, 0, 0, 0,
    9, 9, 9, 9, 9,
    0, 9, 0, 0, 0,
    0, 0, 9, 0, 0,
  ],
};

const DISPLAY_OVERRIDE_HOLD_MS = 520;

import { evaluateArtifactRuntimeReadiness } from './artifactReadiness';
import { normalizeRuntimeDisplayPixels } from './displayPixels';
import { MICROBIT_BUILTIN_SENSOR_DOMAINS } from './microbitSensorDomains';
import type {
  MicrobitRuntimeAdapter,
  MicroPythonRuntimeProgram,
  RuntimeAdapterEvent,
  RuntimeAdapterUnsubscribe,
  RuntimeDataLogEntry,
  RuntimeProgram,
  RuntimeRadioPacket,
  RuntimeSensorId,
} from './runtimeAdapter';
import type { RuntimeReadiness } from './types';

type ButtonId = 'buttonA' | 'buttonB';
type SimulatorSensorId = 'lightLevel' | 'soundLevel' | 'compassX' | 'compassY' | 'compassZ';

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
  initialReady?: boolean;
  deferFlashUntilRequest?: boolean;
  readyTimeoutMs?: number;
  displayCoalesceWindowMs?: number;
  name?: string;
}

const ENABLE_SOUND_DEBUG_LOGS = import.meta.env.DEV;

export class MicroPythonIframeRuntimeAdapter implements MicrobitRuntimeAdapter {
  readonly source = 'micropython';
  readonly name: string;

  private readonly targetWindow: PostMessageTarget;
  private readonly targetOrigin: string;
  private readonly eventTarget?: MessageEventTargetLike;
  private readonly messageSource?: MessageEventSource | null;
  private readonly readyTimeoutMs: number;
  private readonly deferFlashUntilRequest: boolean;
  private readonly displayCoalesceWindowMs: number;
  private readonly listeners = new Set<(event: RuntimeAdapterEvent) => void>();
  private readonly handleMessage = (event: MessageEvent) => this.receiveMessage(event);
  private lastProgram?: MicroPythonRuntimeProgram;
  private pendingSerialOutput = '';
  private pendingSerialFragments = '';
  private pendingSerialFlushTimer?: number;
  private pendingDisplayPixels?: number[];
  private pendingDisplayFingerprint?: string;
  private pendingDisplayFlushTimer?: number;
  private recentDisplayFingerprint?: string;
  private ready = false;
  private resolveReady?: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private mainPyTracebackLineMap?: MainPyTracebackLineMap;

  constructor(options: MicroPythonIframeRuntimeAdapterOptions) {
    this.name = options.name ?? 'micro:bit Foundation MicroPython iframe';
    this.targetWindow = options.targetWindow;
    this.targetOrigin = parseTrustedOrigin(options.targetOrigin);
    this.eventTarget = options.eventTarget;
    this.messageSource = this.eventTarget ? requireMessageSource(options.messageSource) : options.messageSource;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
    this.deferFlashUntilRequest = options.deferFlashUntilRequest ?? false;
    this.displayCoalesceWindowMs = normalizeDisplayCoalesceWindowMs(options.displayCoalesceWindowMs);
    if (!this.eventTarget || options.initialReady) {
      this.markReady();
    }
    this.eventTarget?.addEventListener('message', this.handleMessage);
  }

  evaluateArtifact(filename: string, bytes: Uint8Array): RuntimeReadiness {
    return evaluateArtifactRuntimeReadiness(filename, bytes);
  }

  async flash(program: RuntimeProgram): Promise<void> {
    assertMicroPythonProgram(program);
    this.lastProgram = program;
    await this.waitUntilReady();
    if (this.deferFlashUntilRequest) {
      return;
    }
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

  async setSensor(sensor: RuntimeSensorId, value: number): Promise<void> {
    const domain = MICROBIT_BUILTIN_SENSOR_DOMAINS[sensor];
    if (!Number.isFinite(value)) {
      throw new Error(`MicroPython simulator sensor value for ${sensor} must be finite: ${value}`);
    }
    const clampedValue = Math.max(domain.min, Math.min(domain.max, value));

    this.postSetValue(
      toMicroPythonSimulatorSensorId(sensor),
      toMicroPythonSimulatorSensorValue(sensor, clampedValue),
    );
  }

  async sendRadio(packet: RuntimeRadioPacket): Promise<void> {
    const decoded = decodeMicroPythonRadioString(packet.data);
    const data = decoded === undefined ? packet.data : new TextEncoder().encode(decoded);
    const rssi = toSimulatorRadioRssi(packet.signalStrength);
    this.post({
      kind: 'radio_input',
      data,
      ...(rssi === undefined ? {} : { rssi }),
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
    this.flushPendingDisplayChange();
    this.flushPendingSerialFragments(true);
  }

  private postFlash(program: MicroPythonRuntimeProgram): void {
    const instrumented = instrumentMicroPythonFilesystem(program.filesystem);
    this.mainPyTracebackLineMap = instrumented.mainPyLineMap;
    this.post({ kind: 'flash', filesystem: instrumented.filesystem });
    this.post({ kind: 'mute' });
    debugMicroPythonRuntimeSound('post-mute-command', {});
  }

  private postSetValue(id: ButtonId | SimulatorSensorId, value: number): void {
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
      case 'ready':
        this.flushPendingSerialFragments(true);
        this.markReady();
        break;
      case 'request_flash':
        this.flushPendingSerialFragments(true);
        if (this.lastProgram) {
          try {
            this.postFlash(this.lastProgram);
          } catch (error) {
            this.emit({ type: 'internal-error', error: normalizeError(error) });
          }
        }
        break;
      case 'state_change':
        this.flushPendingSerialFragments(true);
        this.handleStateChange(data.change);
        break;
      case 'radio_output':
        this.flushPendingSerialFragments(true);
        try {
          this.emit({ type: 'radio-output', packet: { data: normalizeBytes(data.data) } });
        } catch (error) {
          this.emit({ type: 'internal-error', error: normalizeError(error) });
        }
        break;
      case 'serial_output':
        this.handleSerialOutput(typeof data.data === 'string' ? data.data : '');
        break;
      case 'log_output':
        try {
          this.flushPendingSerialFragments(true);
          const entry = normalizeDataLogEntry(data);
          if (entry.headings || entry.data) {
            this.emit({ type: 'data-log-output', entry });
          }
        } catch (error) {
          this.emit({ type: 'internal-error', error: normalizeError(error) });
        }
        break;
      case 'log_delete':
        this.flushPendingSerialFragments(true);
        this.emit({ type: 'data-log-delete' });
        break;
      case 'internal_error':
        this.flushPendingSerialFragments(true);
        this.emit({ type: 'internal-error', error: normalizeError(data.error) });
        break;
      default:
        this.flushPendingSerialFragments(true);
        break;
    }

  }

  private handleSerialOutput(data: string): void {
    const parsed = parseDisplayBridgeSerialOutput(this.pendingSerialOutput + data);
    this.pendingSerialOutput = parsed.pending;
    for (const event of parsed.events) {
      if (event.type === 'serial-output') {
        this.emitSerialOutput(event.data);
        continue;
      }
      if (event.type === 'display-change') {
        this.emitDisplayChange(event.pixels);
        continue;
      }
      if (event.type === 'sound-output') {
        debugMicroPythonRuntimeSound('bridge-sound-marker', { level: event.level });
      }
      this.flushPendingSerialFragments(true);
      this.emit(event);
    }
  }

  private emitSerialOutput(data: string): void {
    if (data === '') {
      return;
    }

    if (this.pendingSerialFragments !== '' || isLikelyFragmentedSerialChunk(data)) {
      this.pendingSerialFragments += data;
      this.flushPendingSerialLines();
      this.schedulePendingSerialFlush();
      return;
    }

    this.emit({ type: 'serial-output', data: this.normalizeSerialOutputForUser(data) });
  }

  private flushPendingSerialLines(): void {
    const marker = this.pendingSerialFragments.search(/\r\n|\r|\n/);
    if (marker < 0) {
      return;
    }

    const terminatorLength =
      this.pendingSerialFragments[marker] === '\r' && this.pendingSerialFragments[marker + 1] === '\n' ? 2 : 1;
    const completed = this.pendingSerialFragments.slice(0, marker);
    this.pendingSerialFragments = this.pendingSerialFragments.slice(marker + terminatorLength);
    this.emit({ type: 'serial-output', data: this.normalizeSerialOutputForUser(completed) });
    this.flushPendingSerialLines();
  }

  private schedulePendingSerialFlush(): void {
    if (this.pendingSerialFragments === '') {
      if (this.pendingSerialFlushTimer !== undefined) {
        globalThis.clearTimeout(this.pendingSerialFlushTimer);
        this.pendingSerialFlushTimer = undefined;
      }
      return;
    }

    if (this.pendingSerialFlushTimer !== undefined) {
      globalThis.clearTimeout(this.pendingSerialFlushTimer);
    }
    this.pendingSerialFlushTimer = globalThis.setTimeout(() => {
      this.pendingSerialFlushTimer = undefined;
      this.flushPendingSerialFragments(true);
    }, 35);
  }

  private flushPendingSerialFragments(force: boolean): void {
    if (this.pendingSerialFlushTimer !== undefined) {
      globalThis.clearTimeout(this.pendingSerialFlushTimer);
      this.pendingSerialFlushTimer = undefined;
    }
    if (!force || this.pendingSerialFragments === '') {
      return;
    }
    this.emit({
      type: 'serial-output',
      data: this.normalizeSerialOutputForUser(this.pendingSerialFragments),
    });
    this.pendingSerialFragments = '';
  }

  private normalizeSerialOutputForUser(data: string): string {
    return remapMainPyTracebackLineNumbers(
      normalizeSerialOutput(data),
      this.mainPyTracebackLineMap,
    );
  }

  private handleStateChange(change: unknown): void {
    const displayPixels = readDisplayPixelsFromStateChange(change);
    if (!displayPixels) {
      return;
    }
    this.emitDisplayChange(displayPixels);
  }

  private emitDisplayChange(pixels: number[]): void {
    if (this.displayCoalesceWindowMs > 0) {
      this.queuePendingDisplayChange(pixels);
      return;
    }

    this.emitDisplayChangeNow(pixels);
  }

  private queuePendingDisplayChange(pixels: number[]): void {
    const fingerprint = pixels.join('');
    if (this.pendingDisplayFingerprint === fingerprint || this.recentDisplayFingerprint === fingerprint) {
      return;
    }

    this.pendingDisplayPixels = pixels;
    this.pendingDisplayFingerprint = fingerprint;
    if (this.pendingDisplayFlushTimer !== undefined) {
      return;
    }
    this.pendingDisplayFlushTimer = globalThis.setTimeout(() => {
      this.pendingDisplayFlushTimer = undefined;
      this.flushPendingDisplayChange();
    }, this.displayCoalesceWindowMs);
  }

  private flushPendingDisplayChange(): void {
    if (this.pendingDisplayFlushTimer !== undefined) {
      globalThis.clearTimeout(this.pendingDisplayFlushTimer);
      this.pendingDisplayFlushTimer = undefined;
    }
    if (!this.pendingDisplayPixels) {
      this.pendingDisplayFingerprint = undefined;
      return;
    }
    const pixels = this.pendingDisplayPixels;
    this.pendingDisplayPixels = undefined;
    this.pendingDisplayFingerprint = undefined;
    this.emitDisplayChangeNow(pixels);
  }

  private emitDisplayChangeNow(pixels: number[]): void {
    const fingerprint = pixels.join('');
    if (this.recentDisplayFingerprint === fingerprint) {
      return;
    }

    this.recentDisplayFingerprint = fingerprint;
    queueMicrotask(() => {
      if (this.recentDisplayFingerprint === fingerprint) {
        this.recentDisplayFingerprint = undefined;
      }
    });
    this.flushPendingSerialFragments(true);
    this.emit({ type: 'display-change', pixels });
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
        reject(new Error('MicroPython simulator did not become ready before flash timeout'));
      }, this.readyTimeoutMs);

      this.readyPromise.then(() => {
        globalThis.clearTimeout(timeoutId);
        resolve();
      }, reject);
    });
  }
}

const mainPythonFile = 'main.py';
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const displayBridgePrefix = '\x1eSWARM_DISPLAY:';
const displayBridgeErrorPrefix = '\x1eSWARM_DISPLAY_ERROR:';
const soundBridgePrefix = '\x1eSWARM_SOUND:';
const displayBridgeMarkerPattern =
  /\x1eSWARM_DISPLAY:([0-9]{25})(?:\r?\n)?|\x1eSWARM_DISPLAY_ERROR:([^\r\n]*)(?:\r?\n)?|\x1eSWARM_SOUND:([0-9]{1,3})(?=\r?\n|[^0-9]|$)(?:\r?\n)?/g;

function instrumentMicroPythonFilesystem(filesystem: MicroPythonRuntimeProgram['filesystem']) {
  const main = filesystem[mainPythonFile];
  if (!main) {
    return { filesystem };
  }

  const source = utf8Decoder.decode(main);
  const instrumented = instrumentMicroPythonSource(source);
  return {
    filesystem: {
      ...filesystem,
      [mainPythonFile]: utf8Encoder.encode(instrumented.source),
    },
    mainPyLineMap: instrumented.lineMap,
  };
}

interface MainPyTracebackLineMap {
  insertStartLine: number;
  insertedLineCount: number;
}

function instrumentMicroPythonSource(source: string): {
  source: string;
  lineMap: MainPyTracebackLineMap;
} {
  const lines = source.split(/\r?\n/);
  let insertIndex = 0;

  insertIndex = skipBlankAndCommentLines(lines, insertIndex);
  insertIndex = findModuleDocstringEnd(lines, insertIndex);
  insertIndex = skipBlankAndCommentLines(lines, insertIndex);

  while (insertIndex < lines.length) {
    const line = lines[insertIndex] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      insertIndex += 1;
      continue;
    }

    if (!trimmed.startsWith('import ') && !trimmed.startsWith('from ')) {
      break;
    }

    insertIndex = findImportStatementEnd(lines, insertIndex);
  }

  const instrumentedSource = [
    ...lines.slice(0, insertIndex),
    microPythonDisplayBridgeSource,
    ...lines.slice(insertIndex),
  ].join('\n');
  return {
    source: instrumentedSource,
    lineMap: {
      insertStartLine: insertIndex + 1,
      insertedLineCount: microPythonDisplayBridgeSourceLineCount,
    },
  };
}

function skipBlankAndCommentLines(lines: string[], startIndex: number): number {
  let index = startIndex;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? '';
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      break;
    }
    index += 1;
  }
  return index;
}

function findModuleDocstringEnd(lines: string[], startIndex: number): number {
  const firstLine = lines[startIndex];
  if (firstLine === undefined) {
    return startIndex;
  }

  const trimmed = firstLine.trimStart();
  const tripleQuoteMatch = /^([rRuUbB]*)("""|''')/.exec(trimmed);
  if (tripleQuoteMatch?.[2]) {
    const quote = tripleQuoteMatch[2];
    const remainder = trimmed.slice(tripleQuoteMatch[0].length);
    if (remainder.includes(quote)) {
      return startIndex + 1;
    }

    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (lines[index]?.includes(quote)) {
        return index + 1;
      }
    }
    return lines.length;
  }

  if (/^([rRuUbB]*)("|')/.test(trimmed)) {
    return startIndex + 1;
  }

  return startIndex;
}

function findImportStatementEnd(lines: string[], startIndex: number): number {
  let index = startIndex;
  let bracketDepth = 0;
  do {
    const line = lines[index] ?? '';
    const sanitizedLine = stripPythonStringsAndComments(line);
    bracketDepth = nextBracketDepth(bracketDepth, sanitizedLine);
    index += 1;
    if (bracketDepth === 0 && !sanitizedLine.trimEnd().endsWith('\\')) {
      break;
    }
  } while (index < lines.length);

  return index;
}

function nextBracketDepth(currentDepth: number, line: string): number {
  let nextDepth = currentDepth;
  for (const character of line) {
    if (character === '(' || character === '[' || character === '{') {
      nextDepth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      nextDepth = Math.max(0, nextDepth - 1);
    }
  }

  return nextDepth;
}

function stripPythonStringsAndComments(line: string): string {
  let stripped = '';
  let quote: '"' | "'" | undefined;
  let tripleQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    const nextThree = line.slice(index, index + 3);

    if (!quote && character === '#') {
      break;
    }

    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      tripleQuote = nextThree === character.repeat(3);
      stripped += ' ';
      if (tripleQuote) {
        stripped += '  ';
        index += 2;
      }
      continue;
    }

    if (quote) {
      if (tripleQuote && nextThree === quote.repeat(3)) {
        stripped += '   ';
        index += 2;
        quote = undefined;
        tripleQuote = false;
      } else if (!tripleQuote && character === quote) {
        stripped += ' ';
        quote = undefined;
      } else {
        stripped += ' ';
        if (!tripleQuote && character === '\\') {
          index += 1;
          stripped += ' ';
        }
      }
      continue;
    }

    stripped += character;
  }

  return stripped;
}

function parseDisplayBridgeSerialOutput(input: string): {
  events: RuntimeAdapterEvent[];
  pending: string;
} {
  const { stable, pending } = splitStableDisplayBridgeSerial(input);
  const events: RuntimeAdapterEvent[] = [];
  let cursor = 0;
  displayBridgeMarkerPattern.lastIndex = 0;

  for (let match = displayBridgeMarkerPattern.exec(stable); match; match = displayBridgeMarkerPattern.exec(stable)) {
    if (match.index > cursor) {
      events.push({ type: 'serial-output', data: stable.slice(cursor, match.index) });
    }

    if (match[1]) {
      events.push({ type: 'display-change', pixels: parseDisplayPixels(match[1]) });
    } else if (match[3]) {
      events.push({
        type: 'sound-output',
        level: clampSoundLevel(Number.parseInt(match[3], 10)),
      });
    } else {
      events.push({
        type: 'internal-error',
        error: new Error(match[2] || 'MicroPython display bridge failed'),
      });
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < stable.length) {
    events.push({ type: 'serial-output', data: stable.slice(cursor) });
  }

  return { events, pending };
}

function splitStableDisplayBridgeSerial(input: string): { stable: string; pending: string } {
  let stableEnd = input.length;
  const displayStart = input.lastIndexOf(displayBridgePrefix);
  if (displayStart >= 0) {
    const displayPayload = input.slice(displayStart + displayBridgePrefix.length);
    if (/^[0-9]{0,24}$/.test(displayPayload)) {
      stableEnd = Math.min(stableEnd, displayStart);
    }
  }

  const errorStart = input.lastIndexOf(displayBridgeErrorPrefix);
  if (errorStart >= 0) {
    const errorPayload = input.slice(errorStart + displayBridgeErrorPrefix.length);
    if (!/[\r\n]/.test(errorPayload)) {
      stableEnd = Math.min(stableEnd, errorStart);
    }
  }

  const soundStart = input.lastIndexOf(soundBridgePrefix);
  if (soundStart >= 0) {
    const soundPayload = input.slice(soundStart + soundBridgePrefix.length);
    if (/^[0-9]{0,3}$/.test(soundPayload)) {
      stableEnd = Math.min(stableEnd, soundStart);
    }
  }

  const stableCandidate = input.slice(0, stableEnd);
  const trailingFragmentLength = getTrailingMarkerPrefixFragmentLength(stableCandidate);
  const finalStableEnd = stableEnd - trailingFragmentLength;
  return {
    stable: input.slice(0, finalStableEnd),
    pending: input.slice(finalStableEnd),
  };
}

function getTrailingMarkerPrefixFragmentLength(value: string): number {
  const prefixes = [displayBridgePrefix, displayBridgeErrorPrefix, soundBridgePrefix];
  let longest = 0;
  for (const prefix of prefixes) {
    const maxLength = Math.min(prefix.length - 1, value.length);
    for (let length = 1; length <= maxLength; length += 1) {
      if (prefix.startsWith(value.slice(-length))) {
        longest = Math.max(longest, length);
      }
    }
  }
  return longest;
}

function parseDisplayPixels(value: string): number[] {
  return [...value].map((digit) => Number(digit));
}

function clampSoundLevel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

const mainPyTracebackPattern = /(File "main\.py", line )(\d+)([^\r\n]*)/g;

function remapMainPyTracebackLineNumbers(
  output: string,
  lineMap: MainPyTracebackLineMap | undefined,
): string {
  if (!lineMap) {
    return output;
  }

  const insertStartLine = lineMap.insertStartLine;
  const insertEndExclusive = insertStartLine + lineMap.insertedLineCount;
  return output.replace(mainPyTracebackPattern, (_full, prefix: string, lineText: string, suffix: string) => {
    const lineNumber = Number.parseInt(lineText, 10);
    if (!Number.isFinite(lineNumber) || lineNumber < insertStartLine) {
      return `${prefix}${lineText}${suffix}`;
    }

    if (lineNumber >= insertEndExclusive) {
      return `${prefix}${lineNumber - lineMap.insertedLineCount}${suffix}`;
    }

    return `${prefix}${lineNumber}${suffix} [swarm runtime bridge]`;
  });
}

function normalizeDisplayCoalesceWindowMs(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value ?? 0));
}

const microPythonDisplayBridgeSource = String.raw`
def _swarm_report_display_bridge_error(_swarm_error):
    try:
        print("\x1eSWARM_DISPLAY_ERROR:" + repr(_swarm_error))
    except Exception:
        pass

try:
    import microbit as _swarm_microbit
    try:
        _swarm_display_target = display
    except NameError:
        _swarm_display_target = _swarm_microbit.display

    def _swarm_emit_display():
        try:
            _swarm_pixels = []
            for _swarm_y in range(5):
                for _swarm_x in range(5):
                    _swarm_pixels.append(str(_swarm_display_target.get_pixel(_swarm_x, _swarm_y)))
            print("\x1eSWARM_DISPLAY:" + "".join(_swarm_pixels))
        except Exception as _swarm_error:
            _swarm_report_display_bridge_error(_swarm_error)

    def _swarm_emit_sound(_swarm_level=9):
        try:
            _swarm_value = int(_swarm_level)
        except Exception:
            _swarm_value = 9
        if _swarm_value < 0:
            _swarm_value = 0
        if _swarm_value > 255:
            _swarm_value = 255
        print("\x1eSWARM_SOUND:" + str(_swarm_value))

    class _SwarmDisplayProxy:
        def __init__(self, _swarm_target):
            self._swarm_target = _swarm_target

        def __getattr__(self, _swarm_name):
            return getattr(self._swarm_target, _swarm_name)

        def show(self, *args, **kwargs):
            _swarm_result = self._swarm_target.show(*args, **kwargs)
            _swarm_emit_display()
            return _swarm_result

        def scroll(self, *args, **kwargs):
            _swarm_result = self._swarm_target.scroll(*args, **kwargs)
            _swarm_emit_display()
            return _swarm_result

        def clear(self):
            _swarm_result = self._swarm_target.clear()
            _swarm_emit_display()
            return _swarm_result

        def set_pixel(self, *args, **kwargs):
            _swarm_result = self._swarm_target.set_pixel(*args, **kwargs)
            _swarm_emit_display()
            return _swarm_result

        def on(self):
            _swarm_result = self._swarm_target.on()
            _swarm_emit_display()
            return _swarm_result

        def off(self):
            _swarm_result = self._swarm_target.off()
            _swarm_emit_display()
            return _swarm_result

    display = _SwarmDisplayProxy(_swarm_display_target)
    try:
        _swarm_microbit.display = display
    except Exception:
        pass

    try:
        import music as _swarm_music

        def _swarm_music_set_volume_zero():
            try:
                _swarm_music.set_volume(0)
            except Exception:
                pass

        def _swarm_wrap_music_callable(_swarm_fn):
            def _swarm_wrapped(*args, **kwargs):
                _swarm_emit_sound()
                _swarm_music_set_volume_zero()
                _swarm_result = _swarm_fn(*args, **kwargs)
                _swarm_music_set_volume_zero()
                return _swarm_result
            return _swarm_wrapped

        class _SwarmMusicProxy:
            _swarm_wrappable = ("play", "pitch", "play_tone", "ring_tone", "set_tempo")

            def __init__(self, _swarm_target):
                self._swarm_target = _swarm_target

            def __getattr__(self, _swarm_name):
                _swarm_attr = getattr(self._swarm_target, _swarm_name)
                if _swarm_name in self._swarm_wrappable and callable(_swarm_attr):
                    return _swarm_wrap_music_callable(_swarm_attr)
                return _swarm_attr

        music = _SwarmMusicProxy(_swarm_music)

        for _swarm_name in ("play", "pitch", "play_tone", "ring_tone", "set_tempo"):
            try:
                _swarm_global = globals().get(_swarm_name)
            except Exception:
                _swarm_global = None
            if callable(_swarm_global):
                globals()[_swarm_name] = _swarm_wrap_music_callable(_swarm_global)
        _swarm_music_set_volume_zero()
    except Exception:
        pass

    try:
        import speech as _swarm_speech

        def _swarm_wrap_speech_callable(_swarm_fn):
            def _swarm_wrapped(*args, **kwargs):
                _swarm_emit_sound()
                return _swarm_fn(*args, **kwargs)
            return _swarm_wrapped

        class _SwarmSpeechProxy:
            _swarm_wrappable = ("say", "sing", "pronounce")

            def __init__(self, _swarm_target):
                self._swarm_target = _swarm_target

            def __getattr__(self, _swarm_name):
                _swarm_attr = getattr(self._swarm_target, _swarm_name)
                if _swarm_name in self._swarm_wrappable and callable(_swarm_attr):
                    return _swarm_wrap_speech_callable(_swarm_attr)
                return _swarm_attr

        speech = _SwarmSpeechProxy(_swarm_speech)

        for _swarm_name in ("say", "sing", "pronounce"):
            try:
                _swarm_global = globals().get(_swarm_name)
            except Exception:
                _swarm_global = None
            if callable(_swarm_global):
                globals()[_swarm_name] = _swarm_wrap_speech_callable(_swarm_global)
    except Exception:
        pass

    _swarm_emit_display()
except Exception as _swarm_error:
    _swarm_report_display_bridge_error(_swarm_error)
`;
const microPythonDisplayBridgeSourceLineCount = microPythonDisplayBridgeSource.split('\n').length;

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

function normalizeDataLogEntry(payload: Record<string, unknown>): RuntimeDataLogEntry {
  const headings = normalizeDataLogValues(payload.headings);
  const data = normalizeDataLogValues(payload.data);
  return {
    ...(headings === undefined ? {} : { headings }),
    ...(data === undefined ? {} : { data }),
  };
}

function normalizeDataLogValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      return String(entry);
    }
    if (entry === null || entry === undefined) {
      return '';
    }
    throw new Error('MicroPython simulator log_output contained non-scalar values');
  });
}

function debugMicroPythonRuntimeSound(event: string, details: Record<string, unknown>): void {
  if (!ENABLE_SOUND_DEBUG_LOGS) {
    return;
  }
  console.debug('[swarm-sound-debug]', `micropython-adapter:${event}`, details);
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

function isLikelyFragmentedSerialChunk(value: string): boolean {
  return value.length <= 1 || value === '\r' || value === '\n';
}

function normalizeSerialOutput(value: string): string {
  const singleLine = value.replace(/\r?\n$/, '');
  const normalizedBytes = normalizePythonBytesLiteral(singleLine);
  return normalizedBytes;
}

function normalizePythonBytesLiteral(value: string): string {
  const singleQuoted = /^b'([\x20-\x7e]*)'$/.exec(value);
  const doubleQuoted = /^b"([\x20-\x7e]*)"$/.exec(value);
  const payload = singleQuoted?.[1] ?? doubleQuoted?.[1];
  if (payload === undefined) {
    return value;
  }

  const prefixedEscaped = /^\\x01\\x00\\x01(.+)$/.exec(payload)?.[1];
  if (prefixedEscaped && /^[A-Za-z][A-Za-z0-9_-]*:[\x20-\x7e]+$/.test(prefixedEscaped)) {
    return prefixedEscaped;
  }
  if (payload.includes('\\')) {
    return value;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*:[\x20-\x7e]+$/.test(payload)) {
    return value;
  }
  return payload;
}

function toSimulatorRadioRssi(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(255, Math.round(Math.abs(value))));
}

function toMicroPythonSimulatorSensorId(sensor: RuntimeSensorId): SimulatorSensorId {
  switch (sensor) {
    case 'magneticForceX':
      return 'compassX';
    case 'magneticForceY':
      return 'compassY';
    case 'magneticForceZ':
      return 'compassZ';
    default:
      return sensor;
  }
}

function toMicroPythonSimulatorSensorValue(_sensor: RuntimeSensorId, value: number): number {
  return Math.round(value);
}

function readDisplayPixelsFromStateChange(change: unknown): number[] | undefined {
  if (!isRecord(change)) {
    return undefined;
  }
  const raw = change.displayPixels;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized = normalizeRuntimeDisplayPixels(raw.map((entry) => Number(entry)));
  return normalized ?? undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

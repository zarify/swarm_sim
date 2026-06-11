import type { RuntimeAdapterEvent, RuntimeProgram } from './runtimeAdapter';
import {
  decodeMicroPythonRadioString,
  encodeMicroPythonRadioString,
  MicroPythonIframeRuntimeAdapter,
} from './micropythonIframeAdapter';
import { vi } from 'vitest';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('MicroPython iframe runtime adapter', () => {
  it('flashes MicroPython filesystem programs via the Foundation postMessage API', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });

    const program = makeMicroPythonProgram();

    await adapter.flash(program);

    const flash = getFlashMessage(targetWindow.messages[0]?.message);
    const source = decoder.decode(flash.filesystem['main.py']);
    expect(targetWindow.messages[0]?.targetOrigin).toBe('https://python-simulator.usermbit.org');
    expect(source).toContain('_SwarmDisplayProxy');
    expect(source).toContain('_SwarmMusicProxy');
    expect(source).toContain('_swarm_music_set_volume_zero');
    expect(source).toContain('_swarm_wrap_music_set_volume');
    expect(source).toContain('_swarm_music_volume = 255');
    expect(source).toContain('_SwarmSpeechProxy');
    expect(source).toContain('if _swarm_name == "set_volume"');
    expect(source).not.toContain('set_tempo');
    expect(source).not.toContain('__swarm');
    expect(source).toContain('from microbit import *');
    expect(source.indexOf('from microbit import *')).toBeLessThan(source.indexOf('class _SwarmDisplayProxy'));
    expect(source.indexOf('class _SwarmDisplayProxy')).toBeLessThan(source.indexOf('display.show(Image.ARROW_N)'));
  });

  it('does not split valid multi-line imports when inserting the display bridge', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });

    await adapter.flash({
      source: 'micropython',
      filesystem: {
        'main.py': encoder.encode(`from microbit import (
    display,
    Image,
)
display.show(Image.HEART)`),
      },
    });

    const flash = getFlashMessage(targetWindow.messages[0]?.message);
    const source = decoder.decode(flash.filesystem['main.py']);
    expect(source.indexOf('    Image,\n)')).toBeLessThan(source.indexOf('class _SwarmDisplayProxy'));
    expect(source.indexOf('class _SwarmDisplayProxy')).toBeLessThan(source.indexOf('display.show(Image.HEART)'));
  });

  it('keeps the bridge after imports when a module docstring leads the program', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });

    await adapter.flash({
      source: 'micropython',
      filesystem: {
        'main.py': encoder.encode(`"""Beacon test program."""
from microbit import *
display.show(Image.SNAKE)`),
      },
    });

    const flash = getFlashMessage(targetWindow.messages[0]?.message);
    const source = decoder.decode(flash.filesystem['main.py']);
    expect(source.indexOf('"""Beacon test program."""')).toBeLessThan(source.indexOf('from microbit import *'));
    expect(source.indexOf('from microbit import *')).toBeLessThan(source.indexOf('class _SwarmDisplayProxy'));
    expect(source.indexOf('class _SwarmDisplayProxy')).toBeLessThan(source.indexOf('display.show(Image.SNAKE)'));
  });

  it('ignores brackets in import comments and strings when finding the insertion point', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });

    await adapter.flash({
      source: 'micropython',
      filesystem: {
        'main.py': encoder.encode(`from microbit import *  # (
label = "not an import )"
display.show(Image.ARROW_N)`),
      },
    });

    const flash = getFlashMessage(targetWindow.messages[0]?.message);
    const source = decoder.decode(flash.filesystem['main.py']);
    expect(source.indexOf('from microbit import *  # (')).toBeLessThan(source.indexOf('class _SwarmDisplayProxy'));
    expect(source.indexOf('class _SwarmDisplayProxy')).toBeLessThan(source.indexOf('label = "not an import )"'));
  });

  it('waits for the simulator ready handshake before flashing through a listening adapter', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
      readyTimeoutMs: 100,
    });
    const flash = adapter.flash(makeMicroPythonProgram());

    expect(targetWindow.messages).toEqual([]);
    eventTarget.dispatchMessage({ kind: 'ready' });
    await flash;

    expect(targetWindow.messages[0]?.message).toMatchObject({ kind: 'flash' });
    expect(targetWindow.messages[1]?.message).toMatchObject({ kind: 'mute' });
  });

  it('maps buttons, sensors, reset, stop, and MicroPython string radio input to documented simulator messages', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const radioData = encodeMicroPythonRadioString('ping');

    await adapter.setButton('A', true);
    await adapter.setButton('B', false);
    await adapter.setSensor('lightLevel', 200);
    await adapter.setSensor('soundLevel', 64);
    await adapter.setSensor('magneticForceX', -12);
    await adapter.setSensor('magneticForceY', 45);
    await adapter.setSensor('magneticForceZ', 0);
    await adapter.sendRadio({ data: radioData, signalStrength: -63 });
    const reset = adapter.reset();
    await waitForMessages(targetWindow, 9);
    const resetMessage = targetWindow.messages[8]?.message as Record<string, unknown>;
    eventTarget.dispatchMessage({
      kind: 'reset_complete',
      requestId: String(resetMessage?.requestId ?? ''),
      ok: true,
    });
    await reset;
    await adapter.stop();

    expect(targetWindow.messages).toEqual([
      { message: { kind: 'set_value', id: 'buttonA', value: 1 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'buttonB', value: 0 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'lightLevel', value: 200 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'soundLevel', value: 64 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'compassX', value: -12 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'compassY', value: 45 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'compassZ', value: 0 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      {
        message: { kind: 'radio_input', data: radioData, rssi: 63 },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
      {
        message: {
          kind: 'reset',
          requestId: expect.any(String),
        },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
      { message: { kind: 'stop' }, targetOrigin: 'https://python-simulator.usermbit.org' },
    ]);
  });

  it('waits for reset completion from the simulator', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });

    let resolved = false;
    const reset = adapter.reset().then(() => {
      resolved = true;
    });
    await waitForMessages(targetWindow, 1);
    const resetMessage = targetWindow.messages[0]?.message as Record<string, unknown>;

    expect(resetMessage?.kind).toBe('reset');
    expect(typeof resetMessage?.requestId).toBe('string');
    await Promise.resolve();
    expect(resolved).toBe(false);

    eventTarget.dispatchMessage({
      kind: 'reset_complete',
      requestId: String(resetMessage?.requestId ?? ''),
      ok: true,
    });
    await reset;
    expect(resolved).toBe(true);
  });

  it('serializes repeated reset requests until the prior reset completes', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });

    const firstReset = adapter.reset();
    await waitForMessages(targetWindow, 1);
    const firstRequest = targetWindow.messages[0]?.message as Record<string, unknown>;

    const secondReset = adapter.reset();
    await Promise.resolve();
    expect(targetWindow.messages).toHaveLength(1);

    eventTarget.dispatchMessage({
      kind: 'reset_complete',
      requestId: String(firstRequest?.requestId ?? ''),
      ok: true,
    });
    await firstReset;
    await waitForMessages(targetWindow, 2);

    const secondRequest = targetWindow.messages[1]?.message as Record<string, unknown>;
    expect(secondRequest?.kind).toBe('reset');
    expect(secondRequest?.requestId).not.toBe(firstRequest?.requestId);

    eventTarget.dispatchMessage({
      kind: 'reset_complete',
      requestId: String(secondRequest?.requestId ?? ''),
      ok: true,
    });
    await secondReset;
  });

  it('passes outbound raw radio bytes through to the simulator unchanged', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });
    const rawBytes = new Uint8Array([0xff, 0x00, 0x81, 0x42]);

    await adapter.sendRadio({ data: rawBytes, signalStrength: -52 });

    expect(targetWindow.messages).toEqual([
      {
        message: { kind: 'radio_input', data: rawBytes, rssi: 52 },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
    ]);
  });

  it('converts simulator radio, serial, and internal-error messages into adapter events', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });

    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'radio_output', data: [1, 0, 1, 112, 105, 110, 103] });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'mp-receive' });
    eventTarget.dispatchMessage({ kind: 'log_output', headings: ['time', 'temp'], data: ['1', '22'] });
    eventTarget.dispatchMessage({ kind: 'log_delete' });
    eventTarget.dispatchMessage({ kind: 'internal_error', error: 'boom' });

    expect(events[0]).toMatchObject({ type: 'radio-output' });
    if (events[0]?.type !== 'radio-output') {
      throw new Error('Expected radio-output event');
    }
    expect(decodeMicroPythonRadioString(events[0].packet.data)).toBe('ping');
    expect(events[1]).toEqual({ type: 'serial-output', data: 'mp-receive' });
    expect(events[2]).toEqual({
      type: 'data-log-output',
      entry: { headings: ['time', 'temp'], data: ['1', '22'] },
    });
    expect(events[3]).toEqual({ type: 'data-log-delete' });
    expect(events[4]).toMatchObject({ type: 'internal-error', error: new Error('boom') });
  });

  it('passes inbound raw radio bytes through from the simulator unchanged', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const rawBytes = [0xff, 0x00, 0x81, 0x42];

    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'radio_output', data: rawBytes });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'radio-output' });
    if (events[0]?.type !== 'radio-output') {
      throw new Error('Expected radio-output event');
    }
    expect([...events[0].packet.data]).toEqual(rawBytes);
  });

  it('converts display bridge serial markers into display events without leaking them to user serial logs', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'hello\n\x1eSWARM_DISPLAY:0123456789012345678901234\nworld' });

    expect(events).toEqual([
      { type: 'serial-output', data: 'hello' },
      { type: 'display-change', pixels: digits('0123456789012345678901234') },
      { type: 'serial-output', data: 'world' },
    ]);
  });

  it('buffers split display bridge serial markers until the full LED frame arrives', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'before\n\x1eSWARM_DIS' });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'PLAY:9999900000999990000099999\nafter' });

    expect(events).toEqual([
      { type: 'serial-output', data: 'before' },
      { type: 'display-change', pixels: digits('9999900000999990000099999') },
      { type: 'serial-output', data: 'after' },
    ]);
  });

  it('converts split sound bridge serial markers into sound events without leaking marker text', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'before\n\x1eSWARM_SOUND:2' });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: '55\nafter' });

    expect(events).toEqual([
      { type: 'serial-output', data: 'before' },
      { type: 'sound-output', level: 255 },
      { type: 'serial-output', data: 'after' },
    ]);
  });

  it('parses sound bridge markers even when the simulator omits a trailing newline', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'before\n\x1eSWARM_SOUND:180after' });

    expect(events).toEqual([
      { type: 'serial-output', data: 'before' },
      { type: 'sound-output', level: 180 },
      { type: 'serial-output', data: 'after' },
    ]);
  });

  it('does not parse malformed sound markers with 4+ digit payloads as sound events', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'before\n\x1eSWARM_SOUND:1234\nafter' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'serial-output' });
    if (events[0]?.type !== 'serial-output') {
      throw new Error('Expected serial output');
    }
    expect(events[0].data).toContain('\x1eSWARM_SOUND:1234');
    expect(events.some((event) => event.type === 'sound-output')).toBe(false);
  });

  it('coalesces fragmented serial chunks into one line and normalizes Python bytes literals', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'b' });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: "'light:101'" });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: '\n' });

    expect(events).toEqual([{ type: 'serial-output', data: 'light:101' }]);
  });

  it('remaps transformed MicroPython traceback line numbers back to user lines and tags bridge frames', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const program = makeMicroPythonProgram();
    const flashPromise = adapter.flash(program);
    eventTarget.dispatchMessage({ kind: 'ready' });
    await flashPromise;
    const flashMessage = getFlashMessage(targetWindow.messages[0]?.message);
    const transformedSource = decoder.decode(flashMessage.filesystem['main.py']);
    const transformedUserLine = lineNumberContaining(
      transformedSource,
      'display.show(Image.ARROW_N)',
    );
    const transformedBridgeLine = lineNumberContaining(
      transformedSource,
      'class _SwarmDisplayProxy',
    );
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({
      kind: 'serial_output',
      data:
        `Traceback (most recent call last):\n` +
        `  File "main.py", line ${transformedUserLine}, in <module>\n` +
        `  File "main.py", line ${transformedBridgeLine}, in set_pixel\n`,
    });

    const serialOutput = events
      .filter((event): event is Extract<RuntimeAdapterEvent, { type: 'serial-output' }> =>
        event.type === 'serial-output',
      )
      .map((event) => event.data)
      .join('\n');

    expect(serialOutput).toContain('Traceback (most recent call last):');
    expect(serialOutput).toContain('  File "main.py", line 6, in <module>');
    expect(serialOutput).toContain(
      `  File "main.py", line ${transformedBridgeLine}, in set_pixel [swarm runtime bridge]`,
    );
  });

  it('normalizes escaped MicroPython wire-prefix bytes literals in serial logs', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'b' });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: "'\\x01\\x00\\x01light:73'" });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: '\n' });

    expect(events).toEqual([{ type: 'serial-output', data: 'light:73' }]);
  });

  it('preserves non-telemetry bytes-literal text in serial logs', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'b' });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: "'hello'" });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: '\n' });

    expect(events).toEqual([{ type: 'serial-output', data: "b'hello'" }]);
  });

  it('converts simulator state_change display payloads into display-change events', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({
      kind: 'state_change',
      change: { displayPixels: digits('9000909090009000909090009') },
    });

    expect(events).toEqual([
      { type: 'display-change', pixels: digits('9000909090009000909090009') },
    ]);
  });

  it('deduplicates immediate identical display frames received from state_change and serial bridge markers', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    const frame = '9000909090009000909090009';
    eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits(frame) } });
    eventTarget.dispatchMessage({ kind: 'serial_output', data: `\x1eSWARM_DISPLAY:${frame}\n` });

    expect(events).toEqual([{ type: 'display-change', pixels: digits(frame) }]);
  });

  it('coalesces rapid display updates into the latest frame when configured', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
      displayCoalesceWindowMs: 20,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('0000000000000000000000000') } });
    eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('9000000000000000000000000') } });
    eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('9999900000000000000000000') } });

    expect(events).toEqual([]);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));

    expect(events).toEqual([{ type: 'display-change', pixels: digits('9999900000000000000000000') }]);
  });

  it('flushes coalesced display updates during continuous frame bursts', () => {
    vi.useFakeTimers();
    try {
      const targetWindow = makeTargetWindow();
      const eventTarget = makeMessageEventTarget();
      const adapter = new MicroPythonIframeRuntimeAdapter({
        targetWindow,
        targetOrigin: 'https://python-simulator.usermbit.org',
        eventTarget,
        messageSource: trustedMessageSource,
        displayCoalesceWindowMs: 20,
      });
      const events: RuntimeAdapterEvent[] = [];
      adapter.onEvent((event) => events.push(event));

      eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('9000000000000000000000000') } });
      vi.advanceTimersByTime(10);
      eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('9900000000000000000000000') } });
      vi.advanceTimersByTime(10);
      expect(events).toEqual([{ type: 'display-change', pixels: digits('9900000000000000000000000') }]);

      eventTarget.dispatchMessage({ kind: 'state_change', change: { displayPixels: digits('9990000000000000000000000') } });
      vi.advanceTimersByTime(20);
      expect(events).toEqual([
        { type: 'display-change', pixels: digits('9900000000000000000000000') },
        { type: 'display-change', pixels: digits('9990000000000000000000000') },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-flashes the latest program when the iframe requests flash', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });

    const program = makeMicroPythonProgram();

    eventTarget.dispatchMessage({ kind: 'ready' });
    await adapter.flash(program);
    eventTarget.dispatchMessage({ kind: 'request_flash' });

    const kinds = targetWindow.messages.map((entry) => (entry.message as { kind?: string }).kind);
    expect(kinds.filter((kind) => kind === 'flash')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'mute')).toHaveLength(2);
  });

  it('can defer iframe flashing until the simulator requests it', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
      deferFlashUntilRequest: true,
    });

    eventTarget.dispatchMessage({ kind: 'ready' });
    await adapter.flash(makeMicroPythonProgram());
    expect(targetWindow.messages).toEqual([]);

    eventTarget.dispatchMessage({ kind: 'request_flash' });
    expect(targetWindow.messages).toHaveLength(2);
    expect(targetWindow.messages[0]?.message).toMatchObject({ kind: 'flash' });
    expect(targetWindow.messages[1]?.message).toMatchObject({ kind: 'mute' });
  });

  it('rejects non-MicroPython programs, clamps sensor ranges, and rejects non-finite sensor values', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });
    const makeCodeProgram = { source: 'makecode-pxt' } satisfies RuntimeProgram;

    await expect(adapter.flash(makeCodeProgram)).rejects.toThrow(
      'MicroPython iframe adapter cannot flash makecode-pxt programs',
    );
    await adapter.setSensor('lightLevel', 300);
    await adapter.setSensor('magneticForceX', -5000);
    await expect(adapter.setSensor('soundLevel', Number.NaN)).rejects.toThrow(
      'MicroPython simulator sensor value for soundLevel must be finite',
    );
    expect(targetWindow.messages).toEqual([
      {
        message: { kind: 'set_value', id: 'lightLevel', value: 255 },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
      {
        message: { kind: 'set_value', id: 'compassX', value: -2000 },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
    ]);
  });

  it('requires and enforces a trusted postMessage origin', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const wrongMessageChannel = new MessageChannel();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org/v/0.1/simulator.html',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage(
      { kind: 'serial_output', data: 'ignored' },
      'https://evil.example',
    );
    eventTarget.dispatchMessage(
      { kind: 'serial_output', data: 'same origin wrong source' },
      'https://python-simulator.usermbit.org',
      wrongMessageChannel.port1,
    );
    eventTarget.dispatchMessage({ kind: 'serial_output', data: 'accepted' });

    expect(events).toEqual([{ type: 'serial-output', data: 'accepted' }]);
    expect(
      () =>
        new MicroPythonIframeRuntimeAdapter({
          targetWindow,
          targetOrigin: '*',
        }),
    ).toThrow('MicroPython iframe adapter requires an explicit trusted target origin');
    expect(
      () =>
        new MicroPythonIframeRuntimeAdapter({
          targetWindow,
          targetOrigin: 'https://python-simulator.usermbit.org',
          eventTarget,
        }),
    ).toThrow('MicroPython iframe adapter requires a trusted message source when listening');
  });

  it('emits internal errors for malformed radio output instead of throwing from the message handler', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
      eventTarget,
      messageSource: trustedMessageSource,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    expect(() => eventTarget.dispatchMessage({ kind: 'radio_output', data: { broken: true } })).not.toThrow();
    expect(events[0]).toMatchObject({
      type: 'internal-error',
      error: new Error('MicroPython simulator radio_output did not contain byte data'),
    });
  });
});

function makeMicroPythonProgram() {
  return {
    source: 'micropython',
    filesystem: {
      'main.py': encoder.encode(`# Imports go at the top
from microbit import *
import radio

radio.config(group=42)
display.show(Image.ARROW_N)`),
    },
  } satisfies RuntimeProgram;
}

function digits(value: string): number[] {
  return [...value].map((digit) => Number(digit));
}

function lineNumberContaining(source: string, token: string): number {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.includes(token));
  if (index < 0) {
    throw new Error(`Could not find token in source: ${token}`);
  }
  return index + 1;
}

function makeTargetWindow() {
  const messages: { message: unknown; targetOrigin: string }[] = [];
  return {
    messages,
    postMessage(message: unknown, targetOrigin: string) {
      messages.push({ message, targetOrigin });
    },
  };
}

async function waitForMessages(
  targetWindow: { messages: { message: unknown; targetOrigin: string }[] },
  expectedCount: number,
): Promise<void> {
  while (targetWindow.messages.length < expectedCount) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function getFlashMessage(message: unknown): {
  kind: 'flash';
  filesystem: Record<string, Uint8Array>;
} {
  if (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'flash' &&
    'filesystem' in message &&
    typeof message.filesystem === 'object' &&
    message.filesystem !== null
  ) {
    return message as { kind: 'flash'; filesystem: Record<string, Uint8Array> };
  }

  throw new Error('Expected a flash postMessage');
}

const trustedMessageSource = window;

function makeMessageEventTarget() {
  let listener: ((event: MessageEvent) => void) | undefined;
  return {
    addEventListener(_type: 'message', nextListener: (event: MessageEvent) => void) {
      listener = nextListener;
    },
    removeEventListener(_type: 'message', nextListener: (event: MessageEvent) => void) {
      if (listener === nextListener) {
        listener = undefined;
      }
    },
    dispatchMessage(
      data: unknown,
      origin = 'https://python-simulator.usermbit.org',
      source: MessageEventSource | null = trustedMessageSource,
    ) {
      listener?.(new MessageEvent('message', { data, origin, source }));
    },
  };
}

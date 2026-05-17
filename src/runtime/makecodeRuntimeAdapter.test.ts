import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapterEvent } from './runtimeAdapter';
import {
  decodeMakeCodeRadioString,
  encodeMakeCodeRadioString,
  MakeCodeRuntimeAdapter,
} from './makecodeRuntimeAdapter';

describe('MakeCode runtime adapter', () => {
  it('flashes extracted MakeCode source and emits display + radio runtime events', async () => {
    vi.useFakeTimers();
    const adapter = new MakeCodeRuntimeAdapter({ tickIntervalMs: 1000 });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `radio.setGroup(42)
basic.showIcon(IconNames.Heart)
basic.forever(function () {
  radio.sendString("ping")
  music.playTone(262, music.beat(BeatFraction.Whole))
})`,
      },
    });

    const displayEvent = events.find((event) => event.type === 'display-change');
    expect(displayEvent).toBeDefined();
    if (displayEvent?.type !== 'display-change') {
      throw new Error('Expected display event');
    }
    expect(displayEvent.pixels).toHaveLength(25);

    const firstRadio = events.find((event) => event.type === 'radio-output');
    expect(firstRadio).toBeDefined();
    if (firstRadio?.type !== 'radio-output') {
      throw new Error('Expected radio event');
    }
    expect(firstRadio.packet.group).toBe(42);
    expect(decodeMakeCodeRadioString(firstRadio.packet.data)).toBe('ping');
    expect(events).toContainEqual({ type: 'sound-output', level: 9 });

    vi.advanceTimersByTime(1000);
    expect(events.filter((event) => event.type === 'radio-output').length).toBeGreaterThan(1);
    expect(events.filter((event) => event.type === 'sound-output').length).toBeGreaterThan(1);
    adapter.dispose();
    vi.useRealTimers();
  });

  it('maps received radio packets into serial output handlers', async () => {
    const adapter = new MakeCodeRuntimeAdapter();
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `radio.onReceivedString(function (receivedString) {
  serial.writeLine("mc-receive")
})`,
      },
    });
    await adapter.sendRadio({ data: encodeMakeCodeRadioString('incoming') });

    expect(events).toContainEqual({ type: 'serial-output', data: 'mc-receive' });
  });

  it('emits display-change when receive handlers update the MakeCode display', async () => {
    const adapter = new MakeCodeRuntimeAdapter();
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `radio.onReceivedString(function (receivedString) {
  basic.showIcon(IconNames.Heart)
})`,
      },
    });

    await adapter.sendRadio({ data: encodeMakeCodeRadioString('incoming') });

    const displayEvents = events.filter((event) => event.type === 'display-change');
    expect(displayEvents.length).toBeGreaterThan(0);
    expect(displayEvents.at(-1)).toMatchObject({
      type: 'display-change',
      pixels: [
        0, 9, 0, 9, 0,
        9, 9, 9, 9, 9,
        9, 9, 9, 9, 9,
        0, 9, 9, 9, 0,
        0, 0, 9, 0, 0,
      ],
    });
  });

  it('emits fixture-style display sequence updates (startup icon, arrow loop, clear screen)', async () => {
    vi.useFakeTimers();
    const adapter = new MakeCodeRuntimeAdapter({ tickIntervalMs: 1200 });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `radio.onReceivedString(function (receivedString) {
  serial.writeLine("mc-receive")
  basic.showIcon(IconNames.Surprised)
  basic.pause(200)
})
radio.setGroup(42)
basic.showIcon(IconNames.Happy)
basic.forever(function () {
  basic.showArrow(ArrowNames.North)
  basic.pause(200)
  basic.clearScreen()
  radio.sendString("ping")
  basic.pause(2000)
})`,
      },
    });

    const initialDisplay = events.find((event) => event.type === 'display-change');
    expect(initialDisplay).toMatchObject({
      type: 'display-change',
      pixels: [
        0, 0, 0, 0, 0,
        0, 9, 0, 9, 0,
        0, 0, 0, 0, 0,
        9, 0, 0, 0, 9,
        0, 9, 9, 9, 0,
      ],
    });

    vi.advanceTimersByTime(500);
    const displayEvents = events.filter((event) => event.type === 'display-change');
    expect(displayEvents.length).toBeGreaterThan(1);
    expect(displayEvents[1]).toMatchObject({
      type: 'display-change',
      pixels: [
        0, 0, 9, 0, 0,
        0, 9, 9, 9, 0,
        9, 0, 9, 0, 9,
        0, 0, 9, 0, 0,
        0, 0, 9, 0, 0,
      ],
    });

    vi.advanceTimersByTime(500);
    const latestDisplay = events.filter((event) => event.type === 'display-change').at(-1);
    expect(latestDisplay).toMatchObject({
      type: 'display-change',
      pixels: Array.from({ length: 25 }, () => 0),
    });

    adapter.dispose();
    vi.useRealTimers();
  });

  it('triggers button handlers for display, radio, serial, and sound events', async () => {
    vi.useFakeTimers();
    const adapter = new MakeCodeRuntimeAdapter({ tickIntervalMs: 1000 });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `radio.setGroup(42)
input.onButtonPressed(Button.A, function () {
  basic.showIcon(IconNames.Heart)
  radio.sendString("a-press")
  serial.writeLine("btn-a")
  music.playTone(262, music.beat(BeatFraction.Whole))
})`,
      },
    });

    vi.advanceTimersByTime(2200);
    expect(events.filter((event) => event.type === 'radio-output')).toHaveLength(0);

    await adapter.setButton('A', true);
    await adapter.setButton('A', false);

    const radioOutputs = events.filter((event) => event.type === 'radio-output');
    expect(radioOutputs).toHaveLength(1);
    expect(radioOutputs[0]).toMatchObject({
      type: 'radio-output',
      packet: {
        group: 42,
      },
    });
    if (radioOutputs[0]?.type !== 'radio-output') {
      throw new Error('Expected radio event');
    }
    expect(decodeMakeCodeRadioString(radioOutputs[0].packet.data)).toBe('a-press');
    expect(events).toContainEqual({ type: 'serial-output', data: 'btn-a' });
    expect(events).toContainEqual({ type: 'sound-output', level: 9 });
    expect(events).toContainEqual({
      type: 'display-change',
      pixels: [
        0, 9, 0, 9, 0,
        9, 9, 9, 9, 9,
        9, 9, 9, 9, 9,
        0, 9, 9, 9, 0,
        0, 0, 9, 0, 0,
      ],
    });

    adapter.dispose();
    vi.useRealTimers();
  });

  it('supports sensor-driven writeValue/sendValue and plotBarGraph actions in button handlers', async () => {
    const adapter = new MakeCodeRuntimeAdapter({ tickIntervalMs: 1000 });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': `input.onButtonPressed(Button.A, function () {
  led.plotBarGraph(input.soundLevel(), 255)
  serial.writeValue("sound", input.soundLevel())
  radio.sendValue("sound", input.soundLevel())
})
input.onButtonPressed(Button.B, function () {
  led.plotBarGraph(input.lightLevel(), 255)
  serial.writeValue("light", input.lightLevel())
  radio.sendValue("light", input.lightLevel())
})
radio.setGroup(42)`,
      },
    });

    await adapter.setSensor('soundLevel', 200);
    await adapter.setSensor('lightLevel', 80);
    await adapter.setButton('A', true);
    await adapter.setButton('A', false);
    await adapter.setButton('B', true);
    await adapter.setButton('B', false);

    const serialOutputs = events
      .filter((event) => event.type === 'serial-output')
      .map((event) => (event.type === 'serial-output' ? event.data : ''));
    expect(serialOutputs).toContain('sound:200');
    expect(serialOutputs).toContain('light:80');

    const radioPayloads = events
      .filter((event) => event.type === 'radio-output')
      .map((event) => (event.type === 'radio-output' ? decodeMakeCodeRadioString(event.packet.data) : ''));
    expect(radioPayloads).toContain('sound:200');
    expect(radioPayloads).toContain('light:80');

    const barGraphFrames = events.filter((event) => event.type === 'display-change');
    expect(barGraphFrames.length).toBeGreaterThan(1);
  });

  it('rejects non-MakeCode runtime programs', async () => {
    const adapter = new MakeCodeRuntimeAdapter();

    await expect(
      adapter.flash({
        source: 'micropython',
        filesystem: {},
      }),
    ).rejects.toThrow('MakeCode runtime adapter cannot flash micropython programs');
  });
});

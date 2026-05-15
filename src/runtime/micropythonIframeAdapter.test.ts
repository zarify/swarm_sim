import type { RuntimeAdapterEvent, RuntimeProgram } from './runtimeAdapter';
import {
  decodeMicroPythonRadioString,
  encodeMicroPythonRadioString,
  MicroPythonIframeRuntimeAdapter,
} from './micropythonIframeAdapter';

const encoder = new TextEncoder();

describe('MicroPython iframe runtime adapter', () => {
  it('flashes MicroPython filesystem programs via the Foundation postMessage API', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });
    const program = makeMicroPythonProgram();

    await adapter.flash(program);

    expect(targetWindow.messages).toEqual([
      {
        message: {
          kind: 'flash',
          filesystem: {
            'main.py': program.filesystem['main.py'],
          },
        },
        targetOrigin: 'https://python-simulator.usermbit.org',
      },
    ]);
  });

  it('maps buttons, sensors, reset, stop, and radio input to documented simulator messages', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });
    const radioData = encodeMicroPythonRadioString('ping');

    await adapter.setButton('A', true);
    await adapter.setButton('B', false);
    await adapter.setSensor('lightLevel', 200);
    await adapter.setSensor('soundLevel', 64);
    await adapter.sendRadio({ data: radioData });
    await adapter.reset();
    await adapter.stop();

    expect(targetWindow.messages).toEqual([
      { message: { kind: 'set_value', id: 'buttonA', value: 1 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'buttonB', value: 0 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'lightLevel', value: 200 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'set_value', id: 'soundLevel', value: 64 }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'radio_input', data: radioData }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'reset' }, targetOrigin: 'https://python-simulator.usermbit.org' },
      { message: { kind: 'stop' }, targetOrigin: 'https://python-simulator.usermbit.org' },
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
    eventTarget.dispatchMessage({ kind: 'internal_error', error: 'boom' });

    expect(events[0]).toMatchObject({ type: 'radio-output' });
    if (events[0]?.type !== 'radio-output') {
      throw new Error('Expected radio-output event');
    }
    expect(decodeMicroPythonRadioString(events[0].packet.data)).toBe('ping');
    expect(events[1]).toEqual({ type: 'serial-output', data: 'mp-receive' });
    expect(events[2]).toMatchObject({ type: 'internal-error', error: new Error('boom') });
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

    await adapter.flash(program);
    eventTarget.dispatchMessage({ kind: 'request_flash' });

    expect(targetWindow.messages).toHaveLength(2);
    expect(targetWindow.messages[1]?.message).toMatchObject({ kind: 'flash' });
  });

  it('rejects non-MicroPython programs and invalid sensor values before posting messages', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MicroPythonIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://python-simulator.usermbit.org',
    });
    const makeCodeProgram = { source: 'makecode-pxt' } satisfies RuntimeProgram;

    await expect(adapter.flash(makeCodeProgram)).rejects.toThrow(
      'MicroPython iframe adapter cannot flash makecode-pxt programs',
    );
    await expect(adapter.setSensor('lightLevel', 300)).rejects.toThrow(
      'MicroPython simulator sensor value must be 0-255',
    );
    expect(targetWindow.messages).toEqual([]);
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
      'main.py': encoder.encode('from microbit import *'),
    },
  } satisfies RuntimeProgram;
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

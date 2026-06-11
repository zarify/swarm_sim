import { MakeCodeIframeRuntimeAdapter } from './makecodeIframeRuntimeAdapter';
import type { RuntimeAdapterEvent } from './runtimeAdapter';

describe('MakeCode iframe runtime adapter', () => {
  it('flashes MakeCode programs through the runner protocol', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      initialReady: true,
    });

    const flash = adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: {
        'main.ts': 'radio.sendString("ping")',
      },
    });
    await waitForMessages(targetWindow, 1);

    const loadMessage = targetWindow.messages[0]?.message as Record<string, unknown>;
    expect(loadMessage?.type).toBe('swarm-load-program');
    expect(loadMessage?.sourceFiles).toMatchObject({ 'main.ts': 'radio.sendString("ping")' });

    eventTarget.dispatchMessage({
      type: 'swarm-load-result',
      requestId: String(loadMessage?.requestId ?? ''),
      ok: true,
    });
    await flash;
  });

  it('waits for the runner ready handshake before flashing', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      readyTimeoutMs: 100,
    });

    const flash = adapter.flash({
      source: 'makecode-pxt',
      sourceFiles: { 'main.ts': 'basic.showIcon(IconNames.Heart)' },
    });

    expect(targetWindow.messages).toEqual([]);
    eventTarget.dispatchMessage({ type: 'swarm-runner-ready' });
    await waitForMessages(targetWindow, 1);

    const loadMessage = targetWindow.messages[0]?.message as Record<string, unknown>;
    eventTarget.dispatchMessage({
      type: 'swarm-load-result',
      requestId: String(loadMessage?.requestId ?? ''),
      ok: true,
    });
    await flash;
  });

  it('waits for reset completion from the runner', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      initialReady: true,
    });

    let resolved = false;
    const reset = adapter.reset().then(() => {
      resolved = true;
    });
    await waitForMessages(targetWindow, 1);

    const resetMessage = targetWindow.messages[0]?.message as Record<string, unknown>;
    expect(resetMessage?.type).toBe('swarm-reset-runtime');
    expect(typeof resetMessage?.requestId).toBe('string');
    await Promise.resolve();
    expect(resolved).toBe(false);

    eventTarget.dispatchMessage({
      type: 'swarm-reset-result',
      requestId: String(resetMessage?.requestId ?? ''),
      ok: true,
    });
    await reset;
    expect(resolved).toBe(true);
  });

  it('serializes repeated reset requests until the prior reset completes', async () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      initialReady: true,
    });

    const firstReset = adapter.reset();
    await waitForMessages(targetWindow, 1);
    const firstRequest = targetWindow.messages[0]?.message as Record<string, unknown>;

    const secondReset = adapter.reset();
    await Promise.resolve();
    expect(targetWindow.messages).toHaveLength(1);

    eventTarget.dispatchMessage({
      type: 'swarm-reset-result',
      requestId: String(firstRequest?.requestId ?? ''),
      ok: true,
    });
    await firstReset;
    await waitForMessages(targetWindow, 2);

    const secondRequest = targetWindow.messages[1]?.message as Record<string, unknown>;
    expect(secondRequest?.type).toBe('swarm-reset-runtime');
    expect(secondRequest?.requestId).not.toBe(firstRequest?.requestId);

    eventTarget.dispatchMessage({
      type: 'swarm-reset-result',
      requestId: String(secondRequest?.requestId ?? ''),
      ok: true,
    });
    await secondReset;
  });

  it('maps runner runtime events into adapter events', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      initialReady: true,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'serial',
      payload: { data: 'mc-receive' },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'radio',
      payload: { data: [112, 105, 110, 103], group: 42, signalStrength: -52 },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'radio-config',
      payload: { group: 12, channel: 8, signalStrength: 6 },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'display',
      payload: { pixels: Array.from({ length: 25 }, (_, index) => (index === 12 ? 9 : 0)) },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'sound',
      payload: { level: 7 },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'data-log-output',
      payload: { headings: ['time', 'temp'], data: ['1', '24'] },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'data-log-delete',
      payload: {},
    });

    expect(events[0]).toEqual({ type: 'serial-output', data: 'mc-receive' });
    expect(events[1]).toMatchObject({
      type: 'radio-output',
      packet: { group: 42, signalStrength: -52 },
    });
    if (events[1]?.type !== 'radio-output') {
      throw new Error('Expected radio-output event');
    }
    expect(new TextDecoder().decode(events[1].packet.data)).toBe('ping');
    expect(events[2]).toEqual({
      type: 'radio-config-change',
      config: { group: 12, channel: 8, signalStrength: 6 },
    });
    expect(events[3]).toMatchObject({ type: 'display-change' });
    expect(events[4]).toEqual({ type: 'sound-output', level: 7 });
    expect(events[5]).toEqual({
      type: 'data-log-output',
      entry: { headings: ['time', 'temp'], data: ['1', '24'] },
    });
    expect(events[6]).toEqual({ type: 'data-log-delete' });
  });

  it('emits one internal-error for repeated invalid display payloads until a valid frame arrives', () => {
    const targetWindow = makeTargetWindow();
    const eventTarget = makeMessageEventTarget();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      eventTarget,
      messageSource: trustedMessageSource,
      initialReady: true,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'display',
      payload: { pixels: [1, 2, 3] },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'display',
      payload: { pixels: [4, 5, 6] },
    });

    expect(events.filter((event) => event.type === 'internal-error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'display-change')).toHaveLength(0);

    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'display',
      payload: { pixels: Array.from({ length: 25 }, () => 9) },
    });
    eventTarget.dispatchMessage({
      type: 'swarm-runtime-event',
      eventType: 'display',
      payload: { pixels: [7, 8] },
    });

    expect(events.filter((event) => event.type === 'display-change')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'internal-error')).toHaveLength(2);
  });

  it('rejects invalid sensor values', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      initialReady: true,
    });

    await expect(adapter.setSensor('lightLevel', 999)).rejects.toThrow(/0-255/);
    await expect(adapter.setSensor('temperatureC', -99)).rejects.toThrow(/-5-50/);
    await expect(adapter.setSensor('magneticForceX', -2500)).rejects.toThrow(/-2000-2000/);
  });

  it('posts a dedicated AB pulse message', async () => {
    const targetWindow = makeTargetWindow();
    const adapter = new MakeCodeIframeRuntimeAdapter({
      targetWindow,
      targetOrigin: 'https://swarm.local',
      initialReady: true,
    });

    await adapter.pulseButtonAB();

    expect(targetWindow.messages).toContainEqual({
      message: { type: 'swarm-pulse-button-ab' },
      targetOrigin: 'https://swarm.local',
    });
  });
});

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
      origin = 'https://swarm.local',
      source: MessageEventSource | null = trustedMessageSource,
    ) {
      listener?.(new MessageEvent('message', { data, origin, source }));
    },
  };
}

import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../domain/project';
import {
  deliverRuntimeRadioPacket,
  registerRuntimeRadioSink,
  replaceRuntimeRadioSink,
} from './radioDeliveryRegistry';

const packet = { data: new TextEncoder().encode('ping') };

describe('runtime radio delivery registry', () => {
  it('rejects accidental duplicate registrations for the same device', () => {
    const unregister = registerRuntimeRadioSink('device-a' as DeviceId, async () => {});

    try {
      expect(() => registerRuntimeRadioSink('device-a' as DeviceId, async () => {})).toThrow(
        'Runtime radio sink already registered for device-a',
      );
    } finally {
      unregister();
    }
  });

  it('keeps newer replacement sinks when stale unregister callbacks run', async () => {
    const delivered: string[] = [];
    const unregisterFirst = replaceRuntimeRadioSink('device-b' as DeviceId, async () => {
      delivered.push('first');
    });
    const unregisterSecond = replaceRuntimeRadioSink('device-b' as DeviceId, async () => {
      delivered.push('second');
    });

    unregisterFirst();
    await expect(deliverRuntimeRadioPacket('device-b' as DeviceId, packet)).resolves.toBe(true);
    expect(delivered).toEqual(['second']);

    unregisterSecond();
    await expect(deliverRuntimeRadioPacket('device-b' as DeviceId, packet)).resolves.toBe(false);
  });
});

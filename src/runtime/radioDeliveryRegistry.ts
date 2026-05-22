import type { DeviceId } from '../domain/project';
import type { RuntimeRadioPacket } from './runtimeAdapter';

type RuntimeRadioSink = (packet: RuntimeRadioPacket) => Promise<void>;

interface RuntimeRadioSinkEntry {
  generation: number;
  sink: RuntimeRadioSink;
}

const radioSinks = new Map<DeviceId, RuntimeRadioSinkEntry>();
let nextGeneration = 0;

export function registerRuntimeRadioSink(deviceId: DeviceId, sink: RuntimeRadioSink): () => void {
  if (radioSinks.has(deviceId)) {
    throw new Error(`Runtime radio sink already registered for ${deviceId}`);
  }
  return replaceRuntimeRadioSink(deviceId, sink);
}

export function replaceRuntimeRadioSink(deviceId: DeviceId, sink: RuntimeRadioSink): () => void {
  const entry: RuntimeRadioSinkEntry = {
    generation: ++nextGeneration,
    sink,
  };
  radioSinks.set(deviceId, entry);
  return () => {
    if (radioSinks.get(deviceId)?.generation === entry.generation) {
      radioSinks.delete(deviceId);
    }
  };
}

export async function deliverRuntimeRadioPacket(
  deviceId: DeviceId,
  packet: RuntimeRadioPacket,
): Promise<boolean> {
  const entry = radioSinks.get(deviceId);
  if (!entry) {
    return false;
  }
  await entry.sink(packet);
  return true;
}

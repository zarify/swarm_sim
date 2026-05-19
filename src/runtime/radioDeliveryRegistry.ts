import type { DeviceId } from '../domain/project';
import type { RuntimeRadioPacket } from './runtimeAdapter';

type RuntimeRadioSink = (packet: RuntimeRadioPacket) => Promise<void>;

const radioSinks = new Map<DeviceId, RuntimeRadioSink>();

export function registerRuntimeRadioSink(deviceId: DeviceId, sink: RuntimeRadioSink): () => void {
  radioSinks.set(deviceId, sink);
  return () => {
    if (radioSinks.get(deviceId) === sink) {
      radioSinks.delete(deviceId);
    }
  };
}

export async function deliverRuntimeRadioPacket(
  deviceId: DeviceId,
  packet: RuntimeRadioPacket,
): Promise<boolean> {
  const sink = radioSinks.get(deviceId);
  if (!sink) {
    return false;
  }
  await sink(packet);
  return true;
}

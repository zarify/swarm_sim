import type { EnvironmentSource } from '../domain/project';
import type { RuntimeSensorId } from './runtimeAdapter';

export const FEATURE_FLAGS = {
  light: __FEATURE_LIGHT_ENABLED__,
  sound: __FEATURE_SOUND_ENABLED__,
  magnet: __FEATURE_MAGNET_ENABLED__,
} as const;

export function isEnvironmentSourceTypeEnabled(type: EnvironmentSource['type']): boolean {
  switch (type) {
    case 'light':
      return FEATURE_FLAGS.light;
    case 'sound':
      return FEATURE_FLAGS.sound;
    case 'magnet':
      return FEATURE_FLAGS.magnet;
    default:
      return false;
  }
}

export function filterEnabledEnvironmentSources(
  sources: EnvironmentSource[],
): EnvironmentSource[] {
  return sources.filter((source) => isEnvironmentSourceTypeEnabled(source.type));
}

export function isRuntimeSensorEnabled(sensor: RuntimeSensorId): boolean {
  if (sensor === 'lightLevel') {
    return FEATURE_FLAGS.light;
  }
  if (sensor === 'soundLevel') {
    return FEATURE_FLAGS.sound;
  }
  return FEATURE_FLAGS.magnet;
}

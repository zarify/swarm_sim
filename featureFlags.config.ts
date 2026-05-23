export interface BuildFeatureFlags {
  lightEnabled: boolean;
  soundEnabled: boolean;
  magnetEnabled: boolean;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function pickEnvValue(env: NodeJS.ProcessEnv, primary: string, secondary: string): string | undefined {
  return env[primary] ?? env[secondary];
}

export function resolveBuildFeatureFlags(env: NodeJS.ProcessEnv = process.env): BuildFeatureFlags {
  return {
    lightEnabled: parseBooleanEnv(
      pickEnvValue(env, 'SWARM_FEATURE_LIGHT', 'VITE_SWARM_FEATURE_LIGHT'),
      true,
    ),
    soundEnabled: parseBooleanEnv(
      pickEnvValue(env, 'SWARM_FEATURE_SOUND', 'VITE_SWARM_FEATURE_SOUND'),
      true,
    ),
    magnetEnabled: parseBooleanEnv(
      pickEnvValue(env, 'SWARM_FEATURE_MAGNET', 'VITE_SWARM_FEATURE_MAGNET'),
      false,
    ),
  };
}

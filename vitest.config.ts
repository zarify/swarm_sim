import { defineConfig } from 'vitest/config';
import packageJson from './package.json';
import { resolveBuildFeatureFlags } from './featureFlags.config';

const featureFlags = resolveBuildFeatureFlags();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_REPO_URL__: JSON.stringify('https://github.com/zarify/swarm_sim'),
    __FEATURE_LIGHT_ENABLED__: JSON.stringify(featureFlags.lightEnabled),
    __FEATURE_SOUND_ENABLED__: JSON.stringify(featureFlags.soundEnabled),
    __FEATURE_MAGNET_ENABLED__: JSON.stringify(featureFlags.magnetEnabled),
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});

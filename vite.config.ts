import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';
import { resolveBuildFeatureFlags } from './featureFlags.config';

const featureFlags = resolveBuildFeatureFlags();

export default defineConfig({
  // Emit relative asset URLs so dist/ can be mounted under any site path.
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_REPO_URL__: JSON.stringify('https://github.com/zarify/swarm_sim'),
    __FEATURE_LIGHT_ENABLED__: JSON.stringify(featureFlags.lightEnabled),
    __FEATURE_SOUND_ENABLED__: JSON.stringify(featureFlags.soundEnabled),
    __FEATURE_MAGNET_ENABLED__: JSON.stringify(featureFlags.magnetEnabled),
  },
});

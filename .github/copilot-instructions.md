# Copilot instructions for `microbit-swarm-simulator`

## Build, test, and typecheck commands

Use npm scripts from `package.json`:

- Install deps: `npm install`
- Start dev app: `npm run dev`
- Production build: `npm run build`
- Type-check only: `npm run typecheck`
- Full test suite: `npm run test`
- Install Playwright browsers (first run): `npm run test:e2e:install`
- Full Playwright suite: `npm run test:e2e`
- Run one Playwright file: `npm run test:e2e -- tests/e2e/core-canvas.spec.ts`
- Run one Playwright test by title: `npm run test:e2e -- -g "uploads MicroPython fixture for selected device"`
- Run a single test file: `npm run test -- src/runtime/sourceExtraction.test.ts`
- Run a single test case by name: `npm run test -- src/runtime/sourceExtraction.test.ts -t "extracts the MakeCode project file map from the PXT HEX fixture"`

There is currently no lint script in `package.json`.

## High-level architecture

- `src/App.tsx` is intentionally thin and mounts `SwarmCanvasPanel`, which is the main orchestration surface.
- `src/components/SwarmCanvasPanel.tsx` owns two synchronized state models: `project` (persisted devices/artifacts/environment sources) and `simulationState` (derived runtime state from `src/simulation/simulationEngine.ts`).
- `src/simulation/simulationEngine.ts` is the pure-function state engine for device lifecycle, environment sensor projection, radio routing, and runtime/log history.
- Runtime execution is adapter-driven: `src/runtime/sourceExtraction.ts` and `artifactReadiness.ts` identify embedded source, `src/runtime/programLoader.ts` prepares per-device runtime programs, and `src/runtime/runtimeAdapter.ts` defines the shared contract used by `MicroPythonRuntimeHost` and `MakeCodeRuntimeHost`, composed by `SwarmRuntimeHosts`.
- The browser runtime bridge depends on patched simulator pages in `public/` (`makecode-patched-runner.html`, `makecode-patched-simulator.html`, `micropython-patched-simulator.html`) rather than direct simulator integration from React components.
- Persistence is schema-versioned: `src/domain/project.ts` defines the domain model, `projectSerialization.ts` enforces schema compatibility, `projectBundle.ts` handles compressed `.swarm` bundles, and `browserProjectStore.ts` / `browserWorkingCopyStore.ts` provide IndexedDB-first browser persistence.

## Key repository conventions

- Keep `runtimeSource` explicit and authoritative (`'unknown' | 'makecode-pxt' | 'micropython'`):
  - Artifacts are never classified from filename text alone.
  - `programLoader.ts` validates artifact metadata against byte-level extraction (`extractHexSource`) before preparing runtime programs.
- Treat simulator integration as source-specific adapter work, not direct arbitrary HEX execution. Follow the adapter contract in `runtimeAdapter.ts` and emit typed runtime events (`display-change`, `radio-output`, `radio-config-change`, `sound-output`, `serial-output`, `internal-error`, data-log events).
- Preserve the `project` + `simulationState` coupling in `SwarmCanvasPanel`:
  - Project mutations must reconcile simulation state (see `reconcileSimulationProject` and related helpers).
  - Runtime host callbacks feed back into simulation via `routeRadioPacket`, `setDeviceRadioConfig`, and runtime log appenders.
- Keep radio loop-prevention behavior intact:
  - Runtime packet dedupe is implemented with short-lived fingerprints (microtask-based) in both panel/host bridges.
- Respect shared sensor domains from `src/runtime/microbitSensorDomains.ts`:
  - Use domain min/max/defaults for clamping and value normalization across simulation and runtime adapters.
- Build-time feature flags live in `featureFlags.config.ts`; if you add or change define globals consumed by app code, mirror them in both `vite.config.ts` and `vitest.config.ts`.
- Follow the repository's test-layer split from `AGENTS.md`:
  - runtime/domain logic changes belong in Vitest
  - user-facing canvas workflow changes belong in Playwright
  - mixed changes should run both
- Preserve project schema compatibility:
  - `PROJECT_SCHEMA_VERSION` gates deserialization.
  - Canvas bundles are exported/imported as compressed `.swarm` files; JSON serializer remains an internal compatibility surface.

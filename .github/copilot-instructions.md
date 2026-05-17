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
- Run acceptance coverage only: `npm run test -- src/acceptance/mvpAcceptance.test.ts`

There is currently no lint script in `package.json`.

## Recommended MCP servers

- **Playwright MCP (recommended):** this repo is heavily UI-driven (SVG canvas interactions, drag/drop uploads, runtime host iframes, radio/log inspectors). Use Playwright-based browser automation for end-to-end validation of these flows.
- **GitHub MCP:** useful when implementation work is driven by issues/PRs and you need repository context (linked files, code search, and review workflow) while coding.

## High-level architecture

- `src/App.tsx` is intentionally thin and mounts `SwarmCanvasPanel`, which is the main orchestration surface.
- `src/components/SwarmCanvasPanel.tsx` owns two synchronized states:
  - `project` (persisted domain model: devices, artifacts, environment sources)
  - `simulationState` (runtime state from `src/simulation/simulationEngine.ts`)
- `src/simulation/simulationEngine.ts` is a pure-function state engine for radio routing, device lifecycle, environment sensor projection, and log/radio event history.
- Runtime execution is adapter-driven:
  - Artifact/source analysis: `src/runtime/artifactReadiness.ts`, `src/runtime/sourceExtraction.ts`
  - Program preparation/loading: `src/runtime/programLoader.ts`
  - Common runtime contract: `src/runtime/runtimeAdapter.ts`
  - Runtime hosts: `src/components/MicroPythonRuntimeHost.tsx`, `src/components/MakeCodeRuntimeHost.tsx`, composed by `src/components/SwarmRuntimeHosts.tsx`
- MakeCode execution path is bridged through patched runner pages in `public/`:
  - `makecode-patched-runner.html` (host-side runner bridge)
  - `makecode-patched-simulator.html` (patched simulator event bridge)
  These convert simulator `postMessage` traffic into repository runtime events.
- Project persistence is schema-versioned:
  - Domain types: `src/domain/project.ts`
  - Serialization with artifact bytes encoded inline: `src/domain/projectSerialization.ts`
  - Browser storage abstraction with IndexedDB-first fallback: `src/domain/browserProjectStore.ts`, `src/domain/localProjectStore.ts`

## Key repository conventions

- Keep `runtimeSource` explicit and authoritative (`'unknown' | 'makecode-pxt' | 'micropython'`):
  - Artifacts are never classified from filename text alone.
  - Runtime source may be corrected using byte-level extraction (`extractHexSource`) when upload heuristics disagree.
- Treat simulator integration as source-specific adapter work, not direct arbitrary HEX execution. Follow the adapter contract in `runtimeAdapter.ts` and emit typed runtime events (`display-change`, `radio-output`, `radio-config-change`, `sound-output`, `serial-output`, `internal-error`).
- Preserve the `project` + `simulationState` coupling in `SwarmCanvasPanel`:
  - Project mutations must reconcile simulation state (see `reconcileSimulationProject` and related helpers).
  - Runtime host callbacks feed back into simulation via `routeRadioPacket`, `setDeviceRadioConfig`, and runtime log appenders.
- Keep radio loop-prevention behavior intact:
  - Runtime packet dedupe is implemented with short-lived fingerprints (microtask-based) in both panel/host bridges.
- Respect shared sensor domains from `src/runtime/microbitSensorDomains.ts`:
  - Use domain min/max/defaults for clamping and value normalization across simulation and runtime adapters.
- Preserve project schema compatibility:
  - `PROJECT_SCHEMA_VERSION` gates deserialization.
  - Artifact bytes are persisted as base64 (`bytesBase64`) in exported/imported project JSON.

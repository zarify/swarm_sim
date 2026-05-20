# AGENTS.md

## Test strategy for this repository

Use a two-layer test suite:

1. **Vitest (fast logic/component coverage)** for:
   - runtime adapters and extraction (`src/runtime/**/*.test.ts`)
   - simulation engine behavior (`src/simulation/simulationEngine.test.ts`)
   - domain serialization/persistence (`src/domain/**/*.test.ts`)
   - component-level interaction seams in jsdom (`src/components/*.test.tsx`)
2. **Playwright (browser workflow coverage)** for:
   - canvas boot and core UI workflow smoke
   - save/load/clear flows that depend on browser dialogs/storage
   - file upload flows using real fixture files from `hex_files/`

Do not move low-level edge-case assertions from Vitest into Playwright; keep Playwright for user-visible end-to-end behavior.

## Commands

- Unit/integration suite: `npm run test`
- Type-check: `npm run typecheck`
- Build: `npm run build`
- Install Playwright browsers (first run / CI image prep): `npm run test:e2e:install`
- E2E suite: `npm run test:e2e`
- E2E headed debugging: `npm run test:e2e:headed`

## Versioning expectations

- Follow semantic versioning for this project, including pre-1.0:
  - bug fix -> patch
  - backward-compatible feature -> minor
  - breaking change -> major
- If a change includes bug fixes or new features, update the project version in `package.json` as part of that change.

## Authoring conventions for new tests

- Prefer semantic selectors (`getByRole`, `getByLabelText`, visible text) before CSS selectors.
- Reuse existing UI labels and accessibility names already present in `SwarmCanvasPanel` (e.g. `Simulator instructions`, `Swarm tools`, `Load code onto Alpha`).
- For upload tests, use committed fixtures under `hex_files/` instead of inline synthetic data in browser tests.
- Keep E2E assertions on stable outcomes (assignment text, node counts, menu actions) and avoid deep iframe internals in baseline smoke tests.
- For dialog-driven flows (`prompt`, `confirm`), prefer deterministic stubs via `page.addInitScript` and assert both cancel/accept behavior through resulting UI state.
- Avoid hard sleeps; wait on explicit state transitions with Playwright expectations.

## Validation expectations for code changes

- If you change runtime/domain logic only: run `npm run test` and add/update Vitest tests.
- If you change user-facing canvas workflows: add/update at least one Playwright spec in `tests/e2e`.
- For mixed changes touching both layers: run both `npm run test` and `npm run test:e2e`.

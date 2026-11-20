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
- If a change includes bug fixes or new features, update the project version as part of that change.

### Bumping the version

- Bump with `npm version patch|minor|major` on `main` with a clean worktree. Never hand-edit `version` in `package.json`: `npm version` updates `package.json` and `package-lock.json` together, commits `v<version>`, and creates the annotated tag.
- If `package.json` was bumped by hand, resync the lockfile with `npm install --package-lock-only` and commit both files together. The `version` fields in `package-lock.json` are a snapshot of `package.json` and go stale otherwise (npm ignores them for resolution, so drift is silent).
- Tag only released commits: annotated tags named `v<version>`, created on the release commit on `main` (normally the merge commit of the release PR), after tests pass. Never move or re-point a tag that has been pushed.
- Push releases with `git push --follow-tags` (lightweight tags are not pushed by this flag).

### Packaging

- `npm run release:zip` only packages the current checkout into `release/<name>-v<version>.zip`; it does not bump the version or create tags.
- The script refuses to run unless the worktree is clean and `HEAD` is exactly at tag `v<version>`, so a zip always corresponds to a tagged commit.
- Rebuilding the same version is safe only while the tag stays on the same commit; a rebuild on a different commit must use a new version.

## Authoring conventions for new tests

- Prefer semantic selectors (`getByRole`, `getByLabelText`, visible text) before CSS selectors.
- Reuse existing UI labels and accessibility names already present in `SwarmCanvasPanel` (e.g. `Simulator instructions`, `Swarm tools`, `Load code onto Node 1`).
- For upload tests, use committed fixtures under `hex_files/` instead of inline synthetic data in browser tests.
- Keep E2E assertions on stable outcomes (assignment text, node counts, menu actions) and avoid deep iframe internals in baseline smoke tests.
- For dialog-driven flows (`prompt`, `confirm`), prefer deterministic stubs via `page.addInitScript` and assert both cancel/accept behavior through resulting UI state.
- Avoid hard sleeps; wait on explicit state transitions with Playwright expectations.

## Validation expectations for code changes

- If you change runtime/domain logic only: run `npm run test` and add/update Vitest tests.
- If you change user-facing canvas workflows: add/update at least one Playwright spec in `tests/e2e`.
- For mixed changes touching both layers: run both `npm run test` and `npm run test:e2e`.

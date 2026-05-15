# Micro:bit Swarm Simulator

Greenfield implementation of the PRD in `microbit-swarm-plan.md`.

## Development

```bash
npm install
npm run dev
npm run test
npm run build
```

## Current implementation slice

This first slice establishes the React + TypeScript + Vite application shell and a runtime-spike harness. It intentionally does **not** claim full compiled artifact execution yet.

The spike records the current technical position:

- MakeCode `.hex` support is likely best approached through the official PXT simulator, but it must be isolated behind an adapter before the main simulator depends on it.
- MicroPython `.hex` execution with browser hooks for display, buttons, radio, light, and sound is not currently proven.
- The app accepts `.hex` metadata for spike evaluation only; real execution remains blocked until byte-level adapter checks can distinguish MakeCode/MicroPython artifacts and prove the required hooks.
- The runtime contract includes an explicit `runtimeSource` field so a future byte-level adapter can report `makecode-pxt` or `micropython` without relying on filenames.
- Package availability reinforces the split: `pxt-microbit` and `pxt-core` are published on npm, while `microbit-micropython-js` is not available as an npm package.

## Design direction

The UI uses a field-lab control-room aesthetic: dark instrument panels, phosphor accents, amber warnings, and grid overlays. This keeps the simulator visually tied to spatial radio debugging rather than a generic dashboard.

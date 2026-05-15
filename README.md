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
- Fixture-backed detection now parses Intel HEX data records and classifies the provided `hex_files/mc_beacon.hex` as `makecode-pxt` and `hex_files/mp_beacon.hex` as `micropython`; both remain non-executable until a runtime adapter proves radio/display hooks.

## Simulator adapter decision

Use the official simulator stacks behind one adapter contract rather than searching for a single generic HEX emulator:

- **MicroPython**: `microbit-foundation/micropython-microbit-v2-simulator`. It is MIT licensed, WASM-based, and documents an iframe `postMessage` API for `flash`, `reset`, `stop`, `sensor_set`, `serial_input`, `radio_input`, `serial_output`, `radio_output`, and internal errors. It flashes a MicroPython filesystem such as `main.py`, not arbitrary `.hex` bytes.
- **MakeCode**: `microsoft/pxt` plus `microsoft/pxt-microbit`. The generic simulator driver lives in `microsoft/pxt/pxtsim`; the micro:bit target board and state wiring live in `microsoft/pxt-microbit/sim`, including `DalBoard`, `LedMatrixState`, `ButtonPairState`, `LightSensorState`, `MicrophoneState`, and `RadioState`. This is the official MakeCode simulator stack, but it runs PXT simulator code rather than arbitrary `.hex` bytes.

The shared adapter contract in `src/runtime/runtimeAdapter.ts` now targets the operations the swarm engine needs: flash, reset, stop, button input, light/sound sensor input, radio input, and event output for display, radio, serial, and internal errors. Program flashing is source-specific: MicroPython carries a filesystem payload, while MakeCode can carry simulator JavaScript, source files, project metadata, and the original artifact. Radio packets carry optional group, channel, and signal-strength metadata so the spatial swarm router does not need a breaking adapter change later.

The next runtime spike should prove:

1. MicroPython: extract or preserve `main.py`, flash it into the Foundation simulator, observe `radio_output` for `ping`, inject `radio_input`, and find a stable display-state signal.
2. MakeCode: determine whether `mc_beacon.hex` contains recoverable PXT project/source metadata or whether MakeCode uploads must include source/project data; then run through `pxtsim` and validate display/radio hooks.

## Design direction

The UI uses a field-lab control-room aesthetic: dark instrument panels, phosphor accents, amber warnings, and grid overlays. This keeps the simulator visually tied to spatial radio debugging rather than a generic dashboard.

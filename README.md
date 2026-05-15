# Micro:bit Swarm Simulator

Greenfield implementation of the PRD in `microbit-swarm-plan.md`.

## Development

```bash
npm install
npm run dev
npm run test
npm run build
```

## Current implementation

The app now includes the React + TypeScript + Vite shell, schema-versioned project persistence, source extraction for editor-generated HEX files, a runtime program loading pipeline, a MicroPython iframe adapter for the Foundation simulator API, a pure TypeScript swarm simulation engine, and an interactive SVG swarm canvas with selected-device code upload, radio telemetry, compact per-device logs, a radio message inspector, and persistent embedded MicroPython simulator frames for assigned devices.

It intentionally does **not** claim full compiled artifact execution yet.

The spike records the current technical position:

- MakeCode `.hex` support is likely best approached through the official PXT simulator, but it must be isolated behind an adapter before the main simulator depends on it.
- MicroPython `.hex` execution is now wired through selected-device upload, source extraction, and per-device Foundation simulator iframes for flash/radio/serial/error hooks; display-state extraction and full live-browser validation remain open.
- The app accepts `.hex` uploads from the selected device panel and can now prepare assigned MicroPython device programs from uploaded artifacts; full execution remains blocked for MakeCode and partially proven for MicroPython.
- The runtime contract includes an explicit `runtimeSource` field so a future byte-level adapter can report `makecode-pxt` or `micropython` without relying on filenames.
- Package availability reinforces the split: `pxt-microbit` and `pxt-core` are published on npm, while `microbit-micropython-js` is not available as an npm package.
- Fixture-backed detection now parses Intel HEX data records and classifies the provided `hex_files/mc_beacon.hex` as `makecode-pxt` and `hex_files/mp_beacon.hex` as `micropython`; both remain non-executable until a runtime adapter proves radio/display hooks.
- Source extraction is now proven from editor-generated HEX fixtures: MicroPython recovers `main.py` from the embedded filesystem, while MakeCode recovers the embedded PXT project file map using the documented source header and LZMA payload.
- Device runtime loading now resolves each `programArtifactId`, extracts the source-specific runtime program, and prepares it through a matching adapter when one is provided. Without an adapter the result is explicitly marked `prepared`, not falsely executed.
- A concrete MicroPython iframe adapter waits for the simulator `ready` handshake, can defer `flash` until the simulator sends `request_flash`, posts `reset`, `stop`, `set_value`, and `radio_input` messages, and converts `radio_output`, `serial_output`, and `internal_error` iframe messages into runtime adapter events.
- The Foundation MicroPython iframe API does not currently document live radio group/channel observation. The UI therefore marks runtime group/channel as unexposed instead of inferring static values from source code that can change at runtime.
- Project persistence now has a schema-versioned domain model, self-contained JSON export/import with artifact bytes encoded inline, and browser local-storage helpers for save/reopen flows.
- The simulation engine covers run/pause/resume/reset, 6-10 device radio routing, signal-strength-to-radius mapping, group/channel filtering, movement recalculation, light/sound source influence, and radio message events. MicroPython runtime reset can target one prepared device or all prepared devices in the scenario.

## Simulator adapter decision

Use the official simulator stacks behind one adapter contract rather than searching for a single generic HEX emulator:

- **MicroPython**: `microbit-foundation/micropython-microbit-v2-simulator`. It is MIT licensed, WASM-based, and documents an iframe `postMessage` API for `flash`, `reset`, `stop`, `sensor_set`, `serial_input`, `radio_input`, `serial_output`, `radio_output`, and internal errors. It flashes a MicroPython filesystem such as `main.py`, not arbitrary `.hex` bytes.
- **MakeCode**: `microsoft/pxt` plus `microsoft/pxt-microbit`. The generic simulator driver lives in `microsoft/pxt/pxtsim`; the micro:bit target board and state wiring live in `microsoft/pxt-microbit/sim`, including `DalBoard`, `LedMatrixState`, `ButtonPairState`, `LightSensorState`, `MicrophoneState`, and `RadioState`. This is the official MakeCode simulator stack, but it runs PXT simulator code rather than arbitrary `.hex` bytes.

The shared adapter contract in `src/runtime/runtimeAdapter.ts` now targets the operations the swarm engine needs: flash, reset, stop, button input, light/sound sensor input, radio input, and event output for display, radio, serial, and internal errors. Program flashing is source-specific: MicroPython carries a filesystem payload, while MakeCode can carry simulator JavaScript, source files, project metadata, and the original artifact. Radio packets carry optional group, channel, and signal-strength metadata so the spatial swarm router does not need a breaking adapter change later. `src/runtime/programLoader.ts` is the bridge from persisted projects to per-device runtime programs.

The next runtime spike should prove:

1. MicroPython: verify selected-device upload and the embedded iframe Play flow with the real `mp_beacon.hex` in a browser, confirm bidirectional radio delivery between simulated devices, and find a stable display-state signal.
2. MakeCode: compile/run the recovered PXT project through `pxtsim` and validate display/radio hooks.

## Design direction

The UI uses a field-lab control-room aesthetic: dark instrument panels, phosphor accents, amber warnings, and grid overlays. This keeps the simulator visually tied to spatial radio debugging rather than a generic dashboard.

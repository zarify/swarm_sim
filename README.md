# Micro:bit Swarm Simulator

Greenfield implementation of the PRD in `microbit-swarm-plan.md`.

## Development

```bash
npm install
npm run dev
npm run test
npm run test:e2e
npm run build
```

## Static hosting notes

- The app is static-hostable (`npm run build` + serve `dist/` from any HTTP server).
- GitHub Pages is the baseline hosting target. The repo does not require custom response headers because GitHub Pages does not support project-defined headers.
- A versioned release zip can be created with `npm run release:zip` (output: `release/microbit-swarm-simulator-v<version>.zip`).
- Runtime debug traces (`[swarm-radio-debug]`) are development-only and intentionally suppressed in production bundles.
- Browser warnings about iframe sandbox flags (`allow-scripts` + `allow-same-origin`) are expected with the current simulator embedding strategy.
- The MakeCode runner and simulator scripts use Subresource Integrity hashes. If MakeCode updates those upstream assets, refresh the URLs/hashes together and validate MakeCode runtime smoke tests.
- Self-hosters on platforms such as Netlify, Cloudflare Pages, Vercel, or a school server can add optional security headers, but CSP is not a universal default for this project: a strict policy can break MakeCode assets, local WASM, or LMS/Moodle embedding. If you opt in, test runtime loading before sharing with students.
- New devices now spawn within default radio range of the first node, so two-node MicroPython smoke tests produce received packets without manual repositioning.

## Current implementation

The app now includes the React + TypeScript + Vite shell, schema-versioned project persistence, source extraction for editor-generated HEX files, a runtime program loading pipeline, a MicroPython iframe adapter for the Foundation simulator API, a pure TypeScript swarm simulation engine, and an interactive SVG swarm canvas with selected-device code upload, radio telemetry, compact per-device logs, radio message inspection, per-node runtime activity rings (radio transmit and speaker/sound output), environmental light/sound/magnet sources, and persistent embedded MicroPython simulator frames for assigned devices.

It intentionally does **not** claim full compiled artifact execution yet.

The spike records the current technical position:

- MakeCode `.hex` support is likely best approached through the official PXT simulator, but it must be isolated behind an adapter before the main simulator depends on it.
- MicroPython `.hex` execution is now wired through selected-device upload, source extraction, and per-device Foundation simulator iframes for flash/radio/serial/error hooks; display-state extraction and full live-browser validation remain open.
- The app accepts `.hex` uploads from the selected device panel, keeps unextractable assignments as non-executable `unknown` artifacts, prepares assigned MicroPython programs through iframe simulators, and prepares/runs MakeCode programs through a patched official `pxtsim` iframe runner that emits display/radio/serial events into the swarm engine.
- The runtime contract includes an explicit `runtimeSource` field so a future byte-level adapter can report `makecode-pxt` or `micropython` without relying on filenames.
- Package availability reinforces the split: `pxt-microbit` and `pxt-core` are published on npm, while `microbit-micropython-js` is not available as an npm package.
- Fixture-backed detection now parses Intel HEX data records and classifies the provided `hex_files/mc_beacon.hex` as `makecode-pxt` and `hex_files/mp_beacon.hex` as `micropython`; both can be prepared through runtime adapters, with MakeCode routed through a patched official simulator runner path.
- Source extraction is now proven from editor-generated HEX fixtures: MicroPython recovers `main.py` from the embedded filesystem, while MakeCode recovers the embedded PXT project file map using the documented source header and LZMA payload.
- Device runtime loading now resolves each `programArtifactId`, extracts the source-specific runtime program, and prepares it through a matching adapter when one is provided. Without an adapter the result is explicitly marked `prepared`, not falsely executed.
- A concrete MicroPython iframe adapter waits for the simulator `ready` handshake, can defer `flash` until the simulator sends `request_flash`, posts `reset`, `stop`, `set_value`, and `radio_input` messages, and converts simulator and bridge outputs into `radio-output`, `sound-output`, `serial-output`, and `internal-error` runtime adapter events.
- A concrete MakeCode iframe runtime adapter now consumes extracted project source files, runs them via the official `pxtsim` stack in a patched runner/simulator pair, supports reset/stop lifecycle controls, and emits LED/radio/sound/serial events into the swarm engine while accepting environment-driven button/sensor/radio input.
- Runtime hosts now surface static source-derived radio group hints (for both MicroPython `radio.config(...)` and MakeCode `radio.setGroup(...)`) into the simulation router so mixed-runtime group filtering stays consistent without requiring undocumented live simulator introspection.
- Runtime hosts now stay mounted for every assigned runtime type so mixed MicroPython + MakeCode scenarios run at the same time, and assigned runtimes auto-load after HEX upload (no manual prepare step required in the canvas workflow).
- Canvas device cards are now the primary interaction surface: they are larger and their A/B buttons are clickable, with button state propagated into runtime adapters for both runtimes. Runtime host panels can run without exposing simulator cards in the main canvas workflow.
- A shared micro:bit sensor-domain contract now defines canonical ranges/defaults for current and planned built-in sensors (light/sound/magnetic force/temperature/compass/acceleration/logo touch), so environment mapping and future sensor integrations normalize through one place instead of ad-hoc per feature.
- Project persistence now has a schema-versioned domain model, compressed self-contained bundle export/import, an IndexedDB-first browser layout store (with storage fallback), and a canvas-state menu for save/load/download/upload/clear workflows.
- The simulation engine covers run/pause/resume/reset, 6-10 device radio routing, signal-strength-to-radius mapping, group/channel filtering, movement recalculation, light/sound/magnet source influence, and radio message events. MicroPython runtime reset can target one prepared device or all prepared devices in the scenario.

## Simulator adapter decision

Use the official simulator stacks behind one adapter contract rather than searching for a single generic HEX emulator:

- **MicroPython**: `microbit-foundation/micropython-microbit-v2-simulator`. It is MIT licensed, WASM-based, and documents an iframe `postMessage` API for `flash`, `reset`, `stop`, `sensor_set`, `serial_input`, `radio_input`, `serial_output`, `radio_output`, and internal errors. It flashes a MicroPython filesystem such as `main.py`, not arbitrary `.hex` bytes.
- **MakeCode**: `microsoft/pxt` plus `microsoft/pxt-microbit`. The generic simulator driver lives in `microsoft/pxt/pxtsim`; the micro:bit target board and state wiring live in `microsoft/pxt-microbit/sim`, including `DalBoard`, `LedMatrixState`, `ButtonPairState`, `LightSensorState`, `MicrophoneState`, and `RadioState`. This is the official MakeCode simulator stack, but it runs PXT simulator code rather than arbitrary `.hex` bytes.

The shared adapter contract in `src/runtime/runtimeAdapter.ts` now targets the operations the swarm engine needs: flash, reset, stop, button input, light/sound/magnetic sensor input, radio input, and event output for display, radio, sound, serial, and internal errors. Program flashing is source-specific: MicroPython carries a filesystem payload, while MakeCode can carry simulator JavaScript, source files, project metadata, and the original artifact. Radio packets carry optional group, channel, and signal-strength metadata so the spatial swarm router does not need a breaking adapter change later. `src/runtime/programLoader.ts` is the bridge from persisted projects to per-device runtime programs.

The next runtime spike should prove:

1. MicroPython: verify selected-device upload and auto-start runtime flow with the real `mp_beacon.hex` in a browser, confirm bidirectional radio delivery between simulated devices, and find a stable display-state signal.
2. MakeCode: compile/run the recovered PXT project through `pxtsim` and validate display/radio hooks.

## Design direction

The UI uses a field-lab control-room aesthetic: dark instrument panels, phosphor accents, amber warnings, and grid overlays. This keeps the simulator visually tied to spatial radio debugging rather than a generic dashboard.

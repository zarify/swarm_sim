# Micro:bit Swarm Simulator

I like the Makecode simulator. I like the Micropython simulator. I don't like trying to simulate radio
and sensor behaviour using either of those simulators:
- Sliders aren't that intuitive for things like light and sound
- Makecode radio simulation requires that the same code exists on both sender and receiver. This confuses students **a lot**.

So I decided I'd fire up the trusty (YMMV) agent to make something to fill the gaps.

## What swarm is

The swarm simulator is a canvas that you can create micro:bit device nodes and some types of environmental
nodes (like light and sound sources), load your (pre-written) device code onto the devices, and see what
they do. You can drag the different nodes around and see what happens, press buttons, inspect radio
tranmissions, and hopefully get a better feel for what would happen if you loaded the code onto real devices
in a real environment.

It supports:
- Display
- Buttons
- Radio (range, groups and hand-wavey RSSI values. Channels and transmit power need testing and might not work)
- Visual representations of sound emission (I'm not a monster)
- Serial output
- Data logging (download a zip bundle of data log files via the Swarm tools)
- Light and sound sensors
- Lightweight code editing (text only) of `main.py` and `main.ts` depending on source language for testing and prototyping (requires code to be loaded first)
- Saving and loading of canvas setup with device code and positions both in your browser (IDB) or external files. Use these with your own projects or share them with students
- Locked micro:bit devices that don't have code editing and only support a single program load. Use these for mysteries students need to investigate.

## What swarm isn't

- You don't create any code here. Write it [elsewhere](https://www.microbit.org/code/) then drop it in.
- This isn't a physics simulator, it's a "reasonable approximation simulator"
- This isn't an exact micro:bit simulator. I intentionally left things out (e.g. accelerometer, pins)

## Development

```bash
npm install
npm run dev
npm run test
npm run test:e2e
npm run build
```

## Build-time feature flags

Environment-source capabilities are controlled at build time:

- `SWARM_FEATURE_LIGHT` (default: `true`)
- `SWARM_FEATURE_SOUND` (default: `true`)
- `SWARM_FEATURE_MAGNET` (default: `false`)

`VITE_SWARM_FEATURE_LIGHT`, `VITE_SWARM_FEATURE_SOUND`, and `VITE_SWARM_FEATURE_MAGNET` are accepted aliases.

Examples:

```bash
# Default build (light+sound enabled, magnet disabled)
npm run build

# Build with magnet enabled
SWARM_FEATURE_MAGNET=1 npm run build

# Build without sound
SWARM_FEATURE_SOUND=0 npm run build
```

When magnet is disabled, magnet sources are preserved in project data but hidden and ignored by the simulation/runtime UI.

## Hosting notes

- The app is static-hostable (`npm run build` + serve `dist/` from any HTTP server).
- You can also just grab a current release zip (contents of `dist/`) from releases, but that will only be built with the default features on.

## Implementation notes

Swarm was built with Copilot, mostly with GPT 5.3 Codex. I try to test fairly rigorously for the use cases under development
but as anyone familiar with coding agents will know, there's almost always going to be some stub that got left in while you
were told a feature was fully written. If you find something that looks a bit weird, drop it into the issues.

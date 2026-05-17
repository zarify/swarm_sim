# Product Requirements Document: Micro:bit Swarm Simulator

## 1. Product summary

Micro:bit Swarm Simulator is a browser-based tool for students who can already write micro:bit programs but do not have access to multiple physical devices. It allows them to load different compiled programs onto multiple virtual micro:bits, arrange those devices spatially on a canvas, and observe how they interact through radio and simple environmental stimuli.

The product should feel as close to working with real micro:bits as possible. A student should be able to take code they tested in the simulator, load it onto real devices arranged similarly, and get behavior that is meaningfully consistent, aside from intentionally simplified radio modeling.

## 2. Problem statement

Students can write micro:bit code, including radio-based distributed behavior, but often cannot test it properly because:

- they may have access to only one micro:bit or none at all
- existing simulators are poor at representing multi-device radio behavior
- current simulator workflows often assume identical code on all simulated devices
- students cannot easily reason about spatial position, radio reach, or message flow across a swarm

As a result, students are blocked from learning and experimenting with multi-device micro:bit systems unless they have enough physical hardware.

## 3. Target user

### Primary user

Students who are comfortable writing micro:bit code themselves and want to test multi-device programs, especially radio-driven behavior, without needing a full set of physical micro:bits.

### User context

- working independently rather than relying on teacher-prepared scenarios
- likely using a desktop or laptop browser
- may be using MakeCode or MicroPython toolchains already
- wants confidence that the simulator reflects real device behavior closely enough to support learning and experimentation

## 4. Core value proposition

The product gives students a practical way to build, run, inspect, and debug a small swarm of virtual micro:bits with different programs, in a spatial environment, using a simulation model that is simple enough to understand but realistic enough to trust.

## 5. Product goals

### Primary goal

A student can reliably test multi-micro:bit radio code without physical hardware.

### Supporting goals

1. Let students run different compiled programs on multiple virtual micro:bits in one project.
2. Make radio behavior understandable through spatial visualization and inspection tools.
3. Preserve a close mental model to real micro:bit behavior rather than creating simulator-specific surprises.
4. Keep the product lightweight and accessible by running fully client-side in the browser.
5. Allow projects to be saved, exported, imported, and reopened as self-contained files.

## 6. Non-goals for v1

The first release will explicitly not include:

- precise real-world radio physics
- cloud accounts, cloud storage, or collaboration features
- embedded MakeCode or MicroPython editors
- SPI or I2C peripheral emulation
- generic electronics workbench behavior, wiring, or connected components
- full step-through debugging
- built-in example swarm projects
- phone-first or tablet-first support

## 7. Product principles

### 7.1 Realism over cleverness

The simulator should prioritize behavior that matches real student expectations from physical micro:bits. It should avoid adding hidden simulator-only controls that make outcomes diverge from real device behavior.

### 7.2 Spatial understanding matters

Distributed behavior should be visible. Position, radio reach, and nearby environmental sources should be legible in the main UI.

### 7.3 Student-controlled complexity

The product should support meaningful experimentation without requiring students to understand complex hardware simulation, network physics, or infrastructure.

### 7.4 Local-first simplicity

Students should be able to use the product, load projects, and save work without creating accounts or depending on backend services.

## 8. Scope of v1

### In scope

- browser-based desktop/laptop experience
- fully client-side operation
- importing compiled micro:bit artifacts
- support for both MakeCode and MicroPython compiled outputs
- multiple virtual micro:bits in one simulation
- 6-10 virtual micro:bits as the expected successful use case
- draggable spatial canvas
- visible micro:bit display state on each node
- position-based radio simulation
- radio groups/channels as reflected by program behavior
- radio range derived from program-set strength values
- live re-evaluation of connectivity when devices move
- device buttons as user-triggerable inputs
- placeable light sources and sound sources
- run, pause, resume, and reset controls
- per-device event logs
- radio message inspector
- self-contained project export/import

### Out of scope

- pin simulation in v1
- accelerometer simulation in v1
- manual simulator-side override of radio strength/range
- embedded code editing in v1
- classroom content libraries or starter templates in v1

## 9. Primary user journey

1. A student creates a new swarm project.
2. The student adds micro:bits one by one.
3. For each device, the student assigns a compiled code artifact.
4. The student positions devices on a canvas.
5. The student optionally places light and sound source objects on the canvas.
6. The student starts the simulation.
7. The student observes each device's display output, radio interactions, and logs.
8. The student drags devices or adjusts source objects to test how behavior changes.
9. The student pauses, resumes, or resets as needed.
10. The student saves or exports the project as a self-contained file for later reuse.

## 10. User stories

### Core stories

- As a student, I want to load different programs onto multiple virtual micro:bits so I can test distributed behavior.
- As a student, I want to place devices spatially so I can see how radio reach changes outcomes.
- As a student, I want the simulator to behave similarly to real devices so my learning transfers to physical hardware.
- As a student, I want to inspect radio messages and per-device logs so I can understand why the swarm behaved the way it did.
- As a student, I want to save a complete project into one file so I can reopen or share it without managing separate assets.

### Supporting stories

- As a student, I want each device node to show its current display so I can quickly see state changes.
- As a student, I want to move devices during runtime so I can test how proximity affects communication.
- As a student, I want to add light and sound sources so I can test simple environment-driven interactions.
- As a student, I want to use the simulator entirely in the browser without logging in.

## 11. Functional requirements

### 11.1 Project creation and management

The product must allow users to create a new swarm project with no backend account.

The product must allow users to:

- start a blank project
- add virtual micro:bits one at a time
- assign a compiled code artifact to each device
- rename devices
- save and reopen a project locally
- export and import a portable self-contained project file

The exported project file must include all uploaded code artifacts and project state so it can be reopened without missing dependencies.

### 11.2 Supported code artifacts

The simulator must accept compiled artifacts produced from:

- MakeCode
- MicroPython

The PRD assumes support for hex and/or uf2 style compiled micro:bit artifacts, with the exact accepted file extensions to be finalized during design and technical validation.

V1 must focus on file upload rather than embedded editing, but the product structure should leave room for future embedded editors.

### 11.3 Swarm canvas

The main simulation surface must be a canvas showing:

- each micro:bit as an individual draggable node
- current device display state on each node
- optional radio radius overlays that can be toggled on and off
- placeable environment objects

The canvas must update spatial relationships live while the simulation is running.

### 11.4 Virtual micro:bit nodes

Each virtual micro:bit must have:

- a unique identity within the project
- an assigned compiled program
- a position on the canvas
- visible display output
- access to logs and radio inspection data

Selecting a device must open a detail panel showing:

- device name
- assigned program reference
- current display state
- per-device event log
- radio-related information
- live controls for supported interactions such as button input

Where relevant, v1 should assume micro:bit V2 capabilities.

### 11.5 Radio simulation

Radio behavior is a core requirement.

The simulator must:

- model radio communication using spatial position
- support radio groups/channels as they are used by running programs
- derive radio range from the code-controlled radio strength value
- use a simple linear mapping from strength to displayed/effective radius
- use a default common range unless a program changes strength
- re-evaluate connectivity immediately when devices move

The simulator must not expose a separate simulator-only override for radio strength or range in v1.

The radio model should be realistic enough for student learning and code transfer, but it does not need to model detailed physical radio propagation.

### 11.6 Environment objects

V1 must support simple placeable:

- light sources
- sound sources

Each source object must have:

- a canvas position
- adjustable radius
- adjustable intensity

Nearby virtual micro:bits should be affected by these sources according to a simple spatial influence model.

Micro:bits should also be able to visibly indicate when their running programs are producing sound-related behavior, where relevant.

### 11.7 Interactive inputs

Supported interactive inputs in v1:

- device button controls
- spatial interaction with light sources
- spatial interaction with sound sources

Not supported in v1:

- pin simulation
- accelerometer simulation
- SPI/I2C device behavior

### 11.8 Simulation controls

The product must provide:

- run
- pause
- resume
- reset

These controls must operate at the project level.

### 11.9 Observability and debugging

V1 must include enough observability for students to understand distributed behavior.

Required observability surfaces:

- live per-device display output
- per-device event log
- radio message inspector

The radio message inspector should help users understand which messages were sent, received, or not received under the current simulation conditions.

Full step-through debugging is not required in v1.

## 12. UX requirements

### 12.1 Clarity

The product should make it obvious:

- which code is running on which device
- where each device is located
- what each device is showing
- which devices are in radio range
- what messages are moving through the swarm

### 12.2 Low-friction setup

Users should be able to create a project by adding devices and uploading files, without first learning a template system or account model.

### 12.3 Trustworthy behavior

The UI should avoid exposing settings that produce unrealistic behavior disconnected from how real micro:bit code works.

### 12.4 Progressive extensibility

Although v1 is intentionally scoped down, the canvas and simulation model should leave room for later additions such as:

- embedded editors
- extra sensor types
- pin simulation
- SPI/I2C devices
- more environment objects

## 13. Non-functional requirements

### 13.1 Platform

- browser-based web app
- optimized for desktop/laptop browsers
- fully client-side in v1

### 13.2 Scale

The expected successful simulation size for v1 is 6-10 virtual micro:bits in a single project.

### 13.3 Portability

Projects must be portable as a single self-contained file.

### 13.4 Predictability

Behavior should prioritize consistency and learnability over high-fidelity physical simulation.

## 14. Success criteria

V1 is successful if a student can:

1. Load different compiled programs onto several virtual micro:bits.
2. Arrange those devices spatially and see radio range relationships.
3. Run the simulation and observe realistic enough multi-device behavior to validate radio logic.
4. Inspect logs and radio messages to understand outcomes.
5. Save the full experiment as one portable project file and reopen it later.

## 15. Future opportunities

The following are intentionally deferred but should remain possible later:

- embedded MakeCode editor
- embedded MicroPython editor
- accelerometer simulation
- pin simulation
- SPI/I2C device simulation
- richer hardware/environment objects
- collaboration or cloud storage
- starter swarm templates or example projects

## 16. Summary

Micro:bit Swarm Simulator v1 is a local-first browser product for students who need to test and understand multi-device micro:bit behavior without physical hardware. Its defining strength is realistic, spatially legible swarm simulation: different programs on different devices, live radio interactions, simple environment sources, and enough observability to make distributed behavior understandable.

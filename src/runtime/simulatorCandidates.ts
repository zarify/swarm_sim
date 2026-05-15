import type { RuntimeSource, SimulatorCandidate, SimulatorCapabilityId } from './types';
import { REQUIRED_RUNTIME_CAPABILITY_IDS } from './types';

export const REQUIRED_SWARM_CAPABILITIES: SimulatorCapabilityId[] = [
  'program-load',
  ...REQUIRED_RUNTIME_CAPABILITY_IDS,
];

export const SIMULATOR_CANDIDATES: SimulatorCandidate[] = [
  {
    id: 'microbit-foundation-micropython-v2',
    name: 'micro:bit Foundation MicroPython v2 simulator',
    runtimeSource: 'micropython',
    repository: 'https://github.com/microbit-foundation/micropython-microbit-v2-simulator',
    license: 'MIT',
    integrationSurface: 'iframe postMessage API',
    loadPath:
      'Flash a MicroPython filesystem such as {"main.py": Uint8Array}; the public API does not document direct .hex execution.',
    adapterRisk: 'medium',
    capabilities: [
      {
        id: 'program-load',
        state: 'documented',
        evidence: 'README documents a flash message with filesystem entries.',
      },
      {
        id: 'direct-hex-execution',
        state: 'not-supported',
        evidence: 'README flash API accepts filesystem data, not arbitrary .hex bytes.',
      },
      {
        id: 'display-output',
        state: 'needs-spike',
        evidence: 'Board UI exists, but a stable postMessage LED matrix output was not documented.',
      },
      {
        id: 'button-input',
        state: 'documented',
        evidence: 'README documents sensor_set for buttons and sensors.',
      },
      {
        id: 'light-input',
        state: 'documented',
        evidence: 'README ready state includes lightLevel and sensor_set can update state values.',
      },
      {
        id: 'sound-input',
        state: 'documented',
        evidence: 'README ready state includes soundLevel and sensor_set can update state values.',
      },
      {
        id: 'sound-output',
        state: 'needs-spike',
        evidence: 'README documents mute/unmute but not stable sound output observation for swarm events.',
      },
      {
        id: 'radio-output',
        state: 'documented',
        evidence: 'README documents radio_output messages sent from the running program.',
      },
      {
        id: 'radio-input',
        state: 'documented',
        evidence: 'README documents radio_input messages sent to the running program.',
      },
      {
        id: 'radio-group-observation',
        state: 'needs-spike',
        evidence: 'README says radio_input is assumed to use the current group; group introspection is not documented.',
      },
      {
        id: 'radio-strength',
        state: 'needs-spike',
        evidence: 'Radio signal strength/range observation is not documented in the iframe API.',
      },
      {
        id: 'reset-control',
        state: 'documented',
        evidence: 'README documents reset and stop messages.',
      },
    ],
    nextSpike: [
      'Extract main.py from the MicroPython HEX fixture or preserve source alongside uploads.',
      'Flash the fixture program through the iframe filesystem API.',
      'Verify radio_output payload bytes for "ping" and radio_input delivery back to the program.',
      'Determine whether LED matrix state can be observed without scraping the iframe DOM.',
    ],
  },
  {
    id: 'microsoft-makecode-pxt-microbit',
    name: 'Microsoft MakeCode PXT micro:bit simulator',
    runtimeSource: 'makecode-pxt',
    repository: 'https://github.com/microsoft/pxt + https://github.com/microsoft/pxt-microbit',
    license: 'MIT',
    integrationSurface: 'PXT simulator driver plus pxt-microbit target simulator',
    loadPath:
      'Run generated PXT simulator JavaScript through pxtsim; direct arbitrary .hex execution is not the documented simulator path.',
    adapterRisk: 'high',
    capabilities: [
      {
        id: 'program-load',
        state: 'needs-spike',
        evidence: 'PXT simulator runs simulator JavaScript; rehydrating an uploaded .hex requires source/project metadata validation.',
      },
      {
        id: 'direct-hex-execution',
        state: 'not-supported',
        evidence: 'The located PXT simulator code is a JS runtime/driver, not a generic Intel HEX CPU emulator.',
      },
      {
        id: 'display-output',
        state: 'documented',
        evidence: 'pxt-microbit DalBoard wires LedMatrixState into the simulator board.',
      },
      {
        id: 'button-input',
        state: 'documented',
        evidence: 'pxt-microbit DalBoard wires ButtonPairState into the simulator board.',
      },
      {
        id: 'light-input',
        state: 'documented',
        evidence: 'pxt-microbit DalBoard wires LightSensorState into the simulator board.',
      },
      {
        id: 'sound-input',
        state: 'documented',
        evidence: 'pxt-microbit DalBoard wires MicrophoneState into the simulator board.',
      },
      {
        id: 'sound-output',
        state: 'needs-spike',
        evidence: 'PXT simulator has audio support, but a stable adapter event for sound output was not verified.',
      },
      {
        id: 'radio-output',
        state: 'needs-spike',
        evidence: 'pxt-microbit DalBoard wires RadioState, but external send hooks need adapter validation.',
      },
      {
        id: 'radio-input',
        state: 'needs-spike',
        evidence: 'pxt-microbit DalBoard wires RadioState, but external receive hooks need adapter validation.',
      },
      {
        id: 'radio-group-observation',
        state: 'needs-spike',
        evidence: 'RadioState is present, but group/channel introspection path was not verified.',
      },
      {
        id: 'radio-strength',
        state: 'needs-spike',
        evidence: 'RadioState is present, but signal strength observation/control path was not verified.',
      },
      {
        id: 'reset-control',
        state: 'documented',
        evidence: 'microsoft/pxt pxtsim includes SimulatorDriver lifecycle/restart support.',
      },
    ],
    nextSpike: [
      'Locate the smallest PXT API path that can run the MakeCode fixture as simulator JavaScript.',
      'Verify whether mc_beacon.hex contains enough metadata to recover source/project data.',
      'Observe LedMatrixState and RadioState from an embedded simulator instance.',
      'Decide whether MakeCode uploads must require project/source metadata instead of standalone HEX.',
    ],
  },
];

export function candidateForRuntimeSource(
  runtimeSource: RuntimeSource,
): SimulatorCandidate | undefined {
  return SIMULATOR_CANDIDATES.find((candidate) => candidate.runtimeSource === runtimeSource);
}

export function missingRequiredCapabilities(candidate: SimulatorCandidate): SimulatorCapabilityId[] {
  return REQUIRED_SWARM_CAPABILITIES.filter((capabilityId) => {
    const capability = candidate.capabilities.find(({ id }) => id === capabilityId);
    return capability?.state !== 'documented';
  });
}

import {
  REQUIRED_SWARM_CAPABILITIES,
  SIMULATOR_CANDIDATES,
  candidateForRuntimeSource,
  missingRequiredCapabilities,
} from './simulatorCandidates';
import { REQUIRED_RUNTIME_CAPABILITY_IDS } from './types';

describe('simulator candidates', () => {
  it('selects the micro:bit Foundation simulator for MicroPython artifacts', () => {
    const candidate = candidateForRuntimeSource('micropython');

    expect(candidate?.id).toBe('microbit-foundation-micropython-v2');
    expect(candidate?.integrationSurface).toBe('iframe postMessage API');
  });

  it('selects the Microsoft PXT simulator stack for MakeCode artifacts', () => {
    const candidate = candidateForRuntimeSource('makecode-pxt');

    expect(candidate?.id).toBe('microsoft-makecode-pxt-microbit');
    expect(candidate?.repository).toContain('github.com/microsoft/pxt');
    expect(candidate?.repository).toContain('github.com/microsoft/pxt-microbit');
  });

  it('does not select a simulator before byte-level runtime classification', () => {
    expect(candidateForRuntimeSource('unknown')).toBeUndefined();
  });

  it('tracks every required swarm capability for each candidate', () => {
    for (const candidate of SIMULATOR_CANDIDATES) {
      const capabilityIds = new Set(candidate.capabilities.map(({ id }) => id));

      expect(REQUIRED_SWARM_CAPABILITIES.every((id) => capabilityIds.has(id))).toBe(true);
    }
  });

  it('uses the same runtime capability IDs as the artifact readiness gate', () => {
    expect(REQUIRED_SWARM_CAPABILITIES).toEqual(
      expect.arrayContaining([...REQUIRED_RUNTIME_CAPABILITY_IDS]),
    );
  });

  it('tracks radio strength and sound output proof explicitly', () => {
    for (const candidate of SIMULATOR_CANDIDATES) {
      const capabilityIds = new Set(candidate.capabilities.map(({ id }) => id));

      expect(capabilityIds.has('radio-strength')).toBe(true);
      expect(capabilityIds.has('sound-output')).toBe(true);
    }
  });

  it('keeps direct HEX execution unsupported for both official simulator paths', () => {
    for (const candidate of SIMULATOR_CANDIDATES) {
      expect(candidate.capabilities.find(({ id }) => id === 'direct-hex-execution')?.state).toBe(
        'not-supported',
      );
    }
  });

  it('requires more MakeCode adapter proof than MicroPython adapter proof', () => {
    const makeCode = candidateForRuntimeSource('makecode-pxt');
    const microPython = candidateForRuntimeSource('micropython');

    expect(makeCode).toBeDefined();
    expect(microPython).toBeDefined();
    expect(missingRequiredCapabilities(makeCode!).length).toBeGreaterThan(
      missingRequiredCapabilities(microPython!).length,
    );
  });
});

import {
  detectArtifactKind,
  evaluateArtifactRuntimeReadiness,
} from './artifactReadiness';

describe('artifact runtime readiness', () => {
  it('detects micro:bit hex artifacts by extension without guessing runtime source', () => {
    expect(detectArtifactKind('radio-swarm.hex')).toBe('hex');
  });

  it('does not infer MicroPython from user-controlled filename text', () => {
    expect(detectArtifactKind('radio-swarm-python.hex')).toBe('hex');
  });

  it('blocks unsupported artifact names', () => {
    const readiness = evaluateArtifactRuntimeReadiness('notes.txt');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.artifactKind).toBe('unsupported');
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.capabilities.every((capability) => capability.state === 'blocked')).toBe(
      true,
    );
  });

  it('does not mark hex artifacts executable before byte-level adapter checks are proven', () => {
    const readiness = evaluateArtifactRuntimeReadiness('radio-swarm.hex');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.runtimeSource).toBe('unknown');
    expect(readiness.verdict).toBe('Needs byte-level runtime adapter');
    expect(readiness.capabilities.every((capability) => capability.state === 'blocked')).toBe(true);
  });

  it('blocks UF2 because it is not a proven micro:bit artifact target', () => {
    const readiness = evaluateArtifactRuntimeReadiness('radio-swarm.uf2');

    expect(readiness.canExecuteNow).toBe(false);
    expect(readiness.artifactKind).toBe('unsupported');
  });
});

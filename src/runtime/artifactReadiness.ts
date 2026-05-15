import type {
  ArtifactKind,
  CapabilityState,
  RuntimeCapability,
  RuntimeReadiness,
} from './types';

export const ARTIFACT_EXTENSION_HINT =
  'Spike accepts micro:bit .hex names for evaluation; execution remains disabled until byte-level adapter checks prove the required hooks.';

const requiredHooks = [
  'LED display state',
  'button input injection',
  'radio send/receive',
  'radio group/channel',
  'radio strength',
  'reset lifecycle',
  'light input',
  'sound input/output',
] as const;

export function detectArtifactKind(filename: string): ArtifactKind {
  const normalized = filename.trim().toLowerCase();

  if (normalized.endsWith('.hex')) {
    return 'hex';
  }

  return 'unsupported';
}

export function evaluateArtifactRuntimeReadiness(filename: string): RuntimeReadiness {
  const artifactKind = detectArtifactKind(filename);

  switch (artifactKind) {
    case 'hex':
      return {
        artifactKind,
        runtimeSource: 'unknown',
        canExecuteNow: false,
        verdict: 'Needs byte-level runtime adapter',
        capabilities: makeCapabilities('blocked'),
      };
    case 'unsupported':
      return {
        artifactKind,
        runtimeSource: 'unknown',
        canExecuteNow: false,
        verdict: 'Unsupported extension',
        capabilities: makeCapabilities('blocked'),
      };
  }
}

function makeCapabilities(state: CapabilityState): RuntimeCapability[] {
  return requiredHooks.map((name) => ({ name, state }));
}

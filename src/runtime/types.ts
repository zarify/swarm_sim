export type ArtifactKind = 'hex' | 'unsupported';

export type RuntimeSource = 'unknown' | 'makecode-pxt' | 'micropython';

export type CapabilityState = 'ready' | 'candidate' | 'blocked';

export type SimulatorCapabilityState = 'documented' | 'needs-spike' | 'not-supported';

export type SimulatorCapabilityId =
  | 'program-load'
  | 'direct-hex-execution'
  | 'display-output'
  | 'button-input'
  | 'light-input'
  | 'sound-input'
  | 'temperature-input'
  | 'sound-output'
  | 'radio-output'
  | 'radio-input'
  | 'radio-group-observation'
  | 'radio-strength'
  | 'reset-control';

export const REQUIRED_RUNTIME_CAPABILITY_IDS = [
  'display-output',
  'button-input',
  'radio-output',
  'radio-input',
  'radio-group-observation',
  'radio-strength',
  'reset-control',
  'light-input',
  'sound-input',
  'temperature-input',
  'sound-output',
] as const satisfies readonly SimulatorCapabilityId[];

export type RequiredRuntimeCapabilityId = (typeof REQUIRED_RUNTIME_CAPABILITY_IDS)[number];

export const RUNTIME_CAPABILITY_LABELS: Record<RequiredRuntimeCapabilityId, string> = {
  'display-output': 'LED display state',
  'button-input': 'button input injection',
  'radio-output': 'radio send',
  'radio-input': 'radio receive',
  'radio-group-observation': 'radio group/channel',
  'radio-strength': 'radio strength',
  'reset-control': 'reset lifecycle',
  'light-input': 'light input',
  'sound-input': 'sound input',
  'temperature-input': 'temperature input',
  'sound-output': 'sound output',
};

export interface RuntimeCapability {
  id: RequiredRuntimeCapabilityId;
  name: string;
  state: CapabilityState;
}

export interface SimulatorCapability {
  id: SimulatorCapabilityId;
  state: SimulatorCapabilityState;
  evidence: string;
}

export interface SimulatorCandidate {
  id: string;
  name: string;
  runtimeSource: Exclude<RuntimeSource, 'unknown'>;
  repository: string;
  license: string;
  integrationSurface: string;
  loadPath: string;
  adapterRisk: 'medium' | 'high';
  capabilities: SimulatorCapability[];
  nextSpike: string[];
}

export interface RuntimeReadiness {
  artifactKind: ArtifactKind;
  runtimeSource: RuntimeSource;
  sourceEvidence: string[];
  canExecuteNow: boolean;
  verdict: string;
  capabilities: RuntimeCapability[];
  diagnostic?: string;
}

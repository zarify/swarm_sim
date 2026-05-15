export type ArtifactKind = 'hex' | 'unsupported';

export type RuntimeSource = 'unknown' | 'makecode-pxt' | 'micropython';

export type CapabilityState = 'ready' | 'candidate' | 'blocked';

export interface RuntimeCapability {
  name: string;
  state: CapabilityState;
}

export interface RuntimeReadiness {
  artifactKind: ArtifactKind;
  runtimeSource: RuntimeSource;
  canExecuteNow: boolean;
  verdict: string;
  capabilities: RuntimeCapability[];
}

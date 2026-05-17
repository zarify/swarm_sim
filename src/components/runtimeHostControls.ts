import type { DeviceId } from '../domain/project';

export interface RuntimeResetRequest {
  nonce: number;
  deviceIds: DeviceId[];
  actionLabel: string;
}

export interface RuntimeHostState {
  allFramesReady: boolean;
  isLoading: boolean;
}

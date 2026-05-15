import type { ArtifactKind, RuntimeSource } from '../runtime/types';

export const PROJECT_SCHEMA_VERSION = 1;

export type ProjectId = string;
export type DeviceId = string;
export type ArtifactId = string;
export type EnvironmentSourceId = string;

export interface Point {
  x: number;
  y: number;
}

export interface ProgramArtifact {
  id: ArtifactId;
  name: string;
  artifactKind: ArtifactKind;
  runtimeSource: RuntimeSource;
  bytes: Uint8Array;
  createdAt: string;
}

export interface VirtualDevice {
  id: DeviceId;
  name: string;
  position: Point;
  programArtifactId?: ArtifactId;
}

export interface EnvironmentSource {
  id: EnvironmentSourceId;
  type: 'light' | 'sound';
  position: Point;
  radius: number;
  intensity: number;
}

export interface SwarmProject {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  devices: VirtualDevice[];
  artifacts: ProgramArtifact[];
  environmentSources: EnvironmentSource[];
}

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  deviceCount: number;
  artifactCount: number;
  updatedAt: string;
}

export function createBlankProject(options: {
  id: ProjectId;
  name: string;
  now: string;
}): SwarmProject {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    createdAt: options.now,
    updatedAt: options.now,
    devices: [],
    artifacts: [],
    environmentSources: [],
  };
}

export function summarizeProject(project: SwarmProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    deviceCount: project.devices.length,
    artifactCount: project.artifacts.length,
    updatedAt: project.updatedAt,
  };
}

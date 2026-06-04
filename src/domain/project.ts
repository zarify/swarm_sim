import type { ArtifactKind, RuntimeSource } from '../runtime/types';

export const PROJECT_SCHEMA_VERSION = 3;

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

interface DeviceEditableProgramBase {
  runtimeSource: Exclude<RuntimeSource, 'unknown'>;
  baseArtifactId: ArtifactId;
  revision: number;
  updatedAt: string;
}

export interface MicroPythonDeviceEditableProgram extends DeviceEditableProgramBase {
  runtimeSource: 'micropython';
  files: Record<string, string>;
}

export interface MakeCodeDeviceEditableProgram extends DeviceEditableProgramBase {
  runtimeSource: 'makecode-pxt';
  sourceFiles: Record<string, string>;
  projectMetadata?: Record<string, unknown>;
}

export type DeviceEditableProgram =
  | MicroPythonDeviceEditableProgram
  | MakeCodeDeviceEditableProgram;

export interface VirtualDevice {
  id: DeviceId;
  name: string;
  position: Point;
  programArtifactId?: ArtifactId;
  editableProgram?: DeviceEditableProgram;
}

interface EnvironmentSourceBase {
  id: EnvironmentSourceId;
  name: string;
  position: Point;
  radius: number;
}

export interface LevelEnvironmentSource extends EnvironmentSourceBase {
  type: 'light' | 'sound';
  intensity: number;
}

export interface MagnetEnvironmentSource extends EnvironmentSourceBase {
  type: 'magnet';
  angleDeg: number;
  strengthMicroTesla: number;
}

export type EnvironmentSource = LevelEnvironmentSource | MagnetEnvironmentSource;

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

export function defaultDeviceNameForId(deviceId: DeviceId): string {
  const suffix = suffixFromId(deviceId, 'device-');
  if (/^\d+$/.test(suffix)) {
    return `Node ${suffix}`;
  }
  return toTitleCaseWords(suffix) || 'Device';
}

export function defaultEnvironmentSourceName(source: Pick<EnvironmentSource, 'id' | 'type'>): string {
  const typeLabel = source.type === 'light' ? 'Light' : source.type === 'sound' ? 'Sound' : 'Magnet';
  const suffix = suffixFromId(source.id, `${source.type}-`);
  if (/^\d+$/.test(suffix)) {
    return `${typeLabel} ${suffix}`;
  }
  const normalizedSuffix = toTitleCaseWords(suffix);
  return normalizedSuffix ? `${typeLabel} ${normalizedSuffix}` : typeLabel;
}

function suffixFromId(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function toTitleCaseWords(value: string): string {
  const words = value
    .trim()
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`);
  return words.join(' ');
}

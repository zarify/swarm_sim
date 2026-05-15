import {
  PROJECT_SCHEMA_VERSION,
  type EnvironmentSource,
  type ProgramArtifact,
  type SwarmProject,
  type VirtualDevice,
} from './project';
import type { ArtifactKind, RuntimeSource } from '../runtime/types';

export interface SerializedProgramArtifact extends Omit<ProgramArtifact, 'bytes'> {
  bytesBase64: string;
}

export interface SerializedSwarmProject extends Omit<SwarmProject, 'artifacts'> {
  artifacts: SerializedProgramArtifact[];
}

export function serializeProject(project: SwarmProject): string {
  const serialized: SerializedSwarmProject = {
    ...project,
    artifacts: project.artifacts.map((artifact) => ({
      ...artifact,
      bytesBase64: bytesToBase64(artifact.bytes),
    })),
  };

  return JSON.stringify(serialized, null, 2);
}

export function deserializeProject(serializedProject: string): SwarmProject {
  const parsed: unknown = JSON.parse(serializedProject);

  return parseSerializedProject(parsed);
}

function parseSerializedProject(value: unknown): SwarmProject {
  const project = expectRecord(value, 'project');
  const schemaVersion = expectNumber(project.schemaVersion, 'schemaVersion');

  if (schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version: ${schemaVersion}`);
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: expectString(project.id, 'id'),
    name: expectString(project.name, 'name'),
    createdAt: expectString(project.createdAt, 'createdAt'),
    updatedAt: expectString(project.updatedAt, 'updatedAt'),
    devices: expectArray(project.devices, 'devices').map(parseDevice),
    artifacts: expectArray(project.artifacts, 'artifacts').map(parseArtifact),
    environmentSources: expectArray(project.environmentSources, 'environmentSources').map(
      parseEnvironmentSource,
    ),
  };
}

function parseArtifact(value: unknown): ProgramArtifact {
  const artifact = expectRecord(value, 'artifact');

  return {
    id: expectString(artifact.id, 'artifact.id'),
    name: expectString(artifact.name, 'artifact.name'),
    artifactKind: parseArtifactKind(artifact.artifactKind),
    runtimeSource: parseRuntimeSource(artifact.runtimeSource),
    bytes: base64ToBytes(expectString(artifact.bytesBase64, 'artifact.bytesBase64')),
    createdAt: expectString(artifact.createdAt, 'artifact.createdAt'),
  };
}

function parseDevice(value: unknown): VirtualDevice {
  const device = expectRecord(value, 'device');
  const programArtifactId = device.programArtifactId;

  return {
    id: expectString(device.id, 'device.id'),
    name: expectString(device.name, 'device.name'),
    position: parsePoint(device.position, 'device.position'),
    ...(programArtifactId === undefined
      ? {}
      : { programArtifactId: expectString(programArtifactId, 'device.programArtifactId') }),
  };
}

function parseEnvironmentSource(value: unknown): EnvironmentSource {
  const source = expectRecord(value, 'environmentSource');
  const type = expectString(source.type, 'environmentSource.type');

  if (type !== 'light' && type !== 'sound') {
    throw new Error(`Invalid environment source type: ${type}`);
  }

  return {
    id: expectString(source.id, 'environmentSource.id'),
    type,
    position: parsePoint(source.position, 'environmentSource.position'),
    radius: expectNumber(source.radius, 'environmentSource.radius'),
    intensity: expectNumber(source.intensity, 'environmentSource.intensity'),
  };
}

function parsePoint(value: unknown, label: string) {
  const point = expectRecord(value, label);

  return {
    x: expectNumber(point.x, `${label}.x`),
    y: expectNumber(point.y, `${label}.y`),
  };
}

function parseArtifactKind(value: unknown): ArtifactKind {
  const artifactKind = expectString(value, 'artifact.artifactKind');

  if (artifactKind === 'hex' || artifactKind === 'unsupported') {
    return artifactKind;
  }

  throw new Error(`Invalid artifact kind: ${artifactKind}`);
}

function parseRuntimeSource(value: unknown): RuntimeSource {
  const runtimeSource = expectString(value, 'artifact.runtimeSource');

  if (
    runtimeSource === 'unknown' ||
    runtimeSource === 'makecode-pxt' ||
    runtimeSource === 'micropython'
  ) {
    return runtimeSource;
  }

  throw new Error(`Invalid runtime source: ${runtimeSource}`);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }

  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }

  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }

  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${label} to be a finite number`);
  }

  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

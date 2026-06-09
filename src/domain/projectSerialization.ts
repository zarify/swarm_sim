import {
  normalizeCanvasViewOptions,
  normalizeInstructionsMarkdown,
  defaultEnvironmentSourceName,
  PROJECT_SCHEMA_VERSION,
  type ArtifactProgram,
  type DeviceEditableProgram,
  type EnvironmentSource,
  type ProgramArtifact,
  type SwarmProject,
  type VirtualDevice,
} from './project';
import type { ArtifactKind, RuntimeSource } from '../runtime/types';

export interface SerializedProgramArtifact extends Omit<ProgramArtifact, 'bytes'> {
  bytesBase64?: string;
}

export interface SerializedSwarmProject extends Omit<SwarmProject, 'artifacts'> {
  artifacts: SerializedProgramArtifact[];
}

export function serializeProject(project: SwarmProject): string {
  const serialized: SerializedSwarmProject = {
    ...project,
    artifacts: project.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      artifactKind: artifact.artifactKind,
      runtimeSource: artifact.runtimeSource,
      createdAt: artifact.createdAt,
      ...('program' in artifact ? { program: serializeArtifactProgram(artifact.program) } : {}),
      ...('bytes' in artifact ? { bytesBase64: bytesToBase64(artifact.bytes) } : {}),
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

  if (
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3 &&
    schemaVersion !== 4 &&
    schemaVersion !== 5 &&
    schemaVersion !== 6 &&
    schemaVersion !== 7 &&
    schemaVersion !== PROJECT_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported project schema version: ${schemaVersion}`);
  }

  const instructionsMarkdown = normalizeInstructionsMarkdown(
    expectOptionalString(project.instructionsMarkdown, 'instructionsMarkdown'),
  );

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: expectString(project.id, 'id'),
    name: expectString(project.name, 'name'),
    createdAt: expectString(project.createdAt, 'createdAt'),
    updatedAt: expectString(project.updatedAt, 'updatedAt'),
    viewOptions: parseCanvasViewOptions(project.viewOptions, schemaVersion),
    ...(instructionsMarkdown ? { instructionsMarkdown } : {}),
    devices: expectArray(project.devices, 'devices').map(parseDevice),
    artifacts: expectArray(project.artifacts, 'artifacts').map(parseArtifact),
    environmentSources: expectArray(project.environmentSources, 'environmentSources').map((source) =>
      parseEnvironmentSource(source, schemaVersion),
    ),
  };
}

function serializeArtifactProgram(program: ArtifactProgram): ArtifactProgram {
  switch (program.runtimeSource) {
    case 'micropython':
      return {
        runtimeSource: 'micropython',
        filesystemBase64: { ...program.filesystemBase64 },
      };
    case 'makecode-pxt':
      return {
        runtimeSource: 'makecode-pxt',
        sourceFiles: { ...program.sourceFiles },
        ...(program.projectMetadata === undefined
          ? {}
          : { projectMetadata: cloneRecord(program.projectMetadata) }),
      };
  }
}

function parseArtifact(value: unknown): ProgramArtifact {
  const artifact = expectRecord(value, 'artifact');
  const runtimeSource = parseRuntimeSource(artifact.runtimeSource);
  const base = {
    id: expectString(artifact.id, 'artifact.id'),
    name: expectString(artifact.name, 'artifact.name'),
    artifactKind: parseArtifactKind(artifact.artifactKind),
    createdAt: expectString(artifact.createdAt, 'artifact.createdAt'),
  };

  if (artifact.program !== undefined) {
    const program = parseArtifactProgram(artifact.program, 'artifact.program', runtimeSource);
    return {
      ...base,
      runtimeSource: program.runtimeSource,
      program,
    };
  }

  if (artifact.bytesBase64 !== undefined) {
    return {
      ...base,
      runtimeSource,
      bytes: base64ToBytes(expectString(artifact.bytesBase64, 'artifact.bytesBase64')),
    };
  }

  throw new Error('Expected artifact.program or artifact.bytesBase64');
}

function parseArtifactProgram(
  value: unknown,
  label: string,
  runtimeSource: RuntimeSource,
): ArtifactProgram {
  const program = expectRecord(value, label);
  const programRuntimeSource = parseRuntimeSource(program.runtimeSource);

  if (programRuntimeSource === 'unknown') {
    throw new Error(`Invalid artifact program runtime source: ${programRuntimeSource}`);
  }
  if (runtimeSource !== 'unknown' && runtimeSource !== programRuntimeSource) {
    throw new Error(
      `Artifact runtime source ${runtimeSource} does not match persisted program source ${programRuntimeSource}`,
    );
  }

  if (programRuntimeSource === 'micropython') {
    return {
      runtimeSource: 'micropython',
      filesystemBase64: parseStringRecord(program.filesystemBase64, `${label}.filesystemBase64`),
    };
  }

  return {
    runtimeSource: 'makecode-pxt',
    sourceFiles: parseStringRecord(program.sourceFiles, `${label}.sourceFiles`),
    ...(program.projectMetadata === undefined
      ? {}
      : { projectMetadata: expectRecord(program.projectMetadata, `${label}.projectMetadata`) }),
  };
}

function parseDevice(value: unknown): VirtualDevice {
  const device = expectRecord(value, 'device');
  const programArtifactId = device.programArtifactId;
  const editableProgram = device.editableProgram;
  const locked = expectOptionalBoolean(device.locked, 'device.locked') ?? false;
  const positionPinned = expectOptionalBoolean(device.positionPinned, 'device.positionPinned') ?? false;
  const legacyPositionLocked =
    expectOptionalBoolean(device.positionLocked, 'device.positionLocked') ?? false;
  const parsedProgramArtifactId =
    programArtifactId === undefined
      ? undefined
      : expectString(programArtifactId, 'device.programArtifactId');
  if (legacyPositionLocked && !locked && !positionPinned) {
    throw new Error('device.positionLocked requires device.locked to be true');
  }

  return {
    id: expectString(device.id, 'device.id'),
    name: expectString(device.name, 'device.name'),
    position: parsePoint(device.position, 'device.position'),
    ...(locked ? { locked: true } : {}),
    ...(positionPinned || legacyPositionLocked ? { positionPinned: true } : {}),
    ...(parsedProgramArtifactId === undefined ? {} : { programArtifactId: parsedProgramArtifactId }),
    ...(locked || editableProgram === undefined
      ? {}
      : { editableProgram: parseEditableProgram(editableProgram, 'device.editableProgram') }),
  };
}

function parseEnvironmentSource(value: unknown, schemaVersion: number): EnvironmentSource {
  const source = expectRecord(value, 'environmentSource');
  const id = expectString(source.id, 'environmentSource.id');
  const type = expectString(source.type, 'environmentSource.type');
  const locked = expectOptionalBoolean(source.locked, 'environmentSource.locked') ?? false;
  const positionPinned =
    expectOptionalBoolean(source.positionPinned, 'environmentSource.positionPinned') ?? false;

  if (type !== 'light' && type !== 'sound' && type !== 'magnet') {
    throw new Error(`Invalid environment source type: ${type}`);
  }
  if (schemaVersion === 1 && type === 'magnet') {
    throw new Error(`Invalid environment source type for schema v1: ${type}`);
  }

  const base = {
    id,
    name:
      typeof source.name === 'string' && source.name.trim() !== ''
        ? source.name
        : defaultEnvironmentSourceName({ id, type }),
    position: parsePoint(source.position, 'environmentSource.position'),
    radius: expectNumber(source.radius, 'environmentSource.radius'),
    ...(locked ? { locked: true } : {}),
    ...(positionPinned ? { positionPinned: true } : {}),
  };

  if (type === 'magnet') {
    return {
      ...base,
      type,
      angleDeg: expectNumber(source.angleDeg, 'environmentSource.angleDeg'),
      strengthMicroTesla: expectNumber(
        source.strengthMicroTesla,
        'environmentSource.strengthMicroTesla',
      ),
    };
  }

  return {
    ...base,
    type,
    intensity: expectNumber(source.intensity, 'environmentSource.intensity'),
  };
}

function parseCanvasViewOptions(value: unknown, schemaVersion: number) {
  if (schemaVersion < 8 || value === undefined) {
    return normalizeCanvasViewOptions(undefined);
  }
  const viewOptions = expectRecord(value, 'viewOptions');
  return normalizeCanvasViewOptions({
    showRadioRange: expectOptionalBoolean(viewOptions.showRadioRange, 'viewOptions.showRadioRange'),
  });
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

function parseEditableProgram(value: unknown, label: string): DeviceEditableProgram {
  const editableProgram = expectRecord(value, label);
  const runtimeSource = parseRuntimeSource(editableProgram.runtimeSource);
  if (runtimeSource === 'unknown') {
    throw new Error(`Invalid editable program runtime source: ${runtimeSource}`);
  }

  const base = {
    runtimeSource,
    baseArtifactId: expectString(editableProgram.baseArtifactId, `${label}.baseArtifactId`),
    revision: expectNumber(editableProgram.revision, `${label}.revision`),
    updatedAt: expectString(editableProgram.updatedAt, `${label}.updatedAt`),
  };

  if (runtimeSource === 'micropython') {
    return {
      ...base,
      runtimeSource,
      files: parseStringRecord(editableProgram.files, `${label}.files`),
    };
  }

  return {
    ...base,
    runtimeSource,
    sourceFiles: parseStringRecord(editableProgram.sourceFiles, `${label}.sourceFiles`),
    ...(editableProgram.projectMetadata === undefined
      ? {}
      : { projectMetadata: expectRecord(editableProgram.projectMetadata, `${label}.projectMetadata`) }),
  };
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

function expectOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  const record = expectRecord(value, label);
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new Error(`Expected ${label}.${key} to be a string`);
    }
    parsed[key] = entry;
  }
  return parsed;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }

  return value;
}

function expectOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${label} to be a boolean`);
  }

  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${label} to be a finite number`);
  }

  return value;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
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

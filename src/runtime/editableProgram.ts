import type {
  ArtifactId,
  DeviceEditableProgram,
  ProgramArtifact,
  VirtualDevice,
} from '../domain/project';
import type { MakeCodeRuntimeProgram, MicroPythonRuntimeProgram, RuntimeProgram } from './runtimeAdapter';
import type { RuntimeSource } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createEditableProgramSnapshot(
  baseArtifactId: ArtifactId,
  program: RuntimeProgram,
  updatedAt: string,
): DeviceEditableProgram {
  switch (program.source) {
    case 'micropython':
      return {
        runtimeSource: 'micropython',
        baseArtifactId,
        revision: 0,
        updatedAt,
        files: decodeRuntimeFilesystem(program),
      };
    case 'makecode-pxt':
      return {
        runtimeSource: 'makecode-pxt',
        baseArtifactId,
        revision: 0,
        updatedAt,
        sourceFiles: { ...(program.sourceFiles ?? {}) },
        projectMetadata: normalizeProjectMetadata(program.projectMetadata),
      };
  }
}

export function getActiveEditableProgram(
  device: Pick<VirtualDevice, 'locked' | 'programArtifactId' | 'editableProgram'>,
): DeviceEditableProgram | undefined {
  if (!device.programArtifactId || device.locked) {
    return undefined;
  }
  const editableProgram = device.editableProgram;
  if (!editableProgram || editableProgram.baseArtifactId !== device.programArtifactId) {
    return undefined;
  }
  return editableProgram;
}

export function resolveDeviceRuntimeSource(
  device: Pick<VirtualDevice, 'locked' | 'programArtifactId' | 'editableProgram'>,
  artifact?: Pick<ProgramArtifact, 'runtimeSource'>,
): RuntimeSource {
  return getActiveEditableProgram(device)?.runtimeSource ?? artifact?.runtimeSource ?? 'unknown';
}

export function deviceProgramVersionKey(
  device: Pick<VirtualDevice, 'locked' | 'programArtifactId' | 'editableProgram'>,
): string | undefined {
  if (!device.programArtifactId) {
    return undefined;
  }
  const editableProgram = getActiveEditableProgram(device);
  return `${device.programArtifactId}:${editableProgram?.revision ?? 0}`;
}

export function buildRuntimeProgramFromEditableProgram(
  editableProgram: DeviceEditableProgram,
  artifact?: ProgramArtifact,
): RuntimeProgram {
  switch (editableProgram.runtimeSource) {
    case 'micropython':
      return {
        source: 'micropython',
        filesystem: encodeRuntimeFilesystem(editableProgram.files),
        ...(artifact ? { artifact: { filename: artifact.name, bytes: artifact.bytes } } : {}),
      } satisfies MicroPythonRuntimeProgram;
    case 'makecode-pxt':
      return {
        source: 'makecode-pxt',
        sourceFiles: { ...editableProgram.sourceFiles },
        ...(editableProgram.projectMetadata
          ? { projectMetadata: normalizeProjectMetadata(editableProgram.projectMetadata) }
          : {}),
        ...(artifact ? { artifact: { filename: artifact.name, bytes: artifact.bytes } } : {}),
      } satisfies MakeCodeRuntimeProgram;
  }
}

function decodeRuntimeFilesystem(program: MicroPythonRuntimeProgram): Record<string, string> {
  return Object.fromEntries(
    Object.entries(program.filesystem).map(([filename, bytes]) => [filename, textDecoder.decode(bytes)]),
  );
}

function encodeRuntimeFilesystem(files: Record<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(files).map(([filename, content]) => [filename, textEncoder.encode(content)]),
  );
}

function normalizeProjectMetadata(
  projectMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!projectMetadata) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(projectMetadata)) as Record<string, unknown>;
}

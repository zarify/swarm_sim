import type {
  ArtifactProgram,
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

export function createArtifactProgramSnapshot(program: RuntimeProgram): ArtifactProgram {
  switch (program.source) {
    case 'micropython':
      return {
        runtimeSource: 'micropython',
        filesystemBase64: encodeRuntimeFilesystemBase64(program.filesystem),
      };
    case 'makecode-pxt':
      return {
        runtimeSource: 'makecode-pxt',
        sourceFiles: { ...(program.sourceFiles ?? {}) },
        ...(program.projectMetadata
          ? { projectMetadata: normalizeProjectMetadata(program.projectMetadata) }
          : {}),
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
  artifactName?: string,
): RuntimeProgram {
  switch (editableProgram.runtimeSource) {
    case 'micropython':
      return {
        source: 'micropython',
        filesystem: encodeRuntimeFilesystem(editableProgram.files),
        ...(artifactName ? { artifact: { filename: artifactName } } : {}),
      } satisfies MicroPythonRuntimeProgram;
    case 'makecode-pxt':
      return {
        source: 'makecode-pxt',
        sourceFiles: { ...editableProgram.sourceFiles },
        ...(editableProgram.projectMetadata
          ? { projectMetadata: normalizeProjectMetadata(editableProgram.projectMetadata) }
          : {}),
        ...(artifactName ? { artifact: { filename: artifactName } } : {}),
      } satisfies MakeCodeRuntimeProgram;
  }
}

export function buildRuntimeProgramFromArtifactProgram(
  artifact: Pick<ProgramArtifact, 'name' | 'runtimeSource'> & { program: ArtifactProgram },
): RuntimeProgram {
  switch (artifact.program.runtimeSource) {
    case 'micropython':
      return {
        source: 'micropython',
        filesystem: decodeRuntimeFilesystemBase64(artifact.program.filesystemBase64),
        artifact: { filename: artifact.name },
      } satisfies MicroPythonRuntimeProgram;
    case 'makecode-pxt':
      return {
        source: 'makecode-pxt',
        sourceFiles: { ...artifact.program.sourceFiles },
        ...(artifact.program.projectMetadata
          ? { projectMetadata: normalizeProjectMetadata(artifact.program.projectMetadata) }
          : {}),
        artifact: { filename: artifact.name },
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

function encodeRuntimeFilesystemBase64(filesystem: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filesystem).map(([filename, bytes]) => [filename, bytesToBase64(bytes)]),
  );
}

function decodeRuntimeFilesystemBase64(filesystemBase64: Record<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(filesystemBase64).map(([filename, base64]) => [filename, base64ToBytes(base64)]),
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

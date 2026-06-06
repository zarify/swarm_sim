import type { ArtifactProgram, ProgramArtifact, SwarmProject } from './project';
import { createArtifactProgramSnapshot } from '../runtime/editableProgram';
import { extractHexSource } from '../runtime/sourceExtraction';
import { decompressLzmaSource } from '../runtime/lzmaDecompressor';

interface ArtifactIdentity {
  artifactKind: ProgramArtifact['artifactKind'];
  runtimeSource: ProgramArtifact['runtimeSource'];
  program?: ArtifactProgram;
  bytes?: Uint8Array;
}

export function findReusableArtifact(
  artifacts: ProgramArtifact[],
  candidate: ArtifactIdentity,
): ProgramArtifact | undefined {
  const fingerprint = buildArtifactFingerprint(candidate);
  return artifacts.find((artifact) => {
    if (buildArtifactFingerprint(artifact) !== fingerprint) {
      return false;
    }
    return areEquivalentArtifacts(artifact, candidate);
  });
}

export async function canonicalizeProjectArtifacts(project: SwarmProject): Promise<SwarmProject> {
  const artifacts = await Promise.all(project.artifacts.map(canonicalizeArtifact));
  if (artifacts.every((artifact, index) => artifact === project.artifacts[index])) {
    return project;
  }
  return {
    ...project,
    artifacts,
  };
}

export function deduplicateProjectArtifacts(project: SwarmProject): SwarmProject {
  const dedupedArtifacts: ProgramArtifact[] = [];
  const remappedArtifactIds = new Map<string, string>();
  const fingerprints = new Map<string, ProgramArtifact[]>();
  let devicesChanged = false;

  for (const artifact of project.artifacts) {
    const fingerprint = buildArtifactFingerprint(artifact);
    const candidates = fingerprints.get(fingerprint) ?? [];
    const matching = candidates.find((candidate) => areEquivalentArtifacts(candidate, artifact));

    if (matching) {
      remappedArtifactIds.set(artifact.id, matching.id);
      continue;
    }

    candidates.push(artifact);
    fingerprints.set(fingerprint, candidates);
    dedupedArtifacts.push(artifact);
    remappedArtifactIds.set(artifact.id, artifact.id);
  }

  const devices = project.devices.map((device) => {
    const nextEditableProgram =
      device.editableProgram &&
      remappedArtifactIds.has(device.editableProgram.baseArtifactId) &&
      remappedArtifactIds.get(device.editableProgram.baseArtifactId) !== device.editableProgram.baseArtifactId
        ? {
            ...device.editableProgram,
            baseArtifactId:
              remappedArtifactIds.get(device.editableProgram.baseArtifactId) ??
              device.editableProgram.baseArtifactId,
          }
        : device.editableProgram;
    if (!device.programArtifactId) {
      if (nextEditableProgram === device.editableProgram) {
        return device;
      }
      devicesChanged = true;
      return { ...device, editableProgram: nextEditableProgram };
    }
    const mappedId = remappedArtifactIds.get(device.programArtifactId) ?? device.programArtifactId;
    if (mappedId === device.programArtifactId && nextEditableProgram === device.editableProgram) {
      return device;
    }
    devicesChanged = true;
    return {
      ...device,
      programArtifactId: mappedId,
      ...(nextEditableProgram === undefined ? {} : { editableProgram: nextEditableProgram }),
    };
  });

  const referencedArtifactIds = new Set(
    devices
      .map((device) => device.programArtifactId)
      .filter((artifactId): artifactId is string => Boolean(artifactId)),
  );
  const artifacts = dedupedArtifacts.filter((artifact) => referencedArtifactIds.has(artifact.id));
  const artifactsChanged = artifacts.length !== project.artifacts.length;

  if (!devicesChanged && !artifactsChanged) {
    return project;
  }

  return {
    ...project,
    devices,
    artifacts,
  };
}

async function canonicalizeArtifact(artifact: ProgramArtifact): Promise<ProgramArtifact> {
  if ('program' in artifact) {
    return artifact;
  }
  try {
    const extracted = await extractHexSource(artifact.name, artifact.bytes, {
      decompressLzma: decompressLzmaSource,
    });
    return {
      id: artifact.id,
      name: artifact.name,
      artifactKind: artifact.artifactKind,
      runtimeSource: extracted.runtimeSource,
      program: createArtifactProgramSnapshot(extracted.program),
      createdAt: artifact.createdAt,
    };
  } catch {
    return artifact;
  }
}

function buildArtifactFingerprint(artifact: ArtifactIdentity): string {
  if (artifact.program) {
    return `${artifact.artifactKind}|${artifact.runtimeSource}|program|${stableSerializeValue(artifact.program)}`;
  }
  if (artifact.bytes) {
    return `${artifact.artifactKind}|${artifact.runtimeSource}|bytes|${artifact.bytes.byteLength}|${fnv1a32(
      artifact.bytes,
    )}`;
  }
  return `${artifact.artifactKind}|${artifact.runtimeSource}|empty`;
}

function areEquivalentArtifacts(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  if (left.runtimeSource !== right.runtimeSource || left.artifactKind !== right.artifactKind) {
    return false;
  }
  if (left.program && right.program) {
    return stableSerializeValue(left.program) === stableSerializeValue(right.program);
  }
  if (left.bytes && right.bytes) {
    return areEqualBytes(left.bytes, right.bytes);
  }
  return false;
}

function stableSerializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeValue(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerializeValue(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function areEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

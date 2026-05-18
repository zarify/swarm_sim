import type { ProgramArtifact, SwarmProject } from './project';

interface ArtifactIdentity {
  artifactKind: ProgramArtifact['artifactKind'];
  runtimeSource: ProgramArtifact['runtimeSource'];
  bytes: Uint8Array;
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
    return areEqualBytes(artifact.bytes, candidate.bytes);
  });
}

export function deduplicateProjectArtifacts(project: SwarmProject): SwarmProject {
  const dedupedArtifacts: ProgramArtifact[] = [];
  const remappedArtifactIds = new Map<string, string>();
  const fingerprints = new Map<string, ProgramArtifact[]>();
  let devicesChanged = false;

  for (const artifact of project.artifacts) {
    const fingerprint = buildArtifactFingerprint(artifact);
    const candidates = fingerprints.get(fingerprint) ?? [];
    const matching = candidates.find((candidate) => areEqualBytes(candidate.bytes, artifact.bytes));

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
    if (!device.programArtifactId) {
      return device;
    }
    const mappedId = remappedArtifactIds.get(device.programArtifactId) ?? device.programArtifactId;
    if (mappedId === device.programArtifactId) {
      return device;
    }
    devicesChanged = true;
    return { ...device, programArtifactId: mappedId };
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

function buildArtifactFingerprint(artifact: ArtifactIdentity): string {
  return `${artifact.artifactKind}|${artifact.runtimeSource}|${artifact.bytes.byteLength}|${fnv1a32(
    artifact.bytes,
  )}`;
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

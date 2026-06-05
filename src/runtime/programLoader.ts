import type { DeviceId, ProgramArtifact, SwarmProject, VirtualDevice } from '../domain/project';
import {
  buildRuntimeProgramFromEditableProgram,
  getActiveEditableProgram,
} from './editableProgram';
import { extractHexSource, type ExtractHexSourceOptions } from './sourceExtraction';
import type { MicrobitRuntimeAdapter, RuntimeProgram } from './runtimeAdapter';
import type { RuntimeSource } from './types';

export type DeviceProgramLoadStatus = 'loaded' | 'prepared' | 'skipped' | 'failed';

export interface PreparedDeviceRuntimeProgram {
  device: VirtualDevice;
  artifact: ProgramArtifact;
  program: RuntimeProgram;
  runtimeSource: Exclude<RuntimeSource, 'unknown'>;
}

export interface DeviceProgramLoadResult {
  deviceId: DeviceId;
  artifactId?: string;
  status: DeviceProgramLoadStatus;
  runtimeSource?: RuntimeSource;
  adapterName?: string;
  program?: RuntimeProgram;
  diagnostic?: string;
}

export interface LoadProjectRuntimeProgramsOptions extends ExtractHexSourceOptions {
  createAdapter?: (
    prepared: PreparedDeviceRuntimeProgram,
  ) => MicrobitRuntimeAdapter | undefined | Promise<MicrobitRuntimeAdapter | undefined>;
}

export async function prepareDeviceRuntimeProgram(
  project: SwarmProject,
  device: VirtualDevice,
  options: ExtractHexSourceOptions = {},
): Promise<PreparedDeviceRuntimeProgram | DeviceProgramLoadResult> {
  if (!device.programArtifactId) {
    return {
      deviceId: device.id,
      status: 'skipped',
      diagnostic: 'No artifact assigned to device',
    };
  }

  const artifact = project.artifacts.find((candidate) => candidate.id === device.programArtifactId);
  if (!artifact) {
    return {
      deviceId: device.id,
      artifactId: device.programArtifactId,
      status: 'failed',
      diagnostic: `Assigned artifact does not exist: ${device.programArtifactId}`,
    };
  }

  try {
    const editableProgram = getActiveEditableProgram(device);
    if (editableProgram) {
      return {
        device,
        artifact,
        program: buildRuntimeProgramFromEditableProgram(editableProgram, artifact),
        runtimeSource: editableProgram.runtimeSource,
      };
    }

    const extracted = await extractHexSource(artifact.name, artifact.bytes, options);

    if (artifact.runtimeSource !== 'unknown' && artifact.runtimeSource !== extracted.runtimeSource) {
      return {
        deviceId: device.id,
        artifactId: artifact.id,
        status: 'failed',
        runtimeSource: extracted.runtimeSource,
        diagnostic: `Artifact metadata says ${artifact.runtimeSource}, but HEX source extraction found ${extracted.runtimeSource}`,
      };
    }

    return {
      device,
      artifact,
      program: extracted.program,
      runtimeSource: extracted.runtimeSource,
    };
  } catch (error) {
    return {
      deviceId: device.id,
      artifactId: artifact.id,
      status: 'failed',
      runtimeSource: artifact.runtimeSource,
      diagnostic: error instanceof Error ? error.message : 'Unable to extract runtime program',
    };
  }
}

export async function loadProjectRuntimePrograms(
  project: SwarmProject,
  options: LoadProjectRuntimeProgramsOptions = {},
): Promise<DeviceProgramLoadResult[]> {
  const results: DeviceProgramLoadResult[] = [];

  for (const device of project.devices) {
    const prepared = await prepareDeviceRuntimeProgram(project, device, options);
    if (!isPreparedDeviceRuntimeProgram(prepared)) {
      results.push(prepared);
      continue;
    }

    let adapter: MicrobitRuntimeAdapter | undefined;
    try {
      adapter = await options.createAdapter?.(prepared);
    } catch (error) {
      results.push({
        deviceId: device.id,
        artifactId: prepared.artifact.id,
        status: 'failed',
        runtimeSource: prepared.runtimeSource,
        program: prepared.program,
        diagnostic: error instanceof Error ? error.message : 'Runtime adapter creation failed',
      });
      continue;
    }

    if (!adapter) {
      results.push({
        deviceId: device.id,
        artifactId: prepared.artifact.id,
        status: 'prepared',
        runtimeSource: prepared.runtimeSource,
        program: prepared.program,
        diagnostic: 'Runtime program extracted; no adapter was provided for flashing',
      });
      continue;
    }

    if (adapter.source !== prepared.runtimeSource) {
      results.push({
        deviceId: device.id,
        artifactId: prepared.artifact.id,
        status: 'failed',
        runtimeSource: prepared.runtimeSource,
        adapterName: adapter.name,
        program: prepared.program,
        diagnostic: `Adapter ${adapter.name} handles ${adapter.source}, not ${prepared.runtimeSource}`,
      });
      continue;
    }

    try {
      await adapter.flash(prepared.program);
      results.push({
        deviceId: device.id,
        artifactId: prepared.artifact.id,
        status: 'loaded',
        runtimeSource: prepared.runtimeSource,
        adapterName: adapter.name,
        program: prepared.program,
      });
    } catch (error) {
      results.push({
        deviceId: device.id,
        artifactId: prepared.artifact.id,
        status: 'failed',
        runtimeSource: prepared.runtimeSource,
        adapterName: adapter.name,
        program: prepared.program,
        diagnostic: error instanceof Error ? error.message : 'Runtime adapter flash failed',
      });
    }
  }

  return results;
}

function isPreparedDeviceRuntimeProgram(
  value: PreparedDeviceRuntimeProgram | DeviceProgramLoadResult,
): value is PreparedDeviceRuntimeProgram {
  return 'device' in value && 'artifact' in value && 'program' in value;
}

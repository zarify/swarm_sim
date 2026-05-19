import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import {
  createBlankProject,
  defaultDeviceNameForId,
  defaultEnvironmentSourceName,
  type DeviceId,
  type EnvironmentSource,
  type EnvironmentSourceId,
  type Point,
  type ProjectSummary,
  type SwarmProject,
} from '../domain/project';
import { SwarmRuntimeHosts } from './SwarmRuntimeHosts';
import { evaluateArtifactRuntimeReadiness } from '../runtime/artifactReadiness';
import { extractHexSource } from '../runtime/sourceExtraction';
import { decompressLzmaSource } from '../runtime/lzmaDecompressor';
import { normalizeRuntimeDisplayPixels } from '../runtime/displayPixels';
import { MICROBIT_BUILTIN_SENSOR_DOMAINS } from '../runtime/microbitSensorDomains';
import {
  appendDeviceRuntimeLog,
  moveDevice,
  reconcileSimulationProject,
  resetSimulation,
  routeRadioPacket,
  setDeviceButton,
  setDeviceRadioConfig,
  type DeviceRuntimeState,
  type SimulationState,
} from '../simulation/simulationEngine';
import type { DeviceProgramLoadResult } from '../runtime/programLoader';
import type { RuntimeRadioPacket } from '../runtime/runtimeAdapter';
import type { MicroPythonRuntimeHostProps, RoutedRadioDelivery } from './MicroPythonRuntimeHost';
import type { RuntimeResetRequest } from './runtimeHostControls';
import type { BrowserProjectStore } from '../domain/browserProjectStore';
import { createBrowserProjectStore } from '../domain/browserProjectStore';
import { decodeProjectBundle, encodeProjectBundle } from '../domain/projectBundle';
import { findReusableArtifact } from '../domain/projectArtifacts';

type Selection =
  | { type: 'device'; id: DeviceId }
  | { type: 'source'; id: EnvironmentSourceId }
  | { type: 'none' };
type RenamableSelection = Exclude<Selection, { type: 'none' }>;

type DragTarget =
  | { type: 'device'; id: DeviceId }
  | { type: 'source'; id: EnvironmentSourceId };

interface CanvasModel {
  project: SwarmProject;
  simulationState: SimulationState;
}

async function readBundleFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }

  if (typeof file.text === 'function') {
    return new TextEncoder().encode(await file.text());
  }

  return new Uint8Array(await readFileWithFileReader(file));
}

interface SwarmCanvasPanelProps {
  RuntimeHost?: (props: MicroPythonRuntimeHostProps) => ReactElement;
}

interface ArtifactUploadIssue {
  severity: 'warning' | 'error';
  message: string;
}

interface DeviceRuntimeActivity {
  tx: boolean;
  sound: boolean;
}

type ArtifactUploadState = 'uploading' | 'ready' | 'failed';
type RuntimeNodeState = 'pending' | 'ready' | 'failed';
type RuntimeRadioConfigHint = Partial<Pick<DeviceRuntimeState['radio'], 'group' | 'channel' | 'signalStrength'>>;

const canvasSize = { width: 860, height: 520 };
const defaultRadioOptions = {
  defaultRadioRangeRadius: 160,
  minRadioRangeRadius: 40,
  maxRadioRangeRadius: 240,
};
const runtimeActivityPulseMs = 480;
const displayMinFrameMs = 420;
const buttonPulseMs = 110;
const MICROBIT_SENSOR_LEVEL_MIN = MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.min;
const MICROBIT_SENSOR_LEVEL_MAX = MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.max;
const RADIO_GROUP_MIN = 0;
const RADIO_GROUP_MAX = 255;
const RADIO_CHANNEL_MIN = 0;
const RADIO_CHANNEL_MAX = 83;
const ENABLE_RADIO_DEBUG_LOGS = import.meta.env.DEV;
const MAX_CANVAS_NODE_NAME = 11;
const MAX_SIDEBAR_NODE_NAME = 28;
export function SwarmCanvasPanel({ RuntimeHost = SwarmRuntimeHosts }: SwarmCanvasPanelProps = {}) {
  const [model, setModel] = useState<CanvasModel>(() => {
    const project = createDemoProject();
    return {
      project,
      simulationState: resetSimulation(project, defaultRadioOptions),
    };
  });
  const [selected, setSelected] = useState<Selection>({ type: 'device', id: 'device-alpha' });
  const [showRadioRange, setShowRadioRange] = useState(true);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [runtimeLoadResults, setRuntimeLoadResults] = useState<DeviceProgramLoadResult[]>([]);
  const [savedProjectSummaries, setSavedProjectSummaries] = useState<ProjectSummary[]>([]);
  const [isCanvasStateMenuOpen, setIsCanvasStateMenuOpen] = useState(false);
  const [isRefreshingSavedProjects, setIsRefreshingSavedProjects] = useState(false);
  const [canvasStateMessage, setCanvasStateMessage] = useState<string>();
  const [isBundleDropActive, setIsBundleDropActive] = useState(false);
  const [displaySnapshots, setDisplaySnapshots] = useState<Record<DeviceId, number[]>>({});
  const [runtimeActivity, setRuntimeActivity] = useState<Record<DeviceId, DeviceRuntimeActivity>>({});
  const [scenarioResetSignal, setScenarioResetSignal] = useState(0);
  const [runtimeResetRequest, setRuntimeResetRequest] = useState<RuntimeResetRequest>();
  const [artifactUploadIssues, setArtifactUploadIssues] = useState<Record<DeviceId, ArtifactUploadIssue>>({});
  const [artifactUploadState, setArtifactUploadState] = useState<Record<DeviceId, ArtifactUploadState>>({});
  const [isSidebarDragActive, setIsSidebarDragActive] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenamableSelection | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const modelRef = useRef(model);
  const uploadTokens = useRef(new Map<DeviceId, number>());
  const runtimeActivityTimers = useRef(new Map<string, number>());
  const displayFrameTimers = useRef(new Map<DeviceId, number>());
  const displayLastUpdateMs = useRef(new Map<DeviceId, number>());
  const buttonPulseTimers = useRef(new Map<string, number>());
  const recentRoutedPackets = useRef(new Map<DeviceId, string>());
  const pendingRadioConfigHints = useRef(new Map<DeviceId, RuntimeRadioConfigHint>());
  const runtimeResetNonce = useRef(0);
  const nextDeviceNumber = useRef(model.project.devices.length + 1);
  const capturedPointerId = useRef<number | null>(null);
  const browserProjectStore = useRef<BrowserProjectStore | undefined>(undefined);
  const { project, simulationState } = model;
  const selectedDevice =
    selected.type === 'device'
      ? project.devices.find((device) => device.id === selected.id)
      : undefined;
  const selectedSource =
    selected.type === 'source'
      ? project.environmentSources.find((source) => source.id === selected.id)
      : undefined;

  useEffect(
    () => () => {
      releaseCanvasPointer();
      clearRuntimeActivityTimers(runtimeActivityTimers.current);
      clearDisplayFrameTimers(displayFrameTimers.current);
      clearButtonPulseTimers(buttonPulseTimers.current);
    },
    [],
  );
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    if (browserProjectStore.current) {
      return;
    }
    try {
      browserProjectStore.current = createBrowserProjectStore();
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Browser storage is not available',
      );
    }
  }, []);

  useEffect(() => {
    if (!isCanvasStateMenuOpen) {
      return;
    }
    void refreshSavedProjects();
  }, [isCanvasStateMenuOpen]);

  useEffect(() => {
    if (!renameTarget) {
      return;
    }
    if (selected.type !== renameTarget.type || selected.id !== renameTarget.id) {
      setRenameTarget(null);
      setRenameDraft('');
      return;
    }
    if (renameTarget.type === 'device') {
      if (!project.devices.some((device) => device.id === renameTarget.id)) {
        setRenameTarget(null);
        setRenameDraft('');
      }
      return;
    }
    if (!project.environmentSources.some((source) => source.id === renameTarget.id)) {
      setRenameTarget(null);
      setRenameDraft('');
    }
  }, [renameTarget, selected, project.devices, project.environmentSources]);

  useEffect(() => {
    const activeDeviceIds = new Set(project.devices.map((device) => device.id));
    setDisplaySnapshots((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeDeviceIds.has(deviceId)),
      ) as Record<DeviceId, number[]>;
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setRuntimeActivity((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeDeviceIds.has(deviceId)),
      ) as Record<DeviceId, DeviceRuntimeActivity>;
      if (Object.keys(next).length === Object.keys(current).length) {
        return current;
      }
      for (const key of runtimeActivityTimers.current.keys()) {
        const [deviceId] = key.split(':');
        if (deviceId && !activeDeviceIds.has(deviceId)) {
          const timerId = runtimeActivityTimers.current.get(key);
          if (timerId !== undefined) {
            globalThis.clearTimeout(timerId);
          }
          runtimeActivityTimers.current.delete(key);
        }
      }
      return next;
    });
    for (const [deviceId, timerId] of displayFrameTimers.current.entries()) {
      if (!activeDeviceIds.has(deviceId)) {
        globalThis.clearTimeout(timerId);
        displayFrameTimers.current.delete(deviceId);
      }
    }
    for (const [deviceId] of displayLastUpdateMs.current.entries()) {
      if (!activeDeviceIds.has(deviceId)) {
        displayLastUpdateMs.current.delete(deviceId);
      }
    }
    for (const [key, timerId] of buttonPulseTimers.current.entries()) {
      const [deviceId] = key.split(':');
      if (!deviceId || activeDeviceIds.has(deviceId)) {
        continue;
      }
      globalThis.clearTimeout(timerId);
      buttonPulseTimers.current.delete(key);
    }

    if (pendingRadioConfigHints.current.size > 0) {
      setModel((current) => {
        let simulationState = current.simulationState;
        let changed = false;
        for (const [deviceId, config] of [...pendingRadioConfigHints.current.entries()]) {
          if (!activeDeviceIds.has(deviceId)) {
            continue;
          }
          const runtime = simulationState.devices[deviceId];
          if (!runtime) {
            continue;
          }
          const normalizedConfig = normalizeRuntimeRadioConfigHint(
            config,
            simulationState.options.maxSignalStrength,
          );
          if (
            (normalizedConfig.group === undefined || runtime.radio.group === normalizedConfig.group) &&
            (normalizedConfig.channel === undefined || runtime.radio.channel === normalizedConfig.channel) &&
            (normalizedConfig.signalStrength === undefined ||
              runtime.radio.signalStrength === normalizedConfig.signalStrength)
          ) {
            pendingRadioConfigHints.current.delete(deviceId);
            continue;
          }
          simulationState = setDeviceRadioConfig(simulationState, deviceId, normalizedConfig);
          pendingRadioConfigHints.current.delete(deviceId);
          changed = true;
        }
        if (!changed) {
          return current;
        }
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    }
    setArtifactUploadIssues((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeDeviceIds.has(deviceId)),
      ) as Record<DeviceId, ArtifactUploadIssue>;
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setArtifactUploadState((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeDeviceIds.has(deviceId)),
      ) as Record<DeviceId, ArtifactUploadState>;
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [project.devices]);

  async function refreshSavedProjects() {
    if (!browserProjectStore.current) {
      setSavedProjectSummaries([]);
      return;
    }
    setIsRefreshingSavedProjects(true);
    setCanvasStateMessage(undefined);
    try {
      const summaries = await browserProjectStore.current.list();
      setSavedProjectSummaries(summaries);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to list saved layouts',
      );
    } finally {
      setIsRefreshingSavedProjects(false);
    }
  }

  function addDevice() {
    const deviceNumber = nextDeviceNumber.current;
    nextDeviceNumber.current += 1;
    const id = `device-${deviceNumber}`;
    updateProject((current) => {
      nextDeviceNumber.current = Math.max(nextDeviceNumber.current, current.devices.length + 2);
      return {
        ...current,
        devices: [
          ...current.devices,
          {
            id,
            name: `Node ${deviceNumber}`,
            position: { x: 130 + deviceNumber * 42, y: 130 + deviceNumber * 28 },
          },
        ],
      };
    });
    setSelected({ type: 'device', id });
  }

  function addSource(type: EnvironmentSource['type']) {
    updateProject((current) => {
      const sourceNumber = current.environmentSources.length + 1;
      const id = `${type}-${sourceNumber}`;
      return {
        ...current,
        environmentSources: [
          ...current.environmentSources,
          {
            id,
            type,
            name: defaultEnvironmentSourceName({ id, type }),
            position: { x: type === 'light' ? 220 : 650, y: type === 'light' ? 360 : 140 },
            radius: type === 'light' ? 180 : 150,
            intensity: sensorLevelToIntensity(type === 'light' ? 200 : 168),
          },
        ],
      };
    });
  }

  function updateSource(sourceId: EnvironmentSourceId, patch: Partial<EnvironmentSource>) {
    updateProject((current) => ({
      ...current,
      environmentSources: current.environmentSources.map((source) =>
        source.id === sourceId ? { ...source, ...patch } : source,
      ),
    }));
  }

  function beginRename(target: RenamableSelection, currentName: string) {
    setRenameTarget(target);
    setRenameDraft(currentName);
  }

  function cancelRename() {
    setRenameTarget(null);
    setRenameDraft('');
  }

  function commitRename() {
    if (!renameTarget) {
      return;
    }
    updateProject((current) => {
      const trimmed = renameDraft.trim();
      if (renameTarget.type === 'device') {
        const nextName = trimmed || defaultDeviceNameForId(renameTarget.id);
        return {
          ...current,
          devices: current.devices.map((device) =>
            device.id === renameTarget.id ? { ...device, name: nextName } : device,
          ),
        };
      }
      const targetSource = current.environmentSources.find((source) => source.id === renameTarget.id);
      if (!targetSource) {
        return current;
      }
      const nextName = trimmed || defaultEnvironmentSourceName(targetSource);
      return {
        ...current,
        environmentSources: current.environmentSources.map((source) =>
          source.id === renameTarget.id ? { ...source, name: nextName } : source,
        ),
      };
    });
    cancelRename();
  }

  function resetAllDevices() {
    setScenarioResetSignal((current) => current + 1);
    setDisplaySnapshots({});
    setRuntimeActivity({});
    clearRuntimeActivityTimers(runtimeActivityTimers.current);
    clearDisplayFrameTimers(displayFrameTimers.current);
    clearButtonPulseTimers(buttonPulseTimers.current);
    displayLastUpdateMs.current.clear();
    recentRoutedPackets.current.clear();
    setModel((current) => ({
      ...current,
      simulationState: resetSimulation(current.project, defaultRadioOptions),
    }));
  }

  function resetSelectedDevice() {
    if (!selectedDevice) {
      return;
    }
    const deviceId = selectedDevice.id;
    const nextNonce = runtimeResetNonce.current + 1;
    runtimeResetNonce.current = nextNonce;
    setRuntimeResetRequest({
      nonce: nextNonce,
      deviceIds: [deviceId],
      actionLabel: 'device reset',
    });
    setDisplaySnapshots((current) => removeDisplaySnapshot(current, deviceId));
    setRuntimeActivity((current) => {
      if (!current[deviceId]) {
        return current;
      }
      const { [deviceId]: _removed, ...rest } = current;
      return rest;
    });
    for (const [key, timerId] of runtimeActivityTimers.current.entries()) {
      if (!key.startsWith(`${deviceId}:`)) {
        continue;
      }
      globalThis.clearTimeout(timerId);
      runtimeActivityTimers.current.delete(key);
    }
    const displayTimer = displayFrameTimers.current.get(deviceId);
    if (displayTimer !== undefined) {
      globalThis.clearTimeout(displayTimer);
      displayFrameTimers.current.delete(deviceId);
    }
    displayLastUpdateMs.current.delete(deviceId);
  }

  function deleteSelectedNode() {
    if (selected.type === 'none') {
      return;
    }

    if (selected.type === 'device') {
      const deletingId = selected.id;
      uploadTokens.current.delete(deletingId);
      setArtifactUploadIssues((current) => {
        const { [deletingId]: _removed, ...rest } = current;
        return rest;
      });
      setArtifactUploadState((current) => {
        const { [deletingId]: _removed, ...rest } = current;
        return rest;
      });
      setModel((current) => {
        const nextProject = removeDeviceFromProject(current.project, deletingId);
        const next = {
          project: nextProject,
          simulationState: reconcileSimulationProject(current.simulationState, nextProject),
        };
        modelRef.current = next;
        setSelected(pickFallbackSelection(nextProject));
        return next;
      });
      return;
    }

    const deletingId = selected.id;
    setModel((current) => {
      const nextProject = {
        ...current.project,
        environmentSources: current.project.environmentSources.filter((source) => source.id !== deletingId),
      };
      const next = {
        project: nextProject,
        simulationState: reconcileSimulationProject(current.simulationState, nextProject),
      };
      modelRef.current = next;
      setSelected(pickFallbackSelection(nextProject));
      return next;
    });
  }

  async function uploadArtifactForDevice(deviceId: DeviceId, file: File) {
    const device = modelRef.current.project.devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      return;
    }
    const assignedArtifact = device.programArtifactId
      ? modelRef.current.project.artifacts.find((artifact) => artifact.id === device.programArtifactId)
      : undefined;
    if (
      assignedArtifact &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(
        `This will overwrite ${assignedArtifact.name} on ${device.name}. Continue?`,
      )
    ) {
      return;
    }

    const token = (uploadTokens.current.get(deviceId) ?? 0) + 1;
    uploadTokens.current.set(deviceId, token);
    setArtifactUploadState((current) => ({ ...current, [deviceId]: 'uploading' }));

    try {
      const bytes = await readHexFileBytes(file);
      if (uploadTokens.current.get(deviceId) !== token || !hasDevice(modelRef.current.project, deviceId)) {
        return;
      }

      const readiness = evaluateArtifactRuntimeReadiness(file.name, bytes);
      if (readiness.artifactKind !== 'hex') {
        throw new Error('Only micro:bit .hex files can be assigned to devices right now');
      }
      const { runtimeSource, issue } = await resolveRuntimeSource(
        file.name,
        bytes,
        readiness.runtimeSource,
      );
      if (uploadTokens.current.get(deviceId) !== token || !hasDevice(modelRef.current.project, deviceId)) {
        return;
      }
      debugRadioPanel('artifact-runtime-source', {
        deviceId,
        filename: file.name,
        heuristicRuntimeSource: readiness.runtimeSource,
        resolvedRuntimeSource: runtimeSource,
        issue: issue?.message,
      });

      const now = new Date().toISOString();
      updateProject((current) => {
        const reusableArtifact = findReusableArtifact(current.artifacts, {
          artifactKind: readiness.artifactKind,
          runtimeSource,
          bytes,
        });
        const nextArtifact =
          reusableArtifact ??
          ({
            id: makeArtifactId(deviceId, file.name, now),
            name: file.name,
            artifactKind: readiness.artifactKind,
            runtimeSource,
            bytes,
            createdAt: now,
          } as const);

        return {
          ...current,
          updatedAt: now,
          artifacts: replaceDeviceArtifact(current, deviceId, nextArtifact),
          devices: current.devices.map((device) =>
            device.id === deviceId ? { ...device, programArtifactId: nextArtifact.id } : device,
          ),
        };
      });
      setDisplaySnapshots((current) => removeDisplaySnapshot(current, deviceId));
      setArtifactUploadIssues((current) => {
        if (issue) {
          return {
            ...current,
            [deviceId]: issue,
          };
        }

        const { [deviceId]: _removed, ...rest } = current;
        return rest;
      });
      setArtifactUploadState((current) => ({ ...current, [deviceId]: 'ready' }));
    } catch (error) {
      if (uploadTokens.current.get(deviceId) !== token || !hasDevice(modelRef.current.project, deviceId)) {
        return;
      }

      setArtifactUploadIssues((current) => ({
        ...current,
        [deviceId]: {
          severity: 'error',
          message: error instanceof Error ? error.message : 'Unable to upload artifact',
        },
      }));
      setArtifactUploadState((current) => ({ ...current, [deviceId]: 'failed' }));
    }
  }

  function handleRuntimeRadioPacket(deviceId: DeviceId, packet: RuntimeRadioPacket): RoutedRadioDelivery[] {
    const senderRadio = modelRef.current.simulationState.devices[deviceId]?.radio;
    const effectiveGroup = packet.group ?? senderRadio?.group;
    const effectiveChannel = packet.channel ?? senderRadio?.channel;
    if (
      isDuplicateRecentRoutedPacket(
        recentRoutedPackets.current,
        deviceId,
        packet,
        effectiveGroup,
        effectiveChannel,
      )
    ) {
      debugRadioPanel('dedupe-runtime-radio-packet', {
        senderDeviceId: deviceId,
        packet: summarizeRadioPacket(packet),
      });
      return [];
    }
    pulseRuntimeActivity(deviceId, 'tx');
    let deliveries: RoutedRadioDelivery[] = [];
    let routeDebugDetails: Record<string, unknown> | undefined;
    flushSync(() => {
      setModel((current) => {
        const senderRuntime = current.simulationState.devices[deviceId];
        const senderGroup = senderRuntime?.radio.group;
        const normalized = normalizeRuntimeRadioPacket(
          packet,
          current.simulationState.options.maxSignalStrength,
          senderGroup,
        );
        let simulationState = current.simulationState;
        if (
          normalized.packet.signalStrength !== undefined &&
          senderRuntime?.radio.signalStrength !== normalized.packet.signalStrength
        ) {
          simulationState = setDeviceRadioConfig(simulationState, deviceId, {
            signalStrength: normalized.packet.signalStrength,
          });
        }
        simulationState = routeRadioPacket(simulationState, deviceId, normalized.packet);
        for (const diagnostic of normalized.diagnostics) {
          simulationState = appendDeviceRuntimeLog(
            simulationState,
            deviceId,
            'runtime-error',
            diagnostic,
          );
        }
        const routedEvent = simulationState.radioEvents.at(-1);
        deliveries = (routedEvent?.receivedPackets ?? []).map((receivedPacket) => ({
          recipientId: receivedPacket.deviceId,
          packet: {
            data: new Uint8Array(normalized.packet.data),
            ...(normalized.packet.group === undefined ? {} : { group: normalized.packet.group }),
            ...(normalized.packet.channel === undefined ? {} : { channel: normalized.packet.channel }),
            signalStrength: receivedPacket.rssi,
          },
        }));
        routeDebugDetails = {
          senderDeviceId: deviceId,
          senderRadio: senderRuntime?.radio,
          rawPacket: summarizeRadioPacket(packet),
          normalizedPacket: summarizeRadioPacket(normalized.packet),
          diagnostics: normalized.diagnostics,
          recipients: deliveries.map((delivery) => delivery.recipientId),
          deliveries: deliveries.map((delivery) => ({
            recipientId: delivery.recipientId,
            signalStrength: delivery.packet.signalStrength,
          })),
          blocked:
            routedEvent?.blockedTargets.map((target) => ({
              deviceId: target.deviceId,
              reason: target.reason,
              targetGroup: target.targetGroup,
              targetChannel: target.targetChannel,
            })) ?? [],
        };
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    });
    if (routeDebugDetails) {
      debugRadioPanel('route-radio-packet', routeDebugDetails);
    }

    return deliveries;
  }

  function handleRuntimeLog(
    deviceId: DeviceId,
    type: 'serial-output' | 'internal-error',
    message: string,
  ) {
    setModel((current) => {
      const next = {
        ...current,
        simulationState: appendDeviceRuntimeLog(
          current.simulationState,
          deviceId,
          type === 'serial-output' ? 'serial-output' : 'runtime-error',
          message,
        ),
      };
      modelRef.current = next;
      return next;
    });
  }

  function handleRuntimeDisplayChange(deviceId: DeviceId, pixels: number[]) {
    const normalized = normalizeRuntimeDisplayPixels(pixels);
    if (!normalized) {
      handleRuntimeLog(deviceId, 'internal-error', 'Runtime display bridge emitted invalid LED data');
      return;
    }
    const now = Date.now();
    const lastUpdate = displayLastUpdateMs.current.get(deviceId) ?? 0;
    const elapsed = now - lastUpdate;

    const applyDisplay = () => {
      displayLastUpdateMs.current.set(deviceId, Date.now());
      setDisplaySnapshots((current) => ({
        ...current,
        [deviceId]: normalized,
      }));
    };

    if (elapsed < displayMinFrameMs) {
      const existingTimer = displayFrameTimers.current.get(deviceId);
      if (existingTimer !== undefined) {
        globalThis.clearTimeout(existingTimer);
      }
      const timeoutId = globalThis.setTimeout(() => {
        displayFrameTimers.current.delete(deviceId);
        applyDisplay();
      }, displayMinFrameMs - elapsed);
      displayFrameTimers.current.set(deviceId, timeoutId);
      return;
    }

    applyDisplay();
  }

  function handleRuntimeRadioConfigHint(
    deviceId: DeviceId,
    config: RuntimeRadioConfigHint,
  ) {
    const normalizedConfig = normalizeRuntimeRadioConfigHint(
      config,
      modelRef.current.simulationState.options.maxSignalStrength,
    );
    if (
      normalizedConfig.group === undefined &&
      normalizedConfig.channel === undefined &&
      normalizedConfig.signalStrength === undefined
    ) {
      return;
    }

    let queuedHint = false;
    let appliedHint = false;
    flushSync(() => {
      setModel((current) => {
        const runtime = current.simulationState.devices[deviceId];
        if (!runtime) {
          const existing = pendingRadioConfigHints.current.get(deviceId) ?? {};
          pendingRadioConfigHints.current.set(deviceId, { ...existing, ...normalizedConfig });
          queuedHint = true;
          return current;
        }

        if (
          (normalizedConfig.group === undefined || runtime.radio.group === normalizedConfig.group) &&
          (normalizedConfig.channel === undefined || runtime.radio.channel === normalizedConfig.channel) &&
          (normalizedConfig.signalStrength === undefined ||
            runtime.radio.signalStrength === normalizedConfig.signalStrength)
        ) {
          return current;
        }

        const simulationState = setDeviceRadioConfig(current.simulationState, deviceId, normalizedConfig);
        pendingRadioConfigHints.current.delete(deviceId);
        appliedHint = true;
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    });
    if (queuedHint) {
      debugRadioPanel('queue-radio-config-hint', { deviceId, config: normalizedConfig });
    } else if (appliedHint) {
      debugRadioPanel('apply-radio-config-hint', { deviceId, config: normalizedConfig });
    }
  }

  function handleRuntimeSoundOutput(deviceId: DeviceId, _level: number) {
    pulseRuntimeActivity(deviceId, 'sound');
  }

  function pulseRuntimeActivity(deviceId: DeviceId, activity: keyof DeviceRuntimeActivity) {
    const timerKey = `${deviceId}:${activity}`;
    const existingTimer = runtimeActivityTimers.current.get(timerKey);
    if (existingTimer !== undefined) {
      globalThis.clearTimeout(existingTimer);
    }

    setRuntimeActivity((current) => ({
      ...current,
      [deviceId]: {
        tx: current[deviceId]?.tx ?? false,
        sound: current[deviceId]?.sound ?? false,
        [activity]: true,
      },
    }));

    const timeoutId = globalThis.setTimeout(() => {
      runtimeActivityTimers.current.delete(timerKey);
      setRuntimeActivity((current) => {
        const deviceActivity = current[deviceId];
        if (!deviceActivity || !deviceActivity[activity]) {
          return current;
        }

        const nextDeviceActivity = { ...deviceActivity, [activity]: false };
        const hasAnyActivity = nextDeviceActivity.tx || nextDeviceActivity.sound;
        if (!hasAnyActivity) {
          const { [deviceId]: _removed, ...rest } = current;
          return rest;
        }

        return {
          ...current,
          [deviceId]: nextDeviceActivity,
        };
      });
    }, runtimeActivityPulseMs);

    runtimeActivityTimers.current.set(timerKey, timeoutId);
  }

  function pulseDeviceButton(deviceId: DeviceId, button: 'A' | 'B') {
    setModel((current) => {
      const simulationState = setDeviceButton(current.simulationState, deviceId, button, true);
      const next = { ...current, simulationState };
      modelRef.current = next;
      return next;
    });

    const timerKey = `${deviceId}:${button}`;
    const existingTimer = buttonPulseTimers.current.get(timerKey);
    if (existingTimer !== undefined) {
      globalThis.clearTimeout(existingTimer);
    }

    const timeoutId = globalThis.setTimeout(() => {
      buttonPulseTimers.current.delete(timerKey);
      setModel((current) => {
        const simulationState = setDeviceButton(current.simulationState, deviceId, button, false);
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    }, buttonPulseMs);

    buttonPulseTimers.current.set(timerKey, timeoutId);
  }

  function updateDragPosition(clientX: number, clientY: number) {
    if (!dragTarget || !svgRef.current) {
      return;
    }

    const position = clientPointToCanvasPoint(svgRef.current, clientX, clientY);
    const nextPosition = clampPoint(position);
    const target = dragTarget;
    setModel((current) => ({
      project: moveProjectObject(current.project, target, nextPosition),
      simulationState:
        target.type === 'device'
          ? moveDevice(current.simulationState, target.id, nextPosition)
          : reconcileSimulationProject(
              current.simulationState,
              moveProjectObject(current.project, target, nextPosition),
            ),
    }));
  }

  function updateProject(updater: (current: SwarmProject) => SwarmProject) {
    setModel((current) => {
      const nextProject = updater(current.project);
      const project =
        nextProject.updatedAt === current.project.updatedAt
          ? { ...nextProject, updatedAt: new Date().toISOString() }
          : nextProject;
      return {
        project,
        simulationState: reconcileSimulationProject(current.simulationState, project),
      };
    });
  }

  function captureCanvasPointer(pointerId: number) {
    svgRef.current?.setPointerCapture(pointerId);
    capturedPointerId.current = pointerId;
  }

  function releaseCanvasPointer() {
    const pointerId = capturedPointerId.current;
    if (svgRef.current && pointerId !== null && svgRef.current.hasPointerCapture(pointerId)) {
      svgRef.current.releasePointerCapture(pointerId);
    }

    capturedPointerId.current = null;
  }

  function endDrag() {
    releaseCanvasPointer();
    setDragTarget(null);
  }

  const selectedRuntimeLoadResult = selectedDevice
    ? runtimeLoadResults.find(
        (result) =>
          result.deviceId === selectedDevice.id &&
          result.artifactId === selectedDevice.programArtifactId,
      )
    : undefined;
  const canDropHexToSidebar = Boolean(selectedDevice);

  function handleSidebarDragOver(event: DragEvent<HTMLElement>) {
    if (!canDropHexToSidebar || !event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsSidebarDragActive(true);
  }

  function handleSidebarDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsSidebarDragActive(false);
  }

  function handleSidebarDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsSidebarDragActive(false);
    if (!selectedDevice) {
      return;
    }
    const file = pickFirstHexFile(event.dataTransfer);
    if (!file) {
      setArtifactUploadIssues((current) => ({
        ...current,
        [selectedDevice.id]: {
          severity: 'error',
          message: 'Only micro:bit .hex files can be assigned to devices right now',
        },
      }));
      setArtifactUploadState((current) => ({ ...current, [selectedDevice.id]: 'failed' }));
      return;
    }
    void uploadArtifactForDevice(selectedDevice.id, file);
  }

  function replaceScenarioProject(nextProject: SwarmProject) {
    releaseCanvasPointer();
    setDragTarget(null);
    setIsSidebarDragActive(false);
    setIsBundleDropActive(false);
    setDisplaySnapshots({});
    setRuntimeActivity({});
    setRuntimeLoadResults([]);
    setArtifactUploadIssues({});
    setArtifactUploadState({});
    uploadTokens.current.clear();
    pendingRadioConfigHints.current.clear();
    recentRoutedPackets.current.clear();
    clearRuntimeActivityTimers(runtimeActivityTimers.current);
    clearDisplayFrameTimers(displayFrameTimers.current);
    clearButtonPulseTimers(buttonPulseTimers.current);
    displayLastUpdateMs.current.clear();
    const next = {
      project: nextProject,
      simulationState: resetSimulation(nextProject, defaultRadioOptions),
    };
    modelRef.current = next;
    setModel(next);
    setSelected(pickFallbackSelection(nextProject));
    nextDeviceNumber.current = nextProject.devices.length + 1;
    setScenarioResetSignal((current) => current + 1);
  }

  async function saveCurrentLayoutToBrowser() {
    if (!browserProjectStore.current) {
      setCanvasStateMessage('Browser storage is not available');
      return;
    }
    const proposedName =
      typeof window !== 'undefined' && typeof window.prompt === 'function'
        ? window.prompt('Save layout as:', project.name)
        : project.name;
    if (proposedName === null) {
      return;
    }
    const now = new Date().toISOString();
    const saved: SwarmProject = {
      ...project,
      id: buildSavedProjectId(now),
      name: proposedName.trim() || project.name,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await browserProjectStore.current.save(saved);
      setCanvasStateMessage(`Saved "${saved.name}"`);
      await refreshSavedProjects();
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to save layout',
      );
    }
  }

  async function loadSavedLayout(projectId: string) {
    if (!browserProjectStore.current) {
      setCanvasStateMessage('Browser storage is not available');
      return;
    }
    try {
      const loadedProject = await browserProjectStore.current.load(projectId);
      replaceScenarioProject(loadedProject);
      setCanvasStateMessage(`Loaded "${loadedProject.name}"`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to load saved layout',
      );
    }
  }

  async function downloadCanvasBundle() {
    try {
      const bundleBytes = await encodeProjectBundle(project);
      const bundleBuffer = new Uint8Array(bundleBytes).buffer;
      const blob = new Blob([bundleBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${slugForFilename(project.name)}.swarm`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setCanvasStateMessage('Downloaded canvas bundle');
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to download canvas bundle',
      );
    }
  }

  async function importCanvasBundle(file: File) {
    if (
      isProjectPopulated(project) &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('Importing a bundle will overwrite the current layout. Continue?')
    ) {
      return;
    }

    try {
      const imported = await decodeProjectBundle(await readBundleFileBytes(file));
      replaceScenarioProject(imported);
      setCanvasStateMessage(`Imported "${imported.name}"`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to import bundle',
      );
    }
  }

  function clearCanvasLayout() {
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('Clear all devices, code artifacts, and sources from this canvas?')
    ) {
      return;
    }
    const now = new Date().toISOString();
    replaceScenarioProject(
      createBlankProject({
        id: buildSavedProjectId(now),
        name: 'Untitled layout',
        now,
      }),
    );
    setCanvasStateMessage('Canvas cleared');
  }

  function handleBundleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void importCanvasBundle(file);
    }
    event.currentTarget.value = '';
  }

  function handleBundleDropAreaDragOver(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsBundleDropActive(true);
  }

  function handleBundleDropAreaDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsBundleDropActive(false);
  }

  function handleBundleDropAreaDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsBundleDropActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) {
      return;
    }
    void importCanvasBundle(file);
  }

  const runtimeNodeStates = buildRuntimeNodeStates(project, runtimeLoadResults, artifactUploadState);

  return (
    <section className="swarm-panel" aria-labelledby="swarm-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Swarm canvas</p>
          <h2 id="swarm-title">Spatial radio bench</h2>
        </div>
        <div className="control-stack" aria-label="Simulation controls">
          <button type="button" onClick={resetAllDevices}>
            Reset all
          </button>
          <button
            type="button"
            aria-expanded={isCanvasStateMenuOpen}
            aria-controls="canvas-state-panel"
            onClick={() => setIsCanvasStateMenuOpen((current) => !current)}
          >
            Canvas state
          </button>
        </div>
      </div>
      {isCanvasStateMenuOpen ? (
        <div id="canvas-state-panel" className="canvas-state-panel" aria-label="Canvas state controls">
          <div className="canvas-state-panel__actions">
            <button type="button" onClick={() => void saveCurrentLayoutToBrowser()}>
              Save to browser
            </button>
            <button type="button" onClick={() => void downloadCanvasBundle()}>
              Download bundle
            </button>
            <label className="canvas-state-upload">
              Upload bundle
              <input
                type="file"
                accept=".swarm"
                onChange={handleBundleFileInput}
              />
            </label>
            <button type="button" onClick={clearCanvasLayout}>
              Clear canvas
            </button>
          </div>
          <div
            className={isBundleDropActive ? 'canvas-state-drop canvas-state-drop--active' : 'canvas-state-drop'}
            onDragOver={handleBundleDropAreaDragOver}
            onDragLeave={handleBundleDropAreaDragLeave}
            onDrop={handleBundleDropAreaDrop}
          >
            Drop a saved bundle here to import
          </div>
          <div className="canvas-state-saved">
            <span className="metric-label">Saved layouts</span>
            {isRefreshingSavedProjects ? <p className="hint">Refreshing...</p> : null}
            {!isRefreshingSavedProjects && savedProjectSummaries.length === 0 ? (
              <p className="hint">No saved layouts yet.</p>
            ) : (
              savedProjectSummaries.slice(0, 8).map((summary) => (
                <button
                  key={summary.id}
                  type="button"
                  onClick={() => void loadSavedLayout(summary.id)}
                  className="canvas-state-saved__item"
                >
                  Load {summary.name}
                </button>
              ))
            )}
          </div>
          {canvasStateMessage ? <p className="hint">{canvasStateMessage}</p> : null}
        </div>
      ) : null}

      <div className="swarm-layout">
        <div className="canvas-wrap">
          <svg
            ref={svgRef}
            className="swarm-canvas"
            viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
            role="img"
            aria-label="Draggable micro:bit swarm canvas"
            onPointerMove={(event) => updateDragPosition(event.clientX, event.clientY)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <defs>
              <radialGradient id="radio-glow">
                <stop offset="0%" stopColor="rgba(105, 247, 255, 0.34)" />
                <stop offset="100%" stopColor="rgba(105, 247, 255, 0)" />
              </radialGradient>
              <radialGradient id="source-glow">
                <stop offset="0%" stopColor="rgba(255, 176, 46, 0.28)" />
                <stop offset="100%" stopColor="rgba(255, 176, 46, 0)" />
              </radialGradient>
            </defs>

            <rect className="canvas-field" width={canvasSize.width} height={canvasSize.height} />

            {simulationState.radioLinks
              .filter((link) => link.canCommunicate)
              .map((link) => {
                const source = simulationState.devices[link.sourceDeviceId];
                const target = simulationState.devices[link.targetDeviceId];
                if (!source || !target) {
                  return null;
                }

                return (
                  <line
                    key={`${link.sourceDeviceId}-${link.targetDeviceId}`}
                    className="radio-link"
                    x1={source.position.x}
                    y1={source.position.y}
                    x2={target.position.x}
                    y2={target.position.y}
                  />
                );
              })}

            {project.environmentSources.map((source) => (
              <circle
                key={`${source.id}-radius`}
                className={`source-radius source-radius--${source.type}`}
                cx={source.position.x}
                cy={source.position.y}
                r={source.radius}
              />
            ))}

            {showRadioRange
              ? Object.values(simulationState.devices).map((device) => (
                  <circle
                    key={`${device.deviceId}-radius`}
                    className="radio-radius"
                    cx={device.position.x}
                    cy={device.position.y}
                    r={device.radio.rangeRadius}
                  />
                ))
              : null}

            {project.environmentSources.map((source) => (
              <g
                key={source.id}
                className={`source-node source-node--${source.type}`}
                transform={`translate(${source.position.x} ${source.position.y})`}
                onPointerDown={(event) => {
                  captureCanvasPointer(event.pointerId);
                  setSelected({ type: 'source', id: source.id });
                  setDragTarget({ type: 'source', id: source.id });
                }}
              >
                <circle className="source-core" r="16" />
                <text y="5" textAnchor="middle">
                  {source.type === 'light' ? 'L' : 'S'}
                </text>
              </g>
            ))}

            {Object.values(simulationState.devices).map((device) => {
              const isSelected = selected.type === 'device' && selected.id === device.deviceId;
              const projectDevice = project.devices.find((candidate) => candidate.id === device.deviceId);
              const ledPixels = displaySnapshots[device.deviceId] ?? emptyLedPixels;
              const activity = runtimeActivity[device.deviceId];
              const txActive = activity?.tx ?? false;
              const soundActive = activity?.sound ?? false;
              const runtimeState = runtimeNodeStates[device.deviceId];
              const canvasNodeName = truncatePreview(
                projectDevice?.name ?? defaultDeviceNameForId(device.deviceId),
                MAX_CANVAS_NODE_NAME,
              );
              return (
                <g
                  key={device.deviceId}
                  className={`microbit-node ${isSelected ? 'microbit-node--selected' : ''}`}
                  transform={`translate(${device.position.x} ${device.position.y})`}
                  onPointerDown={(event) => {
                    captureCanvasPointer(event.pointerId);
                    setSelected({ type: 'device', id: device.deviceId });
                    setDragTarget({ type: 'device', id: device.deviceId });
                  }}
                >
                  <circle
                    data-runtime-activity={`tx:${device.deviceId}`}
                    className={
                      txActive
                        ? 'runtime-activity runtime-activity--tx runtime-activity--active'
                        : 'runtime-activity runtime-activity--tx'
                    }
                    r="48"
                  />
                  <circle
                    data-runtime-activity={`sound:${device.deviceId}`}
                    className={
                      soundActive
                        ? 'runtime-activity runtime-activity--sound runtime-activity--active'
                        : 'runtime-activity runtime-activity--sound'
                    }
                    r="54"
                  />
                  <rect className="microbit-body" x="-42" y="-30" width="84" height="60" rx="14" />
                  <circle
                    className="button-dot button-dot--interactive"
                    data-device-button={`${device.deviceId}:A`}
                    data-testid={`device-button-${device.deviceId}-A`}
                    cx="-27"
                    cy="-2"
                    r="6"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      pulseDeviceButton(device.deviceId, 'A');
                    }}
                  />
                  <circle
                    className="button-dot button-dot--interactive"
                    data-device-button={`${device.deviceId}:B`}
                    data-testid={`device-button-${device.deviceId}-B`}
                    cx="27"
                    cy="-2"
                    r="6"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      pulseDeviceButton(device.deviceId, 'B');
                    }}
                  />
                  {runtimeState ? (
                    <g
                      className={`runtime-state runtime-state--${runtimeState}`}
                      data-runtime-state={`${device.deviceId}:${runtimeState}`}
                    >
                      <circle cx="34" cy="-22" r="7" />
                    </g>
                  ) : null}
                  {ledPixels.map((brightness, pixelIndex) => {
                    const column = pixelIndex % 5;
                    const row = Math.floor(pixelIndex / 5);
                    const lit = brightness > 0;
                    return (
                      <rect
                        key={pixelIndex}
                        data-led-pixel={`${device.deviceId}:${pixelIndex}`}
                        className={lit ? 'led-pixel led-pixel--lit' : 'led-pixel'}
                        style={lit ? { opacity: 0.35 + (brightness / 9) * 0.65 } : undefined}
                        x={-16 + column * 8}
                        y={-16 + row * 8}
                        width="4.8"
                        height="4.8"
                        rx="1.2"
                      />
                    );
                  })}
                  <text className="node-label" y="42" textAnchor="middle">
                    {canvasNodeName}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <aside
          className={`swarm-sidebar ${canDropHexToSidebar ? 'swarm-sidebar--drop-enabled' : ''} ${isSidebarDragActive ? 'swarm-sidebar--drag-over' : ''}`}
          aria-label="Canvas controls and selection details"
          onDragOver={handleSidebarDragOver}
          onDragLeave={handleSidebarDragLeave}
          onDrop={handleSidebarDrop}
        >
          {canDropHexToSidebar ? (
            <p className="dropzone-hint">Drop a .hex file anywhere in this panel to load onto {selectedDevice?.name}.</p>
          ) : null}
          {isSidebarDragActive && canDropHexToSidebar ? (
            <div className="swarm-sidebar-drop-overlay">
              Drop .hex to load onto <strong>{selectedDevice?.name}</strong>
            </div>
          ) : null}
          <div className="toolbar-card">
            <span className="metric-label">Canvas tools</span>
            <button type="button" onClick={addDevice}>
              Add device
            </button>
            <button type="button" onClick={() => addSource('light')}>
              Add light
            </button>
            <button type="button" onClick={() => addSource('sound')}>
              Add sound
            </button>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={showRadioRange}
                onChange={(event) => setShowRadioRange(event.target.checked)}
              />
              Radio range overlay
            </label>
          </div>

          <div className="selection-card">
            <span className="metric-label">Selection</span>
            {selectedDevice ? (
              <>
                <DeviceSelection
                  project={project}
                  runtime={simulationState.devices[selectedDevice.id]}
                  runtimeLoadResult={selectedRuntimeLoadResult}
                  uploadState={artifactUploadState[selectedDevice.id]}
                  deviceId={selectedDevice.id}
                  uploadIssue={artifactUploadIssues[selectedDevice.id]}
                  logs={simulationState.deviceLogs.filter((log) => log.deviceId === selectedDevice.id)}
                  onResetRuntime={resetSelectedDevice}
                  onDeleteNode={deleteSelectedNode}
                  onArtifactUpload={uploadArtifactForDevice}
                  isRenaming={renameTarget?.type === 'device' && renameTarget.id === selectedDevice.id}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onBeginRename={() => beginRename({ type: 'device', id: selectedDevice.id }, selectedDevice.name)}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                />
              </>
            ) : selectedSource ? (
              <SourceSelection
                source={selectedSource}
                updateSource={updateSource}
                onDeleteNode={deleteSelectedNode}
                isRenaming={renameTarget?.type === 'source' && renameTarget.id === selectedSource.id}
                renameDraft={renameDraft}
                onRenameDraftChange={setRenameDraft}
                onBeginRename={() => beginRename({ type: 'source', id: selectedSource.id }, selectedSource.name)}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
              />
            ) : (
              <p className="hint">Select a node or environmental source.</p>
            )}
          </div>

          <div className="telemetry-card" aria-live="polite">
            <span className="metric-label">Engine telemetry</span>
            <p>
              {project.devices.length} nodes / {simulationState.radioLinks.filter((link) => link.canCommunicate).length}{' '}
              active directed radio links
            </p>
          </div>

          <details className="radio-inspector-card compact-inspector" aria-label="Radio message inspector">
            <summary>
              <span className="metric-label">Radio inspector</span>
              <strong>{simulationState.radioEvents.length}</strong>
            </summary>
            <div className="compact-inspector__body">
              {simulationState.radioEvents.length === 0 ? (
                <p className="hint">No packets sent yet.</p>
              ) : (
                simulationState.radioEvents
                  .slice(-6)
                  .reverse()
                  .map((event) => (
                    <article key={event.id} className="radio-event">
                      <p className="radio-event__payload">{decodePacketPreview(event.data)}</p>
                      <p className="radio-event__meta">
                        {event.senderId} to {event.recipients.length} received /{' '}
                        {event.blockedTargets.length} blocked
                      </p>
                    </article>
                  ))
              )}
            </div>
          </details>
        </aside>
      </div>
      <RuntimeHost
        project={project}
        selectedDeviceId={selectedDevice?.id}
        resetRequest={runtimeResetRequest}
        headless={false}
        deviceRuntimeStates={simulationState.devices}
        scenarioResetSignal={scenarioResetSignal}
        onRadioPacket={handleRuntimeRadioPacket}
        onRuntimeLog={handleRuntimeLog}
        onDisplayChange={handleRuntimeDisplayChange}
        onSoundOutput={handleRuntimeSoundOutput}
        onRadioConfigHint={handleRuntimeRadioConfigHint}
        onLoadResultsChange={setRuntimeLoadResults}
      />
    </section>
  );
}

function DeviceSelection({
  project,
  deviceId,
  runtime,
  runtimeLoadResult,
  uploadState,
  uploadIssue,
  logs,
  onResetRuntime,
  onDeleteNode,
  onArtifactUpload,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}: {
  project: SwarmProject;
  deviceId: DeviceId;
  runtime?: DeviceRuntimeState;
  runtimeLoadResult?: DeviceProgramLoadResult;
  uploadState?: ArtifactUploadState;
  uploadIssue?: ArtifactUploadIssue;
  logs: SimulationState['deviceLogs'];
  onResetRuntime: () => void;
  onDeleteNode: () => void;
  onArtifactUpload: (deviceId: DeviceId, file: File) => void;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (next: string) => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const device = project.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return <p className="hint">Device missing from project.</p>;
  }
  const runtimeLogNames = new Map(project.devices.map((candidate) => [candidate.id, candidate.name] as const));
  const assignedArtifact = device.programArtifactId
    ? project.artifacts.find((artifact) => artifact.id === device.programArtifactId)
    : undefined;

  return (
    <>
      <SelectionNameEditor
        displayName={device.name}
        isRenaming={isRenaming}
        renameDraft={renameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onBeginRename={onBeginRename}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
      />
      <p>
        x {Math.round(device.position.x)} / y {Math.round(device.position.y)}
      </p>
      <div className="selection-actions">
        <button type="button" onClick={onResetRuntime} disabled={!device.programArtifactId}>
          Reset selected
        </button>
        <button type="button" onClick={onDeleteNode}>
          Delete node
        </button>
      </div>
      <label className="artifact-field artifact-field--compact">
        Load code onto {device.name}
        <input
          type="file"
          accept=".hex"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void onArtifactUpload(device.id, file);
            }
            event.currentTarget.value = '';
          }}
        />
      </label>
      <p>{device.programArtifactId ? `Assigned: ${artifactName(project, device.programArtifactId)}` : 'No code assigned yet'}</p>
      {assignedArtifact ? <p>Runtime source: {assignedArtifact.runtimeSource}</p> : null}
      {uploadIssue ? (
        <p className={uploadIssue.severity === 'error' ? 'hint hint--error' : 'hint'}>
          {uploadIssue.message}
        </p>
      ) : null}
      {uploadState === 'uploading' ? (
        <p>
          Runtime: <strong>loading</strong>
        </p>
      ) : null}
      {runtimeLoadResult ? (
        <p>
          Runtime: <strong>{runtimeLoadResult.status}</strong>
        </p>
      ) : device.programArtifactId && uploadState !== 'uploading' ? (
        <p>
          Runtime: <strong>pending</strong>
        </p>
      ) : null}
      {runtime ? (
        <>
          <dl className="radio-summary">
            <div>
              <dt>Range</dt>
              <dd>{Math.round(runtime.radio.rangeRadius)}</dd>
            </div>
            <div>
              <dt>Light</dt>
              <dd>{runtime.sensors.lightLevel}</dd>
            </div>
            <div>
              <dt>Sound</dt>
              <dd>{runtime.sensors.soundLevel}</dd>
            </div>
          </dl>
        </>
      ) : null}
      <details className="device-log compact-inspector" aria-label={`Event log for ${device.name}`}>
        <summary>
          <span className="metric-label">Runtime log</span>
          <strong>{logs.length}</strong>
        </summary>
        <div className="compact-inspector__body">
          {logs.length === 0 ? (
            <p className="hint">No device events yet.</p>
          ) : (
            logs
              .slice(-6)
              .reverse()
              .map((log) => (
                <p key={log.id} className="device-log__line">
                  <span className="device-log__type">{formatDeviceLogType(log.type)}</span>
                  <span>{formatRuntimeLogMessage(log.message, runtimeLogNames)}</span>
                </p>
              ))
          )}
        </div>
      </details>
    </>
  );
}

function SourceSelection({
  source,
  updateSource,
  onDeleteNode,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}: {
  source: EnvironmentSource;
  updateSource: (sourceId: EnvironmentSourceId, patch: Partial<EnvironmentSource>) => void;
  onDeleteNode: () => void;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (next: string) => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const peakLevel = intensityToSensorLevel(source.intensity);
  return (
    <>
      <SelectionNameEditor
        displayName={source.name}
        isRenaming={isRenaming}
        renameDraft={renameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onBeginRename={onBeginRename}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
      />
      <p className="hint">{source.type === 'light' ? 'Light source' : 'Sound source'}</p>
      <div className="selection-actions">
        <button type="button" onClick={onDeleteNode}>
          Delete node
        </button>
      </div>
      <label className="range-field">
        Radius
        <input
          type="range"
          min="40"
          max="280"
          value={source.radius}
          onChange={(event) => updateSource(source.id, { radius: Number(event.target.value) })}
        />
      </label>
      <label className="range-field">
        Peak level (micro:bit scale)
        <input
          type="range"
          min={MICROBIT_SENSOR_LEVEL_MIN}
          max={MICROBIT_SENSOR_LEVEL_MAX}
          step="1"
          value={peakLevel}
          onChange={(event) =>
            updateSource(source.id, {
              intensity: sensorLevelToIntensity(Number(event.target.value)),
            })
          }
        />
      </label>
    </>
  );
}

function SelectionNameEditor({
  displayName,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}: {
  displayName: string;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (next: string) => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  if (isRenaming) {
    return (
      <input
        className="selection-name-input"
        aria-label="Edit node name"
        autoFocus
        value={renameDraft}
        onChange={(event) => onRenameDraftChange(event.target.value)}
        onBlur={onCancelRename}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommitRename();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancelRename();
          }
        }}
      />
    );
  }

  const sidebarName = truncatePreview(displayName, MAX_SIDEBAR_NODE_NAME);
  return (
    <div className="selection-name-row">
      <strong className="selection-name" title={displayName}>
        {sidebarName}
      </strong>
      <button type="button" className="selection-name-edit" aria-label="Rename selected node" onClick={onBeginRename}>
        ✎
      </button>
    </div>
  );
}

function createDemoProject(): SwarmProject {
  return {
    ...createBlankProject({
      id: 'demo-swarm',
      name: 'Radio field lab',
      now: '2026-05-16T04:20:00.000Z',
    }),
    artifacts: [],
    devices: [
      {
        id: 'device-alpha',
        name: 'Alpha',
        position: { x: 430, y: 260 },
      },
    ],
    environmentSources: [],
  };
}

function artifactName(project: SwarmProject, artifactId: string): string {
  return project.artifacts.find((artifact) => artifact.id === artifactId)?.name ?? artifactId;
}

function pickFallbackSelection(project: SwarmProject): Selection {
  const firstDevice = project.devices[0];
  if (firstDevice) {
    return { type: 'device', id: firstDevice.id };
  }
  const firstSource = project.environmentSources[0];
  if (firstSource) {
    return { type: 'source', id: firstSource.id };
  }
  return { type: 'none' };
}

function removeDeviceFromProject(project: SwarmProject, deviceId: DeviceId): SwarmProject {
  const removedArtifactId = project.devices.find((device) => device.id === deviceId)?.programArtifactId;
  const devices = project.devices.filter((device) => device.id !== deviceId);
  const stillUsedArtifactIds = new Set(
    devices.map((device) => device.programArtifactId).filter((artifactId): artifactId is string => Boolean(artifactId)),
  );
  const artifacts = project.artifacts.filter((artifact) => {
    if (artifact.id !== removedArtifactId) {
      return true;
    }
    return stillUsedArtifactIds.has(artifact.id);
  });
  return {
    ...project,
    devices,
    artifacts,
  };
}

function pickFirstHexFile(dataTransfer: DataTransfer): File | undefined {
  const files = [...dataTransfer.files];
  return files.find((file) => file.name.toLowerCase().endsWith('.hex'));
}

function buildSavedProjectId(timestamp: string): string {
  return `layout-${timestamp.replace(/[^0-9]/g, '')}`;
}

function slugForFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug || 'swarm-layout';
}

function isProjectPopulated(project: SwarmProject): boolean {
  return (
    project.devices.length > 0 ||
    project.artifacts.length > 0 ||
    project.environmentSources.length > 0
  );
}

function buildRuntimeNodeStates(
  project: SwarmProject,
  loadResults: DeviceProgramLoadResult[],
  uploadState: Record<DeviceId, ArtifactUploadState>,
): Record<DeviceId, RuntimeNodeState> {
  const artifactById = new Map(project.artifacts.map((artifact) => [artifact.id, artifact]));
  const loadResultByDeviceId = new Map<DeviceId, DeviceProgramLoadResult>();
  for (const result of loadResults) {
    loadResultByDeviceId.set(result.deviceId, result);
  }
  const states: Record<DeviceId, RuntimeNodeState> = {};
  for (const device of project.devices) {
    if (!device.programArtifactId) {
      continue;
    }
    const artifact = artifactById.get(device.programArtifactId);
    if (!artifact || artifact.runtimeSource === 'unknown') {
      states[device.id] = 'pending';
      continue;
    }
    if (uploadState[device.id] === 'uploading') {
      states[device.id] = 'pending';
      continue;
    }

    const result = loadResultByDeviceId.get(device.id);
    if (!result) {
      states[device.id] = 'pending';
      continue;
    }
    if (result.status === 'failed') {
      states[device.id] = 'failed';
      continue;
    }
    states[device.id] = 'ready';
  }
  return states;
}

function decodePacketPreview(data: Uint8Array): string {
  if (data[0] === 0x01 && data[1] === 0x00 && data[2] === 0x01) {
    const microPythonString = new TextDecoder().decode(data.subarray(3));
    if (microPythonString.trim() !== '') {
      return truncatePreview(microPythonString.trim(), 36);
    }
  }

  const makeCodeValue = decodeMakeCodeRadioPacket(data);
  if (makeCodeValue) {
    return truncatePreview(makeCodeValue, 36);
  }

  const decoded = new TextDecoder().decode(data).trim();
  if (decoded !== '' && /^[\x20-\x7e]+$/.test(decoded)) {
    return truncatePreview(decoded, 36);
  }

  const hex = [...data.slice(0, 8)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join(' ');
  const suffix = data.length > 8 ? ' …' : '';
  return `${data.byteLength}B${hex ? ` ${hex}${suffix}` : ''}`;
}

function truncatePreview(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function decodeMakeCodeRadioPacket(data: Uint8Array): string | undefined {
  if (data.length < 10) {
    return undefined;
  }

  const packetType = data[0];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  switch (packetType) {
    case 0: // PACKET_TYPE_NUMBER
      return data.length >= 13 ? String(view.getInt32(9, true)) : undefined;
    case 1: { // PACKET_TYPE_VALUE
      if (data.length < 14) {
        return undefined;
      }
      const value = view.getInt32(9, true);
      const name = decodePacketText(data, 14, data[13] ?? 0, 8);
      return name ? `${name}:${value}` : String(value);
    }
    case 2: { // PACKET_TYPE_STRING
      const text = decodePacketText(data, 10, data[9] ?? 0, 19);
      return text || undefined;
    }
    case 3: { // PACKET_TYPE_BUFFER
      const bufferLength = Math.max(0, Math.min(data[9] ?? 0, 19, data.length - 10));
      if (bufferLength <= 0) {
        return undefined;
      }
      const payload = data.slice(10, 10 + bufferLength);
      const text = new TextDecoder().decode(payload).trim();
      if (text !== '' && /^[\x20-\x7e]+$/.test(text)) {
        return text;
      }
      return undefined;
    }
    case 4: // PACKET_TYPE_DOUBLE
      return data.length >= 17 ? formatPacketNumber(view.getFloat64(9, true)) : undefined;
    case 5: { // PACKET_TYPE_DOUBLE_VALUE
      if (data.length < 18) {
        return undefined;
      }
      const value = formatPacketNumber(view.getFloat64(9, true));
      const name = decodePacketText(data, 18, data[17] ?? 0, 8);
      return name ? `${name}:${value}` : value;
    }
    default:
      return undefined;
  }
}

function decodePacketText(
  data: Uint8Array,
  start: number,
  declaredLength: number,
  maxLength: number,
): string {
  const length = Math.max(0, Math.min(declaredLength, maxLength, data.length - start));
  if (length <= 0) {
    return '';
  }
  const text = new TextDecoder().decode(data.slice(start, start + length)).trim();
  return /^[\x20-\x7e]+$/.test(text) ? text : '';
}

function formatPacketNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(3).replace(/\.?0+$/, '');
}

function formatDeviceLogType(type: SimulationState['deviceLogs'][number]['type']): string {
  switch (type) {
    case 'lifecycle':
      return 'life';
    case 'button-input':
      return 'btn';
    case 'radio-sent':
      return 'tx';
    case 'radio-received':
      return 'rx';
    case 'radio-blocked':
      return 'drop';
    case 'serial-output':
      return 'serial';
    case 'runtime-error':
      return 'err';
    default:
      return type;
  }
}

function formatRuntimeLogMessage(message: string, deviceNames: Map<DeviceId, string>): string {
  const resolveName = (deviceId: string) => deviceNames.get(deviceId)?.trim() || deviceId;
  return message
    .replace(/Received radio packet from ([a-zA-Z0-9_-]+)/g, (_match, deviceId: string) =>
      `Received radio packet from ${resolveName(deviceId)}`)
    .replace(/Blocked radio packet from ([a-zA-Z0-9_-]+):/g, (_match, deviceId: string) =>
      `Blocked radio packet from ${resolveName(deviceId)}:`);
}

function makeArtifactId(deviceId: DeviceId, filename: string, timestamp: string): string {
  const slug = filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36) || 'artifact';
  return `${deviceId}-${slug}-${timestamp.replace(/[^0-9]/g, '')}`;
}

function replaceDeviceArtifact(
  project: SwarmProject,
  deviceId: DeviceId,
  nextArtifact: SwarmProject['artifacts'][number],
): SwarmProject['artifacts'] {
  const targetDevice = project.devices.find((device) => device.id === deviceId);
  if (!targetDevice) {
    return project.artifacts;
  }
  const previousArtifactId = targetDevice.programArtifactId;
  return [
    ...project.artifacts.filter((artifact) => {
      if (artifact.id === nextArtifact.id) {
        return false;
      }
      if (artifact.id !== previousArtifactId) {
        return true;
      }
      return project.devices.some(
        (device) => device.id !== deviceId && device.programArtifactId === artifact.id,
      );
    }),
    nextArtifact,
  ];
}

function hasDevice(project: SwarmProject, deviceId: DeviceId): boolean {
  return project.devices.some((device) => device.id === deviceId);
}

async function readHexFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.text === 'function') {
    return new TextEncoder().encode(await file.text());
  }

  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }

  return new Uint8Array(await readFileWithFileReader(file));
}

async function resolveRuntimeSource(
  filename: string,
  bytes: Uint8Array,
  heuristicRuntimeSource: SwarmProject['artifacts'][number]['runtimeSource'],
): Promise<{
  runtimeSource: SwarmProject['artifacts'][number]['runtimeSource'];
  issue?: ArtifactUploadIssue;
}> {
  try {
    const extracted = await extractHexSource(filename, bytes, { decompressLzma: decompressLzmaSource });
    if (
      heuristicRuntimeSource !== 'unknown' &&
      heuristicRuntimeSource !== extracted.runtimeSource
    ) {
      return {
        runtimeSource: extracted.runtimeSource,
        issue: {
          severity: 'warning',
          message: `Runtime source corrected from ${heuristicRuntimeSource} to ${extracted.runtimeSource}`,
        },
      };
    }
    return { runtimeSource: extracted.runtimeSource };
  } catch (error) {
    if (heuristicRuntimeSource !== 'unknown') {
      return {
        runtimeSource: heuristicRuntimeSource,
        issue: {
          severity: 'warning',
          message:
            error instanceof Error
              ? `Runtime source extraction failed; using heuristic ${heuristicRuntimeSource}: ${error.message}`
              : `Runtime source extraction failed; using heuristic ${heuristicRuntimeSource}`,
        },
      };
    }
    return {
      runtimeSource: 'unknown',
      issue: {
        severity: 'warning',
        message:
          error instanceof Error
            ? `Assigned, but runtime source could not be identified yet: ${error.message}`
            : 'Assigned, but runtime source could not be identified yet',
      },
    };
  }
}

function readFileWithFileReader(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      if (typeof reader.result === 'string') {
        resolve(new TextEncoder().encode(reader.result).buffer);
        return;
      }
      reject(new Error('Unable to read selected file'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read selected file')));
    reader.readAsArrayBuffer(file);
  });
}

function moveProjectObject(project: SwarmProject, target: DragTarget, position: Point): SwarmProject {
  if (target.type === 'device') {
    return {
      ...project,
      devices: project.devices.map((device) =>
        device.id === target.id ? { ...device, position } : device,
      ),
    };
  }

  return {
    ...project,
    environmentSources: project.environmentSources.map((source) =>
      source.id === target.id ? { ...source, position } : source,
    ),
  };
}

function clientPointToCanvasPoint(svg: SVGSVGElement, clientX: number, clientY: number): Point {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvasSize.width,
    y: ((clientY - rect.top) / rect.height) * canvasSize.height,
  };
}

function clampPoint(point: Point): Point {
  return {
    x: Math.min(canvasSize.width - 42, Math.max(42, point.x)),
    y: Math.min(canvasSize.height - 42, Math.max(42, point.y)),
  };
}

const emptyLedPixels = Array.from({ length: 25 }, () => 0);

function clearRuntimeActivityTimers(timers: Map<string, number>): void {
  for (const timer of timers.values()) {
    globalThis.clearTimeout(timer);
  }
  timers.clear();
}

function clearDisplayFrameTimers(timers: Map<DeviceId, number>): void {
  for (const timer of timers.values()) {
    globalThis.clearTimeout(timer);
  }
  timers.clear();
}

function clearButtonPulseTimers(timers: Map<string, number>): void {
  for (const timer of timers.values()) {
    globalThis.clearTimeout(timer);
  }
  timers.clear();
}

function removeDisplaySnapshot(
  snapshots: Record<DeviceId, number[]>,
  deviceId: DeviceId,
): Record<DeviceId, number[]> {
  if (!snapshots[deviceId]) {
    return snapshots;
  }

  const { [deviceId]: _removed, ...rest } = snapshots;
  return rest;
}

function intensityToSensorLevel(intensity: number): number {
  return Math.round(clampNumber(intensity, 0, 1) * MICROBIT_SENSOR_LEVEL_MAX);
}

function sensorLevelToIntensity(level: number): number {
  return (
    clampNumber(level, MICROBIT_SENSOR_LEVEL_MIN, MICROBIT_SENSOR_LEVEL_MAX) /
    MICROBIT_SENSOR_LEVEL_MAX
  );
}

function normalizeRuntimeRadioConfigHint(
  config: RuntimeRadioConfigHint,
  maxSignalStrength: number,
): RuntimeRadioConfigHint {
  const normalized: RuntimeRadioConfigHint = {};
  if (
    config.group !== undefined &&
    Number.isInteger(config.group) &&
    config.group >= RADIO_GROUP_MIN &&
    config.group <= RADIO_GROUP_MAX
  ) {
    normalized.group = config.group;
  }
  if (
    config.channel !== undefined &&
    Number.isInteger(config.channel) &&
    config.channel >= RADIO_CHANNEL_MIN &&
    config.channel <= RADIO_CHANNEL_MAX
  ) {
    normalized.channel = config.channel;
  }
  if (
    config.signalStrength !== undefined &&
    Number.isInteger(config.signalStrength) &&
    config.signalStrength >= 0 &&
    config.signalStrength <= maxSignalStrength
  ) {
    normalized.signalStrength = config.signalStrength;
  }
  return normalized;
}

function normalizeRuntimeRadioPacket(
  packet: RuntimeRadioPacket,
  maxSignalStrength: number,
  senderGroup?: number,
): { packet: RuntimeRadioPacket; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const normalized: RuntimeRadioPacket = {
    data: packet.data,
  };

  if (packet.group !== undefined) {
    if (Number.isInteger(packet.group) && packet.group >= RADIO_GROUP_MIN && packet.group <= RADIO_GROUP_MAX) {
      if (packet.group === RADIO_GROUP_MIN && senderGroup !== undefined && senderGroup !== RADIO_GROUP_MIN) {
        diagnostics.push(
          `Ignored placeholder runtime radio group 0 in favor of sender group ${senderGroup}`,
        );
      } else {
        normalized.group = packet.group;
      }
    } else {
      diagnostics.push(`Ignored invalid runtime radio group: ${packet.group}`);
    }
  }

  if (packet.channel !== undefined) {
    if (
      Number.isInteger(packet.channel) &&
      packet.channel >= RADIO_CHANNEL_MIN &&
      packet.channel <= RADIO_CHANNEL_MAX
    ) {
      normalized.channel = packet.channel;
    } else {
      diagnostics.push(`Ignored invalid runtime radio channel: ${packet.channel}`);
    }
  }

  if (packet.signalStrength !== undefined) {
    if (
      Number.isInteger(packet.signalStrength) &&
      packet.signalStrength >= 0 &&
      packet.signalStrength <= maxSignalStrength
    ) {
      normalized.signalStrength = packet.signalStrength;
    } else {
      diagnostics.push(`Ignored invalid runtime radio signal strength: ${packet.signalStrength}`);
    }
  }

  return { packet: normalized, diagnostics };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function summarizeRadioPacket(packet: RuntimeRadioPacket): Record<string, unknown> {
  return {
    bytes: packet.data.byteLength,
    preview: [...packet.data.slice(0, 8)],
    group: packet.group,
    channel: packet.channel,
    signalStrength: packet.signalStrength,
  };
}

function isDuplicateRecentRoutedPacket(
  cache: Map<DeviceId, string>,
  deviceId: DeviceId,
  packet: RuntimeRadioPacket,
  effectiveGroup?: number,
  effectiveChannel?: number,
): boolean {
  const fingerprint = `${effectiveGroup ?? 'none'}:${effectiveChannel ?? 'none'}:${[...packet.data].join(',')}:${packet.signalStrength ?? 'none'}`;
  const previous = cache.get(deviceId);
  cache.set(deviceId, fingerprint);
  queueMicrotask(() => {
    if (cache.get(deviceId) === fingerprint) {
      cache.delete(deviceId);
    }
  });
  return previous === fingerprint;
}

function debugRadioPanel(event: string, details: Record<string, unknown>): void {
  if (!ENABLE_RADIO_DEBUG_LOGS) {
    return;
  }
  console.debug('[swarm-radio-debug]', `panel:${event}`, details);
}

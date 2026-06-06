import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement,
} from 'react';
import { flushSync } from 'react-dom';
import { zipSync } from 'fflate';
import {
  createBlankProject,
  defaultDeviceNameForId,
  defaultEnvironmentSourceName,
  normalizeInstructionsMarkdown,
  type DeviceEditableProgram,
  type DeviceId,
  type EnvironmentSource,
  type EnvironmentSourceId,
  type Point,
  type ProjectSummary,
  type SwarmProject,
  type VirtualDevice,
} from '../domain/project';
import { SwarmRuntimeHosts } from './SwarmRuntimeHosts';
import { evaluateArtifactRuntimeReadiness } from '../runtime/artifactReadiness';
import { extractHexSource } from '../runtime/sourceExtraction';
import { decompressLzmaSource } from '../runtime/lzmaDecompressor';
import { normalizeRuntimeDisplayPixels } from '../runtime/displayPixels';
import { MICROBIT_BUILTIN_SENSOR_DOMAINS } from '../runtime/microbitSensorDomains';
import {
  FEATURE_FLAGS,
  filterEnabledEnvironmentSources,
  isEnvironmentSourceTypeEnabled,
} from '../runtime/featureFlags';
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
import type {
  RuntimeDataLogEntry,
  RuntimeDataLogEvent,
  RuntimeProgram,
  RuntimeRadioPacket,
} from '../runtime/runtimeAdapter';
import type { RuntimeSource } from '../runtime/types';
import type { MicroPythonRuntimeHostProps, RoutedRadioDelivery } from './MicroPythonRuntimeHost';
import type { RuntimeResetRequest } from './runtimeHostControls';
import type { BrowserProjectStore } from '../domain/browserProjectStore';
import { createBrowserProjectStore } from '../domain/browserProjectStore';
import type { BrowserWorkingCopyStore } from '../domain/browserWorkingCopyStore';
import { createBrowserWorkingCopyStore } from '../domain/browserWorkingCopyStore';
import { decodeProjectBundle, encodeProjectBundle } from '../domain/projectBundle';
import { findReusableArtifact } from '../domain/projectArtifacts';
import { DeviceCodeEditorModal } from './DeviceCodeEditorModal';
import { CanvasInstructionsEditorModal } from './CanvasInstructionsEditorModal';
import { InstructionsMarkdown } from './InstructionsMarkdown';
import {
  createEditableProgramSnapshot,
  getActiveEditableProgram,
  resolveDeviceRuntimeSource as resolveEditableRuntimeSource,
} from '../runtime/editableProgram';

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

function formatRadioInspectorPayload(
  data: Uint8Array,
  payloadRedacted: boolean,
): string {
  if (payloadRedacted) {
    return 'Broadcast hidden for locked device';
  }
  return decodePacketPreview(data);
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

interface RuntimeDeviceDataLog {
  entries: RuntimeDataLogEntry[];
}

interface RuntimeDataLogArchiveFile {
  filename: string;
  content: string;
}

type ArtifactUploadState = 'uploading' | 'ready' | 'failed';
type RuntimeNodeState = 'pending' | 'ready' | 'failed' | 'error';
type RuntimeRadioConfigHint = Partial<Pick<DeviceRuntimeState['radio'], 'group' | 'channel' | 'signalStrength'>>;

const canvasSize = { width: 860, height: 520 };
const defaultRadioOptions = {
  defaultRadioRangeRadius: 160,
  minRadioRangeRadius: 40,
  maxRadioRangeRadius: 240,
};
const runtimeActivityPulseMs = 480;
const runtimeSoundLogCooldownMs = 900;
const displayMinFrameMs = 420;
const buttonPulseMs = 110;
const AB_BUTTONS = ['A', 'B'] as const;
const MICROBIT_SENSOR_LEVEL_MIN = MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.min;
const MICROBIT_SENSOR_LEVEL_MAX = MICROBIT_BUILTIN_SENSOR_DOMAINS.lightLevel.max;
const MICROBIT_MAGNETIC_STRENGTH_MIN = 0;
const MICROBIT_MAGNETIC_STRENGTH_MAX = MICROBIT_BUILTIN_SENSOR_DOMAINS.magneticFieldStrength.max;
const RADIO_GROUP_MIN = 0;
const RADIO_GROUP_MAX = 255;
const RADIO_CHANNEL_MIN = 0;
const RADIO_CHANNEL_MAX = 83;
const ENABLE_RADIO_DEBUG_LOGS = import.meta.env.DEV;
const APP_VERSION_LABEL = `v${__APP_VERSION__}`;
const APP_REPOSITORY_URL = __APP_REPO_URL__;
const MAX_CANVAS_NODE_NAME = 11;
const MAX_SIDEBAR_NODE_NAME = 28;
const textEncoder = new TextEncoder();
export function SwarmCanvasPanel({ RuntimeHost = SwarmRuntimeHosts }: SwarmCanvasPanelProps = {}) {
  const [model, setModel] = useState<CanvasModel>(() => {
    const project = createDemoProject();
    return {
      project,
      simulationState: resetSimulation(project, defaultRadioOptions),
    };
  });
  const [selected, setSelected] = useState<Selection>({ type: 'device', id: 'device-1' });
  const [showRadioRange, setShowRadioRange] = useState(true);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [runtimeLoadResults, setRuntimeLoadResults] = useState<DeviceProgramLoadResult[]>([]);
  const [savedProjectSummaries, setSavedProjectSummaries] = useState<ProjectSummary[]>([]);
  const [isCanvasStateMenuOpen, setIsCanvasStateMenuOpen] = useState(false);
  const [isSplashOpen, setIsSplashOpen] = useState(false);
  const [isDebugModalOpen, setIsDebugModalOpen] = useState(false);
  const [isInstructionsEditorOpen, setIsInstructionsEditorOpen] = useState(false);
  const [isRefreshingSavedProjects, setIsRefreshingSavedProjects] = useState(false);
  const [canvasStateMessage, setCanvasStateMessage] = useState<string>();
  const [isBundleDropActive, setIsBundleDropActive] = useState(false);
  const [displaySnapshots, setDisplaySnapshots] = useState<Record<DeviceId, number[]>>({});
  const [runtimeActivity, setRuntimeActivity] = useState<Record<DeviceId, DeviceRuntimeActivity>>({});
  const [runtimeDataLogs, setRuntimeDataLogs] = useState<Record<DeviceId, RuntimeDeviceDataLog>>({});
  const [scenarioResetSignal, setScenarioResetSignal] = useState(0);
  const [runtimeResetRequest, setRuntimeResetRequest] = useState<RuntimeResetRequest>();
  const [artifactUploadIssues, setArtifactUploadIssues] = useState<Record<DeviceId, ArtifactUploadIssue>>({});
  const [artifactUploadState, setArtifactUploadState] = useState<Record<DeviceId, ArtifactUploadState>>({});
  const [runtimeErrorByDevice, setRuntimeErrorByDevice] = useState<Record<DeviceId, string>>({});
  const [isSidebarDragActive, setIsSidebarDragActive] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenamableSelection | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [editorDeviceId, setEditorDeviceId] = useState<DeviceId | null>(null);
  const [hasUnsavedCanvasChanges, setHasUnsavedCanvasChanges] = useState(false);
  const [hasSavedWorkingCopy, setHasSavedWorkingCopy] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const bundleDropAreaRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef(model);
  const uploadTokens = useRef(new Map<DeviceId, number>());
  const runtimeActivityTimers = useRef(new Map<string, number>());
  const displayFrameTimers = useRef(new Map<DeviceId, number>());
  const displayLastUpdateMs = useRef(new Map<DeviceId, number>());
  const buttonPulseTimers = useRef(new Map<string, number>());
  const recentRoutedPackets = useRef(new Map<DeviceId, string>());
  const recentRuntimeSoundLogAt = useRef(new Map<DeviceId, number>());
  const pendingRadioConfigHints = useRef(new Map<DeviceId, RuntimeRadioConfigHint>());
  const runtimeResetNonce = useRef(0);
  const nextDeviceNumber = useRef(model.project.devices.length + 1);
  const nextSourceNumber = useRef(nextEnvironmentSourceNumber(model.project.environmentSources));
  const capturedPointerId = useRef<number | null>(null);
  const browserProjectStore = useRef<BrowserProjectStore | undefined>(undefined);
  const browserWorkingCopyStore = useRef<BrowserWorkingCopyStore | undefined>(undefined);
  const hasHydratedWorkingCopy = useRef(false);
  const hasPendingCanvasEditsBeforeHydration = useRef(false);
  const hasUnsavedCanvasChangesRef = useRef(false);
  const { project, simulationState } = model;
  const visibleEnvironmentSources = filterEnabledEnvironmentSources(project.environmentSources);
  const selectedDevice =
    selected.type === 'device'
      ? project.devices.find((device) => device.id === selected.id)
      : undefined;
  const selectedSource =
    selected.type === 'source'
      ? visibleEnvironmentSources.find((source) => source.id === selected.id)
      : undefined;
  const editorDevice =
    editorDeviceId === null
      ? undefined
      : project.devices.find((device) => device.id === editorDeviceId);
  const activeEditorProgram = editorDevice ? getActiveEditableProgram(editorDevice) : undefined;
  const customInstructionsMarkdown = project.instructionsMarkdown;
  const hasCustomInstructions = Boolean(customInstructionsMarkdown);
  const canvasSaveStatus = hasUnsavedCanvasChanges
    ? 'Unsaved'
    : hasSavedWorkingCopy
      ? 'Saved'
      : 'Not saved';
  const canvasSaveButtonTitle = hasUnsavedCanvasChanges
    ? 'Save current canvas for the next browser session'
    : hasSavedWorkingCopy
      ? 'Current canvas is already saved for the next browser session'
      : 'Save current canvas for the next browser session';
  const canvasSaveButtonAriaLabel = hasUnsavedCanvasChanges
    ? 'Save canvas - unsaved changes'
    : hasSavedWorkingCopy
      ? 'Save canvas - saved for next session'
      : 'Save canvas - not yet saved';

  useEffect(
    () => () => {
      releaseCanvasPointer();
      clearRuntimeActivityTimers(runtimeActivityTimers.current);
      clearDisplayFrameTimers(displayFrameTimers.current);
      clearButtonPulseTimers(buttonPulseTimers.current);
      recentRuntimeSoundLogAt.current.clear();
    },
    [],
  );
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    if (hasHydratedWorkingCopy.current) {
      return;
    }
    let cancelled = false;
    try {
      browserProjectStore.current ??= createBrowserProjectStore();
      browserWorkingCopyStore.current ??= createBrowserWorkingCopyStore();
      void (async () => {
        try {
          const savedWorkingCopy = await browserWorkingCopyStore.current?.load();
          if (cancelled) {
            return;
          }
          hasHydratedWorkingCopy.current = true;
          setHasSavedWorkingCopy(Boolean(savedWorkingCopy));
          if (!savedWorkingCopy || hasPendingCanvasEditsBeforeHydration.current) {
            setIsSplashOpen(true);
            return;
          }
          replaceScenarioProject(savedWorkingCopy, {
            hasUnsavedChanges: false,
            recordUserInteraction: false,
            reopenSplash: true,
          });
          setCanvasStateMessage(`Restored current canvas "${savedWorkingCopy.name}"`);
        } catch (error) {
          try {
            await browserWorkingCopyStore.current?.clear();
          } catch {
            // Keep the original restore error surfaced below.
          }
          if (cancelled) {
            return;
          }
          hasHydratedWorkingCopy.current = true;
          setHasSavedWorkingCopy(false);
          setIsSplashOpen(true);
          setCanvasStateMessage(
            error instanceof Error ? error.message : 'Unable to restore saved current canvas',
          );
        }
      })();
    } catch (error) {
      hasHydratedWorkingCopy.current = true;
      setIsSplashOpen(true);
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Browser storage is not available',
      );
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isCanvasStateMenuOpen) {
      return;
    }
    void refreshSavedProjects();
  }, [isCanvasStateMenuOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasUnsavedCanvasChanges) {
      return;
    }
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedCanvasChanges]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    function handleWindowFileDrag(event: globalThis.DragEvent) {
      if (
        shouldGuardGlobalFileDrop(event, [
          sidebarRef.current,
          bundleDropAreaRef.current,
        ])
      ) {
        event.preventDefault();
      }
    }
    window.addEventListener('dragover', handleWindowFileDrag, true);
    window.addEventListener('drop', handleWindowFileDrag, true);
    return () => {
      window.removeEventListener('dragover', handleWindowFileDrag, true);
      window.removeEventListener('drop', handleWindowFileDrag, true);
    };
  }, []);

  useEffect(() => {
    if (!isSplashOpen) {
      return;
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setIsSplashOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isSplashOpen]);

  useEffect(() => {
    if (!isDebugModalOpen) {
      return;
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setIsDebugModalOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isDebugModalOpen]);

  useEffect(() => {
    if (!isInstructionsEditorOpen) {
      return;
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setIsInstructionsEditorOpen(false);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isInstructionsEditorOpen]);

  useEffect(() => {
    if (!editorDeviceId) {
      return;
    }
    const device = project.devices.find((candidate) => candidate.id === editorDeviceId);
    if (!device || !getActiveEditableProgram(device)) {
      setEditorDeviceId(null);
    }
  }, [editorDeviceId, project.devices]);

  useEffect(() => {
    if (!editorDeviceId) {
      return;
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      setEditorDeviceId(null);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [editorDeviceId]);

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
        setRuntimeErrorByDevice((current) => {
          if (!(deviceId in current)) {
            return current;
          }
          const { [deviceId]: _removed, ...rest } = current;
          return rest;
        });
      }

    }
    for (const [deviceId] of recentRuntimeSoundLogAt.current.entries()) {
      if (!activeDeviceIds.has(deviceId)) {
        recentRuntimeSoundLogAt.current.delete(deviceId);
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
    setRuntimeDataLogs((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeDeviceIds.has(deviceId)),
      ) as Record<DeviceId, RuntimeDeviceDataLog>;
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

  function addDevice(options: { locked: boolean } = { locked: false }) {
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
            ...(options.locked ? { locked: true } : {}),
            position: defaultNewDevicePosition(current.devices),
          },
        ],
      };
    });
    setSelected({ type: 'device', id });
  }

  function addSource(type: EnvironmentSource['type']) {
    if (!isEnvironmentSourceTypeEnabled(type)) {
      setCanvasStateMessage(`${type} sources are disabled in this build.`);
      return;
    }
    const sourceNumber = Math.max(
      nextSourceNumber.current,
      nextEnvironmentSourceNumber(modelRef.current.project.environmentSources, type),
    );
    nextSourceNumber.current = sourceNumber + 1;
    const id = `${type}-${sourceNumber}`;
    updateProject((current) => {
      nextSourceNumber.current = Math.max(
        nextSourceNumber.current,
        nextEnvironmentSourceNumber(current.environmentSources),
      );
      const position =
        type === 'light'
          ? { x: 220, y: 360 }
          : type === 'sound'
            ? { x: 650, y: 140 }
            : { x: 640, y: 360 };
      const source: EnvironmentSource =
        type === 'magnet'
          ? {
              id,
              type: 'magnet',
              name: defaultEnvironmentSourceName({ id, type: 'magnet' }),
              position,
              radius: 240,
              angleDeg: 0,
              strengthMicroTesla: 160,
            }
          : {
              id,
              type,
              name: defaultEnvironmentSourceName({ id, type }),
              position,
              radius: type === 'light' ? 180 : 150,
              intensity: sensorLevelToIntensity(type === 'light' ? 200 : 168),
            };
      return {
        ...current,
        environmentSources: [...current.environmentSources, source],
      };
    });
    setSelected({ type: 'source', id });
  }

  function updateSource(sourceId: EnvironmentSourceId, patch: Partial<EnvironmentSource>) {
    updateProject((current) => ({
      ...current,
      environmentSources: current.environmentSources.map((source) =>
        source.id === sourceId ? ({ ...source, ...patch } as EnvironmentSource) : source,
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
    setRuntimeErrorByDevice({});
    clearRuntimeActivityTimers(runtimeActivityTimers.current);
    clearDisplayFrameTimers(displayFrameTimers.current);
    clearButtonPulseTimers(buttonPulseTimers.current);
    displayLastUpdateMs.current.clear();
    recentRoutedPackets.current.clear();
    recentRuntimeSoundLogAt.current.clear();
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
    recentRuntimeSoundLogAt.current.delete(deviceId);
    setRuntimeErrorByDevice((current) => {
      if (!(deviceId in current)) {
        return current;
      }
      const { [deviceId]: _removed, ...rest } = current;
      return rest;
    });
  }

  function lockDevicePosition(deviceId: DeviceId) {
    releaseCanvasPointer();
    setDragTarget((current) =>
      current?.type === 'device' && current.id === deviceId ? null : current,
    );
    updateProject((current) => ({
      ...current,
      devices: current.devices.map((device) =>
        device.id === deviceId && device.locked && !isDevicePositionLocked(device)
          ? { ...device, positionLocked: true }
          : device,
      ),
    }));
  }

  function deleteSelectedNode() {
    if (selected.type === 'none') {
      return;
    }
    recordCanvasUserInteraction();

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
      setRuntimeDataLogs((current) => {
        const { [deletingId]: _removed, ...rest } = current;
        return rest;
      });
      setRuntimeErrorByDevice((current) => {
        const { [deletingId]: _removed, ...rest } = current;
        return rest;
      });
      setModel((current) => {
        const nextProject = touchProjectUpdatedAt(
          current.project,
          removeDeviceFromProject(current.project, deletingId),
        );
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
      const nextProject = touchProjectUpdatedAt(current.project, {
        ...current.project,
        environmentSources: current.project.environmentSources.filter((source) => source.id !== deletingId),
      });
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
    if (!canAssignDeviceCode(device, artifactUploadState[deviceId])) {
      setArtifactUploadIssues((current) => ({
        ...current,
        [deviceId]: {
          severity: 'warning',
          message: `${device.name} is locked after its first successful code upload.`,
        },
      }));
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
    setRuntimeErrorByDevice((current) => {
      if (!(deviceId in current)) {
        return current;
      }
      const { [deviceId]: _removed, ...rest } = current;
      return rest;
    });

    try {
      const bytes = await readHexFileBytes(file);
      if (uploadTokens.current.get(deviceId) !== token || !hasDevice(modelRef.current.project, deviceId)) {
        return;
      }

      const readiness = evaluateArtifactRuntimeReadiness(file.name, bytes);
      if (readiness.artifactKind !== 'hex') {
        throw new Error('Only micro:bit .hex files can be assigned to devices right now');
      }
      const { runtimeSource, issue, program } = await resolveRuntimeSource(
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
            device.id === deviceId
              ? {
                  ...device,
                  programArtifactId: nextArtifact.id,
                  ...(program && !device.locked
                    ? { editableProgram: createEditableProgramSnapshot(nextArtifact.id, program, now) }
                    : { editableProgram: undefined }),
                }
              : device,
          ),
        };
      });
      setDisplaySnapshots((current) => removeDisplaySnapshot(current, deviceId));
      setRuntimeDataLogs((current) => {
        if (!(deviceId in current)) {
          return current;
        }
        const { [deviceId]: _removed, ...rest } = current;
        return rest;
      });
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

  function openDeviceEditor(deviceId: DeviceId) {
    const device = modelRef.current.project.devices.find((candidate) => candidate.id === deviceId);
    if (!device || !getActiveEditableProgram(device)) {
      return;
    }
    setEditorDeviceId(deviceId);
  }

  function saveEditedProgram(deviceId: DeviceId, nextProgram: DeviceEditableProgram) {
    const now = new Date().toISOString();
    updateProject((current) => ({
      ...current,
      updatedAt: now,
      devices: current.devices.map((device) => {
        if (device.id !== deviceId || !device.programArtifactId || device.locked) {
          return device;
        }
        const currentProgram = getActiveEditableProgram(device);
        const revision = currentProgram ? currentProgram.revision + 1 : 1;
        return {
          ...device,
          editableProgram: {
            ...nextProgram,
            baseArtifactId: device.programArtifactId,
            revision,
            updatedAt: now,
          },
        };
      }),
    }));
    setEditorDeviceId(null);
    setDisplaySnapshots((current) => removeDisplaySnapshot(current, deviceId));
    setRuntimeErrorByDevice((current) => {
      if (!(deviceId in current)) {
        return current;
      }
      const { [deviceId]: _removed, ...rest } = current;
      return rest;
    });
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
        const senderRuntimeSource = resolveDeviceRuntimeSource(current.project, deviceId);
        const senderDevice = current.project.devices.find((device) => device.id === deviceId);
        const senderGroup = senderRuntime?.radio.group;
        const normalized = normalizeRuntimeRadioPacket(
          packet,
          current.simulationState.options.maxSignalStrength,
          senderGroup,
        );
        const runtimeErrorDiagnostics = [...normalized.diagnostics];
        const debugDiagnostics = [...normalized.diagnostics];
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
        if (senderDevice?.locked && simulationState.radioEvents.length > 0) {
          const lastEventIndex = simulationState.radioEvents.length - 1;
          simulationState = {
            ...simulationState,
            radioEvents: simulationState.radioEvents.map((event, index) =>
              index === lastEventIndex ? { ...event, payloadRedacted: true } : event,
            ),
          };
        }
        const routedEvent = simulationState.radioEvents.at(-1);
        const outboundGroup = normalized.packet.group ?? senderRuntime?.radio.group;
        const outboundChannel = normalized.packet.channel ?? senderRuntime?.radio.channel;
        deliveries = (routedEvent?.receivedPackets ?? []).map((receivedPacket) => {
          const recipientRuntimeSource = resolveDeviceRuntimeSource(current.project, receivedPacket.deviceId);
          const translatedPacket = translateRuntimeRadioPacketForRecipient(
            normalized.packet,
            senderRuntimeSource,
            recipientRuntimeSource,
          );
          if (translatedPacket.diagnostic) {
            debugDiagnostics.push(translatedPacket.diagnostic);
          }
          return {
            recipientId: receivedPacket.deviceId,
            packet: {
              data: translatedPacket.data,
              ...(outboundGroup === undefined ? {} : { group: outboundGroup }),
              ...(outboundChannel === undefined ? {} : { channel: outboundChannel }),
              signalStrength: receivedPacket.rssi,
            },
          };
        });
        for (const diagnostic of runtimeErrorDiagnostics) {
          simulationState = appendDeviceRuntimeLog(
            simulationState,
            deviceId,
            'runtime-error',
            diagnostic,
          );
        }
        routeDebugDetails = {
          senderDeviceId: deviceId,
          senderRadio: senderRuntime?.radio,
          rawPacket: summarizeRadioPacket(packet),
          normalizedPacket: summarizeRadioPacket(normalized.packet),
          diagnostics: debugDiagnostics,
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
    if (type === 'internal-error') {
      setRuntimeErrorByDevice((current) => ({
        ...current,
        [deviceId]: message,
      }));
    }
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

  function handleRuntimeLoadResults(results: DeviceProgramLoadResult[]) {
    setRuntimeLoadResults(results);
    if (results.length === 0) {
      return;
    }
    setRuntimeErrorByDevice((current) => {
      let changed = false;
      const next = { ...current };
      for (const result of results) {
        if (!(result.deviceId in next)) {
          continue;
        }
        changed = true;
        delete next[result.deviceId];
      }
      return changed ? next : current;
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

  function handleRuntimeSoundOutput(deviceId: DeviceId, level: number) {
    pulseRuntimeActivity(deviceId, 'sound');
    appendRuntimeSoundLog(deviceId, level);
  }

  function appendRuntimeSoundLog(deviceId: DeviceId, level: number) {
    const now = Date.now();
    const lastLogged = recentRuntimeSoundLogAt.current.get(deviceId) ?? 0;
    if (now - lastLogged < runtimeSoundLogCooldownMs) {
      return;
    }
    recentRuntimeSoundLogAt.current.set(deviceId, now);
    const normalizedLevel = Number.isFinite(level) ? Math.max(0, Math.round(level)) : 0;
    const message =
      normalizedLevel > 0 ? `Sound output started (level ${normalizedLevel})` : 'Sound output started';
    setModel((current) => {
      const next = {
        ...current,
        simulationState: appendDeviceRuntimeLog(
          current.simulationState,
          deviceId,
          'sound-output',
          message,
        ),
      };
      modelRef.current = next;
      return next;
    });
  }

  function handleRuntimeDataLog(deviceId: DeviceId, event: RuntimeDataLogEvent) {
    if (event.type === 'data-log-delete') {
      setRuntimeDataLogs((current) => {
        if (!(deviceId in current)) {
          return current;
        }
        const { [deviceId]: _removed, ...rest } = current;
        return rest;
      });
      return;
    }

    const normalized = normalizeRuntimeDataLogEntry(event.entry);
    if (!normalized) {
      return;
    }
    setRuntimeDataLogs((current) => ({
      ...current,
      [deviceId]: {
        entries: [...(current[deviceId]?.entries ?? []), normalized],
      },
    }));
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

  function setPulsedButtons(deviceId: DeviceId, buttons: readonly ('A' | 'B')[], pressed: boolean) {
    setModel((current) => {
      let simulationState = current.simulationState;
      for (const button of buttons) {
        simulationState = setDeviceButton(simulationState, deviceId, button, pressed);
      }
      const next = { ...current, simulationState };
      modelRef.current = next;
      return next;
    });
  }

  function clearButtonPulseTimer(timerKey: string): boolean {
    const existingTimer = buttonPulseTimers.current.get(timerKey);
    if (existingTimer === undefined) {
      return false;
    }
    globalThis.clearTimeout(existingTimer);
    buttonPulseTimers.current.delete(timerKey);
    return true;
  }

  function pulseDeviceButton(deviceId: DeviceId, button: 'A' | 'B') {
    setPulsedButtons(deviceId, [button], true);

    const timerKey = `${deviceId}:${button}`;
    const hadABPulse = clearButtonPulseTimer(`${deviceId}:AB`);
    if (hadABPulse) {
      const otherButton = button === 'A' ? 'B' : 'A';
      setPulsedButtons(deviceId, [otherButton], false);
    }
    clearButtonPulseTimer(timerKey);

    const timeoutId = globalThis.setTimeout(() => {
      buttonPulseTimers.current.delete(timerKey);
      setPulsedButtons(deviceId, [button], false);
    }, buttonPulseMs);

    buttonPulseTimers.current.set(timerKey, timeoutId);
  }

  function pulseDeviceButtonAB(deviceId: DeviceId) {
    const timerKey = `${deviceId}:AB`;
    clearButtonPulseTimer(`${deviceId}:A`);
    clearButtonPulseTimer(`${deviceId}:B`);
    clearButtonPulseTimer(timerKey);
    setPulsedButtons(deviceId, AB_BUTTONS, true);

    const timeoutId = globalThis.setTimeout(() => {
      buttonPulseTimers.current.delete(timerKey);
      setPulsedButtons(deviceId, AB_BUTTONS, false);
    }, buttonPulseMs);
    buttonPulseTimers.current.set(timerKey, timeoutId);
  }

  function updateDragPosition(clientX: number, clientY: number) {
    if (!dragTarget || !svgRef.current) {
      return;
    }
    if (
      dragTarget.type === 'device' &&
      isDevicePositionLocked(
        modelRef.current.project.devices.find((device) => device.id === dragTarget.id),
      )
    ) {
      endDrag();
      return;
    }

    recordCanvasUserInteraction();
    const position = clientPointToCanvasPoint(svgRef.current, clientX, clientY);
    const nextPosition = clampPoint(position);
    const target = dragTarget;
    setModel((current) => {
      const nextProject = touchProjectUpdatedAt(
        current.project,
        moveProjectObject(current.project, target, nextPosition),
      );
      const next = {
        project: nextProject,
        simulationState:
          target.type === 'device'
            ? moveDevice(current.simulationState, target.id, nextPosition)
            : reconcileSimulationProject(current.simulationState, nextProject),
      };
      modelRef.current = next;
      return next;
    });
  }

  function updateProject(updater: (current: SwarmProject) => SwarmProject) {
    recordCanvasUserInteraction();
    setModel((current) => {
      const project = touchProjectUpdatedAt(current.project, updater(current.project));
      const next = {
        project,
        simulationState: reconcileSimulationProject(current.simulationState, project),
      };
      modelRef.current = next;
      return next;
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
  const canDropHexToSidebar = Boolean(
    selectedDevice && canAssignDeviceCode(selectedDevice, artifactUploadState[selectedDevice.id]),
  );

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

  function setCanvasDirtyState(nextDirtyState: boolean) {
    if (hasUnsavedCanvasChangesRef.current === nextDirtyState) {
      return;
    }
    hasUnsavedCanvasChangesRef.current = nextDirtyState;
    setHasUnsavedCanvasChanges(nextDirtyState);
  }

  function recordCanvasUserInteraction() {
    if (!hasHydratedWorkingCopy.current) {
      hasPendingCanvasEditsBeforeHydration.current = true;
    }
    setCanvasDirtyState(true);
  }

  function replaceScenarioProject(
    nextProject: SwarmProject,
    options: {
      hasUnsavedChanges?: boolean;
      recordUserInteraction?: boolean;
      reopenSplash?: boolean;
    } = {},
  ) {
    if (options.recordUserInteraction ?? true) {
      recordCanvasUserInteraction();
    }
    releaseCanvasPointer();
    setDragTarget(null);
    setIsSidebarDragActive(false);
    setIsBundleDropActive(false);
    setIsInstructionsEditorOpen(false);
    setRenameTarget(null);
    setRenameDraft('');
    setEditorDeviceId(null);
    setDisplaySnapshots({});
    setRuntimeActivity({});
    setRuntimeLoadResults([]);
    setRuntimeDataLogs({});
    setArtifactUploadIssues({});
    setArtifactUploadState({});
    uploadTokens.current.clear();
    pendingRadioConfigHints.current.clear();
    recentRoutedPackets.current.clear();
    recentRuntimeSoundLogAt.current.clear();
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
    setCanvasDirtyState(options.hasUnsavedChanges ?? false);
    setSelected(pickFallbackSelection(nextProject));
    nextDeviceNumber.current = nextProject.devices.length + 1;
    nextSourceNumber.current = nextEnvironmentSourceNumber(nextProject.environmentSources);
    setScenarioResetSignal((current) => current + 1);
    if (options.reopenSplash) {
      setIsSplashOpen(true);
    }
  }

  async function saveCurrentCanvasToBrowser() {
    if (!browserWorkingCopyStore.current) {
      setCanvasStateMessage('Browser storage is not available');
      return;
    }
    try {
      await browserWorkingCopyStore.current.save(project);
      setCanvasDirtyState(false);
      setHasSavedWorkingCopy(true);
      setCanvasStateMessage(`Saved current canvas "${project.name}"`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to save current canvas',
      );
    }
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

  function confirmReplacingCurrentCanvas(actionLabel: string): boolean {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      return true;
    }
    const unsavedSuffix = hasUnsavedCanvasChanges
      ? ' This will also discard unsaved layout or code changes.'
      : '';
    return window.confirm(`${actionLabel} will replace the current canvas.${unsavedSuffix} Continue?`);
  }

  async function loadSavedLayout(projectId: string) {
    if (!browserProjectStore.current) {
      setCanvasStateMessage('Browser storage is not available');
      return;
    }
    if (!confirmReplacingCurrentCanvas('Loading this saved layout')) {
      return;
    }
    try {
      const loadedProject = await browserProjectStore.current.load(projectId);
      replaceScenarioProject(loadedProject, { reopenSplash: true });
      setCanvasStateMessage(`Loaded "${loadedProject.name}"`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to load saved layout',
      );
    }
  }

  async function deleteSavedLayout(projectId: string, projectName: string) {
    if (!browserProjectStore.current) {
      setCanvasStateMessage('Browser storage is not available');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(`Delete saved layout "${projectName}"?`)
    ) {
      return;
    }
    try {
      await browserProjectStore.current.remove(projectId);
      setCanvasStateMessage(`Deleted "${projectName}"`);
      await refreshSavedProjects();
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to delete saved layout',
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

  async function downloadRuntimeDataLogs() {
    const files = runtimeDataLogFiles;
    if (files.length === 0) {
      setCanvasStateMessage('No device log files available');
      return;
    }
    try {
      const zipEntries = Object.fromEntries(
        files.map((file) => [file.filename, textEncoder.encode(file.content)] as const),
      );
      const zipBytes = zipSync(zipEntries, { level: 0 });
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${slugForFilename(project.name)}-device-logs.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setCanvasStateMessage(`Downloaded log files for ${files.length} device${files.length === 1 ? '' : 's'}`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to download device log files',
      );
    }
  }

  async function importCanvasBundle(file: File) {
    if (!confirmReplacingCurrentCanvas('Importing a bundle')) {
      return;
    }

    try {
      const imported = await decodeProjectBundle(await readBundleFileBytes(file));
      replaceScenarioProject(imported, { reopenSplash: true });
      setCanvasStateMessage(`Imported "${imported.name}"`);
    } catch (error) {
      setCanvasStateMessage(
        error instanceof Error ? error.message : 'Unable to import bundle',
      );
    }
  }

  function clearCanvasLayout() {
    if (!confirmReplacingCurrentCanvas('Clearing the canvas')) {
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

  function saveCanvasInstructions(nextInstructions: string) {
    const normalizedInstructions = normalizeInstructionsMarkdown(nextInstructions);
    if (normalizedInstructions === project.instructionsMarkdown) {
      setIsInstructionsEditorOpen(false);
      return;
    }
    updateProject((current) => {
      const { instructionsMarkdown: _existingInstructions, ...rest } = current;
      return normalizedInstructions
        ? { ...rest, instructionsMarkdown: normalizedInstructions }
        : rest;
    });
    setCanvasStateMessage(
      normalizedInstructions ? 'Saved canvas instructions' : 'Restored default quick start instructions',
    );
    setIsInstructionsEditorOpen(false);
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

  const runtimeNodeStates = buildRuntimeNodeStates(
    project,
    runtimeLoadResults,
    artifactUploadState,
    runtimeErrorByDevice,
  );
  const deviceDisplayNames = new Map(project.devices.map((device) => [device.id, device.name] as const));
  const runtimeDataLogFiles = buildRuntimeDataLogArchiveFiles(project, runtimeDataLogs);
  const hasRuntimeDataLogFiles = runtimeDataLogFiles.length > 0;

  return (
    <section className="swarm-panel" aria-label="Swarm canvas">
      <div className="panel-header">
        <div className="panel-header__meta">
          <p className="eyebrow">Swarm canvas</p>
          <span className="panel-version" aria-label={`Version ${APP_VERSION_LABEL}`}>
            {APP_VERSION_LABEL}
          </span>
          <a
            className="panel-repo-link"
            href={APP_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open project repository on GitHub"
            title="Open project repository on GitHub"
          >
            ↗
          </a>
        </div>
        <div className="control-stack" aria-label="Simulation controls">
          <button
            type="button"
            className={
              hasUnsavedCanvasChanges
                ? 'canvas-save-button canvas-save-button--dirty'
                : hasSavedWorkingCopy
                  ? 'canvas-save-button canvas-save-button--saved'
                  : 'canvas-save-button'
            }
            aria-label={canvasSaveButtonAriaLabel}
            title={canvasSaveButtonTitle}
            onClick={() => void saveCurrentCanvasToBrowser()}
          >
            <strong>Save canvas</strong>
            <span className="canvas-save-button__status" aria-live="polite">
              {canvasSaveStatus}
            </span>
          </button>
          {hasCustomInstructions ? (
            <button
              type="button"
              className="panel-info-button"
              aria-label="Show instructions"
              title="Show instructions"
              onClick={() => setIsSplashOpen(true)}
            >
              <span aria-hidden="true">ⓘ</span>
            </button>
          ) : null}
          <button
            type="button"
            className="button-with-icon"
            onClick={resetAllDevices}
            title="Reset all devices and runtimes"
          >
            <span aria-hidden="true">↺</span> Reset
          </button>
          <button
            type="button"
            className="button-with-icon"
            aria-expanded={isCanvasStateMenuOpen}
            aria-controls="canvas-state-panel"
            title="Open swarm tools"
            onClick={() => setIsCanvasStateMenuOpen((current) => !current)}
          >
            <span className="button-icon button-icon--toolbar" aria-hidden="true">
              ⚙
            </span>
            Swarm tools
          </button>
        </div>
      </div>
      {isCanvasStateMenuOpen ? (
        <div id="canvas-state-panel" className="canvas-state-panel" aria-label="Swarm tool controls">
          <div className="canvas-state-panel__section">
            <span className="metric-label">Swarm tools</span>
            <div className="canvas-state-panel__actions">
              <button type="button" onClick={() => addDevice()} title="Add device">
                Add device
              </button>
              <button type="button" onClick={() => addDevice({ locked: true })} title="Add locked device">
                Add locked device
              </button>
              {FEATURE_FLAGS.light ? (
                <button type="button" onClick={() => addSource('light')} title="Add light source">
                  Add light
                </button>
              ) : null}
              {FEATURE_FLAGS.sound ? (
                <button type="button" onClick={() => addSource('sound')} title="Add sound source">
                  Add sound
                </button>
              ) : null}
              {FEATURE_FLAGS.magnet ? (
                <button type="button" onClick={() => addSource('magnet')} title="Add magnet source">
                  Add magnet
                </button>
              ) : null}
              <label className="toggle-field canvas-state-toggle">
                <input
                  type="checkbox"
                  checked={showRadioRange}
                  onChange={(event) => setShowRadioRange(event.target.checked)}
                />
                Radio range overlay
              </label>
            </div>
          </div>
          <div className="canvas-state-panel__section">
            <span className="metric-label">Canvas state</span>
            <div className="canvas-state-panel__actions">
              <button
                type="button"
                onClick={() => setIsInstructionsEditorOpen(true)}
                title="Edit canvas instructions"
              >
                Edit instructions
              </button>
              <button type="button" onClick={() => void saveCurrentLayoutToBrowser()} title="Save layout to browser">
                Save to browser
              </button>
              <button
                type="button"
                className="button-with-icon"
                onClick={() => void downloadCanvasBundle()}
                title="Download canvas bundle"
              >
                <span className="button-icon button-icon--bundle" aria-hidden="true">
                  ⬇
                </span>
                Download bundle
              </button>
              <label className="canvas-state-upload" title="Upload canvas bundle">
                <span className="button-icon button-icon--bundle" aria-hidden="true">
                  ⬆
                </span>
                Upload bundle
                <input
                  type="file"
                  accept=".swarm"
                  aria-label="Upload bundle"
                  onChange={handleBundleFileInput}
                />
              </label>
              <button
                type="button"
                onClick={() => void downloadRuntimeDataLogs()}
                disabled={!hasRuntimeDataLogFiles}
                title="Download runtime log files"
              >
                Download log files
              </button>
              <button type="button" onClick={clearCanvasLayout} title="Clear canvas">
                Clear canvas
              </button>
            </div>
          </div>
          <div
            ref={bundleDropAreaRef}
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
                <div key={summary.id} className="canvas-state-saved__row">
                  <button
                    type="button"
                    onClick={() => void loadSavedLayout(summary.id)}
                    className="canvas-state-saved__item"
                    title={`Load ${summary.name}`}
                  >
                    Load {summary.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSavedLayout(summary.id, summary.name)}
                    className="canvas-state-saved__delete"
                    aria-label={`Delete ${summary.name}`}
                    title={`Delete ${summary.name}`}
                  >
                    <span aria-hidden="true">🗑</span>
                  </button>
                </div>
              ))
            )}
          </div>
          {canvasStateMessage ? <p className="hint">{canvasStateMessage}</p> : null}
        </div>
      ) : null}
      {isSplashOpen ? (
        <div
          className="splash-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Simulator instructions"
          onClick={() => setIsSplashOpen(false)}
        >
          <div className="splash-modal__card" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="splash-modal__close"
              aria-label="Close instructions"
              onClick={() => setIsSplashOpen(false)}
            >
              ×
            </button>
            <p className="metric-label">{hasCustomInstructions ? 'Instructions' : 'Quick start'}</p>
            <div className="splash-modal__body">
              {customInstructionsMarkdown ? (
                <InstructionsMarkdown markdown={customInstructionsMarkdown} />
              ) : (
                <>
                  <h3>Getting started</h3>
                  <p>
                    Drag nodes to change distance, load `.hex` files onto selected devices, and inspect packet flow in
                    the radio inspector.
                  </p>
                </>
              )}
            </div>
            <p className="hint splash-modal__hint">
              Click anywhere, press Escape, or use the close button to continue.
            </p>
          </div>
        </div>
      ) : null}
      {isInstructionsEditorOpen ? (
        <CanvasInstructionsEditorModal
          initialInstructions={project.instructionsMarkdown}
          onClose={() => setIsInstructionsEditorOpen(false)}
          onSave={saveCanvasInstructions}
        />
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

            {visibleEnvironmentSources.map((source) => (
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

            {visibleEnvironmentSources.map((source) => (
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
                {source.type === 'magnet' ? (
                  <g transform={`rotate(${source.angleDeg})`}>
                    <rect className="source-magnet source-magnet--north" x="-26" y="-9" width="26" height="18" rx="4" />
                    <rect className="source-magnet source-magnet--south" x="0" y="-9" width="26" height="18" rx="4" />
                    <text x="-13" y="5" textAnchor="middle">N</text>
                    <text x="13" y="5" textAnchor="middle">S</text>
                  </g>
                ) : (
                  <>
                    <circle className="source-core" r="16" />
                    <text y="5" textAnchor="middle">
                      {source.type === 'light' ? 'L' : 'S'}
                    </text>
                  </>
                )}
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
                    setSelected({ type: 'device', id: device.deviceId });
                    if (isDevicePositionLocked(projectDevice)) {
                      releaseCanvasPointer();
                      setDragTarget(null);
                      return;
                    }
                    captureCanvasPointer(event.pointerId);
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
                  {soundActive ? (
                    <g
                      className="runtime-sound-badge"
                      data-runtime-sound-indicator={device.deviceId}
                      transform="translate(0 -40)"
                    >
                      <circle r="9" />
                      <path className="runtime-sound-badge__speaker" d="M-4 -2 L-1 -2 L2 -5 V5 L-1 2 L-4 2 Z" />
                      <path d="M3 -2.5 Q5 0 3 2.5" />
                      <path d="M5 -4 Q8 0 5 4" />
                    </g>
                  ) : null}
                  <rect className="microbit-body" x="-42" y="-30" width="84" height="60" rx="14" />
                  <g className="button-combo-link" data-device-button-combo-link={device.deviceId}>
		    <path d="M-29 -2 V20 H29 V-3"/>
                  </g>
                  <circle
                    className="button-dot button-dot--interactive"
                    data-device-button={`${device.deviceId}:A`}
                    data-testid={`device-button-${device.deviceId}-A`}
                    cx="-29"
                    cy="-2"
                    r="7"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      pulseDeviceButton(device.deviceId, 'A');
                    }}
                  />
                  <circle
                    className="button-dot button-dot--interactive"
                    data-device-button={`${device.deviceId}:B`}
                    data-testid={`device-button-${device.deviceId}-B`}
                    cx="29"
                    cy="-2"
                    r="7"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      pulseDeviceButton(device.deviceId, 'B');
                    }}
                  />
                  <circle
                    className="button-dot button-dot--interactive button-dot--combo"
                    data-device-button={`${device.deviceId}:AB`}
                    data-testid={`device-button-${device.deviceId}-AB`}
                    cx="29"
                    cy="20"
                    r="5.8"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      pulseDeviceButtonAB(device.deviceId);
                    }}
                  />
                  <text className="button-dot-label" x="29" y="18" textAnchor="middle">
                    
                  </text>
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
                        x={-18 + column * 8}
                        y={-21 + row * 8}
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
          ref={sidebarRef}
          className={`swarm-sidebar ${canDropHexToSidebar ? 'swarm-sidebar--drop-enabled' : ''} ${isSidebarDragActive ? 'swarm-sidebar--drag-over' : ''}`}
          aria-label="Canvas controls and selection details"
          onDragOver={handleSidebarDragOver}
          onDragLeave={handleSidebarDragLeave}
          onDrop={handleSidebarDrop}
        >
          {isSidebarDragActive && canDropHexToSidebar ? (
            <div className="swarm-sidebar-drop-overlay">
              Drop .hex to load onto <strong>{selectedDevice?.name}</strong>
            </div>
          ) : null}

          <div className="selection-card">
            <span className="metric-label">Selection</span>
            {selectedDevice ? (
              <>
                <DeviceSelection
                  project={project}
                  runtime={simulationState.devices[selectedDevice.id]}
                  showMagneticReadings={FEATURE_FLAGS.magnet}
                  runtimeLoadResult={selectedRuntimeLoadResult}
                  uploadState={artifactUploadState[selectedDevice.id]}
                  deviceId={selectedDevice.id}
                  uploadIssue={artifactUploadIssues[selectedDevice.id]}
                  runtimeError={runtimeErrorByDevice[selectedDevice.id]}
                  logs={simulationState.deviceLogs.filter((log) => log.deviceId === selectedDevice.id)}
                  onResetRuntime={resetSelectedDevice}
                  onDeleteNode={deleteSelectedNode}
                  onLockPosition={lockDevicePosition}
                  onArtifactUpload={uploadArtifactForDevice}
                  onOpenEditor={openDeviceEditor}
                  canAssignCode={canAssignDeviceCode(selectedDevice, artifactUploadState[selectedDevice.id])}
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
                  .map((event) => {
                    const senderName =
                      deviceDisplayNames.get(event.senderId) ?? defaultDeviceNameForId(event.senderId);
                    return (
                      <article key={event.id} className="radio-event">
                        <p className="radio-event__payload">
                          {formatRadioInspectorPayload(event.data, event.payloadRedacted === true)}
                        </p>
                        <p className="radio-event__meta">
                          {senderName} to {event.recipients.length} received / {event.blockedTargets.length} blocked
                        </p>
                      </article>
                    );
                  })
              )}
            </div>
          </details>
          <div className="swarm-sidebar-footer">
            <button
              type="button"
              className="swarm-sidebar-debug-button"
              aria-haspopup="dialog"
              aria-expanded={isDebugModalOpen}
              aria-controls="debug-tools-modal"
              onClick={() => setIsDebugModalOpen(true)}
            >
              Debug
            </button>
          </div>
        </aside>
      </div>
      <div
        id="debug-tools-modal"
        className={isDebugModalOpen ? 'debug-modal' : 'debug-modal debug-modal--hidden'}
        role="dialog"
        aria-modal="true"
        aria-label="Debug tools"
        aria-hidden={!isDebugModalOpen}
        onClick={() => setIsDebugModalOpen(false)}
      >
        <div className="debug-modal__card" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="debug-modal__close"
            aria-label="Close debug tools"
            onClick={() => setIsDebugModalOpen(false)}
          >
            ×
          </button>
          <p className="metric-label">Debug tools</p>
          <div className="telemetry-card" aria-live="polite">
            <span className="metric-label">Engine telemetry</span>
            <p>
              {project.devices.length} nodes / {simulationState.radioLinks.filter((link) => link.canCommunicate).length}{' '}
              active directed radio links
            </p>
          </div>
          <RuntimeHost
            project={project}
            selectedDeviceId={selectedDevice?.id}
            resetRequest={runtimeResetRequest}
            headless={false}
            showHostCard={isDebugModalOpen}
            deviceRuntimeStates={simulationState.devices}
            scenarioResetSignal={scenarioResetSignal}
            onRadioPacket={handleRuntimeRadioPacket}
            onRuntimeLog={handleRuntimeLog}
            onDisplayChange={handleRuntimeDisplayChange}
            onSoundOutput={handleRuntimeSoundOutput}
            onRadioConfigHint={handleRuntimeRadioConfigHint}
            onRuntimeDataLog={handleRuntimeDataLog}
            onLoadResultsChange={handleRuntimeLoadResults}
          />
        </div>
      </div>
      {editorDevice && activeEditorProgram ? (
        <DeviceCodeEditorModal
          deviceName={editorDevice.name}
          editableProgram={activeEditorProgram}
          onClose={() => setEditorDeviceId(null)}
          onSave={(nextProgram) => saveEditedProgram(editorDevice.id, nextProgram)}
        />
      ) : null}
    </section>
  );
}

function DeviceSelection({
  project,
  deviceId,
  showMagneticReadings,
  runtime,
  runtimeLoadResult,
  uploadState,
  uploadIssue,
  runtimeError,
  logs,
  onResetRuntime,
  onDeleteNode,
  onLockPosition,
  onArtifactUpload,
  onOpenEditor,
  canAssignCode,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}: {
  project: SwarmProject;
  deviceId: DeviceId;
  showMagneticReadings: boolean;
  runtime?: DeviceRuntimeState;
  runtimeLoadResult?: DeviceProgramLoadResult;
  uploadState?: ArtifactUploadState;
  uploadIssue?: ArtifactUploadIssue;
  runtimeError?: string;
  logs: SimulationState['deviceLogs'];
  onResetRuntime: () => void;
  onDeleteNode: () => void;
  onLockPosition: (deviceId: DeviceId) => void;
  onArtifactUpload: (deviceId: DeviceId, file: File) => void;
  onOpenEditor: (deviceId: DeviceId) => void;
  canAssignCode: boolean;
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
  const editableProgram = getActiveEditableProgram(device);
  const locked = device.locked === true;
  const positionLocked = isDevicePositionLocked(device);

  return (
    <>
      <SelectionNameEditor
        displayName={device.name}
        badge={
          locked ? (
            <span className="selection-name-badge" aria-label="Locked device">
              <span aria-hidden="true">🔒</span> Locked
            </span>
          ) : undefined
        }
        isRenaming={isRenaming}
        renameDraft={renameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onBeginRename={onBeginRename}
        onCommitRename={onCommitRename}
        onCancelRename={onCancelRename}
      />
      <div className="selection-actions">
        <button type="button" onClick={onResetRuntime} disabled={!device.programArtifactId}>
          <span aria-hidden="true">↺</span> Reset
        </button>
        <button type="button" onClick={onDeleteNode}>
          <span aria-hidden="true">🗑</span> Delete
        </button>
        {!locked ? (
          <button type="button" onClick={() => onOpenEditor(device.id)} disabled={!editableProgram}>
            <span aria-hidden="true">✎</span> Edit code
          </button>
        ) : null}
        {locked && !positionLocked ? (
          <button type="button" onClick={() => onLockPosition(device.id)}>
            <span aria-hidden="true">📍</span> Lock position
          </button>
        ) : null}
      </div>
      {runtime ? (
        <>
          <dl className="radio-summary">
            <div>
              <dt>Light</dt>
              <dd>{runtime.sensors.lightLevel}</dd>
            </div>
            <div>
              <dt>Sound</dt>
              <dd>{runtime.sensors.soundLevel}</dd>
            </div>
            {showMagneticReadings ? (
              <>
                <div>
                  <dt>Mag X</dt>
                  <dd>{runtime.sensors.magneticForceX} µT</dd>
                </div>
                <div>
                  <dt>Mag Y</dt>
                  <dd>{runtime.sensors.magneticForceY} µT</dd>
                </div>
                <div>
                  <dt>Mag strength</dt>
                  <dd>{runtime.sensors.magneticFieldStrength} µT</dd>
                </div>
              </>
            ) : null}
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
      <div className="selection-artifact-block">
        {locked ? (
          <p>
            <strong>Locked device.</strong>{' '}
            {device.programArtifactId
              ? 'Source is hidden and this device cannot be overwritten.'
              : 'The first successful code upload will be its only assignment.'}
          </p>
        ) : null}
        {locked ? (
          <div className="selection-position-lock">
            {positionLocked ? (
              <p>
                <strong>Position fixed.</strong> This device is locked in place on the canvas and cannot
                {' '}be moved or unlocked.
              </p>
            ) : (
              <>
                <p>Keep this locked device fixed in place on the canvas.</p>
                <p>This is permanent once applied.</p>
              </>
            )}
          </div>
        ) : null}
        {canAssignCode ? (
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
        ) : locked && uploadState !== 'uploading' ? (
          <p>Locked after first code upload.</p>
        ) : null}
        <p>{device.programArtifactId ? `Assigned: ${artifactName(project, device.programArtifactId)}` : 'No code assigned yet'}</p>
        {assignedArtifact ? <p>Runtime source: {assignedArtifact.runtimeSource}</p> : null}
        {editableProgram ? (
          <p>
            Editable source: <strong>{editableProgram.revision > 0 ? 'saved changes ready' : 'ready to edit'}</strong>
          </p>
        ) : null}
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
        {runtimeError ? (
          <p className="hint hint--error">
            Runtime: <strong>something went wrong</strong> — {runtimeError}
          </p>
        ) : null}
      </div>
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
  const peakLevel = source.type === 'magnet' ? 0 : intensityToSensorLevel(source.intensity);
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
      <p className="hint">
        {source.type === 'light' ? 'Light source' : source.type === 'sound' ? 'Sound source' : 'Magnet source'}
      </p>
      <div className="selection-actions">
        <button type="button" onClick={onDeleteNode}>
          <span aria-hidden="true">🗑</span> Delete
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
      {source.type === 'magnet' ? (
        <>
          <label className="range-field">
            Angle
            <input
              type="range"
              min="0"
              max="359"
              step="1"
              value={source.angleDeg}
              onChange={(event) => updateSource(source.id, { angleDeg: Number(event.target.value) })}
            />
          </label>
          <label className="range-field">
            Strength (µT, microtesla)
            <input
              type="range"
              min={MICROBIT_MAGNETIC_STRENGTH_MIN}
              max={MICROBIT_MAGNETIC_STRENGTH_MAX}
              step="1"
              value={source.strengthMicroTesla}
              onChange={(event) =>
                updateSource(source.id, {
                  strengthMicroTesla: Number(event.target.value),
                })
              }
            />
          </label>
        </>
      ) : (
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
      )}
    </>
  );
}

function SelectionNameEditor({
  displayName,
  badge,
  isRenaming,
  renameDraft,
  onRenameDraftChange,
  onBeginRename,
  onCommitRename,
  onCancelRename,
}: {
  displayName: string;
  badge?: ReactElement;
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
        onFocus={(event) => event.currentTarget.select()}
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
      {badge}
      <button type="button" className="selection-name-edit" aria-label="Rename selected node" onClick={onBeginRename}>
        ✎
      </button>
    </div>
  );
}

function canAssignDeviceCode(
  device: Pick<VirtualDevice, 'locked' | 'programArtifactId'>,
  uploadState?: ArtifactUploadState,
): boolean {
  if (!device.locked) {
    return true;
  }
  if (uploadState === 'uploading') {
    return false;
  }
  return !device.programArtifactId;
}

function isDevicePositionLocked(
  device: Pick<VirtualDevice, 'locked' | 'positionLocked'> | undefined,
): boolean {
  return device?.locked === true && device.positionLocked === true;
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
        id: 'device-1',
        name: 'Node 1',
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
  const firstSource = project.environmentSources.find((source) =>
    isEnvironmentSourceTypeEnabled(source.type),
  );
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

function touchProjectUpdatedAt(currentProject: SwarmProject, nextProject: SwarmProject): SwarmProject {
  return nextProject.updatedAt === currentProject.updatedAt
    ? { ...nextProject, updatedAt: new Date().toISOString() }
    : nextProject;
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

function normalizeRuntimeDataLogEntry(entry: RuntimeDataLogEntry): RuntimeDataLogEntry | undefined {
  const headings = normalizeRuntimeDataLogValues(entry.headings);
  const data = normalizeRuntimeDataLogValues(entry.data);
  if (!headings && !data) {
    return undefined;
  }
  return {
    ...(headings ? { headings } : {}),
    ...(data ? { data } : {}),
  };
}

function normalizeRuntimeDataLogValues(values: RuntimeDataLogEntry['headings']): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  return values.map((value) => value ?? '');
}

function buildRuntimeDataLogArchiveFiles(
  project: SwarmProject,
  runtimeDataLogs: Record<DeviceId, RuntimeDeviceDataLog>,
): RuntimeDataLogArchiveFile[] {
  const usedBaseNames = new Map<string, number>();
  return project.devices.flatMap((device) => {
    const log = runtimeDataLogs[device.id];
    if (!log || log.entries.length === 0) {
      return [];
    }
    const baseName = slugForFilename(device.name);
    const occurrence = (usedBaseNames.get(baseName) ?? 0) + 1;
    usedBaseNames.set(baseName, occurrence);
    const uniqueBaseName = occurrence === 1 ? baseName : `${baseName}-${occurrence}`;
    return [
      {
        filename: `${uniqueBaseName}-MY_DATA.html`,
        content: renderRuntimeDataLogHtml(device.name, log.entries),
      },
    ];
  });
}

function renderRuntimeDataLogHtml(deviceName: string, entries: RuntimeDataLogEntry[]): string {
  type DataLogSection = { headings: string[]; rows: string[][] };
  const sections: DataLogSection[] = [];
  let activeHeadings: string[] | undefined;

  for (const rawEntry of entries) {
    const entry = normalizeRuntimeDataLogEntry(rawEntry);
    if (!entry) {
      continue;
    }
    if (entry.headings) {
      activeHeadings = entry.headings;
      const currentSection = sections.at(-1);
      if (!currentSection || !areLogHeadingsEqual(currentSection.headings, activeHeadings)) {
        sections.push({ headings: [...activeHeadings], rows: [] });
      }
    }
    if (entry.data) {
      const rowHeadings =
        activeHeadings && activeHeadings.length > 0
          ? activeHeadings
          : entry.data.map((_, index) => `Column ${index + 1}`);
      let section = sections.at(-1);
      if (!section || !areLogHeadingsEqual(section.headings, rowHeadings)) {
        section = { headings: [...rowHeadings], rows: [] };
        sections.push(section);
      }
      section.rows.push(rowHeadings.map((_, index) => entry.data?.[index] ?? ''));
    }
  }

  const body =
    sections.length === 0
      ? '<p>No data log rows captured.</p>'
      : sections
          .map(
            (section, index) =>
              `<section><h2>Log ${index + 1}</h2><table><thead><tr>${section.headings
                .map((heading) => `<th>${escapeHtml(heading)}</th>`)
                .join('')}</tr></thead><tbody>${section.rows
                .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
                .join('')}</tbody></table></section>`,
          )
          .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MY_DATA - ${escapeHtml(deviceName)}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0 20px; }
      th, td { border: 1px solid #c9cdd1; padding: 6px 8px; text-align: left; font-size: 14px; }
      th { background: #f6f8fa; }
      h1 { margin: 0 0 8px; }
      h2 { margin: 18px 0 6px; font-size: 16px; }
      .hint { color: #57606a; font-size: 13px; margin: 0 0 12px; }
    </style>
  </head>
  <body>
    <h1>MY_DATA</h1>
    <p class="hint">Device: ${escapeHtml(deviceName)}</p>
    ${body}
  </body>
</html>`;
}

function areLogHeadingsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function shouldGuardGlobalFileDrop(
  event: Pick<globalThis.DragEvent, 'dataTransfer' | 'target' | 'composedPath'>,
  allowedRoots: ReadonlyArray<HTMLElement | null>,
): boolean {
  const transferTypes = event.dataTransfer?.types;
  if (!transferTypes || !transferTypes.includes('Files')) {
    return false;
  }
  const activeAllowedRoots = allowedRoots.filter((root): root is HTMLElement => Boolean(root));
  if (activeAllowedRoots.length === 0) {
    return true;
  }
  const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const pathTargets =
    eventPath.length > 0
      ? eventPath
      : event.target instanceof Node
        ? collectNodePath(event.target)
        : [];
  return !activeAllowedRoots.some((root) =>
    pathTargets.some((target) => target instanceof Node && root.contains(target)));
}

function collectNodePath(target: Node): Node[] {
  const path: Node[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  return path;
}

function buildRuntimeNodeStates(
  project: SwarmProject,
  loadResults: DeviceProgramLoadResult[],
  uploadState: Record<DeviceId, ArtifactUploadState>,
  runtimeErrors: Record<DeviceId, string>,
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
    if (runtimeErrors[device.id]) {
      states[device.id] = 'error';
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

function resolveDeviceRuntimeSource(project: SwarmProject, deviceId: DeviceId): RuntimeSource {
  const device = project.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return 'unknown';
  }
  const artifact = device.programArtifactId
    ? project.artifacts.find((candidate) => candidate.id === device.programArtifactId)
    : undefined;
  return resolveEditableRuntimeSource(device, artifact);
}

export function translateRuntimeRadioPacketForRecipient(
  packet: RuntimeRadioPacket,
  senderRuntimeSource: RuntimeSource,
  recipientRuntimeSource: RuntimeSource,
): { data: Uint8Array; diagnostic?: string } {
  if (
    senderRuntimeSource === recipientRuntimeSource ||
    senderRuntimeSource === 'unknown' ||
    recipientRuntimeSource === 'unknown'
  ) {
    return { data: new Uint8Array(packet.data) };
  }

  if (senderRuntimeSource === 'makecode-pxt' && recipientRuntimeSource === 'micropython') {
    const decoded = decodeMakeCodeRadioPacket(packet.data);
    if (!decoded) {
      return { data: new Uint8Array(packet.data) };
    }
    return {
      data: new TextEncoder().encode(decoded),
      diagnostic: `Translated MakeCode radio packet for MicroPython recipient: ${truncatePreview(decoded, 28)}`,
    };
  }

  if (senderRuntimeSource === 'micropython' && recipientRuntimeSource === 'makecode-pxt') {
    if (isLikelyMakeCodeTypedPacket(packet.data)) {
      return { data: new Uint8Array(packet.data) };
    }
    const decoded = decodeMicroPythonRadioText(packet.data);
    if (!decoded) {
      return { data: new Uint8Array(packet.data) };
    }
    return {
      data: encodeMakeCodeInteropPacketFromText(decoded),
      diagnostic: `Translated MicroPython radio payload for MakeCode recipient: ${truncatePreview(decoded, 28)}`,
    };
  }

  return { data: new Uint8Array(packet.data) };
}

function decodeMicroPythonRadioText(data: Uint8Array): string | undefined {
  if (data[0] === 0x01 && data[1] === 0x00 && data[2] === 0x01) {
    const decodedPrefixed = new TextDecoder().decode(data.subarray(3)).trim();
    return decodedPrefixed === '' ? undefined : decodedPrefixed;
  }
  const decoded = new TextDecoder().decode(data).trim();
  if (decoded === '' || !/^[\x20-\x7e]+$/.test(decoded)) {
    return undefined;
  }
  return decoded;
}

function isLikelyMakeCodeTypedPacket(data: Uint8Array): boolean {
  const packetType = data[0];
  switch (packetType) {
    case 0:
      return data.length >= 13;
    case 1:
      return data.length >= 14;
    case 2:
    case 3:
      return data.length >= 10;
    case 4:
      return data.length >= 17;
    case 5:
      return data.length >= 18;
    default:
      return false;
  }
}

function encodeMakeCodeInteropPacketFromText(value: string): Uint8Array {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) {
    return Number.isInteger(numberValue)
      ? encodeMakeCodeNumberPacket(numberValue)
      : encodeMakeCodeDoublePacket(numberValue);
  }

  const valuePairMatch = /^([A-Za-z][A-Za-z0-9 _-]{0,31}):(-?\d+(?:\.\d+)?)$/.exec(value);
  if (valuePairMatch) {
    const name = valuePairMatch[1];
    const numericValue = Number(valuePairMatch[2]);
    if (name && name.length <= 8 && Number.isFinite(numericValue)) {
      return Number.isInteger(numericValue)
        ? encodeMakeCodeValuePacket(name, numericValue)
        : encodeMakeCodeDoubleValuePacket(name, numericValue);
    }
  }

  return encodeMakeCodeStringPacket(value);
}

function encodeMakeCodeNumberPacket(value: number): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 0;
  const view = new DataView(packet.buffer);
  view.setInt32(9, value, true);
  return packet;
}

function encodeMakeCodeDoublePacket(value: number): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 4;
  const view = new DataView(packet.buffer);
  view.setFloat64(9, value, true);
  return packet;
}

function encodeMakeCodeValuePacket(name: string, value: number): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 1;
  const view = new DataView(packet.buffer);
  view.setInt32(9, value, true);
  const encodedName = new TextEncoder().encode(name.slice(0, 8));
  packet[13] = encodedName.length;
  packet.set(encodedName, 14);
  return packet;
}

function encodeMakeCodeDoubleValuePacket(name: string, value: number): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 5;
  const view = new DataView(packet.buffer);
  view.setFloat64(9, value, true);
  const encodedName = new TextEncoder().encode(name.slice(0, 8));
  packet[17] = encodedName.length;
  packet.set(encodedName, 18);
  return packet;
}

function encodeMakeCodeStringPacket(value: string): Uint8Array {
  const packet = new Uint8Array(32);
  packet[0] = 2;
  const encoded = new TextEncoder().encode(value);
  const length = Math.min(encoded.length, 19);
  packet[9] = length;
  packet.set(encoded.slice(0, length), 10);
  return packet;
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
    case 'sound-output':
      return 'snd';
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
  program?: RuntimeProgram;
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
        program: extracted.program,
      };
    }
    return { runtimeSource: extracted.runtimeSource, program: extracted.program };
  } catch (error) {
    return {
      runtimeSource: 'unknown',
      issue: {
        severity: 'warning',
        message:
          error instanceof Error
            ? `Assigned as non-executable because runtime source extraction failed: ${error.message}`
            : 'Assigned as non-executable because runtime source extraction failed',
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
    const targetDevice = project.devices.find((device) => device.id === target.id);
    if (isDevicePositionLocked(targetDevice)) {
      return project;
    }
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

function defaultNewDevicePosition(existingDevices: SwarmProject['devices']): Point {
  if (existingDevices.length === 0) {
    return {
      x: canvasSize.width / 2,
      y: canvasSize.height / 2,
    };
  }

  const anchor = existingDevices[0]?.position ?? { x: canvasSize.width / 2, y: canvasSize.height / 2 };
  const slotIndex = existingDevices.length - 1;
  const ringIndex = Math.floor(slotIndex / 8);
  const angle = (slotIndex % 8) * (Math.PI / 4);
  const radius = 96 + ringIndex * 72;
  return clampPoint({
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
  });
}

function nextEnvironmentSourceNumber(
  environmentSources: SwarmProject['environmentSources'],
  type?: EnvironmentSource['type'],
): number {
  const maxSuffix = environmentSources.reduce((max, source) => {
    if (type && source.type !== type) {
      return max;
    }
    const suffix = source.id.slice(source.type.length + 1);
    const numericSuffix = /^\d+$/.test(suffix) ? Number(suffix) : 0;
    return Math.max(max, numericSuffix);
  }, 0);
  return maxSuffix + 1;
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

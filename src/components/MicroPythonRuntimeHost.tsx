import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceId, SwarmProject } from '../domain/project';
import { MicroPythonIframeRuntimeAdapter } from '../runtime/micropythonIframeAdapter';
import { normalizeRuntimeDisplayPixels } from '../runtime/displayPixels';
import {
  deliverRuntimeRadioPacket,
  registerRuntimeRadioSink,
} from '../runtime/radioDeliveryRegistry';
import {
  loadProjectRuntimePrograms,
  type DeviceProgramLoadResult,
  type LoadProjectRuntimeProgramsOptions,
  type PreparedDeviceRuntimeProgram,
} from '../runtime/programLoader';
import type { RuntimeHostState, RuntimeResetRequest } from './runtimeHostControls';
import type {
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeDataLogEvent,
  RuntimeProgram,
  RuntimeRadioPacket,
} from '../runtime/runtimeAdapter';
import type { DeviceRuntimeState } from '../simulation/simulationEngine';

export const MICRO_PYTHON_SIMULATOR_URL =
  new URL(
    '/micropython-patched-simulator.html?color=%23b7ff4a',
    globalThis.location?.origin ?? 'http://localhost',
  ).toString();
const MICRO_PYTHON_SIMULATOR_ORIGIN = new URL(MICRO_PYTHON_SIMULATOR_URL).origin;
const ENABLE_RADIO_DEBUG_LOGS = import.meta.env.DEV;
const MICRO_PYTHON_DISPLAY_COALESCE_WINDOW_MS = 24;

type RuntimeLoadPrograms = (
  project: SwarmProject,
  options: LoadProjectRuntimeProgramsOptions,
) => Promise<DeviceProgramLoadResult[]>;
type RuntimeRadioConfigHint = Partial<
  Pick<DeviceRuntimeState['radio'], 'group' | 'channel' | 'signalStrength'>
>;

export interface RoutedRadioDelivery {
  recipientId: DeviceId;
  packet: RuntimeRadioPacket;
}

export interface MicroPythonRuntimeHostProps {
  project: SwarmProject;
  selectedDeviceId?: DeviceId;
  resetRequest?: RuntimeResetRequest;
  deviceRuntimeStates?: Record<DeviceId, DeviceRuntimeState>;
  scenarioResetSignal?: number;
  autoPrepare?: boolean;
  prepareEnabled?: boolean;
  showSimulatorFrames?: boolean;
  showHostCard?: boolean;
  headless?: boolean;
  onRadioPacket: (deviceId: DeviceId, packet: RuntimeRadioPacket) => RoutedRadioDelivery[];
  onRuntimeLog: (
    deviceId: DeviceId,
    type: Extract<RuntimeAdapterEvent['type'], 'serial-output' | 'internal-error'>,
    message: string,
  ) => void;
  onDisplayChange?: (deviceId: DeviceId, pixels: number[]) => void;
  onSoundOutput?: (deviceId: DeviceId, level: number) => void;
  onRadioConfigHint?: (
    deviceId: DeviceId,
    config: RuntimeRadioConfigHint,
  ) => void;
  onRuntimeDataLog?: (deviceId: DeviceId, event: RuntimeDataLogEvent) => void;
  onLoadResultsChange?: (results: DeviceProgramLoadResult[]) => void;
  onRuntimeHostStateChange?: (state: RuntimeHostState) => void;
  loadPrograms?: RuntimeLoadPrograms;
  createAdapter?: (
    prepared: PreparedDeviceRuntimeProgram,
    frameWindow: Window,
    ready: boolean,
  ) => MicrobitRuntimeAdapter;
}

export function MicroPythonRuntimeHost({
  project,
  selectedDeviceId,
  resetRequest,
  deviceRuntimeStates,
  scenarioResetSignal = 0,
  autoPrepare = false,
  prepareEnabled = true,
  showSimulatorFrames = true,
  showHostCard = true,
  headless = false,
  onRadioPacket,
  onRuntimeLog,
  onDisplayChange,
  onSoundOutput,
  onRadioConfigHint,
  onRuntimeDataLog,
  onLoadResultsChange,
  onRuntimeHostStateChange,
  loadPrograms = loadProjectRuntimePrograms,
  createAdapter,
}: MicroPythonRuntimeHostProps) {
  const [loadResults, setLoadResults] = useState<DeviceProgramLoadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const frames = useRef(new Map<DeviceId, HTMLIFrameElement>());
  const adapters = useRef(new Map<DeviceId, MicrobitRuntimeAdapter>());
  const adapterArtifactIds = useRef(new Map<DeviceId, string>());
  const adapterUnsubscribes = useRef(new Map<DeviceId, () => void>());
  const adapterRadioSinkUnsubscribes = useRef(new Map<DeviceId, () => void>());
  const lastSensorValues = useRef(new Map<DeviceId, string>());
  const lastButtonValues = useRef(new Map<DeviceId, string>());
  const recentRadioPackets = useRef(new Map<DeviceId, string>());
  const recentSerialOutputs = useRef(new Map<DeviceId, string>());
  const sourceRadioConfigHints = useRef(new Map<DeviceId, RuntimeRadioConfigHint>());
  const scenarioResetRef = useRef(scenarioResetSignal);
  const loadRequestId = useRef(0);
  const callbacks = useRef({
    onRadioPacket,
    onRuntimeLog,
    onDisplayChange,
    onSoundOutput,
    onRadioConfigHint,
    onRuntimeDataLog,
  });
  const [readyDeviceIds, setReadyDeviceIds] = useState<Set<DeviceId>>(() => new Set());
  const invalidDisplayFrameLogged = useRef(new Set<DeviceId>());
  const lastResetRequestNonce = useRef(0);
  const activeDeviceIds = useRef(new Set<DeviceId>());

  useEffect(() => {
    onLoadResultsChange?.(loadResults);
  }, [loadResults, onLoadResultsChange]);

  useEffect(() => {
    callbacks.current = {
      onRadioPacket,
      onRuntimeLog,
      onDisplayChange,
      onSoundOutput,
      onRadioConfigHint,
      onRuntimeDataLog,
    };
  }, [onRadioPacket, onRuntimeLog, onDisplayChange, onSoundOutput, onRadioConfigHint, onRuntimeDataLog]);

  useEffect(
    () =>
      () =>
        disposeAdapters(
          adapters.current,
          adapterUnsubscribes.current,
          adapterRadioSinkUnsubscribes.current,
          adapterArtifactIds.current,
        ),
    [],
  );

  const devices = useMemo(
    () =>
      project.devices.filter((device) => {
        const artifact = project.artifacts.find((candidate) => candidate.id === device.programArtifactId);
        return artifact?.runtimeSource === 'micropython';
      }),
    [project],
  );
  activeDeviceIds.current = new Set(devices.map((device) => device.id));

  const selectedRuntimeDevice = devices.find((device) => device.id === selectedDeviceId);
  const deferFlashUntilRequest = headless;

  const createRuntimeAdapter = useCallback(
    (prepared: PreparedDeviceRuntimeProgram, frameWindow: Window, ready: boolean): MicrobitRuntimeAdapter =>
      createAdapter?.(prepared, frameWindow, ready) ??
      createMicroPythonIframeAdapter(prepared, frameWindow, ready, {
        deferFlashUntilRequest,
      }),
    [createAdapter, deferFlashUntilRequest],
  );

  useEffect(() => {
    loadRequestId.current += 1;
    setIsLoading(false);
    const activeArtifactIds = new Map(devices.map((device) => [device.id, device.programArtifactId]));
    for (const [deviceId, adapter] of adapters.current.entries()) {
      const activeArtifactId = activeArtifactIds.get(deviceId);
      if (!activeArtifactId || adapterArtifactIds.current.get(deviceId) !== activeArtifactId) {
        disposeAdapterForDevice(
          adapters.current,
          adapterUnsubscribes.current,
          adapterRadioSinkUnsubscribes.current,
          adapterArtifactIds.current,
          deviceId,
          adapter,
        );
        sourceRadioConfigHints.current.delete(deviceId);
        lastSensorValues.current.delete(deviceId);
        lastButtonValues.current.delete(deviceId);
        recentRadioPackets.current.delete(deviceId);
        recentSerialOutputs.current.delete(deviceId);
        invalidDisplayFrameLogged.current.delete(deviceId);
      }
    }
    setReadyDeviceIds((current) => {
      const activeDeviceIds = new Set(activeArtifactIds.keys());
      const next = new Set([...current].filter((deviceId) => activeDeviceIds.has(deviceId)));
      return next.size === current.size ? current : next;
    });
    setLoadResults((current) =>
      current.filter((result) => activeArtifactIds.get(result.deviceId) === result.artifactId),
    );
  }, [devices]);

  useEffect(() => {
    if (!deviceRuntimeStates) {
      return;
    }

    for (const [deviceId, adapter] of adapters.current.entries()) {
      const runtime = deviceRuntimeStates[deviceId];
      if (!runtime) {
        continue;
      }

      const sensorKey = `${runtime.sensors.lightLevel}:${runtime.sensors.soundLevel}`;
      if (lastSensorValues.current.get(deviceId) === sensorKey) {
        continue;
      }

      lastSensorValues.current.set(deviceId, sensorKey);
      void Promise.all([
        adapter.setSensor('lightLevel', runtime.sensors.lightLevel),
        adapter.setSensor('soundLevel', runtime.sensors.soundLevel),
      ]).catch((error: unknown) => {
        callbacks.current.onRuntimeLog(
          deviceId,
          'internal-error',
          error instanceof Error ? error.message : 'Unable to update MicroPython simulator sensors',
        );
      });
    }
  }, [deviceRuntimeStates, loadResults]);

  useEffect(() => {
    if (!deviceRuntimeStates) {
      return;
    }

    for (const [deviceId, adapter] of adapters.current.entries()) {
      const runtime = deviceRuntimeStates[deviceId];
      if (!runtime) {
        continue;
      }

      const buttonKey = `${runtime.buttons.A}:${runtime.buttons.B}`;
      if (lastButtonValues.current.get(deviceId) === buttonKey) {
        continue;
      }

      lastButtonValues.current.set(deviceId, buttonKey);
      void Promise.all([
        adapter.setButton('A', runtime.buttons.A),
        adapter.setButton('B', runtime.buttons.B),
      ]).catch((error: unknown) => {
        callbacks.current.onRuntimeLog(
          deviceId,
          'internal-error',
          error instanceof Error ? error.message : 'Unable to update MicroPython simulator buttons',
        );
      });
    }
  }, [deviceRuntimeStates, loadResults]);

  useEffect(() => {
    if (scenarioResetRef.current === scenarioResetSignal) {
      return;
    }

    scenarioResetRef.current = scenarioResetSignal;
    resetRuntimeAdapters([...adapters.current.keys()], 'scenario reset');
  }, [scenarioResetSignal]);

  useEffect(() => {
    if (!resetRequest || resetRequest.nonce === lastResetRequestNonce.current) {
      return;
    }

    lastResetRequestNonce.current = resetRequest.nonce;
    resetRuntimeAdapters(resetRequest.deviceIds, resetRequest.actionLabel);
  }, [resetRequest]);

  useEffect(() => {
    function handleReadyMessage(event: MessageEvent) {
      if (event.origin !== MICRO_PYTHON_SIMULATOR_ORIGIN) {
        return;
      }

      const data = event.data;
      if (!isRecord(data) || data.kind !== 'ready') {
        return;
      }

      let readyDeviceId: DeviceId | undefined;
      for (const [deviceId, frame] of frames.current.entries()) {
        if (frame.contentWindow === event.source) {
          readyDeviceId = deviceId;
          break;
        }
      }
      if (!readyDeviceId) {
        return;
      }

      debugMicroPythonRuntime('simulator-ready', { deviceId: readyDeviceId });
      setReadyDeviceIds((current) => {
        if (current.has(readyDeviceId)) {
          return current;
        }
        return new Set([...current, readyDeviceId]);
      });
    }

    window.addEventListener('message', handleReadyMessage);
    return () => window.removeEventListener('message', handleReadyMessage);
  }, []);

  const setFrame = useCallback((deviceId: DeviceId, frame: HTMLIFrameElement | null) => {
    if (frame) {
      const previousFrame = frames.current.get(deviceId);
      if (previousFrame === frame) {
        return;
      }
      const previousWindow = previousFrame?.contentWindow;
      const nextWindow = frame.contentWindow;
      frames.current.set(deviceId, frame);
      if (previousWindow && nextWindow && previousWindow !== nextWindow) {
        setReadyDeviceIds((current) => {
          if (!current.has(deviceId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(deviceId);
          return next;
        });
      }
      setFrameVersion((current) => current + 1);
    } else if (frames.current.has(deviceId)) {
      if (activeDeviceIds.current.has(deviceId)) {
        // React ref callback identity churn can temporarily report null before reattaching.
        return;
      }
      frames.current.delete(deviceId);
      setReadyDeviceIds((current) => {
        if (!current.has(deviceId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
      setFrameVersion((current) => current + 1);
    }
  }, []);

  const frameRefs = useMemo(
    () => new Map(devices.map((device) => [device.id, (frame: HTMLIFrameElement | null) => setFrame(device.id, frame)])),
    [devices, setFrame],
  );

  async function loadRuntimes(targetDevices: SwarmProject['devices']) {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setIsLoading(true);
    for (const device of targetDevices) {
      disposeAdapterForDevice(
        adapters.current,
        adapterUnsubscribes.current,
        adapterRadioSinkUnsubscribes.current,
        adapterArtifactIds.current,
        device.id,
      );
      sourceRadioConfigHints.current.delete(device.id);
      lastSensorValues.current.delete(device.id);
      lastButtonValues.current.delete(device.id);
      recentRadioPackets.current.delete(device.id);
      recentSerialOutputs.current.delete(device.id);
      invalidDisplayFrameLogged.current.delete(device.id);
    }
    const requestAdapters: { deviceId: DeviceId; adapter: MicrobitRuntimeAdapter }[] = [];

    try {
      const results = normalizeDeferredFlashResults(
        await loadPrograms(makeRuntimeProject(project, targetDevices), {
          createAdapter: (prepared) => {
            if (prepared.runtimeSource !== 'micropython') {
              return undefined;
            }

            const frameWindow = frames.current.get(prepared.device.id)?.contentWindow;
            if (!frameWindow) {
              throw new Error(`Simulator iframe is not ready for ${prepared.device.name}`);
            }
            if (loadRequestId.current !== requestId) {
              return undefined;
            }

            const adapter = createRuntimeAdapter(
              prepared,
              frameWindow,
              readyDeviceIds.has(prepared.device.id),
            );
            debugMicroPythonRuntime('adapter-created', {
              requestId,
              deviceId: prepared.device.id,
              deferFlashUntilRequest,
              frameReady: readyDeviceIds.has(prepared.device.id),
            });
            const radioConfigHint = extractMicroPythonRadioConfig(prepared.program);
            if (hasRuntimeRadioConfigHint(radioConfigHint)) {
              sourceRadioConfigHints.current.set(prepared.device.id, radioConfigHint);
              callbacks.current.onRadioConfigHint?.(prepared.device.id, radioConfigHint);
            } else {
              sourceRadioConfigHints.current.delete(prepared.device.id);
            }
            adapters.current.set(prepared.device.id, adapter);
            requestAdapters.push({ deviceId: prepared.device.id, adapter });
            adapterArtifactIds.current.set(prepared.device.id, prepared.artifact.id);
            adapterRadioSinkUnsubscribes.current.get(prepared.device.id)?.();
            adapterRadioSinkUnsubscribes.current.set(
              prepared.device.id,
              registerRuntimeRadioSink(prepared.device.id, (packet) => adapter.sendRadio(packet)),
            );
            adapterUnsubscribes.current.set(
              prepared.device.id,
              adapter.onEvent((event) => handleRuntimeEvent(prepared.device.id, event)),
            );
            return adapter;
          },
        }),
        deferFlashUntilRequest,
      );
      if (loadRequestId.current !== requestId) {
        disposeRequestAdapters(
          requestAdapters,
          adapters.current,
          adapterUnsubscribes.current,
          adapterRadioSinkUnsubscribes.current,
          adapterArtifactIds.current,
        );
        return;
      }

      const resultDeviceIds = new Set(results.map((result) => result.deviceId));
      debugMicroPythonRuntime('load-results', {
        requestId,
        devices: targetDevices.map((device) => device.id),
        results: results.map((result) => ({
          deviceId: result.deviceId,
          status: result.status,
          runtimeSource: result.runtimeSource,
          diagnostic: result.diagnostic,
        })),
      });
      setLoadResults((current) => [
        ...current.filter((result) => !resultDeviceIds.has(result.deviceId)),
        ...results,
      ]);
    } catch (error) {
      if (loadRequestId.current !== requestId) {
        disposeRequestAdapters(
          requestAdapters,
          adapters.current,
          adapterUnsubscribes.current,
          adapterRadioSinkUnsubscribes.current,
          adapterArtifactIds.current,
        );
        return;
      }
      const diagnostic = error instanceof Error ? error.message : 'Unable to load MicroPython runtimes';
      debugMicroPythonRuntime('load-failed', {
        requestId,
        devices: targetDevices.map((device) => device.id),
        diagnostic,
      });
      const results: DeviceProgramLoadResult[] = targetDevices.map((device) => ({
        deviceId: device.id,
        artifactId: device.programArtifactId,
        status: 'failed',
        runtimeSource: 'micropython',
        diagnostic,
      }));
      const resultDeviceIds = new Set(results.map((result) => result.deviceId));
      setLoadResults((current) => [
        ...current.filter((result) => !resultDeviceIds.has(result.deviceId)),
        ...results,
      ]);
    } finally {
      if (loadRequestId.current === requestId) {
        setIsLoading(false);
      }
    }
  }

  function resetRuntimeAdapters(deviceIds: DeviceId[], actionLabel: string) {
    void Promise.all(
      deviceIds.map(async (deviceId) => {
        const adapter = adapters.current.get(deviceId);
        if (!adapter) {
          return;
        }
        invalidDisplayFrameLogged.current.delete(deviceId);
        recentRadioPackets.current.delete(deviceId);
        recentSerialOutputs.current.delete(deviceId);
        await adapter.reset();
        const sourceRadioConfigHint = sourceRadioConfigHints.current.get(deviceId);
        if (sourceRadioConfigHint && hasRuntimeRadioConfigHint(sourceRadioConfigHint)) {
          callbacks.current.onRadioConfigHint?.(deviceId, sourceRadioConfigHint);
        }
      }),
    ).catch((error: unknown) => {
      callbacks.current.onRuntimeLog(
        deviceIds[0] ?? 'runtime',
        'internal-error',
        error instanceof Error ? error.message : `Unable to complete ${actionLabel}`,
      );
    });
  }

  function handleRuntimeEvent(deviceId: DeviceId, event: RuntimeAdapterEvent) {
    switch (event.type) {
      case 'radio-output': {
        if (isDuplicateRecentRadioPacket(recentRadioPackets.current, deviceId, event.packet)) {
          break;
        }
        const runtimeRadioConfig = runtimeRadioConfigFromPacket(event.packet);
        if (
          runtimeRadioConfig.group !== undefined ||
          runtimeRadioConfig.channel !== undefined ||
          runtimeRadioConfig.signalStrength !== undefined
        ) {
          callbacks.current.onRadioConfigHint?.(deviceId, runtimeRadioConfig);
        }
        const deliveries = callbacks.current.onRadioPacket(deviceId, event.packet);
        void Promise.all(
          deliveries.map(({ recipientId, packet }) =>
            deliverRuntimeRadioPacket(recipientId, packet),
          ),
        ).catch((error: unknown) => {
          callbacks.current.onRuntimeLog(
            deviceId,
            'internal-error',
            error instanceof Error ? error.message : 'Unable to deliver runtime radio packet',
          );
        });
        break;
      }
      case 'radio-config-change':
        callbacks.current.onRadioConfigHint?.(deviceId, event.config);
        break;
      case 'serial-output':
        if (isDuplicateRecentSerialOutput(recentSerialOutputs.current, deviceId, event.data)) {
          break;
        }
        if (event.data.trim() === '') {
          break;
        }
        callbacks.current.onRuntimeLog(deviceId, 'serial-output', event.data);
        break;
      case 'internal-error':
        callbacks.current.onRuntimeLog(deviceId, 'internal-error', event.error.message);
        break;
      case 'display-change':
        {
          const normalized = normalizeRuntimeDisplayPixels(event.pixels);
          if (!normalized) {
            if (!invalidDisplayFrameLogged.current.has(deviceId)) {
              callbacks.current.onRuntimeLog(
                deviceId,
                'internal-error',
                'MicroPython runtime emitted invalid LED data',
              );
              invalidDisplayFrameLogged.current.add(deviceId);
            }
            break;
          }
          invalidDisplayFrameLogged.current.delete(deviceId);
          callbacks.current.onDisplayChange?.(deviceId, normalized);
        }
        break;
      case 'sound-output':
        debugMicroPythonRuntime('runtime-sound-output', {
          deviceId,
          level: event.level,
        });
        callbacks.current.onSoundOutput?.(deviceId, event.level);
        break;
      case 'data-log-output':
      case 'data-log-delete':
        callbacks.current.onRuntimeDataLog?.(deviceId, event);
        break;
    }
  }

  const readyFrames = devices.filter((device) => readyDeviceIds.has(device.id)).length;
  const allFramesReady = devices.length > 0 && readyFrames === devices.length;
  const selectedFrameReady = selectedRuntimeDevice ? readyDeviceIds.has(selectedRuntimeDevice.id) : false;
  const preparedDeviceIds = new Set(adapters.current.keys());
  const selectedPrepared = selectedDeviceId ? preparedDeviceIds.has(selectedDeviceId) : false;
  const hasPreparedRuntime = preparedDeviceIds.size > 0;
  const canPrepareSelected = Boolean(selectedRuntimeDevice && selectedFrameReady);
  const showPrepareSelected = Boolean(selectedRuntimeDevice && devices.length > 1);

  useEffect(() => {
    onRuntimeHostStateChange?.({
      allFramesReady,
      isLoading,
    });
  }, [allFramesReady, isLoading, onRuntimeHostStateChange]);

  useEffect(() => {
    if (!autoPrepare || !prepareEnabled || isLoading || devices.length === 0 || !allFramesReady) {
      return;
    }

    const needsPrepare = devices.some((device) => {
      if (!device.programArtifactId) {
        return false;
      }
      return adapterArtifactIds.current.get(device.id) !== device.programArtifactId;
    });
    if (!needsPrepare) {
      return;
    }

    void loadRuntimes(devices);
  }, [autoPrepare, prepareEnabled, devices, allFramesReady, isLoading]);

  const hostCardVisible = !headless && showHostCard;
  const frameGridClassName =
    hostCardVisible && showSimulatorFrames
      ? 'runtime-frame-grid'
      : 'runtime-frame-grid runtime-frame-grid--hidden';
  const frameCardClassName =
    hostCardVisible && showSimulatorFrames
      ? 'runtime-frame-card'
      : 'runtime-frame-card runtime-frame-card--hidden';

  return (
    <div
      className={hostCardVisible ? 'runtime-host-card' : 'runtime-host-mount runtime-host-mount--hidden'}
      aria-label={hostCardVisible ? 'MicroPython runtime host' : undefined}
    >
      <div hidden={!hostCardVisible}>
        <span className="metric-label">MicroPython runtime host</span>
        <strong>
          {devices.length === 0
            ? 'No MicroPython runtime'
            : `${readyFrames}/${devices.length} simulator(s) ready`}
        </strong>
        <p className="hint">
          {deferFlashUntilRequest
            ? 'Prepared code is sent when the simulator frame asks for it. Press Play in the frame after preparing the runtime.'
            : 'Prepared code auto-starts after the runtime is loaded.'}
        </p>
      </div>
      <div className="runtime-host-actions" hidden={!hostCardVisible}>
        {autoPrepare ? (
          <button
            type="button"
            onClick={() => loadRuntimes(devices)}
            disabled={isLoading || !allFramesReady}
          >
            {isLoading ? 'Loading runtimes...' : devices.length <= 1 ? 'Reload runtime' : 'Reload all'}
          </button>
        ) : (
          <>
            {showPrepareSelected && selectedRuntimeDevice ? (
              <button
                type="button"
                onClick={() => loadRuntimes([selectedRuntimeDevice])}
                disabled={isLoading || !canPrepareSelected}
              >
                {isLoading ? 'Preparing runtime...' : 'Prepare selected'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => loadRuntimes(devices)}
              disabled={isLoading || !allFramesReady}
            >
              {isLoading ? 'Preparing runtimes...' : devices.length <= 1 ? 'Prepare runtime' : 'Prepare all'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => selectedDeviceId && resetRuntimeAdapters([selectedDeviceId], 'device reset')}
          disabled={!selectedPrepared}
        >
          Reset selected runtime
        </button>
        <button
          type="button"
          onClick={() => resetRuntimeAdapters([...preparedDeviceIds], 'runtime reset')}
          disabled={!hasPreparedRuntime}
        >
          Reset all runtimes
        </button>
      </div>
      <div className={frameGridClassName} data-frame-version={frameVersion}>
        {devices.map((device) => (
          <article key={device.id} className={frameCardClassName}>
            <div className="runtime-frame-card__header">
              <strong>{device.name}</strong>
              <span>{preparedDeviceIds.has(device.id) ? 'prepared' : readyDeviceIds.has(device.id) ? 'ready' : 'loading'}</span>
            </div>
            <iframe
              ref={frameRefs.get(device.id)}
              title={`MicroPython simulator for ${device.name}`}
              src={MICRO_PYTHON_SIMULATOR_URL}
              sandbox="allow-scripts allow-same-origin"
              scrolling="no"
            />
          </article>
        ))}
      </div>
      {hostCardVisible && loadResults.length > 0 ? (
        <div className="runtime-load-list" aria-label="Runtime load results">
          {loadResults.map((result) => (
            <p key={result.deviceId}>
              <strong data-state={result.status}>{result.status}</strong> {result.deviceId}
              {result.diagnostic ? ` — ${result.diagnostic}` : ''}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function makeRuntimeProject(project: SwarmProject, devices: SwarmProject['devices']): SwarmProject {
  const artifactIds = new Set(devices.map((device) => device.programArtifactId).filter(Boolean));
  return {
    ...project,
    devices,
    artifacts: project.artifacts.filter((artifact) => artifactIds.has(artifact.id)),
  };
}

function createMicroPythonIframeAdapter(
  prepared: PreparedDeviceRuntimeProgram,
  frameWindow: Window,
  ready: boolean,
  options?: {
    deferFlashUntilRequest?: boolean;
  },
): MicrobitRuntimeAdapter {
  return new MicroPythonIframeRuntimeAdapter({
    targetWindow: frameWindow,
    targetOrigin: MICRO_PYTHON_SIMULATOR_URL,
    eventTarget: window,
    messageSource: frameWindow,
    initialReady: ready,
    deferFlashUntilRequest: options?.deferFlashUntilRequest ?? false,
    displayCoalesceWindowMs: MICRO_PYTHON_DISPLAY_COALESCE_WINDOW_MS,
    name: `MicroPython iframe for ${prepared.device.name}`,
  });
}

function normalizeDeferredFlashResults(
  results: DeviceProgramLoadResult[],
  deferFlashUntilRequest: boolean,
): DeviceProgramLoadResult[] {
  if (!deferFlashUntilRequest) {
    return results;
  }
  return results.map((result) =>
    result.status === 'loaded'
      ? {
          ...result,
          status: 'prepared',
          diagnostic: 'Prepared; press Play in the simulator frame to start.',
        }
      : result,
  );
}

function disposeAdapters(
  adapters: Map<DeviceId, MicrobitRuntimeAdapter>,
  unsubscribes: Map<DeviceId, () => void>,
  radioSinkUnsubscribes: Map<DeviceId, () => void>,
  artifactIds: Map<DeviceId, string>,
): void {
  for (const unsubscribe of unsubscribes.values()) {
    unsubscribe();
  }
  unsubscribes.clear();
  for (const unsubscribe of radioSinkUnsubscribes.values()) {
    unsubscribe();
  }
  radioSinkUnsubscribes.clear();

  for (const adapter of adapters.values()) {
    if ('dispose' in adapter && typeof adapter.dispose === 'function') {
      adapter.dispose();
    }
  }
  adapters.clear();
  artifactIds.clear();
}

function disposeRequestAdapters(
  requestAdapters: { deviceId: DeviceId; adapter: MicrobitRuntimeAdapter }[],
  adapters: Map<DeviceId, MicrobitRuntimeAdapter>,
  unsubscribes: Map<DeviceId, () => void>,
  radioSinkUnsubscribes: Map<DeviceId, () => void>,
  artifactIds: Map<DeviceId, string>,
): void {
  for (const { deviceId, adapter } of requestAdapters) {
    disposeAdapterForDevice(
      adapters,
      unsubscribes,
      radioSinkUnsubscribes,
      artifactIds,
      deviceId,
      adapter,
    );
  }
}

function disposeAdapterForDevice(
  adapters: Map<DeviceId, MicrobitRuntimeAdapter>,
  unsubscribes: Map<DeviceId, () => void>,
  radioSinkUnsubscribes: Map<DeviceId, () => void>,
  artifactIds: Map<DeviceId, string>,
  deviceId: DeviceId,
  expectedAdapter?: MicrobitRuntimeAdapter,
): void {
  const adapter = adapters.get(deviceId);
  if (!adapter || (expectedAdapter && adapter !== expectedAdapter)) {
    return;
  }

  unsubscribes.get(deviceId)?.();
  unsubscribes.delete(deviceId);
  radioSinkUnsubscribes.get(deviceId)?.();
  radioSinkUnsubscribes.delete(deviceId);
  if ('dispose' in adapter && typeof adapter.dispose === 'function') {
    adapter.dispose();
  }
  adapters.delete(deviceId);
  artifactIds.delete(deviceId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function debugMicroPythonRuntime(event: string, details: Record<string, unknown>): void {
  if (!ENABLE_RADIO_DEBUG_LOGS) {
    return;
  }
  console.debug('[swarm-radio-debug]', `micropython-host:${event}`, details);
}

function extractMicroPythonRadioConfig(
  program: RuntimeProgram,
): RuntimeRadioConfigHint {
  if (program.source !== 'micropython') {
    return {};
  }

  const mainPy = program.filesystem['main.py'];
  if (!mainPy) {
    return {};
  }

  const source = new TextDecoder().decode(mainPy);
  const configArgs = source.match(/radio\.config\(([^)]*)\)/)?.[1];
  if (!configArgs) {
    return {};
  }

  const parsed: Partial<Pick<DeviceRuntimeState['radio'], 'group' | 'channel' | 'signalStrength'>> = {};
  const group = configArgs.match(/\bgroup\s*=\s*(\d+)\b/)?.[1];
  const channel = configArgs.match(/\bchannel\s*=\s*(\d+)\b/)?.[1];
  const signalStrength = configArgs.match(/\bpower\s*=\s*(\d+)\b/)?.[1];
  if (group) {
    parsed.group = Number.parseInt(group, 10);
  }
  if (channel) {
    parsed.channel = Number.parseInt(channel, 10);
  }
  if (signalStrength) {
    parsed.signalStrength = Number.parseInt(signalStrength, 10);
  }

  return parsed;
}

function runtimeRadioConfigFromPacket(
  packet: RuntimeRadioPacket,
): RuntimeRadioConfigHint {
  return {
    ...(packet.group === undefined ? {} : { group: packet.group }),
    ...(packet.channel === undefined ? {} : { channel: packet.channel }),
    ...(packet.signalStrength === undefined ? {} : { signalStrength: packet.signalStrength }),
  };
}

function hasRuntimeRadioConfigHint(config: RuntimeRadioConfigHint): boolean {
  return (
    config.group !== undefined ||
    config.channel !== undefined ||
    config.signalStrength !== undefined
  );
}

function isDuplicateRecentRadioPacket(
  cache: Map<DeviceId, string>,
  deviceId: DeviceId,
  packet: RuntimeRadioPacket,
): boolean {
  const fingerprint = `${packet.group ?? 'none'}:${packet.channel ?? 'none'}:${packet.signalStrength ?? 'none'}:${[...packet.data].join(',')}`;
  const previous = cache.get(deviceId);
  cache.set(deviceId, fingerprint);
  queueMicrotask(() => {
    if (cache.get(deviceId) === fingerprint) {
      cache.delete(deviceId);
    }
  });
  return previous === fingerprint;
}

function isDuplicateRecentSerialOutput(
  cache: Map<DeviceId, string>,
  deviceId: DeviceId,
  data: string,
): boolean {
  const previous = cache.get(deviceId);
  cache.set(deviceId, data);
  queueMicrotask(() => {
    if (cache.get(deviceId) === data) {
      cache.delete(deviceId);
    }
  });
  return previous === data;
}

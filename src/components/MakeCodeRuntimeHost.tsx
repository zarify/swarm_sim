import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceId, SwarmProject } from '../domain/project';
import { MakeCodeIframeRuntimeAdapter } from '../runtime/makecodeIframeRuntimeAdapter';
import {
  loadProjectRuntimePrograms,
  type DeviceProgramLoadResult,
  type LoadProjectRuntimeProgramsOptions,
  type PreparedDeviceRuntimeProgram,
} from '../runtime/programLoader';
import type { RuntimeHostState, RuntimeResetRequest } from './runtimeHostControls';
import { decompressLzmaSource } from '../runtime/lzmaDecompressor';
import { normalizeRuntimeDisplayPixels } from '../runtime/displayPixels';
import {
  deliverRuntimeRadioPacket,
  replaceRuntimeRadioSink,
} from '../runtime/radioDeliveryRegistry';
import type {
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeDataLogEvent,
  RuntimeProgram,
  RuntimeRadioPacket,
} from '../runtime/runtimeAdapter';
import type { DeviceRuntimeState } from '../simulation/simulationEngine';
import type { RoutedRadioDelivery } from './MicroPythonRuntimeHost';

type RuntimeLoadPrograms = (
  project: SwarmProject,
  options: LoadProjectRuntimeProgramsOptions,
) => Promise<DeviceProgramLoadResult[]>;
type RuntimeRadioConfigHint = Partial<
  Pick<DeviceRuntimeState['radio'], 'group' | 'channel' | 'signalStrength'>
>;
type ABPulseCapableRuntimeAdapter = MicrobitRuntimeAdapter & { pulseButtonAB: () => Promise<void> };

const MAKECODE_SIMULATOR_RUNNER_URL = '/makecode-patched-runner.html';
const ENABLE_RADIO_DEBUG_LOGS = import.meta.env.DEV;

export interface MakeCodeRuntimeHostProps {
  project: SwarmProject;
  selectedDeviceId?: DeviceId;
  resetRequest?: RuntimeResetRequest;
  deviceRuntimeStates?: Record<DeviceId, DeviceRuntimeState>;
  scenarioResetSignal?: number;
  autoPrepare?: boolean;
  prepareEnabled?: boolean;
  showHostCard?: boolean;
  showSimulatorFrames?: boolean;
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

export function MakeCodeRuntimeHost({
  project,
  selectedDeviceId,
  resetRequest,
  deviceRuntimeStates,
  scenarioResetSignal = 0,
  autoPrepare = false,
  prepareEnabled = true,
  showHostCard = true,
  showSimulatorFrames = true,
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
  createAdapter = createMakeCodeRuntimeAdapter,
}: MakeCodeRuntimeHostProps) {
  const requiresRunnerFrames = createAdapter === createMakeCodeRuntimeAdapter;
  const [loadResults, setLoadResults] = useState<DeviceProgramLoadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const [displaySnapshots, setDisplaySnapshots] = useState<Record<DeviceId, number[]>>({});
  const frames = useRef(new Map<DeviceId, HTMLIFrameElement>());
  const adapters = useRef(new Map<DeviceId, MicrobitRuntimeAdapter>());
  const adapterArtifactIds = useRef(new Map<DeviceId, string>());
  const adapterUnsubscribes = useRef(new Map<DeviceId, () => void>());
  const adapterRadioSinkUnsubscribes = useRef(new Map<DeviceId, () => void>());
  const activeDeviceIds = useRef(new Set<DeviceId>());
  const lastSensorValues = useRef(new Map<DeviceId, string>());
  const lastButtonValues = useRef(new Map<DeviceId, string>());
  const scenarioResetRef = useRef(scenarioResetSignal);
  const loadRequestId = useRef(0);
  const [readyDeviceIds, setReadyDeviceIds] = useState<Set<DeviceId>>(() => new Set());
  const invalidDisplayFrameLogged = useRef(new Set<DeviceId>());
  const recentRadioPackets = useRef(new Map<DeviceId, string>());
  const recentSerialOutputs = useRef(new Map<DeviceId, string>());
  const sourceRadioConfigHints = useRef(new Map<DeviceId, RuntimeRadioConfigHint>());
  const lastResetRequestNonce = useRef(0);
  const callbacks = useRef({
    onRadioPacket,
    onRuntimeLog,
    onDisplayChange,
    onSoundOutput,
    onRadioConfigHint,
    onRuntimeDataLog,
  });

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
        return artifact?.runtimeSource === 'makecode-pxt';
      }),
    [project],
  );
  activeDeviceIds.current = new Set(devices.map((device) => device.id));

  const selectedRuntimeDevice = devices.find((device) => device.id === selectedDeviceId);

  function syncRuntimeInputs(
    deviceId: DeviceId,
    adapter: MicrobitRuntimeAdapter,
    runtime: DeviceRuntimeState,
    force = false,
  ): Promise<void> {
    const tasks: Promise<void>[] = [];
    const sensorKey = `${runtime.sensors.lightLevel}:${runtime.sensors.soundLevel}`;
    if (force || lastSensorValues.current.get(deviceId) !== sensorKey) {
      lastSensorValues.current.set(deviceId, sensorKey);
      tasks.push(
        Promise.all([
          adapter.setSensor('lightLevel', runtime.sensors.lightLevel),
          adapter.setSensor('soundLevel', runtime.sensors.soundLevel),
        ]).then(() => undefined),
      );
    }

    const buttonKey = `${runtime.buttons.A}:${runtime.buttons.B}`;
    const previousButtonKey = lastButtonValues.current.get(deviceId);
    if (force || previousButtonKey !== buttonKey) {
      lastButtonValues.current.set(deviceId, buttonKey);
      if (!force && supportsABPulse(adapter)) {
        if (previousButtonKey === 'false:false' && buttonKey === 'true:true') {
          return tasks.length === 0 ? Promise.resolve() : Promise.all(tasks).then(() => undefined);
        }
        if (previousButtonKey === 'true:true' && buttonKey === 'false:false') {
          tasks.push(adapter.pulseButtonAB());
          return tasks.length === 0 ? Promise.resolve() : Promise.all(tasks).then(() => undefined);
        }
      }
      tasks.push(
        Promise.all([
          adapter.setButton('A', runtime.buttons.A),
          adapter.setButton('B', runtime.buttons.B),
        ]).then(() => undefined),
      );
    }

    return tasks.length === 0 ? Promise.resolve() : Promise.all(tasks).then(() => undefined);
  }

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
        invalidDisplayFrameLogged.current.delete(deviceId);
        recentRadioPackets.current.delete(deviceId);
        recentSerialOutputs.current.delete(deviceId);
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
    setDisplaySnapshots((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([deviceId]) => activeArtifactIds.has(deviceId)),
      ) as Record<DeviceId, number[]>,
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

      void syncRuntimeInputs(deviceId, adapter, runtime).catch((error: unknown) => {
        callbacks.current.onRuntimeLog(
          deviceId,
          'internal-error',
          error instanceof Error ? error.message : 'Unable to update MakeCode runtime sensors',
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

      void syncRuntimeInputs(deviceId, adapter, runtime).catch((error: unknown) => {
        callbacks.current.onRuntimeLog(
          deviceId,
          'internal-error',
          error instanceof Error ? error.message : 'Unable to update MakeCode runtime buttons',
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
    setDisplaySnapshots({});
  }, [scenarioResetSignal]);

  useEffect(() => {
    if (!resetRequest || resetRequest.nonce === lastResetRequestNonce.current) {
      return;
    }

    lastResetRequestNonce.current = resetRequest.nonce;
    resetRuntimeAdapters(resetRequest.deviceIds, resetRequest.actionLabel);
  }, [resetRequest]);

  useEffect(() => {
    function handleRunnerReady(event: MessageEvent) {
      const data = event.data;
      if (!isRecord(data) || data.type !== 'swarm-runner-ready') {
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

      debugMakeCodeRadio('runner-ready', { deviceId: readyDeviceId });
      setReadyDeviceIds((current) => {
        if (current.has(readyDeviceId)) {
          return current;
        }
        return new Set([...current, readyDeviceId]);
      });
    }

    window.addEventListener('message', handleRunnerReady);
    return () => window.removeEventListener('message', handleRunnerReady);
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
    () =>
      new Map(
        devices.map((device) => [
          device.id,
          (frame: HTMLIFrameElement | null) => setFrame(device.id, frame),
        ]),
      ),
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
      invalidDisplayFrameLogged.current.delete(device.id);
      recentRadioPackets.current.delete(device.id);
      recentSerialOutputs.current.delete(device.id);
    }

    const requestAdapters: { deviceId: DeviceId; adapter: MicrobitRuntimeAdapter }[] = [];

    try {
      const results = await loadPrograms(makeRuntimeProject(project, targetDevices), {
        decompressLzma: decompressLzmaSource,
        createAdapter: (prepared) => {
          if (prepared.runtimeSource !== 'makecode-pxt') {
            debugMakeCodeRadio('skip-non-makecode-runtime', {
              deviceId: prepared.device.id,
              runtimeSource: prepared.runtimeSource,
              artifactId: prepared.artifact.id,
            });
            return undefined;
          }

          if (loadRequestId.current !== requestId) {
            return undefined;
          }

          const frameWindow = frames.current.get(prepared.device.id)?.contentWindow;
          if (requiresRunnerFrames && !frameWindow) {
            throw new Error(`Simulator iframe is not ready for ${prepared.device.name}`);
          }
          if (loadRequestId.current !== requestId) {
            return undefined;
          }

          const adapter = createAdapter(
            prepared,
            frameWindow ?? window,
            readyDeviceIds.has(prepared.device.id),
          );
          const radioConfigHint = extractMakeCodeRadioConfig(prepared.program);
          if (hasRuntimeRadioConfigHint(radioConfigHint)) {
            debugMakeCodeRadio('source-hint', {
              deviceId: prepared.device.id,
              group: radioConfigHint.group,
              channel: radioConfigHint.channel,
              signalStrength: radioConfigHint.signalStrength,
            });
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
            replaceRuntimeRadioSink(prepared.device.id, (packet) => adapter.sendRadio(packet)),
          );
          adapterUnsubscribes.current.set(
            prepared.device.id,
            adapter.onEvent((event) => handleRuntimeEvent(prepared.device.id, event)),
          );
          return adapter;
        },
      });

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
      debugMakeCodeRadio('load-results', {
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

      const diagnostic = error instanceof Error ? error.message : 'Unable to load MakeCode runtimes';
      const results: DeviceProgramLoadResult[] = targetDevices.map((device) => ({
        deviceId: device.id,
        artifactId: device.programArtifactId,
        status: 'failed',
        runtimeSource: 'makecode-pxt',
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
        const runtime = deviceRuntimeStates?.[deviceId];
        await adapter.reset();
        lastSensorValues.current.delete(deviceId);
        lastButtonValues.current.delete(deviceId);
        invalidDisplayFrameLogged.current.delete(deviceId);
        recentRadioPackets.current.delete(deviceId);
        recentSerialOutputs.current.delete(deviceId);
        const sourceRadioConfigHint = sourceRadioConfigHints.current.get(deviceId);
        if (sourceRadioConfigHint && hasRuntimeRadioConfigHint(sourceRadioConfigHint)) {
          callbacks.current.onRadioConfigHint?.(deviceId, sourceRadioConfigHint);
        }
        if (runtime) {
          await syncRuntimeInputs(deviceId, adapter, runtime, true);
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

  function pulseButton(deviceId: DeviceId, button: 'A' | 'B') {
    const adapter = adapters.current.get(deviceId);
    if (!adapter) {
      return;
    }

    void (async () => {
      await adapter.setButton(button, true);
      await adapter.setButton(button, false);
    })().catch((error: unknown) => {
      callbacks.current.onRuntimeLog(
        deviceId,
        'internal-error',
        error instanceof Error ? error.message : `Unable to apply button ${button} input`,
      );
    });
  }

  function pulseButtonAB(deviceId: DeviceId) {
    const adapter = adapters.current.get(deviceId);
    if (!adapter) {
      return;
    }

    void (async () => {
      if (supportsABPulse(adapter)) {
        await adapter.pulseButtonAB();
        return;
      }
      await adapter.setButton('A', true);
      await adapter.setButton('B', true);
      await adapter.setButton('B', false);
      await adapter.setButton('A', false);
    })().catch((error: unknown) => {
      callbacks.current.onRuntimeLog(
        deviceId,
        'internal-error',
        error instanceof Error ? error.message : 'Unable to apply button AB input',
      );
    });
  }

  function handleRuntimeEvent(deviceId: DeviceId, event: RuntimeAdapterEvent) {
    switch (event.type) {
      case 'radio-output': {
        if (isDuplicateRecentRadioPacket(recentRadioPackets.current, deviceId, event.packet)) {
          debugMakeCodeRadio('dedupe-tx-packet', {
            deviceId,
            bytes: event.packet.data.byteLength,
            preview: [...event.packet.data.slice(0, 8)],
            packetGroup: event.packet.group,
            packetChannel: event.packet.channel,
            packetSignalStrength: event.packet.signalStrength,
          });
          break;
        }
        const runtimeRadioConfig = runtimeRadioConfigFromPacket(event.packet);
        debugMakeCodeRadio('tx-packet', {
          deviceId,
          bytes: event.packet.data.byteLength,
          preview: [...event.packet.data.slice(0, 8)],
          packetGroup: event.packet.group,
          packetChannel: event.packet.channel,
          packetSignalStrength: event.packet.signalStrength,
        });
        if (
          runtimeRadioConfig.group !== undefined ||
          runtimeRadioConfig.channel !== undefined ||
          runtimeRadioConfig.signalStrength !== undefined
        ) {
          debugMakeCodeRadio('tx-packet-config', {
            deviceId,
            group: runtimeRadioConfig.group,
            channel: runtimeRadioConfig.channel,
            signalStrength: runtimeRadioConfig.signalStrength,
          });
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
        debugMakeCodeRadio('runtime-config-change', {
          deviceId,
          group: event.config.group,
          channel: event.config.channel,
          signalStrength: event.config.signalStrength,
        });
        callbacks.current.onRadioConfigHint?.(deviceId, event.config);
        break;
      case 'serial-output':
        if (isDuplicateRecentSerialOutput(recentSerialOutputs.current, deviceId, event.data)) {
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
                'MakeCode runtime emitted invalid LED data',
              );
              invalidDisplayFrameLogged.current.add(deviceId);
            }
            return;
          }
          invalidDisplayFrameLogged.current.delete(deviceId);
          setDisplaySnapshots((current) => ({ ...current, [deviceId]: normalized }));
          callbacks.current.onDisplayChange?.(deviceId, normalized);
        }
        break;
      case 'sound-output':
        debugMakeCodeRadio('runtime-sound-output', {
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

  const preparedDeviceIds = new Set(adapters.current.keys());
  const readyFrames = devices.filter((device) => readyDeviceIds.has(device.id)).length;
  const allFramesReady =
    devices.length > 0 && (!requiresRunnerFrames || readyFrames === devices.length);
  const selectedFrameReady = selectedRuntimeDevice ? readyDeviceIds.has(selectedRuntimeDevice.id) : false;
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
      aria-label={hostCardVisible ? 'MakeCode runtime host' : undefined}
    >
      <div hidden={!hostCardVisible}>
        <span className="metric-label">MakeCode runtime host</span>
        <strong>
          {devices.length === 0 ? 'No MakeCode runtime' : `${readyFrames}/${devices.length} simulator(s) ready`}
        </strong>
        <p className="hint">
          Patched MakeCode simulator runners execute programs and receive environment-driven inputs.
        </p>
      </div>
      <div className="runtime-host-actions" hidden={!hostCardVisible}>
        {autoPrepare ? (
          <button type="button" onClick={() => loadRuntimes(devices)} disabled={isLoading || !allFramesReady}>
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
            <button type="button" onClick={() => loadRuntimes(devices)} disabled={isLoading || !allFramesReady}>
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
              <span>
                {preparedDeviceIds.has(device.id) ? 'prepared' : readyDeviceIds.has(device.id) ? 'ready' : 'loading'}
              </span>
            </div>
            <iframe
              ref={frameRefs.get(device.id)}
              title={`MakeCode simulator for ${device.name}`}
              src={MAKECODE_SIMULATOR_RUNNER_URL}
              sandbox="allow-scripts allow-same-origin"
              scrolling="no"
            />
          </article>
        ))}
      </div>
      {hostCardVisible && showSimulatorFrames ? (
        <div className="runtime-frame-grid">
          {devices.map((device) => {
            const prepared = preparedDeviceIds.has(device.id);
            const ledPixels = displaySnapshots[device.id] ?? EMPTY_LED_PIXELS;
            return (
              <article key={device.id} className="runtime-frame-card runtime-frame-card--virtual">
                <div className="runtime-frame-card__header">
                  <strong>{device.name}</strong>
                  <span>{prepared ? 'prepared' : 'standby'}</span>
                </div>
                <div className="runtime-frame-card__body runtime-frame-card__body--makecode">
                  <div className="virtual-simulator" aria-label={`MakeCode simulator for ${device.name}`}>
                    <div className="virtual-simulator__led-grid">
                      {ledPixels.map((brightness, pixelIndex) => {
                        const lit = brightness > 0;
                        return (
                          <span
                            key={pixelIndex}
                            data-runtime-led={`${device.id}:${pixelIndex}`}
                            className={lit ? 'virtual-led-pixel virtual-led-pixel--lit' : 'virtual-led-pixel'}
                            style={lit ? { opacity: 0.35 + (brightness / 9) * 0.65 } : undefined}
                          />
                        );
                      })}
                    </div>
                    <div className="virtual-simulator__button-row">
                      <button
                        type="button"
                        aria-label={`Press A for ${device.name}`}
                        onClick={() => pulseButton(device.id, 'A')}
                        disabled={!prepared}
                      >
                        A
                      </button>
                      <button
                        type="button"
                        aria-label={`Press B for ${device.name}`}
                        onClick={() => pulseButton(device.id, 'B')}
                        disabled={!prepared}
                      >
                        B
                      </button>
                      <button
                        type="button"
                        aria-label={`Press A+B for ${device.name}`}
                        onClick={() => pulseButtonAB(device.id)}
                        disabled={!prepared}
                      >
                        A+B
                      </button>
                    </div>
                  </div>
                  <p className="runtime-frame-card__note">
                    Host view of runtime I/O mirrored from the simulator.
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {hostCardVisible && loadResults.length > 0 ? (
        <div className="runtime-load-list" aria-label="MakeCode runtime load results">
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

function createMakeCodeRuntimeAdapter(
  prepared: PreparedDeviceRuntimeProgram,
  frameWindow: Window,
  ready: boolean,
): MicrobitRuntimeAdapter {
  return new MakeCodeIframeRuntimeAdapter({
    targetWindow: frameWindow,
    targetOrigin: window.location.origin,
    eventTarget: window,
    messageSource: frameWindow,
    initialReady: ready,
    name: `MakeCode iframe for ${prepared.device.name}`,
  });
}

function extractMakeCodeRadioConfig(
  program: RuntimeProgram,
): RuntimeRadioConfigHint {
  if (program.source !== 'makecode-pxt') {
    return {};
  }

  const sourceText = Object.values(program.sourceFiles ?? {}).join('\n');
  const group = sourceText.match(/radio\.setGroup\(\s*(\d+)\s*\)/)?.[1];
  const channel = sourceText.match(/radio\.setFrequencyBand\(\s*(\d+)\s*\)/)?.[1];
  const signalStrength = sourceText.match(/radio\.setTransmitPower\(\s*(\d+)\s*\)/)?.[1];

  return {
    ...(group === undefined ? {} : { group: Number.parseInt(group, 10) }),
    ...(channel === undefined ? {} : { channel: Number.parseInt(channel, 10) }),
    ...(signalStrength === undefined ? {} : { signalStrength: Number.parseInt(signalStrength, 10) }),
  };
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

function supportsABPulse(adapter: MicrobitRuntimeAdapter): adapter is ABPulseCapableRuntimeAdapter {
  return typeof adapter.pulseButtonAB === 'function';
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

function debugMakeCodeRadio(event: string, details: Record<string, unknown>): void {
  if (!ENABLE_RADIO_DEBUG_LOGS) {
    return;
  }
  console.debug('[swarm-radio-debug]', `makecode-host:${event}`, details);
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

const EMPTY_LED_PIXELS = Array.from({ length: 25 }, () => 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

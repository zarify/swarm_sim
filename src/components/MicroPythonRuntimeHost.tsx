import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceId, SwarmProject } from '../domain/project';
import { MicroPythonIframeRuntimeAdapter } from '../runtime/micropythonIframeAdapter';
import {
  loadProjectRuntimePrograms,
  type DeviceProgramLoadResult,
  type LoadProjectRuntimeProgramsOptions,
  type PreparedDeviceRuntimeProgram,
} from '../runtime/programLoader';
import type {
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeRadioPacket,
} from '../runtime/runtimeAdapter';

export const MICRO_PYTHON_SIMULATOR_URL =
  'https://python-simulator.usermbit.org/v/0.1/simulator.html?color=%23b7ff4a';

type RuntimeLoadPrograms = (
  project: SwarmProject,
  options: LoadProjectRuntimeProgramsOptions,
) => Promise<DeviceProgramLoadResult[]>;

interface MicroPythonRuntimeHostProps {
  project: SwarmProject;
  selectedDeviceId?: DeviceId;
  onRadioPacket: (deviceId: DeviceId, packet: RuntimeRadioPacket) => DeviceId[];
  onRuntimeLog: (
    deviceId: DeviceId,
    type: Extract<RuntimeAdapterEvent['type'], 'serial-output' | 'internal-error'>,
    message: string,
  ) => void;
  onLoadResultsChange?: (results: DeviceProgramLoadResult[]) => void;
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
  onRadioPacket,
  onRuntimeLog,
  onLoadResultsChange,
  loadPrograms = loadProjectRuntimePrograms,
  createAdapter = createMicroPythonIframeAdapter,
}: MicroPythonRuntimeHostProps) {
  const [loadResults, setLoadResults] = useState<DeviceProgramLoadResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const frames = useRef(new Map<DeviceId, HTMLIFrameElement>());
  const adapters = useRef(new Map<DeviceId, MicrobitRuntimeAdapter>());
  const adapterArtifactIds = useRef(new Map<DeviceId, string>());
  const adapterUnsubscribes = useRef(new Map<DeviceId, () => void>());
  const loadRequestId = useRef(0);
  const callbacks = useRef({ onRadioPacket, onRuntimeLog });
  const [readyDeviceIds, setReadyDeviceIds] = useState<Set<DeviceId>>(() => new Set());

  useEffect(() => {
    onLoadResultsChange?.(loadResults);
  }, [loadResults, onLoadResultsChange]);

  useEffect(() => {
    callbacks.current = { onRadioPacket, onRuntimeLog };
  }, [onRadioPacket, onRuntimeLog]);

  useEffect(() => () => disposeAdapters(adapters.current, adapterUnsubscribes.current, adapterArtifactIds.current), []);

  const devices = useMemo(
    () =>
      project.devices.filter((device) => {
        if (selectedDeviceId && device.id !== selectedDeviceId) {
          return false;
        }
        const artifact = project.artifacts.find(
          (candidate) => candidate.id === device.programArtifactId,
        );
        return artifact?.runtimeSource === 'micropython';
      }),
    [project, selectedDeviceId],
  );

  const runtimeProject = useMemo(
    () => ({
      ...project,
      devices,
      artifacts: project.artifacts.filter((artifact) =>
        devices.some((device) => device.programArtifactId === artifact.id),
      ),
    }),
    [devices, project],
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
          adapterArtifactIds.current,
          deviceId,
          adapter,
        );
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
    function handleReadyMessage(event: MessageEvent) {
      if (event.origin !== new URL(MICRO_PYTHON_SIMULATOR_URL).origin) {
        return;
      }

      const data = event.data;
      if (!isRecord(data) || data.kind !== 'ready') {
        return;
      }

      const readyDevice = devices.find(
        (device) => frames.current.get(device.id)?.contentWindow === event.source,
      );
      if (!readyDevice) {
        return;
      }

      setReadyDeviceIds((current) => {
        if (current.has(readyDevice.id)) {
          return current;
        }
        return new Set([...current, readyDevice.id]);
      });
    }

    window.addEventListener('message', handleReadyMessage);
    return () => window.removeEventListener('message', handleReadyMessage);
  }, [devices]);

  const setFrame = useCallback((deviceId: DeviceId, frame: HTMLIFrameElement | null) => {
    if (frame) {
      if (frames.current.get(deviceId) === frame) {
        return;
      }
      frames.current.set(deviceId, frame);
      setReadyDeviceIds((current) => {
        if (!current.has(deviceId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
      setFrameVersion((current) => current + 1);
    } else if (frames.current.has(deviceId)) {
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

  async function loadRuntimes() {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setIsLoading(true);
    disposeAdapters(adapters.current, adapterUnsubscribes.current, adapterArtifactIds.current);
    adapters.current.clear();
    adapterUnsubscribes.current.clear();
    adapterArtifactIds.current.clear();
    const requestAdapters: { deviceId: DeviceId; adapter: MicrobitRuntimeAdapter }[] = [];

    try {
      const results = normalizeDeferredFlashResults(await loadPrograms(runtimeProject, {
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

          const adapter = createAdapter(
            prepared,
            frameWindow,
            readyDeviceIds.has(prepared.device.id),
          );
          adapters.current.set(prepared.device.id, adapter);
          requestAdapters.push({ deviceId: prepared.device.id, adapter });
          adapterArtifactIds.current.set(prepared.device.id, prepared.artifact.id);
          adapterUnsubscribes.current.set(
            prepared.device.id,
            adapter.onEvent((event) => handleRuntimeEvent(prepared.device.id, event)),
          );
          return adapter;
        },
      }));
      if (loadRequestId.current !== requestId) {
        disposeRequestAdapters(requestAdapters, adapters.current, adapterUnsubscribes.current, adapterArtifactIds.current);
        return;
      }

      setLoadResults(results);
    } catch (error) {
      if (loadRequestId.current !== requestId) {
        disposeRequestAdapters(requestAdapters, adapters.current, adapterUnsubscribes.current, adapterArtifactIds.current);
        return;
      }
      const diagnostic = error instanceof Error ? error.message : 'Unable to load MicroPython runtimes';
      const results: DeviceProgramLoadResult[] = devices.map((device) => ({
        deviceId: device.id,
        artifactId: device.programArtifactId,
        status: 'failed',
        runtimeSource: 'micropython',
        diagnostic,
      }));
      setLoadResults(results);
    } finally {
      if (loadRequestId.current === requestId) {
        setIsLoading(false);
      }
    }
  }

  function handleRuntimeEvent(deviceId: DeviceId, event: RuntimeAdapterEvent) {
    switch (event.type) {
      case 'radio-output': {
        const recipients = callbacks.current.onRadioPacket(deviceId, event.packet);
        void Promise.all(
          recipients.map((recipientId) => adapters.current.get(recipientId)?.sendRadio(event.packet)),
        ).catch((error: unknown) => {
          callbacks.current.onRuntimeLog(
            deviceId,
            'internal-error',
            error instanceof Error ? error.message : 'Unable to deliver runtime radio packet',
          );
        });
        break;
      }
      case 'serial-output':
        callbacks.current.onRuntimeLog(deviceId, 'serial-output', event.data);
        break;
      case 'internal-error':
        callbacks.current.onRuntimeLog(deviceId, 'internal-error', event.error.message);
        break;
      case 'display-change':
        break;
    }
  }

  const readyFrames = devices.filter((device) => readyDeviceIds.has(device.id)).length;

  return (
    <div className="runtime-host-card" aria-label="MicroPython runtime host">
      <div>
        <span className="metric-label">MicroPython runtime host</span>
        <strong>
          {devices.length === 0
            ? 'No MicroPython runtime'
            : `${readyFrames}/${devices.length} simulator(s) ready`}
        </strong>
        <p className="hint">
          Prepared code is sent when the simulator frame asks for it. Press Play in the
          frame after preparing the runtime.
        </p>
      </div>
      <button
        type="button"
        onClick={loadRuntimes}
        disabled={isLoading || devices.length === 0 || readyFrames !== devices.length}
      >
        {isLoading ? 'Preparing runtime...' : devices.length === 1 ? 'Prepare runtime' : 'Prepare runtimes'}
      </button>
      <div className="runtime-frame-grid" data-frame-version={frameVersion}>
        {devices.map((device) => (
          <iframe
            key={device.id}
            ref={frameRefs.get(device.id)}
            title={`MicroPython simulator for ${device.name}`}
            src={MICRO_PYTHON_SIMULATOR_URL}
            sandbox="allow-scripts allow-same-origin"
            scrolling="no"
          />
        ))}
      </div>
      {loadResults.length > 0 ? (
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

function createMicroPythonIframeAdapter(
  prepared: PreparedDeviceRuntimeProgram,
  frameWindow: Window,
  ready: boolean,
): MicrobitRuntimeAdapter {
  return new MicroPythonIframeRuntimeAdapter({
    targetWindow: frameWindow,
    targetOrigin: MICRO_PYTHON_SIMULATOR_URL,
    eventTarget: window,
    messageSource: frameWindow,
    initialReady: ready,
    deferFlashUntilRequest: true,
    name: `MicroPython iframe for ${prepared.device.name}`,
  });
}

function normalizeDeferredFlashResults(results: DeviceProgramLoadResult[]): DeviceProgramLoadResult[] {
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
  artifactIds: Map<DeviceId, string>,
): void {
  for (const unsubscribe of unsubscribes.values()) {
    unsubscribe();
  }
  unsubscribes.clear();

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
  artifactIds: Map<DeviceId, string>,
): void {
  for (const { deviceId, adapter } of requestAdapters) {
    disposeAdapterForDevice(adapters, unsubscribes, artifactIds, deviceId, adapter);
  }
}

function disposeAdapterForDevice(
  adapters: Map<DeviceId, MicrobitRuntimeAdapter>,
  unsubscribes: Map<DeviceId, () => void>,
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
  if ('dispose' in adapter && typeof adapter.dispose === 'function') {
    adapter.dispose();
  }
  adapters.delete(deviceId);
  artifactIds.delete(deviceId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

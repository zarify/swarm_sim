import { useEffect, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import {
  createBlankProject,
  type DeviceId,
  type EnvironmentSource,
  type EnvironmentSourceId,
  type Point,
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
  pauseSimulation,
  reconcileSimulationProject,
  resumeSimulation,
  resetSimulation,
  routeRadioPacket,
  setDeviceButton,
  setDeviceRadioConfig,
  startSimulation,
  type DeviceRuntimeState,
  type SimulationState,
  type SimulationMode,
} from '../simulation/simulationEngine';
import type { DeviceProgramLoadResult } from '../runtime/programLoader';
import type { RuntimeRadioPacket } from '../runtime/runtimeAdapter';
import type { MicroPythonRuntimeHostProps } from './MicroPythonRuntimeHost';

type Selection =
  | { type: 'device'; id: DeviceId }
  | { type: 'source'; id: EnvironmentSourceId };

type DragTarget = Selection;

interface CanvasModel {
  project: SwarmProject;
  simulationState: SimulationState;
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
  const [displaySnapshots, setDisplaySnapshots] = useState<Record<DeviceId, number[]>>({});
  const [runtimeActivity, setRuntimeActivity] = useState<Record<DeviceId, DeviceRuntimeActivity>>({});
  const [scenarioResetSignal, setScenarioResetSignal] = useState(0);
  const [artifactUploadIssues, setArtifactUploadIssues] = useState<Record<DeviceId, ArtifactUploadIssue>>({});
  const svgRef = useRef<SVGSVGElement | null>(null);
  const modelRef = useRef(model);
  const uploadTokens = useRef(new Map<DeviceId, number>());
  const runtimeActivityTimers = useRef(new Map<string, number>());
  const displayFrameTimers = useRef(new Map<DeviceId, number>());
  const displayLastUpdateMs = useRef(new Map<DeviceId, number>());
  const buttonPulseTimers = useRef(new Map<string, number>());
  const recentRoutedPackets = useRef(new Map<DeviceId, string>());
  const pendingRadioConfigHints = useRef(
    new Map<DeviceId, Partial<Pick<DeviceRuntimeState['radio'], 'group' | 'channel'>>>(),
  );
  const nextDeviceNumber = useRef(model.project.devices.length + 1);
  const capturedPointerId = useRef<number | null>(null);
  const { project, simulationState } = model;
  const mode = simulationState.mode;
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
          if (
            (config.group === undefined || runtime.radio.group === config.group) &&
            (config.channel === undefined || runtime.radio.channel === config.channel)
          ) {
            pendingRadioConfigHints.current.delete(deviceId);
            continue;
          }
          simulationState = setDeviceRadioConfig(simulationState, deviceId, config);
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
  }, [project.devices]);

  function setSimulationMode(nextMode: SimulationMode) {
    if (nextMode === 'idle') {
      setScenarioResetSignal((current) => current + 1);
      setDisplaySnapshots({});
      setRuntimeActivity({});
      clearRuntimeActivityTimers(runtimeActivityTimers.current);
      clearDisplayFrameTimers(displayFrameTimers.current);
      clearButtonPulseTimers(buttonPulseTimers.current);
      displayLastUpdateMs.current.clear();
      recentRoutedPackets.current.clear();
    }

    setModel((current) => {
      if (nextMode === 'idle') {
        return {
          ...current,
          simulationState: resetSimulation(current.project, defaultRadioOptions),
        };
      }

      if (nextMode === 'running') {
        if (current.simulationState.mode === 'running') {
          return current;
        }

        return {
          ...current,
          simulationState:
            current.simulationState.mode === 'paused'
              ? resumeSimulation(current.simulationState)
              : startSimulation(current.simulationState),
        };
      }

      if (current.simulationState.mode !== 'running') {
        return current;
      }

      return {
        ...current,
        simulationState: pauseSimulation(current.simulationState),
      };
    });
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

  async function uploadArtifactForDevice(deviceId: DeviceId, file: File) {
    const token = (uploadTokens.current.get(deviceId) ?? 0) + 1;
    uploadTokens.current.set(deviceId, token);

    try {
      const bytes = await readHexFileBytes(file);
      if (uploadTokens.current.get(deviceId) !== token) {
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
      debugRadioPanel('artifact-runtime-source', {
        deviceId,
        filename: file.name,
        heuristicRuntimeSource: readiness.runtimeSource,
        resolvedRuntimeSource: runtimeSource,
        issue: issue?.message,
      });

      const now = new Date().toISOString();
      const artifactId = makeArtifactId(deviceId, file.name, now);
      updateProject((current) => ({
        ...current,
        updatedAt: now,
        artifacts: replaceDeviceArtifact(current, deviceId, {
          id: artifactId,
          name: file.name,
          artifactKind: readiness.artifactKind,
          runtimeSource,
          bytes,
          createdAt: now,
        }),
        devices: current.devices.map((device) =>
          device.id === deviceId ? { ...device, programArtifactId: artifactId } : device,
        ),
      }));
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
    } catch (error) {
      if (uploadTokens.current.get(deviceId) !== token) {
        return;
      }

      setArtifactUploadIssues((current) => ({
        ...current,
        [deviceId]: {
          severity: 'error',
          message: error instanceof Error ? error.message : 'Unable to upload artifact',
        },
      }));
    }
  }

  function handleRuntimeRadioPacket(deviceId: DeviceId, packet: RuntimeRadioPacket): DeviceId[] {
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
    let recipients: DeviceId[] = [];
    flushSync(() => {
      setModel((current) => {
        const senderRuntime = current.simulationState.devices[deviceId];
        const senderGroup = senderRuntime?.radio.group;
        const normalized = normalizeRuntimeRadioPacket(
          packet,
          current.simulationState.options.maxSignalStrength,
          senderGroup,
        );
        let simulationState = routeRadioPacket(current.simulationState, deviceId, normalized.packet);
        for (const diagnostic of normalized.diagnostics) {
          simulationState = appendDeviceRuntimeLog(
            simulationState,
            deviceId,
            'runtime-error',
            diagnostic,
          );
        }
        const routedEvent = simulationState.radioEvents.at(-1);
        recipients = routedEvent?.recipients ?? [];
        debugRadioPanel('route-radio-packet', {
          senderDeviceId: deviceId,
          senderRadio: senderRuntime?.radio,
          rawPacket: summarizeRadioPacket(packet),
          normalizedPacket: summarizeRadioPacket(normalized.packet),
          diagnostics: normalized.diagnostics,
          recipients,
          blocked:
            routedEvent?.blockedTargets.map((target) => ({
              deviceId: target.deviceId,
              reason: target.reason,
              targetGroup: target.targetGroup,
              targetChannel: target.targetChannel,
            })) ?? [],
        });
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    });

    return recipients;
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
    config: Partial<Pick<DeviceRuntimeState['radio'], 'group' | 'channel'>>,
  ) {
    if (config.group === undefined && config.channel === undefined) {
      return;
    }

    flushSync(() => {
      setModel((current) => {
        const runtime = current.simulationState.devices[deviceId];
        if (!runtime) {
          const existing = pendingRadioConfigHints.current.get(deviceId) ?? {};
          pendingRadioConfigHints.current.set(deviceId, { ...existing, ...config });
          debugRadioPanel('queue-radio-config-hint', { deviceId, config });
          return current;
        }

        if (
          (config.group === undefined || runtime.radio.group === config.group) &&
          (config.channel === undefined || runtime.radio.channel === config.channel)
        ) {
          return current;
        }

        const simulationState = setDeviceRadioConfig(current.simulationState, deviceId, config);
        pendingRadioConfigHints.current.delete(deviceId);
        debugRadioPanel('apply-radio-config-hint', { deviceId, config });
        const next = { ...current, simulationState };
        modelRef.current = next;
        return next;
      });
    });
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
      const project = updater(current.project);
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

  return (
    <section className="swarm-panel" aria-labelledby="swarm-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Swarm canvas</p>
          <h2 id="swarm-title">Spatial radio bench</h2>
        </div>
        <div className="control-stack" aria-label="Simulation controls">
          <button type="button" onClick={() => setSimulationMode('running')} disabled={mode === 'running'}>
            Run
          </button>
          <button type="button" onClick={() => setSimulationMode('paused')} disabled={mode !== 'running'}>
            Pause
          </button>
          <button type="button" onClick={() => setSimulationMode('idle')}>
            Reset
          </button>
        </div>
      </div>

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
              const ledPixels = displaySnapshots[device.deviceId] ?? emptyLedPixels;
              const activity = runtimeActivity[device.deviceId];
              const txActive = activity?.tx ?? false;
              const soundActive = activity?.sound ?? false;
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
                    {device.deviceId.replace('device-', '')}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <aside className="swarm-sidebar" aria-label="Canvas controls and selection details">
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
                  runtimeLoadResult={runtimeLoadResults.find(
                    (result) => result.deviceId === selectedDevice.id,
                  )}
                  deviceId={selectedDevice.id}
                  uploadIssue={artifactUploadIssues[selectedDevice.id]}
                  logs={simulationState.deviceLogs.filter((log) => log.deviceId === selectedDevice.id)}
                  onArtifactUpload={uploadArtifactForDevice}
                />
              </>
            ) : selectedSource ? (
              <SourceSelection source={selectedSource} updateSource={updateSource} />
            ) : (
              <p className="hint">Select a node or environmental source.</p>
            )}
          </div>

          <RuntimeHost
            project={project}
            selectedDeviceId={selectedDevice?.id}
            deviceRuntimeStates={simulationState.devices}
            scenarioResetSignal={scenarioResetSignal}
            onRadioPacket={handleRuntimeRadioPacket}
            onRuntimeLog={handleRuntimeLog}
            onDisplayChange={handleRuntimeDisplayChange}
            onSoundOutput={handleRuntimeSoundOutput}
            onRadioConfigHint={handleRuntimeRadioConfigHint}
            onLoadResultsChange={setRuntimeLoadResults}
          />

          <div className="telemetry-card" aria-live="polite">
            <span className="metric-label">Engine telemetry</span>
            <strong>{mode}</strong>
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
    </section>
  );
}

function DeviceSelection({
  project,
  deviceId,
  runtime,
  runtimeLoadResult,
  uploadIssue,
  logs,
  onArtifactUpload,
}: {
  project: SwarmProject;
  deviceId: DeviceId;
  runtime?: DeviceRuntimeState;
  runtimeLoadResult?: DeviceProgramLoadResult;
  uploadIssue?: ArtifactUploadIssue;
  logs: SimulationState['deviceLogs'];
  onArtifactUpload: (deviceId: DeviceId, file: File) => void;
}) {
  const device = project.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return <p className="hint">Device missing from project.</p>;
  }
  const assignedArtifact = device.programArtifactId
    ? project.artifacts.find((artifact) => artifact.id === device.programArtifactId)
    : undefined;

  return (
    <>
      <strong>{device.name}</strong>
      <p>
        x {Math.round(device.position.x)} / y {Math.round(device.position.y)}
      </p>
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
      {runtimeLoadResult ? (
        <p>
          Runtime: <strong>{runtimeLoadResult.status}</strong>
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
                  <span>{log.message}</span>
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
}: {
  source: EnvironmentSource;
  updateSource: (sourceId: EnvironmentSourceId, patch: Partial<EnvironmentSource>) => void;
}) {
  const peakLevel = intensityToSensorLevel(source.intensity);
  return (
    <>
      <strong>
        {source.type} source {source.id}
      </strong>
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
  const previousArtifactId = project.devices.find((device) => device.id === deviceId)?.programArtifactId;
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

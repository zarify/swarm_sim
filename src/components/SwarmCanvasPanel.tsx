import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  createBlankProject,
  type DeviceId,
  type EnvironmentSource,
  type EnvironmentSourceId,
  type Point,
  type SwarmProject,
} from '../domain/project';
import { MicroPythonRuntimeHost } from './MicroPythonRuntimeHost';
import {
  appendDeviceRuntimeLog,
  moveDevice,
  pauseSimulation,
  reconcileSimulationProject,
  resumeSimulation,
  resetSimulation,
  routeRadioPacket,
  setDeviceButton,
  startSimulation,
  type DeviceRuntimeState,
  type SimulationState,
  type SimulationMode,
} from '../simulation/simulationEngine';
import type { DeviceProgramLoadResult } from '../runtime/programLoader';
import type { RuntimeRadioPacket } from '../runtime/runtimeAdapter';

type Selection =
  | { type: 'device'; id: DeviceId }
  | { type: 'source'; id: EnvironmentSourceId };

type DragTarget = Selection;

interface CanvasModel {
  project: SwarmProject;
  simulationState: SimulationState;
}

const canvasSize = { width: 860, height: 520 };
const defaultRadioOptions = {
  defaultRadioRangeRadius: 160,
  minRadioRangeRadius: 40,
  maxRadioRangeRadius: 240,
};
const textEncoder = new TextEncoder();
const demoMicroPythonBeaconHex = makeMicroPythonDemoHex(`
import radio
radio.config(group=42)
radio.on()
radio.send("ping")
`);

export function SwarmCanvasPanel() {
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const modelRef = useRef(model);
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

  useEffect(() => () => releaseCanvasPointer(), []);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  function setSimulationMode(nextMode: SimulationMode) {
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
    updateProject((current) => {
      const deviceNumber = current.devices.length + 1;
      const id = `device-${deviceNumber}`;
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
            intensity: type === 'light' ? 0.78 : 0.66,
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

  function sendPingFromSelected() {
    if (selected.type !== 'device') {
      return;
    }

    setModel((current) => ({
      ...current,
      simulationState: routeRadioPacket(current.simulationState, selected.id, {
        data: new TextEncoder().encode('ping'),
      }),
    }));
  }

  function setSelectedDeviceButton(button: 'A' | 'B', pressed: boolean) {
    if (selected.type !== 'device') {
      return;
    }

    setModel((current) => ({
      ...current,
      simulationState: setDeviceButton(current.simulationState, selected.id, button, pressed),
    }));
  }

  function handleRuntimeRadioPacket(deviceId: DeviceId, packet: RuntimeRadioPacket): DeviceId[] {
    let recipients: DeviceId[] = [];
    flushSync(() => {
      setModel((current) => {
        const simulationState = routeRadioPacket(current.simulationState, deviceId, packet);
        recipients = simulationState.radioEvents.at(-1)?.recipients ?? [];
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
                <circle className="source-radius" r={source.radius} />
                <circle className="source-core" r="16" />
                <text y="5" textAnchor="middle">
                  {source.type === 'light' ? 'L' : 'S'}
                </text>
              </g>
            ))}

            {Object.values(simulationState.devices).map((device, index) => {
              const isSelected = selected.type === 'device' && selected.id === device.deviceId;
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
                  {showRadioRange ? (
                    <circle className="radio-radius" r={device.radio.rangeRadius} />
                  ) : null}
                  <rect className="microbit-body" x="-34" y="-24" width="68" height="48" rx="12" />
                  <circle className="button-dot" cx="-23" cy="-1" r="5" />
                  <circle className="button-dot" cx="23" cy="-1" r="5" />
                  {makeLedPixels(index).map((lit, pixelIndex) => {
                    const column = pixelIndex % 5;
                    const row = Math.floor(pixelIndex / 5);
                    return (
                      <rect
                        key={pixelIndex}
                        className={lit ? 'led-pixel led-pixel--lit' : 'led-pixel'}
                        x={-12 + column * 6}
                        y={-12 + row * 6}
                        width="3.6"
                        height="3.6"
                        rx="1"
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
              <DeviceSelection
                project={project}
                runtime={simulationState.devices[selectedDevice.id]}
                runtimeLoadResult={runtimeLoadResults.find(
                  (result) => result.deviceId === selectedDevice.id,
                )}
                deviceId={selectedDevice.id}
                logs={simulationState.deviceLogs.filter((log) => log.deviceId === selectedDevice.id)}
                onButtonChange={setSelectedDeviceButton}
                onSendPing={sendPingFromSelected}
              />
            ) : selectedSource ? (
              <SourceSelection source={selectedSource} updateSource={updateSource} />
            ) : (
              <p className="hint">Select a node or environmental source.</p>
            )}
          </div>

          <div className="telemetry-card" aria-live="polite">
            <span className="metric-label">Engine telemetry</span>
            <strong>{mode}</strong>
            <p>
              {project.devices.length} nodes / {simulationState.radioLinks.filter((link) => link.canCommunicate).length}{' '}
              active directed radio links
            </p>
          </div>

          <MicroPythonRuntimeHost
            project={project}
            onRadioPacket={handleRuntimeRadioPacket}
            onRuntimeLog={handleRuntimeLog}
            onLoadResultsChange={setRuntimeLoadResults}
          />

          <div className="radio-inspector-card" aria-label="Radio message inspector">
            <span className="metric-label">Radio inspector</span>
            {simulationState.radioEvents.length === 0 ? (
              <p className="hint">No packets sent yet.</p>
            ) : (
              simulationState.radioEvents
                .slice(-4)
                .reverse()
                .map((event) => (
                  <article key={event.id} className="radio-event">
                    <strong>{new TextDecoder().decode(event.data)}</strong>
                    <p>
                      {event.senderId} to {event.recipients.length} received /{' '}
                      {event.blockedTargets.length} blocked
                    </p>
                  </article>
                ))
            )}
          </div>
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
  logs,
  onButtonChange,
  onSendPing,
}: {
  project: SwarmProject;
  deviceId: DeviceId;
  runtime?: DeviceRuntimeState;
  runtimeLoadResult?: DeviceProgramLoadResult;
  logs: SimulationState['deviceLogs'];
  onButtonChange: (button: 'A' | 'B', pressed: boolean) => void;
  onSendPing: () => void;
}) {
  const device = project.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return <p className="hint">Device missing from project.</p>;
  }

  return (
    <>
      <strong>{device.name}</strong>
      <p>
        x {Math.round(device.position.x)} / y {Math.round(device.position.y)}
      </p>
      <p>{device.programArtifactId ? `Artifact: ${device.programArtifactId}` : 'No artifact assigned yet'}</p>
      {runtimeLoadResult ? (
        <p>
          Runtime: <strong>{runtimeLoadResult.status}</strong>
        </p>
      ) : null}
      {runtime ? (
        <>
          <dl className="radio-summary">
            <div>
              <dt>Group</dt>
              <dd>{runtime.radio.group}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{runtime.radio.channel}</dd>
            </div>
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
          <div className="button-controls" aria-label={`Button controls for ${device.name}`}>
            {(['A', 'B'] as const).map((button) => (
              <button
                key={button}
                type="button"
                onPointerDown={() => onButtonChange(button, true)}
                onPointerUp={() => onButtonChange(button, false)}
                onPointerCancel={() => onButtonChange(button, false)}
              >
                {runtime.buttons[button] ? `Release ${button}` : `Press ${button}`}
              </button>
            ))}
          </div>
          <button type="button" onClick={onSendPing}>
            Send ping
          </button>
        </>
      ) : null}
      <div className="device-log" aria-label={`Event log for ${device.name}`}>
        <span className="metric-label">Device log</span>
        {logs.length === 0 ? (
          <p className="hint">No device events yet.</p>
        ) : (
          logs
            .slice(-5)
            .reverse()
            .map((log) => (
              <p key={log.id}>
                <strong>{log.type}</strong> {log.message}
              </p>
            ))
        )}
      </div>
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
        Intensity
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={source.intensity}
          onChange={(event) => updateSource(source.id, { intensity: Number(event.target.value) })}
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
    artifacts: [
      {
        id: 'artifact-micropython-beacon',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: textEncoder.encode(demoMicroPythonBeaconHex),
        createdAt: '2026-05-16T04:20:00.000Z',
      },
    ],
    devices: [
      {
        id: 'device-alpha',
        name: 'Alpha',
        position: { x: 180, y: 180 },
        programArtifactId: 'artifact-micropython-beacon',
      },
      {
        id: 'device-beta',
        name: 'Beta',
        position: { x: 315, y: 220 },
        programArtifactId: 'artifact-micropython-beacon',
      },
      { id: 'device-gamma', name: 'Gamma', position: { x: 505, y: 190 } },
      { id: 'device-delta', name: 'Delta', position: { x: 610, y: 340 } },
    ],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        position: { x: 220, y: 390 },
        radius: 180,
        intensity: 0.8,
      },
      {
        id: 'sound-1',
        type: 'sound',
        position: { x: 670, y: 145 },
        radius: 150,
        intensity: 0.64,
      },
    ],
  };
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

function makeMicroPythonDemoHex(mainPy: string): string {
  const filename = textEncoder.encode('main.py');
  const source = textEncoder.encode(mainPy);
  const chunk = new Uint8Array(128).fill(0xff);
  const dataStart = 3 + filename.length;
  const endOffset = dataStart + source.length - 1;
  if (endOffset > 126) {
    throw new Error('Demo MicroPython program is too large for a single filesystem chunk');
  }

  chunk[0] = 0xfe;
  chunk[1] = endOffset;
  chunk[2] = filename.length;
  chunk.set(filename, 3);
  chunk.set(source, dataStart);

  return [
    ...chunkBytes(chunk, 16).map((record, index) => makeHexRecord(index * 16, 0x00, [...record])),
    makeHexRecord(0x0000, 0x01, []),
  ].join('\n');
}

function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, recordType, ...data];
  const checksum = (-bytes.reduce((total, byte) => total + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function makeLedPixels(seed: number): boolean[] {
  return Array.from({ length: 25 }, (_, index) => {
    const row = Math.floor(index / 5);
    const column = index % 5;
    return row === column || row + column === 4 || (seed + row + column) % 7 === 0;
  });
}

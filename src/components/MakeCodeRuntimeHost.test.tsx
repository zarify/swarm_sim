import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlankProject, type DeviceId, type SwarmProject } from '../domain/project';
import type {
  DeviceProgramLoadResult,
  LoadProjectRuntimeProgramsOptions,
} from '../runtime/programLoader';
import type { RuntimeAdapterEvent, RuntimeProgram } from '../runtime/runtimeAdapter';
import type { DeviceRuntimeState } from '../simulation/simulationEngine';
import { MakeCodeRuntimeHost } from './MakeCodeRuntimeHost';

const now = '2026-05-16T05:52:00.000Z';

describe('MakeCodeRuntimeHost', () => {
  it('renders one MakeCode runtime host card and prepares assigned runtimes', async () => {
    const flashed: RuntimeProgram[] = [];
    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() => makeEventAdapter(() => {})}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
            },
          });
          const program: RuntimeProgram = {
            source: 'makecode-pxt',
            sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
          };
          await adapter?.flash(program);
          flashed.push(program);
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
              adapterName: adapter?.name,
            },
          ];
        }}
      />,
    );

    expect(screen.getByLabelText('MakeCode runtime host')).toBeInTheDocument();
    expect(screen.getByTitle('MakeCode simulator for Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Press A for Alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Press B for Alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Press A+B for Alpha' })).toBeDisabled();
    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(screen.getByText(/loaded/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Press A for Alpha' })).not.toBeDisabled();
    expect(flashed).toHaveLength(1);
  });

  it('forwards MakeCode adapter display, radio, and serial events through host callbacks', async () => {
    const displayChanges: string[] = [];
    const logs: string[] = [];
    const packets: string[] = [];
    const sounds: string[] = [];
    const buttonInputs: string[] = [];
    const radioHints: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onDisplayChange={(deviceId, pixels) => displayChanges.push(`${deviceId}:${pixels.join('')}`)}
        onRadioPacket={(deviceId, packet) => {
          packets.push(`${deviceId}:${new TextDecoder().decode(packet.data)}`);
          return [];
        }}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        onSoundOutput={(deviceId, level) => sounds.push(`${deviceId}:${level}`)}
        onRadioConfigHint={(deviceId, config) => {
          radioHints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
            },
          });
          await adapter?.flash({
            source: 'makecode-pxt',
            sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
              adapterName: adapter?.name,
            },
          ];
        }}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          }, (button, pressed) => {
            buttonInputs.push(`${button}:${pressed}`);
          })
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    act(() => {
      emitRuntimeEvent?.({
        type: 'display-change',
        pixels: [9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9],
      });
      emitRuntimeEvent?.({
        type: 'radio-output',
        packet: { data: new TextEncoder().encode('ping'), group: 17, channel: 9, signalStrength: 6 },
      });
      emitRuntimeEvent?.({
        type: 'radio-config-change',
        config: { group: 42, channel: 7, signalStrength: 5 },
      });
      emitRuntimeEvent?.({
        type: 'serial-output',
        data: 'mc-receive',
      });
      emitRuntimeEvent?.({
        type: 'sound-output',
        level: 7,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Press A for Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Press B for Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Press A+B for Alpha' }));

    expect(displayChanges).toEqual(['device-alpha:9000909090009000909090009']);
    expect(packets).toEqual(['device-alpha:ping']);
    expect(logs).toContain('device-alpha:mc-receive');
    expect(sounds).toEqual(['device-alpha:7']);
    expect(radioHints).toEqual(['device-alpha:17:9:6', 'device-alpha:42:7:5']);
    await waitFor(() =>
      expect(document.querySelector('[data-runtime-led="device-alpha:0"]')).toHaveClass('virtual-led-pixel--lit'),
    );
    await waitFor(() => expect(buttonInputs).toHaveLength(8));
    expect(buttonInputs.filter((entry) => entry === 'A:true')).toHaveLength(2);
    expect(buttonInputs.filter((entry) => entry === 'A:false')).toHaveLength(2);
    expect(buttonInputs.filter((entry) => entry === 'B:true')).toHaveLength(2);
    expect(buttonInputs.filter((entry) => entry === 'B:false')).toHaveLength(2);
  });

  it('deduplicates back-to-back identical radio packets from the same runtime device', async () => {
    const packets: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onDisplayChange={() => {}}
        onRadioPacket={(deviceId, packet) => {
          packets.push(`${deviceId}:${new TextDecoder().decode(packet.data)}`);
          return [];
        }}
        onRuntimeLog={() => {}}
        onSoundOutput={() => {}}
        onRadioConfigHint={() => {}}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
            },
          });
          await adapter?.flash({
            source: 'makecode-pxt',
            sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
              adapterName: adapter?.name,
            },
          ];
        }}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    act(() => {
      const packet = { data: new TextEncoder().encode('light:76'), group: 42 };
      emitRuntimeEvent?.({ type: 'radio-output', packet });
      emitRuntimeEvent?.({ type: 'radio-output', packet });
    });

    expect(packets).toEqual(['device-alpha:light:76']);
  });

  it('deduplicates immediate identical serial outputs from the same runtime device', async () => {
    const logs: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onDisplayChange={() => {}}
        onRadioPacket={() => []}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        onSoundOutput={() => {}}
        onRadioConfigHint={() => {}}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
            },
          });
          await adapter?.flash({
            source: 'makecode-pxt',
            sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
              adapterName: adapter?.name,
            },
          ];
        }}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    act(() => {
      emitRuntimeEvent?.({ type: 'serial-output', data: 'light:66' });
      emitRuntimeEvent?.({ type: 'serial-output', data: 'light:66' });
    });

    expect(logs).toEqual(['device-alpha:light:66']);
  });

  it('filters malformed display frames and logs the fault once until a valid frame arrives', async () => {
    const displayChanges: string[] = [];
    const logs: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onDisplayChange={(deviceId, pixels) => displayChanges.push(`${deviceId}:${pixels.join('')}`)}
        onRadioPacket={() => []}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
            },
          });
          await adapter?.flash({
            source: 'makecode-pxt',
            sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
              adapterName: adapter?.name,
            },
          ];
        }}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    act(() => {
      emitRuntimeEvent?.({ type: 'display-change', pixels: [1, 2, 3] });
      emitRuntimeEvent?.({ type: 'display-change', pixels: [4, 5, 6] });
      emitRuntimeEvent?.({
        type: 'display-change',
        pixels: Array.from({ length: 25 }, (_, index) => (index === 0 ? 9 : 0)),
      });
    });

    expect(logs.filter((entry) => entry.includes('MakeCode runtime emitted invalid LED data'))).toHaveLength(1);
    expect(displayChanges).toEqual(['device-alpha:9000000000000000000000000']);
  });

  it('syncs engine-derived light and sound levels into prepared adapters', async () => {
    const sensorValues: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(17, 23)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            (sensor, value) => {
              sensorValues.push(`${sensor}:${value}`);
            },
          )
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(sensorValues).toEqual(['lightLevel:17', 'soundLevel:23']));

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(81, 5)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            (sensor, value) => {
              sensorValues.push(`${sensor}:${value}`);
            },
          )
        }
      />,
    );

    await waitFor(() =>
      expect(sensorValues).toEqual(['lightLevel:17', 'soundLevel:23', 'lightLevel:81', 'soundLevel:5']),
    );
  });

  it('reapplies engine sensor values after runtime reset even when values are unchanged', async () => {
    const sensorValues: string[] = [];
    const resets: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(0, 0)}
        scenarioResetSignal={0}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            (sensor, value) => {
              sensorValues.push(`${sensor}:${value}`);
            },
            () => {
              resets.push('reset');
            },
          )
        }
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(sensorValues).toEqual(['lightLevel:0', 'soundLevel:0']));

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(0, 0)}
        scenarioResetSignal={1}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            (sensor, value) => {
              sensorValues.push(`${sensor}:${value}`);
            },
            () => {
              resets.push('reset');
            },
          )
        }
      />,
    );

    await waitFor(() =>
      expect(sensorValues).toEqual(['lightLevel:0', 'soundLevel:0', 'lightLevel:0', 'soundLevel:0']),
    );
    expect(resets).toEqual(['reset']);
  });

  it('publishes MakeCode radio config hints from prepared source, including tx power', async () => {
    const hints: string[] = [];

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() => makeEventAdapter(() => {})}
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={async (_project, options) => {
          await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: {
                'main.ts': 'radio.sendString("ping")',
                'custom.ts': 'radio.setGroup(42)\nradio.setFrequencyBand(23)\nradio.setTransmitPower(6)',
              },
            },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mc',
              status: 'loaded',
              runtimeSource: 'makecode-pxt',
            },
          ];
        }}
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(hints).toContain('device-alpha:42:23:6'));
  });

  it('preserves existing runner readiness when adding a second MakeCode device', async () => {
    const loadCalls: DeviceId[][] = [];
    const makeAutoLoadPrograms =
      () =>
      async (
        project: SwarmProject,
        options: LoadProjectRuntimeProgramsOptions,
      ): Promise<DeviceProgramLoadResult[]> => {
        loadCalls.push(project.devices.map((device) => device.id));
        const artifactsById = new Map(project.artifacts.map((artifact) => [artifact.id, artifact]));
        for (const device of project.devices) {
          if (!device.programArtifactId) {
            continue;
          }
          const artifact = artifactsById.get(device.programArtifactId);
          if (!artifact) {
            continue;
          }
          await options.createAdapter?.({
            device,
            artifact,
            runtimeSource: 'makecode-pxt',
            program: {
              source: 'makecode-pxt',
              sourceFiles: {
                'main.ts': `radio.setGroup(42)\nserial.writeLine("${device.id}")`,
              },
            },
          });
        }
        return project.devices
          .filter((device) => device.programArtifactId)
          .map((device) => ({
            deviceId: device.id,
            artifactId: device.programArtifactId,
            status: 'loaded' as const,
            runtimeSource: 'makecode-pxt' as const,
          }));
      };
    const loadPrograms = makeAutoLoadPrograms();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        autoPrepare
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadPrograms}
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(loadCalls.some((call) => call.includes('device-alpha'))).toBe(true));
    expect(screen.getByText('1/1 simulator(s) ready')).toBeInTheDocument();

    rerender(
      <MakeCodeRuntimeHost
        project={makeProject({ assignGammaMakeCode: true })}
        autoPrepare
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadPrograms}
      />,
    );
    await waitFor(() => expect(screen.getByText('1/2 simulator(s) ready')).toBeInTheDocument());
    expect(loadCalls.some((call) => call.includes('device-gamma'))).toBe(false);
  }, 15000);
});

function makeProject(options: { assignGammaMakeCode?: boolean } = {}): SwarmProject {
  const gammaArtifactId = options.assignGammaMakeCode ? 'artifact-mc-gamma' : undefined;
  return {
    ...createBlankProject({ id: 'runtime-host-project', name: 'Runtime host', now }),
    artifacts: [
      {
        id: 'artifact-mc',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        bytes: new Uint8Array([1, 2, 3]),
        createdAt: now,
      },
      ...(gammaArtifactId
        ? [
            {
              id: gammaArtifactId,
              name: 'mc_gamma.hex',
              artifactKind: 'hex' as const,
              runtimeSource: 'makecode-pxt' as const,
              bytes: new Uint8Array([4, 5, 6]),
              createdAt: now,
            },
          ]
        : []),
    ],
    devices: [
      {
        id: 'device-alpha',
        name: 'Alpha',
        position: { x: 100, y: 100 },
        programArtifactId: 'artifact-mc',
      },
      {
        id: 'device-gamma',
        name: 'Gamma',
        position: { x: 200, y: 100 },
        ...(gammaArtifactId ? { programArtifactId: gammaArtifactId } : {}),
      },
    ],
    environmentSources: [],
  };
}

function makeEventAdapter(
  subscribe: (listener: (event: RuntimeAdapterEvent) => void) => void,
  onSetButton?: (button: 'A' | 'B', pressed: boolean) => void,
  onSetSensor?: (sensor: 'lightLevel' | 'soundLevel', value: number) => void,
  onReset?: () => void,
) {
  return {
    name: 'event adapter',
    source: 'makecode-pxt' as const,
    evaluateArtifact: () => ({
      artifactKind: 'hex' as const,
      runtimeSource: 'makecode-pxt' as const,
      sourceEvidence: [],
      canExecuteNow: true,
      verdict: 'event adapter',
      capabilities: [],
    }),
    flash: async () => {},
    reset: async () => {
      onReset?.();
    },
    stop: async () => {},
    setButton: async (button: 'A' | 'B', pressed: boolean) => {
      onSetButton?.(button, pressed);
    },
    setSensor: async (sensor: 'lightLevel' | 'soundLevel', value: number) => {
      onSetSensor?.(sensor, value);
    },
    sendRadio: async () => {},
    onEvent: (listener: (event: RuntimeAdapterEvent) => void) => {
      subscribe(listener);
      return () => {};
    },
  };
}

function makeDeviceRuntimeStates(lightLevel: number, soundLevel: number): Record<string, DeviceRuntimeState> {
  return {
    'device-alpha': {
      deviceId: 'device-alpha',
      lifecycle: 'stopped',
      position: { x: 100, y: 100 },
      radio: { group: 0, channel: 7, rangeRadius: 160 },
      buttons: { A: false, B: false },
      sensors: { lightLevel, soundLevel },
    },
  };
}

async function loadTargetProjectDevices(
  _project: SwarmProject,
  options: LoadProjectRuntimeProgramsOptions,
): Promise<DeviceProgramLoadResult[]> {
  await options.createAdapter?.({
    device: makeProject().devices[0]!,
    artifact: makeProject().artifacts[0]!,
    runtimeSource: 'makecode-pxt',
    program: {
      source: 'makecode-pxt',
      sourceFiles: { 'main.ts': 'radio.sendString("ping")' },
    },
  });

  return [
    {
      deviceId: 'device-alpha',
      artifactId: 'artifact-mc',
      status: 'loaded' as const,
      runtimeSource: 'makecode-pxt' as const,
    },
  ];
}

async function markRunnerReady(deviceName: string): Promise<void> {
  const frame = screen.getByTitle(`MakeCode simulator for ${deviceName}`) as HTMLIFrameElement;
  await act(async () => {
    const event = new MessageEvent('message', {
      data: { type: 'swarm-runner-ready' },
      origin: window.location.origin,
    });
    Object.defineProperty(event, 'source', {
      value: frame.contentWindow,
    });
    window.dispatchEvent(event);
  });
}

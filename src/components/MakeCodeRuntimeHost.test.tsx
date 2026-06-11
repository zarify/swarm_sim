import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlankProject, type DeviceId, type SwarmProject } from '../domain/project';
import { FEATURE_FLAGS } from '../runtime/featureFlags';
import type {
  DeviceProgramLoadResult,
  LoadProjectRuntimeProgramsOptions,
} from '../runtime/programLoader';
import { registerRuntimeRadioSink } from '../runtime/radioDeliveryRegistry';
import type { RuntimeAdapterEvent, RuntimeProgram, RuntimeSensorId } from '../runtime/runtimeAdapter';
import type { DeviceRuntimeState } from '../simulation/simulationEngine';
import { buildMakeCodeRunnerUrl, MakeCodeRuntimeHost } from './MakeCodeRuntimeHost';

const now = '2026-05-16T05:52:00.000Z';

describe('MakeCodeRuntimeHost', () => {
  it('builds a dev trace query only for dev runner URLs', () => {
    expect(buildMakeCodeRunnerUrl('./', true)).toBe('./makecode-patched-runner.html?swarmTrace=1');
    expect(buildMakeCodeRunnerUrl('./', false)).toBe('./makecode-patched-runner.html');
    expect(buildMakeCodeRunnerUrl('/swarm/', true)).toBe('/swarm/makecode-patched-runner.html?swarmTrace=1');
  });

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

  it('keeps the same simulator iframe when toggling host card visibility', () => {
    const project = makeProject();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={project}
        showHostCard={false}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );
    const initialFrame = screen.getByTitle('MakeCode simulator for Alpha');

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        showHostCard
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );
    expect(screen.getByTitle('MakeCode simulator for Alpha')).toBe(initialFrame);

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        showHostCard={false}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );
    expect(screen.getByTitle('MakeCode simulator for Alpha')).toBe(initialFrame);
  });

  it('remounts the runner iframe on selected runtime reset when using the default runner adapter', async () => {
    const loadCalls: string[] = [];

    render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={async (_project, options) => {
          loadCalls.push('load');
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
        }}
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(loadCalls).toHaveLength(1));

    const initialFrame = screen.getByTitle('MakeCode simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Reset selected runtime' }));

    await waitFor(() => expect(screen.getByTitle('MakeCode simulator for Alpha')).not.toBe(initialFrame));
    await markRunnerReady('Alpha');
    await waitFor(() => expect(loadCalls).toHaveLength(2));
  });

  it('forwards MakeCode adapter display, radio, and serial events through host callbacks', async () => {
    const displayChanges: string[] = [];
    const logs: string[] = [];
    const packets: string[] = [];
    const sounds: string[] = [];
    const buttonInputs: string[] = [];
    const comboPulses: string[] = [];
    const radioHints: string[] = [];
    const dataLogs: string[] = [];
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
        onRuntimeDataLog={(deviceId, event) => {
          if (event.type === 'data-log-delete') {
            dataLogs.push(`${deviceId}:delete`);
            return;
          }
          dataLogs.push(
            `${deviceId}:${
              event.entry.headings?.join('|') ?? 'none'
            }:${event.entry.data?.join('|') ?? 'none'}`,
          );
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
          }, undefined, undefined, () => {
            comboPulses.push('AB');
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
      emitRuntimeEvent?.({
        type: 'data-log-output',
        entry: { headings: ['time', 'light'], data: ['1', '42'] },
      });
      emitRuntimeEvent?.({ type: 'data-log-delete' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Press A for Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Press B for Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Press A+B for Alpha' }));

    expect(displayChanges).toEqual(['device-alpha:9000909090009000909090009']);
    expect(packets).toEqual(['device-alpha:ping']);
    expect(logs).toContain('device-alpha:mc-receive');
    expect(sounds).toEqual(['device-alpha:7']);
    expect(radioHints).toEqual(['device-alpha:17:9:6', 'device-alpha:42:7:5']);
    expect(dataLogs).toEqual(['device-alpha:time|light:1|42', 'device-alpha:delete']);
    await waitFor(() =>
      expect(document.querySelector('[data-runtime-led="device-alpha:0"]')).toHaveClass('virtual-led-pixel--lit'),
    );
    await waitFor(() => expect(buttonInputs).toHaveLength(4));
    expect(buttonInputs.filter((entry) => entry === 'A:true')).toHaveLength(1);
    expect(buttonInputs.filter((entry) => entry === 'A:false')).toHaveLength(1);
    expect(buttonInputs.filter((entry) => entry === 'B:true')).toHaveLength(1);
    expect(buttonInputs.filter((entry) => entry === 'B:false')).toHaveLength(1);
    expect(comboPulses).toEqual(['AB']);
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

  it('delivers routed radio packets to recipients registered by other runtime hosts', async () => {
    const delivered: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const unregister = registerRuntimeRadioSink('device-external' as DeviceId, async (packet) => {
      delivered.push(new TextDecoder().decode(packet.data));
    });

    try {
      render(
        <MakeCodeRuntimeHost
          project={makeProject()}
          onDisplayChange={() => {}}
          onRadioPacket={(_deviceId, packet) => [
            {
              recipientId: 'device-external',
              packet,
            },
          ]}
          onRuntimeLog={() => {}}
          onSoundOutput={() => {}}
          onRadioConfigHint={() => {}}
          loadPrograms={loadTargetProjectDevices}
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
        emitRuntimeEvent?.({
          type: 'radio-output',
          packet: { data: new TextEncoder().encode('light:75'), group: 42, channel: 7 },
        });
      });

      await waitFor(() => expect(delivered).toEqual(['light:75']));
    } finally {
      unregister();
    }
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

  it('syncs engine-derived light, sound, and magnetic levels into prepared adapters', async () => {
    const sensorValues: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(17, 23, undefined, {
          x: 12,
          y: -34,
          z: 56,
        })}
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
    await waitFor(() =>
      expect(sensorValues).toEqual(expectedSyncedSensors(17, 23, { x: 12, y: -34, z: 56 })),
    );

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(81, 5, undefined, {
          x: -400,
          y: 200,
          z: 1,
        })}
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
      expect(sensorValues).toEqual([
        ...expectedSyncedSensors(17, 23, { x: 12, y: -34, z: 56 }),
        ...expectedSyncedSensors(81, 5, { x: -400, y: 200, z: 1 }),
      ]),
    );
  });

  it('maps false:false -> true:true -> false:false button state cycles to one AB pulse when supported', async () => {
    const buttonValues: string[] = [];
    const comboPulses: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(0, 0)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            (button, pressed) => {
              buttonValues.push(`${button}:${pressed}`);
            },
            undefined,
            undefined,
            () => {
              comboPulses.push('AB');
            },
          )
        }
      />
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(buttonValues).toEqual(['A:false', 'B:false']));

    buttonValues.length = 0;

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(0, 0, { A: true, B: true })}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            (button, pressed) => {
              buttonValues.push(`${button}:${pressed}`);
            },
            undefined,
            undefined,
            () => {
              comboPulses.push('AB');
            },
          )
        }
      />
    );

    rerender(
      <MakeCodeRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(0, 0, { A: false, B: false })}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            (button, pressed) => {
              buttonValues.push(`${button}:${pressed}`);
            },
            undefined,
            undefined,
            () => {
              comboPulses.push('AB');
            },
          )
        }
      />
    );

    await waitFor(() => expect(comboPulses).toEqual(['AB']));
    expect(buttonValues).toEqual([]);
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
    await waitFor(() =>
      expect(sensorValues).toEqual(expectedSyncedSensors(0, 0, { x: 0, y: 45, z: 0 })),
    );

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
      expect(sensorValues).toEqual([
        ...expectedSyncedSensors(0, 0, { x: 0, y: 45, z: 0 }),
        ...expectedSyncedSensors(0, 0, { x: 0, y: 45, z: 0 }),
      ]),
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

  it('replays MakeCode source radio config hints after scenario reset', async () => {
    const hints: string[] = [];
    const resets: string[] = [];
    const loadPrograms = async (_project: SwarmProject, options: LoadProjectRuntimeProgramsOptions) => {
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
          status: 'loaded' as const,
          runtimeSource: 'makecode-pxt' as const,
        },
      ];
    };

    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        scenarioResetSignal={0}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            undefined,
            () => {
              resets.push('reset');
            },
          )
        }
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadPrograms}
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(hints.filter((hint) => hint === 'device-alpha:42:23:6')).toHaveLength(1));

    rerender(
      <MakeCodeRuntimeHost
        project={makeProject()}
        scenarioResetSignal={1}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            undefined,
            () => {
              resets.push('reset');
            },
          )
        }
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadPrograms}
      />,
    );

    await waitFor(() => expect(resets).toEqual(['reset']));
    await waitFor(() => expect(hints.filter((hint) => hint === 'device-alpha:42:23:6')).toHaveLength(2));
  });

  it('waits for async reset completion before replaying MakeCode source radio config hints', async () => {
    const hints: string[] = [];
    let resolveReset: (() => void) | undefined;
    const resetStarted = vi.fn();
    const loadPrograms = async (_project: SwarmProject, options: LoadProjectRuntimeProgramsOptions) => {
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
          status: 'loaded' as const,
          runtimeSource: 'makecode-pxt' as const,
        },
      ];
    };

    const { rerender } = render(
      <MakeCodeRuntimeHost
        project={makeProject()}
        scenarioResetSignal={0}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            undefined,
            () =>
              new Promise<void>((resolve) => {
                resetStarted();
                resolveReset = resolve;
              }),
          )
        }
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadPrograms}
      />,
    );

    await markRunnerReady('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare runtime' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(hints.filter((hint) => hint === 'device-alpha:42:23:6')).toHaveLength(1));

    rerender(
      <MakeCodeRuntimeHost
        project={makeProject()}
        scenarioResetSignal={1}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={() =>
          makeEventAdapter(
            () => {},
            undefined,
            undefined,
            () =>
              new Promise<void>((resolve) => {
                resetStarted();
                resolveReset = resolve;
              }),
          )
        }
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadPrograms}
      />,
    );

    await waitFor(() => expect(resetStarted).toHaveBeenCalledTimes(1));
    expect(hints.filter((hint) => hint === 'device-alpha:42:23:6')).toHaveLength(1);

    resolveReset?.();
    await waitFor(() => expect(hints.filter((hint) => hint === 'device-alpha:42:23:6')).toHaveLength(2));
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
  onSetSensor?: (sensor: RuntimeSensorId, value: number) => void,
  onReset?: () => void | Promise<void>,
  onPulseButtonAB?: () => void,
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
      await onReset?.();
    },
    stop: async () => {},
    setButton: async (button: 'A' | 'B', pressed: boolean) => {
      onSetButton?.(button, pressed);
    },
    pulseButtonAB: async () => {
      onPulseButtonAB?.();
    },
    setSensor: async (sensor: RuntimeSensorId, value: number) => {
      onSetSensor?.(sensor, value);
    },
    sendRadio: async () => {},
    onEvent: (listener: (event: RuntimeAdapterEvent) => void) => {
      subscribe(listener);
      return () => {};
    },
  };
}

function makeDeviceRuntimeStates(
  lightLevel: number,
  soundLevel: number,
  buttons: DeviceRuntimeState['buttons'] = { A: false, B: false },
  magnetic: { x: number; y: number; z: number } = { x: 0, y: 45, z: 0 },
): Record<string, DeviceRuntimeState> {
  const magneticFieldStrength = Math.round(
    Math.hypot(magnetic.x, magnetic.y, magnetic.z),
  );
  return {
    'device-alpha': {
      deviceId: 'device-alpha',
      lifecycle: 'stopped',
      position: { x: 100, y: 100 },
      radio: { group: 0, channel: 7, rangeRadius: 160 },
      buttons,
      sensors: {
        lightLevel,
        soundLevel,
        magneticForceX: magnetic.x,
        magneticForceY: magnetic.y,
        magneticForceZ: magnetic.z,
        magneticFieldStrength,
      },
    },
  };
}

function expectedSyncedSensors(
  lightLevel: number,
  soundLevel: number,
  magnetic: { x: number; y: number; z: number },
): string[] {
  const values: string[] = [];
  if (FEATURE_FLAGS.light) {
    values.push(`lightLevel:${lightLevel}`);
  }
  if (FEATURE_FLAGS.sound) {
    values.push(`soundLevel:${soundLevel}`);
  }
  if (FEATURE_FLAGS.magnet) {
    values.push(
      `magneticForceX:${magnetic.x}`,
      `magneticForceY:${magnetic.y}`,
      `magneticForceZ:${magnetic.z}`,
    );
  }
  return values;
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

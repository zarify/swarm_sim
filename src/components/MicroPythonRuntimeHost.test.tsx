import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createBlankProject, type SwarmProject } from '../domain/project';
import type { LoadProjectRuntimeProgramsOptions } from '../runtime/programLoader';
import type { MicrobitRuntimeAdapter, RuntimeAdapterEvent, RuntimeProgram } from '../runtime/runtimeAdapter';
import type { DeviceRuntimeState } from '../simulation/simulationEngine';
import {
  MicroPythonRuntimeHost,
  MICRO_PYTHON_SIMULATOR_URL,
} from './MicroPythonRuntimeHost';

const now = '2026-05-16T05:52:00.000Z';

describe('MicroPythonRuntimeHost', () => {
  it('renders one simulator iframe per MicroPython-assigned device', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.getByLabelText('MicroPython runtime host')).toBeInTheDocument();
    expect(screen.getByTitle('MicroPython simulator for Alpha')).toHaveAttribute(
      'src',
      MICRO_PYTHON_SIMULATOR_URL,
    );
    expect(screen.queryByTitle('MicroPython simulator for Gamma')).not.toBeInTheDocument();
  });

  it('can keep MicroPython host controls hidden while keeping runtime iframes mounted', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        showHostCard={false}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.getByTitle('MicroPython simulator for Alpha')).toBeInTheDocument();
  });

  it('loads MicroPython programs through iframe-backed adapters', async () => {
    const flashed: RuntimeProgram[] = [];

    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={async (_project, options) => {
          const adapter = await options.createAdapter?.({
            device: makeProject().devices[0]!,
            artifact: makeProject().artifacts[0]!,
            runtimeSource: 'micropython',
            program: {
              source: 'micropython',
              filesystem: { 'main.py': new TextEncoder().encode('radio.send("ping")') },
            },
          });
          await adapter?.flash({
            source: 'micropython',
            filesystem: { 'main.py': new TextEncoder().encode('radio.send("ping")') },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mp',
              status: 'loaded',
              runtimeSource: 'micropython',
              adapterName: adapter?.name,
            },
          ];
        }}
        createAdapter={(_prepared, _frameWindow, ready) => makeAdapter(flashed, ready)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(screen.getByText('loaded', { selector: 'strong[data-state]' })).toBeInTheDocument());
    expect(flashed).toHaveLength(1);
  });

  it('keeps loading disabled until the simulator posts its ready handshake', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Prepare runtime' })).toBeDisabled();
    expect(screen.getByText('0/1 simulator(s) ready')).toBeInTheDocument();

    dispatchReadyFor('MicroPython simulator for Alpha');

    expect(screen.getByRole('button', { name: 'Prepare runtime' })).toBeEnabled();
    expect(screen.getByText('1/1 simulator(s) ready')).toBeInTheDocument();
  });

  it('requires simulator-origin ready handshakes before enabling runtime preparation', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    const frame = screen.getByTitle('MicroPython simulator for Alpha') as HTMLIFrameElement;
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'https://evil.example',
        source: frame.contentWindow,
        data: { kind: 'ready' },
      }),
    );

    expect(screen.getByRole('button', { name: 'Prepare runtime' })).toBeDisabled();
    expect(screen.getByText('0/1 simulator(s) ready')).toBeInTheDocument();

    dispatchReadyFor('MicroPython simulator for Alpha');
    expect(screen.getByRole('button', { name: 'Prepare runtime' })).toBeEnabled();
  });

  it('keeps same-origin sandbox flags on MicroPython simulator iframes for local WASM loading', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.getByTitle('MicroPython simulator for Alpha')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin',
    );
  });

  it('keeps simulator frames mounted while focusing the selected device', () => {
    render(
      <MicroPythonRuntimeHost
        project={makeTwoMicroPythonDeviceProject()}
        selectedDeviceId="device-beta"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.getByTitle('MicroPython simulator for Alpha')).toBeInTheDocument();
    expect(screen.getByTitle('MicroPython simulator for Beta')).toBeInTheDocument();
  });

  it('preserves ready state for existing simulators when adding another MicroPython device', () => {
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    expect(screen.getByText('1/1 simulator(s) ready')).toBeInTheDocument();

    rerender(
      <MicroPythonRuntimeHost
        project={makeTwoMicroPythonDeviceProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
      />,
    );

    expect(screen.getByText('1/2 simulator(s) ready')).toBeInTheDocument();
  });

  it('preserves an existing device runtime when another selected device is prepared', async () => {
    const disposed: string[] = [];
    const created: string[] = [];
    const project = makeTwoMicroPythonDeviceProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={(prepared) => {
          created.push(prepared.device.id);
          return makeDisposableAdapter(disposed, [], prepared.device.id);
        }}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare selected' }));
    await waitFor(() => expect(screen.getByText(/device-alpha/)).toBeInTheDocument());

    rerender(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-beta"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={(prepared) => {
          created.push(prepared.device.id);
          return makeDisposableAdapter(disposed, [], prepared.device.id);
        }}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Beta');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare selected' }));
    await waitFor(() => expect(screen.getByText(/device-beta/)).toBeInTheDocument());

    expect(created).toEqual(['device-alpha', 'device-beta']);
    expect(disposed).toEqual([]);
  });

  it('can prepare all ready device runtimes even when one device is selected', async () => {
    const created: string[] = [];
    const project = makeTwoMicroPythonDeviceProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={(prepared) => {
          created.push(prepared.device.id);
          return makeAdapter([], true);
        }}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    dispatchReadyFor('MicroPython simulator for Beta');

    expect(screen.getByRole('button', { name: 'Prepare selected' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare all' }));

    await waitFor(() => expect(created).toEqual(['device-alpha', 'device-beta']));
  });

  it('resets selected and scenario runtimes without disposing prepared adapters', async () => {
    const resetDevices: string[] = [];
    const disposed: string[] = [];
    const project = makeTwoMicroPythonDeviceProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={(prepared) => makeResettableAdapter(resetDevices, disposed, prepared.device.id)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare selected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset selected runtime' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Reset selected runtime' }));
    await waitFor(() => expect(resetDevices).toEqual(['device-alpha']));

    rerender(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        scenarioResetSignal={1}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={(prepared) => makeResettableAdapter(resetDevices, disposed, prepared.device.id)}
      />,
    );

    await waitFor(() => expect(resetDevices).toEqual(['device-alpha', 'device-alpha']));
    expect(disposed).toEqual([]);
  });

  it('syncs engine-derived light and sound levels into prepared adapters', async () => {
    const sensorValues: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(17, 23)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() => makeSensorAdapter(sensorValues)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));

    await waitFor(() => expect(sensorValues).toEqual(['lightLevel:17', 'soundLevel:23']));

    rerender(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        deviceRuntimeStates={makeDeviceRuntimeStates(81, 5)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() => makeSensorAdapter(sensorValues)}
      />,
    );

    await waitFor(() =>
      expect(sensorValues).toEqual(['lightLevel:17', 'soundLevel:23', 'lightLevel:81', 'soundLevel:5']),
    );
  });

  it('forwards prepared adapter display changes with the originating device id', async () => {
    const displayChanges: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        showHostCard={false}
        autoPrepare
        prepareEnabled
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onDisplayChange={(deviceId, pixels) => displayChanges.push(`${deviceId}:${pixels.join('')}`)}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() => makeEventAdapter((listener) => {
          emitRuntimeEvent = listener;
        })}
      />,
    );
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    dispatchReadyFor('MicroPython simulator for Alpha');
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    emitRuntimeEvent?.({
      type: 'display-change',
      pixels: [9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9],
    });

    expect(displayChanges).toEqual(['device-alpha:9000909090009000909090009']);
  });

  it('forwards MicroPython adapter radio, serial, and sound events through host callbacks', async () => {
    const logs: string[] = [];
    const packets: string[] = [];
    const sounds: string[] = [];
    const hints: string[] = [];
    const forwardedPackets: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={(deviceId, packet) => {
          packets.push(`${deviceId}:${new TextDecoder().decode(packet.data)}`);
          return [
            {
              recipientId: 'device-alpha',
              packet: { data: new TextEncoder().encode('pong'), signalStrength: 4 },
            },
          ];
        }}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        onSoundOutput={(deviceId, level) => sounds.push(`${deviceId}:${level}`)}
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter(
            (listener) => {
              emitRuntimeEvent = listener;
            },
            (packet) => {
              forwardedPackets.push(new TextDecoder().decode(packet.data));
            },
          )
        }
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    emitRuntimeEvent?.({
      type: 'radio-output',
      packet: { data: new TextEncoder().encode('ping'), group: 17, channel: 9, signalStrength: 6 },
    });
    emitRuntimeEvent?.({
      type: 'radio-config-change',
      config: { group: 42, channel: 7, signalStrength: 5 },
    });
    emitRuntimeEvent?.({ type: 'serial-output', data: 'mp-receive' });
    emitRuntimeEvent?.({ type: 'sound-output', level: 7 });

    await waitFor(() => expect(forwardedPackets).toEqual(['pong']));
    expect(packets).toEqual(['device-alpha:ping']);
    expect(logs).toContain('device-alpha:mp-receive');
    expect(sounds).toEqual(['device-alpha:7']);
    expect(hints).toEqual(['device-alpha:42:9:6', 'device-alpha:17:9:6', 'device-alpha:42:7:5']);
  });

  it('deduplicates immediate identical radio packets from the same runtime device', async () => {
    const packets: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={(deviceId, packet) => {
          packets.push(`${deviceId}:${new TextDecoder().decode(packet.data)}`);
          return [];
        }}
        onRuntimeLog={() => {}}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    const packet = { data: new TextEncoder().encode('light:76'), group: 42 };
    emitRuntimeEvent?.({ type: 'radio-output', packet });
    emitRuntimeEvent?.({ type: 'radio-output', packet });

    expect(packets).toEqual(['device-alpha:light:76']);
  });

  it('deduplicates immediate identical serial outputs from the same runtime device', async () => {
    const logs: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    emitRuntimeEvent?.({ type: 'serial-output', data: 'light:66' });
    emitRuntimeEvent?.({ type: 'serial-output', data: 'light:66' });

    expect(logs).toEqual(['device-alpha:light:66']);
  });

  it('drops blank serial payloads so bridge-only whitespace does not create empty runtime log lines', async () => {
    const logs: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    emitRuntimeEvent?.({ type: 'serial-output', data: '\n' });
    emitRuntimeEvent?.({ type: 'serial-output', data: 'sound:13' });
    emitRuntimeEvent?.({ type: 'serial-output', data: '   ' });

    expect(logs).toEqual(['device-alpha:sound:13']);
  });

  it('filters malformed display frames with the same host guardrails used by MakeCode', async () => {
    const displayChanges: string[] = [];
    const logs: string[] = [];
    let emitRuntimeEvent: ((event: RuntimeAdapterEvent) => void) | undefined;
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={(deviceId, _type, message) => logs.push(`${deviceId}:${message}`)}
        onDisplayChange={(deviceId, pixels) => displayChanges.push(`${deviceId}:${pixels.join('')}`)}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() =>
          makeEventAdapter((listener) => {
            emitRuntimeEvent = listener;
          })
        }
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(emitRuntimeEvent).toBeDefined());

    emitRuntimeEvent?.({ type: 'display-change', pixels: [1, 2, 3] });
    emitRuntimeEvent?.({ type: 'display-change', pixels: [4, 5, 6] });
    emitRuntimeEvent?.({
      type: 'display-change',
      pixels: Array.from({ length: 25 }, (_, index) => (index === 24 ? 9 : 0)),
    });

    expect(logs.filter((entry) => entry.includes('MicroPython runtime emitted invalid LED data'))).toHaveLength(1);
    expect(displayChanges).toEqual(['device-alpha:0000000000000000000000009']);
  });

  it('publishes MicroPython radio config hints from prepared source', async () => {
    const hints: string[] = [];
    const project = makeProject();
    render(
      <MicroPythonRuntimeHost
        project={project}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onRadioConfigHint={(deviceId, config) => {
          hints.push(`${deviceId}:${config.group ?? 'none'}:${config.channel ?? 'none'}:${config.signalStrength ?? 'none'}`);
        }}
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() => makeAdapter([], true)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));

    await waitFor(() => expect(hints).toContain('device-alpha:42:9:6'));
  });

  it('auto-starts MicroPython programs in non-headless mode without request_flash', async () => {
    const project = makeProject();
    const frameLoadStatuses: string[][] = [];
    render(
      <MicroPythonRuntimeHost
        project={project}
        autoPrepare
        prepareEnabled
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => frameLoadStatuses.push(results.map((result) => result.status))}
        loadPrograms={async (_project, options) => {
          const device = project.devices[0]!;
          const artifact = project.artifacts[0]!;
          const program: RuntimeProgram = {
            source: 'micropython',
            filesystem: { 'main.py': new TextEncoder().encode('radio.send("ping")') },
          };
          const adapter = await options.createAdapter?.({
            device,
            artifact,
            runtimeSource: 'micropython',
            program,
          });
          await adapter?.flash(program);
          return [
            {
              deviceId: device.id,
              artifactId: artifact.id,
              status: 'loaded',
              runtimeSource: 'micropython',
              adapterName: adapter?.name,
            },
          ];
        }}
      />,
    );
    const frame = screen.getByTitle('MicroPython simulator for Alpha') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    dispatchReadyFor('MicroPython simulator for Alpha');

    await waitFor(() => expect(frameLoadStatuses.at(-1)).toEqual(['loaded']));
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'flash' }),
      new URL(MICRO_PYTHON_SIMULATOR_URL).origin,
    );
  });

  it('keeps MicroPython programs deferred in headless mode until request_flash', async () => {
    const project = makeProject();
    const frameLoadStatuses: string[][] = [];
    render(
      <MicroPythonRuntimeHost
        project={project}
        autoPrepare
        prepareEnabled
        headless
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => frameLoadStatuses.push(results.map((result) => result.status))}
        loadPrograms={async (_project, options) => {
          const device = project.devices[0]!;
          const artifact = project.artifacts[0]!;
          const program: RuntimeProgram = {
            source: 'micropython',
            filesystem: { 'main.py': new TextEncoder().encode('radio.send("ping")') },
          };
          const adapter = await options.createAdapter?.({
            device,
            artifact,
            runtimeSource: 'micropython',
            program,
          });
          await adapter?.flash(program);
          return [
            {
              deviceId: device.id,
              artifactId: artifact.id,
              status: 'loaded',
              runtimeSource: 'micropython',
              adapterName: adapter?.name,
            },
          ];
        }}
      />,
    );
    const frame = screen.getByTitle('MicroPython simulator for Alpha') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    dispatchReadyFor('MicroPython simulator for Alpha');

    await waitFor(() => expect(frameLoadStatuses.at(-1)).toEqual(['prepared']));
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'flash' }),
      new URL(MICRO_PYTHON_SIMULATOR_URL).origin,
    );

    fireEvent(
      window,
      new MessageEvent('message', {
        origin: new URL(MICRO_PYTHON_SIMULATOR_URL).origin,
        source: frame.contentWindow,
        data: { kind: 'request_flash' },
      }),
    );
    await waitFor(() =>
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'flash' }),
        new URL(MICRO_PYTHON_SIMULATOR_URL).origin,
      ),
    );
  });

  it('disposes adapter listeners when MicroPython devices are removed from the runtime set', async () => {
    const disposed: string[] = [];
    const unsubscribed: string[] = [];
    const project = makeProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        loadPrograms={async (_project, options) => {
          await options.createAdapter?.({
            device: project.devices[0]!,
            artifact: project.artifacts[0]!,
            runtimeSource: 'micropython',
            program: { source: 'micropython', filesystem: {} },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mp',
              status: 'loaded',
              runtimeSource: 'micropython',
            },
          ];
        }}
        createAdapter={(prepared) => makeDisposableAdapter(disposed, unsubscribed, prepared.device.id)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(screen.getByText('loaded', { selector: 'strong[data-state]' })).toBeInTheDocument());

    rerender(
      <MicroPythonRuntimeHost
        project={{ ...project, devices: [{ ...project.devices[0]!, programArtifactId: undefined }] }}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        createAdapter={(prepared) => makeDisposableAdapter(disposed, unsubscribed, prepared.device.id)}
      />,
    );

    await waitFor(() => {
      expect(unsubscribed).toEqual(['device-alpha']);
      expect(disposed).toEqual(['device-alpha']);
    });
  });

  it('disposes prepared adapters and clears runtime results when a device artifact changes', async () => {
    const disposed: string[] = [];
    const unsubscribed: string[] = [];
    const resultChanges: string[][] = [];
    const project = makeProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => resultChanges.push(results.map((result) => result.artifactId ?? 'none'))}
        loadPrograms={async (_project, options) => {
          await options.createAdapter?.({
            device: project.devices[0]!,
            artifact: project.artifacts[0]!,
            runtimeSource: 'micropython',
            program: { source: 'micropython', filesystem: {} },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mp',
              status: 'loaded',
              runtimeSource: 'micropython',
            },
          ];
        }}
        createAdapter={(prepared) => makeDisposableAdapter(disposed, unsubscribed, prepared.device.id)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(screen.getByText('loaded', { selector: 'strong[data-state]' })).toBeInTheDocument());

    rerender(
      <MicroPythonRuntimeHost
        project={withReplacementArtifact(project)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => resultChanges.push(results.map((result) => result.artifactId ?? 'none'))}
        createAdapter={(prepared) => makeDisposableAdapter(disposed, unsubscribed, prepared.device.id)}
      />,
    );

    await waitFor(() => {
      expect(unsubscribed).toEqual(['device-alpha']);
      expect(disposed).toEqual(['device-alpha']);
      expect(screen.queryByText('loaded', { selector: 'strong[data-state]' })).not.toBeInTheDocument();
      expect(resultChanges.at(-1)).toEqual([]);
    });
  });

  it('ignores in-flight runtime preparation after a device artifact changes', async () => {
    const continueLoad = deferred<void>();
    const createdAdapters: string[] = [];
    const resultChanges: string[][] = [];
    const project = makeProject();
    const { rerender } = render(
      <MicroPythonRuntimeHost
        project={project}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => resultChanges.push(results.map((result) => result.artifactId ?? 'none'))}
        loadPrograms={async (_project, options) => {
          await continueLoad.promise;
          await options.createAdapter?.({
            device: project.devices[0]!,
            artifact: project.artifacts[0]!,
            runtimeSource: 'micropython',
            program: { source: 'micropython', filesystem: {} },
          });
          return [
            {
              deviceId: 'device-alpha',
              artifactId: 'artifact-mp',
              status: 'loaded',
              runtimeSource: 'micropython',
            },
          ];
        }}
        createAdapter={(prepared) => {
          createdAdapters.push(prepared.artifact.id);
          return makeAdapter([], true);
        }}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));

    rerender(
      <MicroPythonRuntimeHost
        project={withReplacementArtifact(project)}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onLoadResultsChange={(results) => resultChanges.push(results.map((result) => result.artifactId ?? 'none'))}
        createAdapter={(prepared) => {
          createdAdapters.push(prepared.artifact.id);
          return makeAdapter([], true);
        }}
      />,
    );
    continueLoad.resolve();

    await waitFor(() => {
      expect(createdAdapters).toEqual([]);
      expect(screen.queryByText('loaded', { selector: 'strong[data-state]' })).not.toBeInTheDocument();
      expect(resultChanges.at(-1)).toEqual([]);
    });
  });
});

function dispatchReadyFor(title: string) {
  const frame = screen.getByTitle(title) as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent('message', {
      origin: new URL(MICRO_PYTHON_SIMULATOR_URL).origin,
      source: frame.contentWindow,
      data: { kind: 'ready' },
    }),
  );
}

function makeTwoMicroPythonDeviceProject(): SwarmProject {
  const project = makeProject();
  return {
    ...project,
    devices: [
      project.devices[0]!,
      {
        id: 'device-beta',
        name: 'Beta',
        position: { x: 160, y: 100 },
        programArtifactId: 'artifact-mp',
      },
    ],
  };
}

async function loadTargetProjectDevices(project: SwarmProject, options: LoadProjectRuntimeProgramsOptions) {
  return Promise.all(
    project.devices.map(async (device) => {
      const artifact = project.artifacts.find((candidate) => candidate.id === device.programArtifactId)!;
      const program: RuntimeProgram = {
        source: 'micropython',
        filesystem: {
          'main.py': new TextEncoder().encode('import radio\nradio.config(group=42, channel=9, power=6)\nradio.send("ping")'),
        },
      };
      const adapter = await options.createAdapter?.({
        device,
        artifact,
        runtimeSource: 'micropython',
        program,
      });
      await adapter?.flash(program);
      return {
        deviceId: device.id,
        artifactId: artifact.id,
        status: 'loaded' as const,
        runtimeSource: 'micropython' as const,
        adapterName: adapter?.name,
        program,
      };
    }),
  );
}

function makeProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'runtime-host-project', name: 'Runtime host', now }),
    artifacts: [
      {
        id: 'artifact-mp',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: new Uint8Array([1, 2, 3]),
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-alpha',
        name: 'Alpha',
        position: { x: 100, y: 100 },
        programArtifactId: 'artifact-mp',
      },
      {
        id: 'device-gamma',
        name: 'Gamma',
        position: { x: 200, y: 100 },
      },
    ],
    environmentSources: [],
  };
}

function withReplacementArtifact(project: SwarmProject): SwarmProject {
  return {
    ...project,
    artifacts: [
      ...project.artifacts,
      {
        id: 'artifact-mp-replacement',
        name: 'mp_replacement.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        bytes: new Uint8Array([4, 5, 6]),
        createdAt: now,
      },
    ],
    devices: project.devices.map((device) =>
      device.id === 'device-alpha'
        ? { ...device, programArtifactId: 'artifact-mp-replacement' }
        : device,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeAdapter(flashed: RuntimeProgram[], ready: boolean): MicrobitRuntimeAdapter {
  return {
    name: 'test iframe adapter',
    source: 'micropython',
    evaluateArtifact: () => ({
      artifactKind: 'hex',
      runtimeSource: 'micropython',
      sourceEvidence: [],
      canExecuteNow: true,
      verdict: 'test',
      capabilities: [],
    }),
    flash: async (program) => {
      if (!ready) {
        throw new Error('adapter created before simulator was ready');
      }
      flashed.push(program);
    },
    reset: async () => {},
    stop: async () => {},
    setButton: async () => {},
    setSensor: async () => {},
    sendRadio: async () => {},
    onEvent: () => () => {},
  };
}

function makeResettableAdapter(resetDevices: string[], disposed: string[], deviceId: string): MicrobitRuntimeAdapter {
  return {
    ...makeDisposableAdapter(disposed, [], deviceId),
    reset: async () => {
      resetDevices.push(deviceId);
    },
  };
}

function makeSensorAdapter(sensorValues: string[]): MicrobitRuntimeAdapter {
  return {
    ...makeAdapter([], true),
    setSensor: async (sensor, value) => {
      sensorValues.push(`${sensor}:${value}`);
    },
  };
}

function makeEventAdapter(
  captureListener: (listener: (event: RuntimeAdapterEvent) => void) => void,
  onSendRadio?: (packet: { data: Uint8Array }) => void,
): MicrobitRuntimeAdapter {
  return {
    ...makeAdapter([], true),
    sendRadio: async (packet) => {
      onSendRadio?.(packet);
    },
    onEvent: (listener) => {
      captureListener(listener);
      return () => {};
    },
  };
}

function makeDisposableAdapter(disposed: string[], unsubscribed: string[], deviceId: string): MicrobitRuntimeAdapter {
  return {
    ...makeAdapter([], true),
    onEvent: () => () => unsubscribed.push(deviceId),
    dispose: () => disposed.push(deviceId),
  } as MicrobitRuntimeAdapter & { dispose(): void };
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

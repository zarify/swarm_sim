import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlankProject, type SwarmProject } from '../domain/project';
import type { LoadProjectRuntimeProgramsOptions } from '../runtime/programLoader';
import type { MicrobitRuntimeAdapter, RuntimeProgram } from '../runtime/runtimeAdapter';
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

  it('loads prepared MicroPython programs through iframe-backed adapters', async () => {
    const flashed: RuntimeProgram[] = [];
    const radioConfigs: string[] = [];

    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onRuntimeRadioConfig={(deviceId, radio) => radioConfigs.push(`${deviceId}:${radio.group ?? 'none'}`)}
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

    await waitFor(() => expect(screen.getByText(/prepared/)).toBeInTheDocument());
    expect(flashed).toHaveLength(1);
    expect(radioConfigs).toEqual([]);
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

    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
    await waitFor(() => expect(screen.getByText(/device-beta/)).toBeInTheDocument());

    expect(created).toEqual(['device-alpha', 'device-beta']);
    expect(disposed).toEqual([]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));
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

  it('reports statically declared MicroPython radio group metadata after preparation', async () => {
    const radioConfigs: string[] = [];
    render(
      <MicroPythonRuntimeHost
        project={makeProject()}
        selectedDeviceId="device-alpha"
        onRadioPacket={() => []}
        onRuntimeLog={() => {}}
        onRuntimeRadioConfig={(deviceId, radio) =>
          radioConfigs.push(`${deviceId}:${radio.group}:${radio.channel ?? 'default'}:${radio.signalStrength ?? 'default'}`)
        }
        loadPrograms={loadTargetProjectDevices}
        createAdapter={() => makeAdapter([], true)}
      />,
    );
    dispatchReadyFor('MicroPython simulator for Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare runtime' }));

    await waitFor(() => expect(radioConfigs).toEqual(['device-alpha:42:default:default']));
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
    await waitFor(() => expect(screen.getByText(/prepared/)).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText(/prepared/)).toBeInTheDocument());

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
      expect(screen.queryByText(/prepared/)).not.toBeInTheDocument();
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
      expect(screen.queryByText(/prepared/)).not.toBeInTheDocument();
      expect(resultChanges.at(-1)).toEqual([]);
    });
  });
});

function dispatchReadyFor(title: string) {
  const frame = screen.getByTitle(title) as HTMLIFrameElement;
  fireEvent(
    window,
    new MessageEvent('message', {
      origin: 'https://python-simulator.usermbit.org',
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
          'main.py': new TextEncoder().encode('import radio\nradio.config(group=42)\nradio.send("ping")'),
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

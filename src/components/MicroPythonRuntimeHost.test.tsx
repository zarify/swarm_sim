import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlankProject, type SwarmProject } from '../domain/project';
import type { MicrobitRuntimeAdapter, RuntimeProgram } from '../runtime/runtimeAdapter';
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

    fireEvent.click(screen.getByRole('button', { name: 'Load MicroPython runtimes' }));

    await waitFor(() => expect(screen.getByText(/loaded/)).toBeInTheDocument());
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

    expect(screen.getByRole('button', { name: 'Load MicroPython runtimes' })).toBeDisabled();
    expect(screen.getByText('0/1 simulator(s) ready')).toBeInTheDocument();

    dispatchReadyFor('MicroPython simulator for Alpha');

    expect(screen.getByRole('button', { name: 'Load MicroPython runtimes' })).toBeEnabled();
    expect(screen.getByText('1/1 simulator(s) ready')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Load MicroPython runtimes' }));
    await waitFor(() => expect(screen.getByText(/loaded/)).toBeInTheDocument());

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

function makeDisposableAdapter(disposed: string[], unsubscribed: string[], deviceId: string): MicrobitRuntimeAdapter {
  return {
    ...makeAdapter([], true),
    onEvent: () => () => unsubscribed.push(deviceId),
    dispose: () => disposed.push(deviceId),
  } as MicrobitRuntimeAdapter & { dispose(): void };
}

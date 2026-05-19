import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { vi } from 'vitest';
import type { MicroPythonRuntimeHostProps } from './MicroPythonRuntimeHost';
import { SwarmCanvasPanel } from './SwarmCanvasPanel';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';

describe('SwarmCanvasPanel', () => {
  beforeEach(() => {
    if (typeof window.localStorage?.clear === 'function') {
      window.localStorage.clear();
    }
    vi.restoreAllMocks();
  });

  it('renders the spatial canvas with reset-only runtime controls', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    expect(screen.getByText(/1 nodes \//)).toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifact execution gate')).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset all' })[0]!);
    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
  });

  it('adds devices without bypassing engine-derived telemetry', () => {
    const { container } = render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/3 nodes \//)).toBeInTheDocument();
    expect(screen.getAllByText('Node 3').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(3);
  });

  it('renames selected devices from the side panel and truncates long names for display', () => {
    const { container } = render(<SwarmCanvasPanel />);
    const longName = 'Extremely descriptive node name that exceeds display limits';

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: longName } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    const sidebarName = container.querySelector('.selection-name');
    expect(sidebarName).toHaveAttribute('title', longName);
    expect(sidebarName?.textContent?.endsWith('…')).toBe(true);
    expect(container.querySelector('.node-label')?.textContent?.endsWith('…')).toBe(true);
  });

  it('cancels rename edits when the inline input loses focus', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'Cancelled name' } });
    fireEvent.blur(renameInput);

    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cancelled name')).not.toBeInTheDocument();
  });

  it('keeps device interaction honest and inspection panels compact', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('button', { name: /Press A|Press B|Send ping/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime group')).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Not exposed')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Event log for Alpha')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Radio message inspector')).not.toHaveAttribute('open');
  });

  it('assigns uploaded code to the selected device without showing MicroPython host chrome', async () => {
    render(<SwarmCanvasPanel />);

    const file = new File([makeHexWithAscii('MicroPython')], 'mp.hex', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/Load code onto Alpha/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset selected' })).toBeEnabled();
  });

  it('assigns MakeCode fixture HEX files and classifies their runtime source', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('mc_beacon.hex', makeCodeBeaconHex);
    fireEvent.change(screen.getByLabelText(/Load code onto Alpha/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode simulator for Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unable to identify this HEX/)).not.toBeInTheDocument();
  }, 30000);

  it('keeps valid HEX assignments even when runtime source cannot yet be identified', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('unknown.hex', makeHexWithAscii('hello'));
    fireEvent.change(screen.getByLabelText(/Load code onto Alpha/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: unknown.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: unknown')).toBeInTheDocument();
    expect(
      screen.getByText(/Assigned, but runtime source could not be identified yet/),
    ).toBeInTheDocument();
  });

  it('keeps the latest selected-device upload when an older read finishes later', async () => {
    render(<SwarmCanvasPanel />);
    const slowUpload = makeDeferredUpload('slow.hex');
    const input = screen.getByLabelText(/Load code onto Alpha/);

    fireEvent.change(input, { target: { files: [slowUpload.file] } });
    fireEvent.change(input, {
      target: { files: [makeUploadFile('fast.hex', makeHexWithAscii('MicroPython'))] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: fast.hex')).toBeInTheDocument());
    slowUpload.resolve(makeHexWithAscii('MicroPython'));

    await waitFor(() => expect(screen.getByText('Assigned: fast.hex')).toBeInTheDocument());
    expect(screen.queryByText('Assigned: slow.hex')).not.toBeInTheDocument();
  });

  it('supports dropping a .hex file anywhere in the right sidebar for the selected device', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.drop(screen.getByLabelText('Canvas controls and selection details'), {
      dataTransfer: {
        files: [makeUploadFile('dropped.hex', makeHexWithAscii('MicroPython'))],
        types: ['Files'],
      },
    });

    await waitFor(() => expect(screen.getByText('Assigned: dropped.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
  });

  it('prompts before overwriting existing code on a device', async () => {
    render(<SwarmCanvasPanel />);
    const input = screen.getByLabelText(/Load code onto Alpha/);
    fireEvent.change(input, { target: { files: [makeUploadFile('first.hex', makeHexWithAscii('MicroPython'))] } });
    await waitFor(() => expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(input, { target: { files: [makeUploadFile('second.hex', makeHexWithAscii('MicroPython'))] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument();
    expect(screen.queryByText('Assigned: second.hex')).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('deletes the selected device node from the canvas', () => {
    const { container } = render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete node' }));
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(0);
  });

  it('keeps runtime hosts hidden until devices have assigned runtime artifacts', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/2 nodes \//)).toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
  });

  it('keeps both runtime simulators mounted when MicroPython and MakeCode devices are assigned together', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.change(screen.getByLabelText(/Load code onto Alpha/), {
      target: { files: [makeUploadFile('mp.hex', makeHexWithAscii('MicroPython'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mc_beacon.hex', makeCodeBeaconHex)] },
    });
    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });

    expect(screen.getByTitle('MicroPython simulator for Alpha')).toBeInTheDocument();
    expect(screen.getByTitle('MakeCode simulator for Node 2')).toBeInTheDocument();
  }, 30000);

  it('draws canvas LEDs from live runtime display-change events instead of decorative pixels', async () => {
    const pixels = [9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9];
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <DisplayEmitterHost {...props} pixels={pixels} />} />);

    await waitFor(() => {
      expect(container.querySelector('[data-led-pixel="device-alpha:0"]')).toHaveClass('led-pixel--lit');
      expect(container.querySelector('[data-led-pixel="device-alpha:1"]')).not.toHaveClass('led-pixel--lit');
      expect(container.querySelector('[data-led-pixel="device-alpha:6"]')).toHaveClass('led-pixel--lit');
    });
  });

  it('shows transient runtime activity rings for radio transmit and sound output', async () => {
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <ActivityEmitterHost {...props} />} />);

    await waitFor(() => {
      expect(container.querySelector('[data-runtime-activity="tx:device-alpha"]')).toHaveClass('runtime-activity--active');
      expect(container.querySelector('[data-runtime-activity="sound:device-alpha"]')).toHaveClass('runtime-activity--active');
    });
  });

  it('normalizes invalid runtime radio signal-strength values instead of crashing the panel', async () => {
    const { container } = render(
      <SwarmCanvasPanel RuntimeHost={(props) => <InvalidSignalStrengthHost {...props} />} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-runtime-activity="tx:device-alpha"]')).toHaveClass(
        'runtime-activity--active',
      );
    });
    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
  });

  it('updates sender range from runtime tx power packets so radio radius reflects power', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <SignalStrengthRangeHost {...props} />} />);

    await waitFor(() => {
      const rangeValue = screen.getByText('Range').parentElement?.querySelector('dd');
      expect(rangeValue).toHaveTextContent('240');
    });
  });

  it('updates sender range from runtime radio config hints that include tx power', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <SignalStrengthHintHost {...props} />} />);

    await waitFor(() => {
      const rangeValue = screen.getByText('Range').parentElement?.querySelector('dd');
      expect(rangeValue).toHaveTextContent('240');
    });
  });

  it('shows serial output in runtime logs and renders compact radio packet previews', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <SerialAndRadioEmitterHost {...props} />} />);

    const deviceLog = screen.getByLabelText('Event log for Alpha');
    const radioInspector = screen.getByLabelText('Radio message inspector');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);
    fireEvent.click(radioInspector.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getAllByText('sound:13').length).toBeGreaterThanOrEqual(2));
  });

  it('applies runtime radio config hints before routing immediate packets', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Received radio packet from Alpha')).toBeInTheDocument());
    expect(screen.queryByText('Blocked radio packet from Alpha: group-mismatch')).not.toBeInTheDocument();
  });

  it('renders renamed sender display names in runtime radio log lines', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'sensors' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Received radio packet from sensors')).toBeInTheDocument());
  });

  it('uses autogenerated fallback names and keeps radio identity keyed by device id', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    let renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: '   ' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'Alpha' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    const renamedDeviceLog = screen.getByLabelText('Event log for Alpha');
    fireEvent.click(renamedDeviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Received radio packet from Alpha')).toBeInTheDocument());
  });

  it('deduplicates immediate identical runtime radio packets before routing', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <DuplicateRadioPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() =>
      expect(screen.getByText('Received radio packet from Alpha')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Received radio packet from Alpha')).toHaveLength(1);
  });

  it('pulses canvas device buttons into runtime state so hosts can consume button input', async () => {
    const buttonStates: string[] = [];
    render(<SwarmCanvasPanel RuntimeHost={(props) => <ButtonProbeHost {...props} buttonStates={buttonStates} />} />);

    fireEvent.pointerDown(screen.getByTestId('device-button-device-alpha-A'));

    await waitFor(() => expect(buttonStates).toContain('true:false'));
    await waitFor(() => expect(buttonStates).toContain('false:false'));
  });

  it('saves a layout to browser storage and can load it back from the canvas-state menu', async () => {
    render(<SwarmCanvasPanel />);

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Layout one');
    fireEvent.click(screen.getByRole('button', { name: 'Canvas state' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to browser' }));

    await waitFor(() => expect(promptSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load Layout one' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    expect(screen.getByText(/2 nodes \//)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load Layout one' }));

    await waitFor(() => expect(screen.getByText(/1 nodes \//)).toBeInTheDocument());
  });

  it('prompts before clearing the canvas and only clears after confirmation', async () => {
    render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas state' }));

    const declineSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear canvas' }));
    await waitFor(() => expect(declineSpy).toHaveBeenCalled());
    expect(screen.getByText(/1 nodes \//)).toBeInTheDocument();

    declineSpy.mockRestore();
    const acceptSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear canvas' }));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/0 nodes \//)).toBeInTheDocument());
  });

  it('rejects legacy json uploads in the canvas bundle importer', async () => {
    render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas state' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const legacyBundle = new File(['{"schemaVersion":1}'], 'legacy.swarm.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Upload bundle'), {
      target: { files: [legacyBundle] },
    });

    await waitFor(() =>
      expect(screen.getByText('Unsupported canvas bundle format')).toBeInTheDocument(),
    );
  });

});

function DisplayEmitterHost({
  onDisplayChange,
  pixels,
}: MicroPythonRuntimeHostProps & { pixels: number[] }) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    onDisplayChange?.('device-alpha', pixels);
  }, [onDisplayChange, pixels]);

  return <div aria-label="MicroPython runtime host" />;
}

function ActivityEmitterHost({
  onRadioPacket,
  onSoundOutput,
}: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioPacket('device-alpha', { data: new Uint8Array([0x01]) });
      onSoundOutput?.('device-alpha', 9);
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioPacket, onSoundOutput]);

  return <div aria-label="MicroPython runtime host" />;
}

function InvalidSignalStrengthHost({ onRadioPacket }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioPacket('device-alpha', {
        data: new Uint8Array([0x01]),
        signalStrength: -52,
      });
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioPacket]);

  return <div aria-label="MicroPython runtime host" />;
}

function SignalStrengthRangeHost({ onRadioPacket }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioPacket('device-alpha', {
        data: new Uint8Array([0x01]),
        signalStrength: 7,
      });
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioPacket]);

  return <div aria-label="MicroPython runtime host" />;
}

function SignalStrengthHintHost({ onRadioConfigHint }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioConfigHint?.('device-alpha', { signalStrength: 7 });
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioConfigHint]);

  return <div aria-label="MicroPython runtime host" />;
}

function ButtonProbeHost({
  deviceRuntimeStates,
  buttonStates,
}: MicroPythonRuntimeHostProps & { buttonStates: string[] }) {
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    const runtime = deviceRuntimeStates?.['device-alpha'];
    if (!runtime) {
      return;
    }
    const snapshot = `${runtime.buttons.A}:${runtime.buttons.B}`;
    if (last.current === snapshot) {
      return;
    }
    last.current = snapshot;
    buttonStates.push(snapshot);
  }, [deviceRuntimeStates, buttonStates]);

  return <div aria-label="MicroPython runtime host" />;
}

function SerialAndRadioEmitterHost({ onRadioPacket, onRuntimeLog }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRuntimeLog('device-alpha', 'serial-output', 'sound:13');
      onRadioPacket('device-alpha', { data: makeMakeCodeValuePacket('sound', 13) });
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioPacket, onRuntimeLog]);

  return <div aria-label="MicroPython runtime host" />;
}

function RadioConfigThenPacketHost({ project, onRadioConfigHint, onRadioPacket }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current || !project.devices.some((device) => device.id === 'device-2')) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioConfigHint?.('device-alpha', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      onRadioPacket('device-alpha', { data: new Uint8Array([0x01]), signalStrength: 7 });
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [project, onRadioConfigHint, onRadioPacket]);

  return <div aria-label="MicroPython runtime host" />;
}

function DuplicateRadioPacketHost({ project, onRadioConfigHint, onRadioPacket }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current || !project.devices.some((device) => device.id === 'device-2')) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioConfigHint?.('device-alpha', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      const packet = { data: new Uint8Array([0x01]), signalStrength: 7 };
      onRadioPacket('device-alpha', packet);
      onRadioPacket('device-alpha', packet);
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [project, onRadioConfigHint, onRadioPacket]);

  return <div aria-label="MicroPython runtime host" />;
}


function makeHexWithAscii(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  return `${makeHexRecord(0, 0, bytes)}\n${makeHexRecord(0, 1, [])}`;
}

function makeUploadFile(name: string, contents: string): File {
  return {
    name,
    text: async () => contents,
  } as File;
}

function makeDeferredUpload(name: string): {
  file: File;
  resolve: (contents: string) => void;
} {
  let resolveText!: (contents: string) => void;
  return {
    file: {
      name,
      text: () => new Promise<string>((resolve) => {
        resolveText = resolve;
      }),
    } as File,
    resolve: (contents: string) => resolveText(contents),
  };
}

function makeHexRecord(address: number, recordType: number, data: number[]): string {
  const bytes = [data.length, address >> 8, address & 0xff, recordType, ...data];
  const checksum = (-bytes.reduce((total, byte) => total + byte, 0)) & 0xff;
  return `:${[...bytes, checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function makeMakeCodeValuePacket(name: string, value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 1; // PACKET_TYPE_VALUE
  const view = new DataView(bytes.buffer);
  view.setInt32(9, value, true);
  const encodedName = new TextEncoder().encode(name.slice(0, 8));
  bytes[13] = encodedName.length;
  bytes.set(encodedName, 14);
  return bytes;
}

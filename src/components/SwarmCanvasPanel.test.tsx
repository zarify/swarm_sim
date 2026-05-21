import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { unzipSync } from 'fflate';
import { useEffect, useRef } from 'react';
import { vi } from 'vitest';
import type { MicroPythonRuntimeHostProps, RoutedRadioDelivery } from './MicroPythonRuntimeHost';
import { SwarmCanvasPanel, translateRuntimeRadioPacketForRecipient } from './SwarmCanvasPanel';
import makeCodeBeaconHex from '../../hex_files/mc_beacon.hex?raw';

describe('SwarmCanvasPanel', () => {
  beforeEach(() => {
    if (typeof window.localStorage?.clear === 'function') {
      window.localStorage.clear();
    }
    vi.restoreAllMocks();
  });

  function openSwarmTools() {
    if (!screen.queryByRole('button', { name: 'Save to browser' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    }
  }

  function addDeviceFromSwarmTools() {
    openSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
  }

  it('renders the spatial canvas with reset-only runtime controls', () => {
    const { container } = render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('heading', { name: 'Spatial radio bench' })).not.toBeInTheDocument();
    expect(screen.getByText('v0.2.0')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open project repository on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/zarify/swarm_sim',
    );
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Debug tools' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifact execution gate')).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset all' })[0]!);
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
  });

  it('shows and dismisses the startup instructions with Escape', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument();
  });

  it('dismisses the startup instructions from the close button', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Close instructions' }));
    expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument();
  });

  it('dismisses the startup instructions when clicking anywhere on the splash', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('dialog', { name: 'Simulator instructions' }));
    expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument();
  });

  it('keeps telemetry in the debug modal by default', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('dialog', { name: 'Debug tools' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    expect(screen.getByRole('dialog', { name: 'Debug tools' })).toBeInTheDocument();
    expect(screen.getByText(/1 nodes \//)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close debug tools' }));
    expect(screen.queryByRole('dialog', { name: 'Debug tools' })).not.toBeInTheDocument();
  });

  it('adds devices without bypassing engine-derived telemetry', () => {
    const { container } = render(<SwarmCanvasPanel />);

    addDeviceFromSwarmTools();
    addDeviceFromSwarmTools();

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

    expect(screen.getAllByText('Node 1').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cancelled name')).not.toBeInTheDocument();
  });

  it('keeps device interaction honest and inspection panels compact', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('button', { name: /Press A|Press B|Send ping/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime group')).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Not exposed')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Event log for Node 1')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Radio message inspector')).not.toHaveAttribute('open');
  });

  it('assigns uploaded code to the selected device without showing MicroPython host chrome', async () => {
    render(<SwarmCanvasPanel />);

    const file = new File([makeHexWithAscii('MicroPython')], 'mp.hex', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reset$/ })).toBeEnabled();
  });

  it('assigns MakeCode fixture HEX files and classifies their runtime source', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('mc_beacon.hex', makeCodeBeaconHex);
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode simulator for Node 1')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unable to identify this HEX/)).not.toBeInTheDocument();
  }, 30000);

  it('keeps valid HEX assignments even when runtime source cannot yet be identified', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('unknown.hex', makeHexWithAscii('hello'));
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
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
    const input = screen.getByLabelText(/Load code onto Node 1/);

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
    const input = screen.getByLabelText(/Load code onto Node 1/);
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
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(0);
  });

  it('keeps runtime hosts hidden until devices have assigned runtime artifacts', () => {
    render(<SwarmCanvasPanel />);

    addDeviceFromSwarmTools();

    expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
  });

  it('keeps both runtime simulators mounted when MicroPython and MakeCode devices are assigned together', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [makeUploadFile('mp.hex', makeHexWithAscii('MicroPython'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());

    addDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mc_beacon.hex', makeCodeBeaconHex)] },
    });
    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });

    expect(screen.getByTitle('MicroPython simulator for Node 1')).toBeInTheDocument();
    expect(screen.getByTitle('MakeCode simulator for Node 2')).toBeInTheDocument();
  }, 30000);

  it('draws canvas LEDs from live runtime display-change events instead of decorative pixels', async () => {
    const pixels = [9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9, 0, 0, 0, 9, 0, 9, 0, 9, 0, 0, 0, 9];
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <DisplayEmitterHost {...props} pixels={pixels} />} />);

    await waitFor(() => {
      expect(container.querySelector('[data-led-pixel="device-1:0"]')).toHaveClass('led-pixel--lit');
      expect(container.querySelector('[data-led-pixel="device-1:1"]')).not.toHaveClass('led-pixel--lit');
      expect(container.querySelector('[data-led-pixel="device-1:6"]')).toHaveClass('led-pixel--lit');
    });
  });

  it('shows transient runtime activity rings for radio transmit and sound output', async () => {
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <ActivityEmitterHost {...props} />} />);

    await waitFor(() => {
      expect(container.querySelector('[data-runtime-activity="tx:device-1"]')).toHaveClass('runtime-activity--active');
      expect(container.querySelector('[data-runtime-activity="sound:device-1"]')).toHaveClass('runtime-activity--active');
      expect(container.querySelector('[data-runtime-sound-indicator="device-1"]')).toBeInTheDocument();
    });
  });

  it('logs sound start once for bursty runtime sound events', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <BurstSoundEmitterHost {...props} />} />);

    const deviceLog = screen.getByLabelText('Event log for Node 1');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() =>
      expect(screen.getByText('Sound output started (level 9)')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Sound output started (level 9)')).toHaveLength(1);
    expect(
      screen
        .getByText('Sound output started (level 9)')
        .closest('.device-log__line')
        ?.querySelector('.device-log__type'),
    ).toHaveTextContent('snd');
  });

  it('normalizes invalid runtime radio signal-strength values instead of crashing the panel', async () => {
    const { container } = render(
      <SwarmCanvasPanel RuntimeHost={(props) => <InvalidSignalStrengthHost {...props} />} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-runtime-activity="tx:device-1"]')).toHaveClass(
        'runtime-activity--active',
      );
    });
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();

    const deviceLog = screen.getByLabelText('Event log for Node 1');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);
    const diagnostic = await screen.findByText('Ignored invalid runtime radio signal strength: -52');
    expect(diagnostic.closest('.device-log__line')?.querySelector('.device-log__type')).toHaveTextContent('err');
  });

  it('updates sender range from runtime tx power packets so radio radius reflects power', async () => {
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <SignalStrengthRangeHost {...props} />} />);

    await waitFor(() => {
      expect(container.querySelector('.radio-radius')).toHaveAttribute('r', '240');
    });
  });

  it('updates sender range from runtime radio config hints that include tx power', async () => {
    const { container } = render(<SwarmCanvasPanel RuntimeHost={(props) => <SignalStrengthHintHost {...props} />} />);

    await waitFor(() => {
      expect(container.querySelector('.radio-radius')).toHaveAttribute('r', '240');
    });
  });

  it('shows serial output in runtime logs and renders compact radio packet previews', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <SerialAndRadioEmitterHost {...props} />} />);

    const deviceLog = screen.getByLabelText('Event log for Node 1');
    const radioInspector = screen.getByLabelText('Radio message inspector');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);
    fireEvent.click(radioInspector.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getAllByText('sound:13').length).toBeGreaterThanOrEqual(2));
  });

  it('applies runtime radio config hints before routing immediate packets', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    addDeviceFromSwarmTools();
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Received radio packet from Node 1')).toBeInTheDocument());
    expect(screen.queryByText('Blocked radio packet from Node 1: group-mismatch')).not.toBeInTheDocument();
  });

  it('renders renamed sender display names in runtime radio log lines', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'sensors' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    addDeviceFromSwarmTools();
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Received radio packet from sensors')).toBeInTheDocument());
  });

  it('renders renamed sender display names in radio inspector meta lines', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'sensors' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    addDeviceFromSwarmTools();
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const radioInspector = screen.getByLabelText('Radio message inspector');
    fireEvent.click(radioInspector.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText(/sensors to 1 received/i)).toBeInTheDocument());
  });

  it('uses autogenerated fallback names and keeps radio identity keyed by device id', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <RadioConfigThenPacketHost {...props} />} />);

    addDeviceFromSwarmTools();
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

    await waitFor(() => expect(screen.getByText('Received radio packet from Node 1')).toBeInTheDocument());
  });

  it('deduplicates immediate identical runtime radio packets before routing', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <DuplicateRadioPacketHost {...props} />} />);

    addDeviceFromSwarmTools();
    await waitFor(() => expect(screen.getAllByText('Node 2').length).toBeGreaterThan(0));

    const deviceLog = screen.getByLabelText('Event log for Node 2');
    fireEvent.click(deviceLog.querySelector('summary') as HTMLElement);

    await waitFor(() =>
      expect(screen.getByText('Received radio packet from Node 1')).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Received radio packet from Node 1')).toHaveLength(1);
  });

  it('translates mixed-runtime radio packets between MakeCode and MicroPython devices', async () => {
    const mcToMp = translateRuntimeRadioPacketForRecipient(
      { data: makeMakeCodeValuePacket('light', 76) },
      'makecode-pxt',
      'micropython',
    );
    expect(new TextDecoder().decode(mcToMp.data)).toBe('light:76');

    const mpToMc = translateRuntimeRadioPacketForRecipient(
      { data: new TextEncoder().encode('sound:13') },
      'micropython',
      'makecode-pxt',
    );
    expect(describeMakeCodeValuePacket(mpToMc.data)).toBe('value:sound:13');
  });

  it('keeps sender runtime group when translating MicroPython text packets for MakeCode recipients', async () => {
    const deliveredPackets: RoutedRadioDelivery[][] = [];
    const { container } = render(
      <SwarmCanvasPanel
        RuntimeHost={(props) => (
          <MicroPythonToMakeCodeDeliveryProbeHost
            {...props}
            onDeliveries={(deliveries) => deliveredPackets.push(deliveries)}
          />
        )}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [makeUploadFile('mp.hex', makeHexWithAscii('MicroPython'))] },
    });
    await waitFor(() => expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument());

    addDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mc_beacon.hex', makeCodeBeaconHex)] },
    });
    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });

    await waitFor(() => expect(deliveredPackets.length).toBeGreaterThan(0));
    const firstDelivery = deliveredPackets.at(-1)?.[0];
    expect(firstDelivery?.recipientId).toBe('device-2');
    expect(firstDelivery?.packet.group).toBe(42);
    expect(describeMakeCodeValuePacket(firstDelivery?.packet.data ?? new Uint8Array())).toBe(
      'value:light:77',
    );

    const alphaNode = container.querySelector('[data-runtime-activity="tx:device-1"]');
    expect(alphaNode).toBeInTheDocument();
    const canvas = container.querySelector('.swarm-canvas') as SVGElement;
    Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn(), configurable: true });
    fireEvent.pointerDown(alphaNode as Element);
    const senderDeviceLog = screen.getByLabelText('Event log for Node 1');
    fireEvent.click(senderDeviceLog.querySelector('summary') as HTMLElement);
    await waitFor(() => expect(screen.getByText('Sent radio packet to 1 recipient(s)')).toBeInTheDocument());
    expect(
      screen.queryByText(/Translated MicroPython radio payload for MakeCode recipient:/i),
    ).not.toBeInTheDocument();
  }, 30000);

  it('shows a per-device error runtime state when runtime internal errors are reported', async () => {
    const { container } = render(
      <SwarmCanvasPanel RuntimeHost={(props) => <RuntimeErrorEmitterHost {...props} />} />,
    );

    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [makeUploadFile('mp.hex', makeHexWithAscii('MicroPython'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());

    await waitFor(() =>
      expect(container.querySelector('[data-runtime-state="device-1:error"]')).toBeInTheDocument(),
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Reset$/ }));
    await waitFor(() =>
      expect(container.querySelector('[data-runtime-state="device-1:error"]')).not.toBeInTheDocument(),
    );
  });

  it('pulses canvas A, B, and A+B controls into runtime state so hosts can consume button input', async () => {
    const buttonStates: string[] = [];
    const { container } = render(
      <SwarmCanvasPanel RuntimeHost={(props) => <ButtonProbeHost {...props} buttonStates={buttonStates} />} />,
    );

    fireEvent.pointerDown(screen.getByTestId('device-button-device-1-A'));

    await waitFor(() => expect(buttonStates).toContain('true:false'));
    await waitFor(() => expect(buttonStates).toContain('false:false'));

    fireEvent.pointerDown(screen.getByTestId('device-button-device-1-B'));

    await waitFor(() => expect(buttonStates).toContain('false:true'));
    await waitFor(() => expect(buttonStates).toContain('false:false'));

    fireEvent.pointerDown(screen.getByTestId('device-button-device-1-AB'));

    await waitFor(() => expect(buttonStates).toContain('true:true'));
    await waitFor(() => expect(buttonStates).toContain('false:false'));
    expect(container.querySelector('[data-device-button-combo-link="device-1"]')).toBeInTheDocument();
  });

  it('saves a layout to browser storage and can load it back from the canvas-state menu', async () => {
    const { container } = render(<SwarmCanvasPanel />);

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Layout one');
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to browser' }));

    await waitFor(() => expect(promptSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load Layout one' })).toBeInTheDocument());

    addDeviceFromSwarmTools();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Load Layout one' }));

    await waitFor(() => expect(container.querySelectorAll('.microbit-node')).toHaveLength(1));
  });

  it('deletes individual saved layouts from the canvas-state menu', async () => {
    render(<SwarmCanvasPanel />);

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Layout one');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to browser' }));

    await waitFor(() => expect(promptSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load Layout one' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete Layout one' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load Layout one' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('No saved layouts yet.')).toBeInTheDocument();
  });

  it('downloads runtime log files as a zip archive with device-name-prefixed MY_DATA files', async () => {
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => 'blob:runtime-logs');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<SwarmCanvasPanel RuntimeHost={(props) => <RuntimeDataLogEmitterHost {...props} />} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'Sensors Hub' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    const downloadLogsButton = screen.getByRole('button', { name: 'Download log files' });
    await waitFor(() => expect(downloadLogsButton).toBeEnabled());
    fireEvent.click(downloadLogsButton);

    const archiveBlob = await waitFor(() => {
      const object = createObjectURLSpy.mock.calls.at(-1)?.[0];
      expect(object).toBeInstanceOf(Blob);
      const blob = object as Blob;
      expect(blob.type).toBe('application/zip');
      return blob;
    });
    const archiveBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read archive blob'));
      reader.readAsArrayBuffer(archiveBlob);
    });
    const archiveBytes = new Uint8Array(archiveBuffer);
    const archive = unzipSync(archiveBytes);
    const fileNames = Object.keys(archive);
    expect(fileNames.some((name) => name === 'sensors-hub-MY_DATA.html')).toBe(true);
    expect(screen.getByText('Downloaded log files for 1 device')).toBeInTheDocument();
  });

  it('prompts before clearing the canvas and only clears after confirmation', async () => {
    const { container } = render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));

    const declineSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear canvas' }));
    await waitFor(() => expect(declineSpy).toHaveBeenCalled());
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(1);

    declineSpy.mockRestore();
    const acceptSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear canvas' }));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('.microbit-node')).toHaveLength(0));
  });

  it('rejects legacy json uploads in the canvas bundle importer', async () => {
    render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
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

  it('selects the full node name when entering rename mode', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name') as HTMLInputElement;

    expect(renameInput.selectionStart).toBe(0);
    expect(renameInput.selectionEnd).toBe(renameInput.value.length);
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
    onDisplayChange?.('device-1', pixels);
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
      onRadioPacket('device-1', { data: new Uint8Array([0x01]) });
      onSoundOutput?.('device-1', 9);
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [onRadioPacket, onSoundOutput]);

  return <div aria-label="MicroPython runtime host" />;
}

function BurstSoundEmitterHost({ onSoundOutput }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current || !onSoundOutput) {
      return;
    }
    emitted.current = true;
    onSoundOutput('device-1', 9);
    onSoundOutput('device-1', 9);
    onSoundOutput('device-1', 9);
  }, [onSoundOutput]);

  return <div aria-label="MicroPython runtime host" />;
}

function RuntimeDataLogEmitterHost({ onRuntimeDataLog }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    if (emitted.current || !onRuntimeDataLog) {
      return;
    }
    emitted.current = true;
    onRuntimeDataLog('device-1', {
      type: 'data-log-output',
      entry: {
        headings: ['time', 'temp'],
        data: ['1', '22'],
      },
    });
  }, [onRuntimeDataLog]);

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
      onRadioPacket('device-1', {
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
      onRadioPacket('device-1', {
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
      onRadioConfigHint?.('device-1', { signalStrength: 7 });
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
    const runtime = deviceRuntimeStates?.['device-1'];
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
      onRuntimeLog('device-1', 'serial-output', 'sound:13');
      onRadioPacket('device-1', { data: makeMakeCodeValuePacket('sound', 13) });
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
      onRadioConfigHint?.('device-1', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      onRadioPacket('device-1', { data: new Uint8Array([0x01]), signalStrength: 7 });
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
      onRadioConfigHint?.('device-1', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      const packet = { data: new Uint8Array([0x01]), signalStrength: 7 };
      onRadioPacket('device-1', packet);
      onRadioPacket('device-1', packet);
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [project, onRadioConfigHint, onRadioPacket]);

  return <div aria-label="MicroPython runtime host" />;
}

function RuntimeErrorEmitterHost({ project, onRuntimeLog }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    const alpha = project.devices.find((device) => device.id === 'device-1');
    if (emitted.current || !alpha?.programArtifactId) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRuntimeLog('device-1', 'internal-error', 'Simulated runtime crash');
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [project, onRuntimeLog]);

  return <div aria-label="MicroPython runtime host" />;
}

function MicroPythonToMakeCodeDeliveryProbeHost({
  project,
  onRadioConfigHint,
  onRadioPacket,
  onDeliveries,
}: MicroPythonRuntimeHostProps & { onDeliveries: (deliveries: RoutedRadioDelivery[]) => void }) {
  const emitted = useRef(false);
  useEffect(() => {
    const alpha = project.devices.find((device) => device.id === 'device-1');
    const node2 = project.devices.find((device) => device.id === 'device-2');
    if (emitted.current || !alpha?.programArtifactId || !node2?.programArtifactId) {
      return;
    }

    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioConfigHint?.('device-1', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      onDeliveries(
        onRadioPacket('device-1', {
          data: new TextEncoder().encode('light:77'),
        }),
      );
    }, 0);
    return () => globalThis.clearTimeout(timerId);
  }, [project, onRadioConfigHint, onRadioPacket, onDeliveries]);

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

function describeMakeCodeValuePacket(data: Uint8Array): string {
  if (data[0] !== 1 || data.length < 14) {
    return 'none';
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const value = view.getInt32(9, true);
  const nameLength = Math.max(0, Math.min(data[13] ?? 0, 8, data.length - 14));
  const name = new TextDecoder().decode(data.slice(14, 14 + nameLength));
  return `value:${name}:${value}`;
}

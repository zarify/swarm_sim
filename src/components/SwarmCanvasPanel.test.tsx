import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { unzipSync } from 'fflate';
import { useEffect, useRef } from 'react';
import { vi } from 'vitest';
import type { MicroPythonRuntimeHostProps, RoutedRadioDelivery } from './MicroPythonRuntimeHost';
const workingCopyStorageState = vi.hoisted(() => ({
  items: new Map<string, string>(),
}));

vi.mock('../domain/browserWorkingCopyStore', async () => {
  const actual =
    await vi.importActual<typeof import('../domain/browserWorkingCopyStore')>(
      '../domain/browserWorkingCopyStore'
    );
  const storage: Storage = {
    get length() {
      return workingCopyStorageState.items.size;
    },
    clear: () => workingCopyStorageState.items.clear(),
    getItem: (key) => workingCopyStorageState.items.get(key) ?? null,
    key: (index) => [...workingCopyStorageState.items.keys()][index] ?? null,
    removeItem: (key) => {
      workingCopyStorageState.items.delete(key);
    },
    setItem: (key, value) => {
      workingCopyStorageState.items.set(key, value);
    },
  };
  return {
    ...actual,
    createBrowserWorkingCopyStore: () =>
      actual.createBrowserWorkingCopyStore({ indexedDbFactory: undefined, storage }),
  };
});

import {
  SwarmCanvasPanel,
  shouldGuardGlobalFileDrop,
  translateRuntimeRadioPacketForRecipient,
} from './SwarmCanvasPanel';
import { createBlankProject, type SwarmProject } from '../domain/project';
import { serializeProject } from '../domain/projectSerialization';
import { FEATURE_FLAGS } from '../runtime/featureFlags';
import {
  decodeMicroPythonRadioString,
  encodeMicroPythonRadioString,
} from '../runtime/micropythonIframeAdapter';

describe('SwarmCanvasPanel', () => {
  beforeEach(() => {
    if (typeof window.localStorage?.clear === 'function') {
      window.localStorage.clear();
    }
    workingCopyStorageState.items.clear();
    vi.restoreAllMocks();
  });

  function openSwarmTools() {
    if (!screen.queryByRole('button', { name: 'Save to browser' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    }
  }

  function getSaveCanvasButton() {
    return screen.getByRole('button', { name: /Save canvas/i });
  }

  function addDeviceFromSwarmTools() {
    openSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
  }

  function setAddLockedMode(enabled: boolean) {
    openSwarmTools();
    const checkbox = screen.getByRole('checkbox', { name: 'Add locked' });
    if ((checkbox as HTMLInputElement).checked !== enabled) {
      fireEvent.click(checkbox);
    }
  }

  function addLockedDeviceFromSwarmTools() {
    setAddLockedMode(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    setAddLockedMode(false);
  }

  function stubCanvasGeometry(canvas: SVGElement) {
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 860,
        bottom: 520,
        width: 860,
        height: 520,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(canvas, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(canvas, 'releasePointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(canvas, 'hasPointerCapture', { configurable: true, value: () => false });
  }

  it('renders the spatial canvas with reset-only runtime controls', () => {
    const { container } = render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('heading', { name: 'Spatial radio bench' })).not.toBeInTheDocument();
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeInTheDocument();
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
    fireEvent.click(screen.getAllByRole('button', { name: /^Reset$/ })[0]!);
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
  });

  it('uses compact glyph controls with tooltips in the header and canvas-state menu', () => {
    render(<SwarmCanvasPanel />);

    const saveButton = getSaveCanvasButton();
    expect(saveButton).toHaveAttribute('title', 'Save current canvas for the next browser session');
    expect(saveButton).toHaveTextContent('Not saved');

    const swarmToolsButton = screen.getByRole('button', { name: 'Swarm tools' });
    expect(swarmToolsButton).toHaveAttribute('title', 'Open swarm tools');

    fireEvent.click(swarmToolsButton);
    const actions = screen.getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim());
    expect(actions.indexOf('⬇ Download bundle')).toBeLessThan(actions.indexOf('Download log files'));
    expect(screen.getByLabelText('Upload bundle').closest('label')).toHaveAttribute('title', 'Upload canvas bundle');
    expect(screen.getByRole('checkbox', { name: 'Add locked' })).not.toBeChecked();
  });

  it('shows and dismisses the startup instructions with Escape', async () => {
    render(<SwarmCanvasPanel />);

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument(),
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument(),
    );
  });

  it('dismisses the startup instructions from the close button', async () => {
    render(<SwarmCanvasPanel />);

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close instructions' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument(),
    );
  });

  it('dismisses the startup instructions when clicking anywhere on the splash', async () => {
    render(<SwarmCanvasPanel />);

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('dialog', { name: 'Simulator instructions' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Simulator instructions' })).not.toBeInTheDocument(),
    );
  });

  it('saves custom instructions, renders markdown, and lets the user reopen them from the header', async () => {
    render(<SwarmCanvasPanel />);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    openSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));

    expect(screen.getByRole('dialog', { name: 'Canvas instructions editor' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Canvas instructions markdown'), {
      target: {
        value: '# Lesson steps\n\n- Press `A`\n- Open the log\n\n```python\nradio.send("ping")\n```',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));

    expect(screen.getByRole('button', { name: 'Show instructions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show instructions' }));

    const splash = screen.getByRole('dialog', { name: 'Simulator instructions' });
    expect(splash).toBeInTheDocument();
    expect(screen.getByText('Instructions')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lesson steps' })).toBeInTheDocument();
    expect(screen.getByText('A', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('radio.send("ping")', { selector: 'code' })).toBeInTheDocument();
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

  it('adds locked devices with a visible lock badge in the selection card', () => {
    const { container } = render(<SwarmCanvasPanel />);

    addLockedDeviceFromSwarmTools();

    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);
    expect(screen.getByText('Locked', { selector: '.selection-name-badge' })).toBeInTheDocument();
    expect(screen.getByText('The first successful code upload will be its only assignment.')).toBeInTheDocument();
  });

  it('supports toggleable pinning for regular devices and permanent pinning for locked devices', () => {
    const { container } = render(<SwarmCanvasPanel />);

    const regularPinButton = screen.getByRole('button', { name: 'Pin device position' });
    expect(regularPinButton).toHaveAttribute('title', 'Pin device position');
    fireEvent.click(regularPinButton);
    expect(screen.getByRole('button', { name: 'Unpin device position' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Unpin device position' }));
    expect(screen.getByRole('button', { name: 'Pin device position' })).toHaveAttribute('aria-pressed', 'false');

    addLockedDeviceFromSwarmTools();

    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);
    const lockedPinButton = screen.getByRole('button', { name: 'Pin device position permanently' });
    expect(screen.getByRole('button', { name: 'Rename selected node' })).toBeEnabled();
    fireEvent.click(lockedPinButton);

    expect(screen.getByRole('button', { name: 'Pinned device position permanently' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename selected node' })).toBeDisabled();
    expect(
      screen.getByText('This device is locked in place on the canvas and cannot be moved, renamed, or unlocked.'),
    ).toBeInTheDocument();
  });

  it('locks pinned environment source properties and rename controls when added in locked mode', () => {
    if (!FEATURE_FLAGS.light) {
      return;
    }

    const { container } = render(<SwarmCanvasPanel />);

    setAddLockedMode(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add light' }));
    setAddLockedMode(false);

    expect(container.querySelectorAll('.source-node--light')).toHaveLength(1);
    expect(screen.getByText('Locked', { selector: '.selection-name-badge' })).toBeInTheDocument();
    expect(screen.getByLabelText('Radius')).toBeEnabled();
    expect(screen.getByLabelText('Peak level (micro:bit scale)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rename selected node' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Pin node position permanently' }));

    expect(screen.getByRole('button', { name: 'Pinned node position permanently' })).toBeDisabled();
    expect(screen.getByLabelText('Radius')).toBeDisabled();
    expect(screen.getByLabelText('Peak level (micro:bit scale)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename selected node' })).toBeDisabled();
    expect(
      screen.getByText('This node is locked in place and its properties cannot be changed.'),
    ).toBeInTheDocument();
  });

  it('keeps unlocked source controls editable when the source is pinned', () => {
    if (!FEATURE_FLAGS.light) {
      return;
    }

    render(<SwarmCanvasPanel />);

    openSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Add light' }));

    const radius = screen.getByLabelText('Radius');
    const peakLevel = screen.getByLabelText('Peak level (micro:bit scale)');
    fireEvent.click(screen.getByRole('button', { name: 'Pin node position' }));

    expect(screen.getByRole('button', { name: 'Unpin node position' })).toBeEnabled();
    expect(radius).toBeEnabled();
    expect(peakLevel).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rename selected node' })).toBeEnabled();
  });

  it('blocks a stale rename commit after a locked source becomes permanently pinned', () => {
    if (!FEATURE_FLAGS.light) {
      return;
    }

    render(<SwarmCanvasPanel />);

    setAddLockedMode(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add light' }));
    setAddLockedMode(false);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name');
    fireEvent.change(renameInput, { target: { value: 'Locked renamed light' } });

    fireEvent.click(screen.getByRole('button', { name: 'Pin node position permanently' }));
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    expect(screen.getByText('Light 1', { selector: '.selection-name' })).toBeInTheDocument();
    expect(screen.queryByText('Locked renamed light', { selector: '.selection-name' })).not.toBeInTheDocument();
  });

  it('persists the radio range overlay through current-canvas save and restore', async () => {
    const { container, unmount } = render(<SwarmCanvasPanel />);

    openSwarmTools();
    const radioRangeToggle = screen.getByRole('checkbox', { name: 'Radio range overlay' });
    fireEvent.click(radioRangeToggle);
    expect(container.querySelectorAll('.radio-radius')).toHaveLength(0);
    expect(getSaveCanvasButton()).toHaveTextContent('Unsaved');

    fireEvent.click(getSaveCanvasButton());
    await waitFor(() => expect(getSaveCanvasButton()).toHaveTextContent('Saved'));

    unmount();

    const restored = render(<SwarmCanvasPanel />);
    await waitFor(() => expect(getSaveCanvasButton()).toHaveTextContent('Saved'));
    fireEvent.keyDown(window, { key: 'Escape' });
    openSwarmTools();

    expect(screen.getByRole('checkbox', { name: 'Radio range overlay' })).not.toBeChecked();
    expect(restored.container.querySelectorAll('.radio-radius')).toHaveLength(0);
  });

  it('handles magnet source controls according to feature flags', () => {
    const { container } = render(<SwarmCanvasPanel />);

    openSwarmTools();
    if (FEATURE_FLAGS.magnet) {
      fireEvent.click(screen.getByRole('button', { name: 'Add magnet' }));
      expect(container.querySelectorAll('.source-node--magnet')).toHaveLength(1);
      expect(screen.getByText('Magnet source')).toBeInTheDocument();
      expect(screen.getByLabelText('Angle')).toBeInTheDocument();
      expect(screen.getByLabelText('Strength (µT, microtesla)')).toBeInTheDocument();
      return;
    }

    expect(screen.queryByRole('button', { name: 'Add magnet' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('.source-node--magnet')).toHaveLength(0);
    expect(screen.queryByText('Mag strength')).not.toBeInTheDocument();
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

    const file = new File([makeMicroPythonHex('radio.send("ping")')], 'mp.hex', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode runtime host')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Reset$/ })[0]!).toBeEnabled();
  });

  it('assigns MakeCode fixture HEX files and classifies their runtime source', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('mc_beacon.hex', makeMakeCodeHex({ 'main.ts': 'radio.sendString("ping")' }));
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Runtime source: makecode-pxt')).toBeInTheDocument(), {
      timeout: 12000,
    });
    expect(screen.queryByLabelText('MicroPython runtime host')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('MakeCode simulator for Node 1')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unable to identify this HEX/)).not.toBeInTheDocument();
  });

  it('opens a code editor for uploaded MicroPython code and persists saved source edits', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [makeUploadFile('mp.hex', makeMicroPythonHex('radio.send("ping")'))] },
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit code' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit code' }));

    const editor = screen.getByRole('dialog', { name: 'Code editor for Node 1' });
    expect(editor).toBeInTheDocument();
    const sourceField = screen.getByLabelText('Editing main.py for Node 1');
    fireEvent.change(sourceField, { target: { value: 'radio.send("edited")\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Code editor for Node 1' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Editable source:/)).toHaveTextContent('saved changes ready');

    fireEvent.click(screen.getByRole('button', { name: 'Edit code' }));
    expect(screen.getByLabelText('Editing main.py for Node 1')).toHaveValue('radio.send("edited")\n');
  });

  it('keeps source edits forked per device when two devices share the same uploaded artifact', async () => {
    Object.defineProperty(SVGSVGElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(SVGSVGElement.prototype, 'releasePointerCapture', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(SVGSVGElement.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    });
    const { container } = render(<SwarmCanvasPanel />);
    addDeviceFromSwarmTools();

    const sharedFile = makeUploadFile('shared.hex', makeMicroPythonHex('radio.send("shared")'));
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [sharedFile] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: shared.hex')).toBeInTheDocument());

    fireEvent.pointerDown(container.querySelectorAll('.microbit-node')[0]!, {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [sharedFile] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: shared.hex')).toBeInTheDocument());

    fireEvent.pointerDown(container.querySelectorAll('.microbit-node')[1]!, {
      button: 0,
      pointerId: 2,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit code' }));
    fireEvent.change(screen.getByLabelText('Editing main.py for Node 2'), {
      target: { value: 'radio.send("node-1")\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Code editor for Node 2' })).not.toBeInTheDocument());

    fireEvent.pointerDown(container.querySelectorAll('.microbit-node')[0]!, {
      button: 0,
      pointerId: 3,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit code' }));
    expect(screen.getByLabelText('Editing main.py for Node 1')).toHaveValue('radio.send("shared")');
  });

  it('rejects unextractable HEX uploads', async () => {
    render(<SwarmCanvasPanel />);

    const file = makeUploadFile('unknown.hex', makeHexWithAscii('hello'));
    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(
        screen.getByText('No embedded MicroPython or MakeCode source found in HEX artifact'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('No code assigned yet')).toBeInTheDocument();
    expect(
      screen.queryByText('Assigned: unknown.hex'),
    ).not.toBeInTheDocument();
  });

  it('keeps the latest selected-device upload when an older read finishes later', async () => {
    render(<SwarmCanvasPanel />);
    const slowUpload = makeDeferredUpload('slow.hex');
    const input = screen.getByLabelText(/Load code onto Node 1/);

    fireEvent.change(input, { target: { files: [slowUpload.file] } });
    fireEvent.change(input, {
      target: { files: [makeUploadFile('fast.hex', makeMicroPythonHex('radio.send("fast")'))] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: fast.hex')).toBeInTheDocument());
    slowUpload.resolve(makeMicroPythonHex('radio.send("slow")'));

    await waitFor(() => expect(screen.getByText('Assigned: fast.hex')).toBeInTheDocument());
    expect(screen.queryByText('Assigned: slow.hex')).not.toBeInTheDocument();
  });

  it('supports dropping a .hex file anywhere in the right sidebar for the selected device', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.drop(screen.getByLabelText('Canvas controls and selection details'), {
      dataTransfer: {
        files: [makeUploadFile('dropped.hex', makeMicroPythonHex('radio.send("drop")'))],
        types: ['Files'],
      },
    });

    await waitFor(() => expect(screen.getByText('Assigned: dropped.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
  });

  it('prompts before overwriting existing code on a device', async () => {
    render(<SwarmCanvasPanel />);
    const input = screen.getByLabelText(/Load code onto Node 1/);
    fireEvent.change(input, { target: { files: [makeUploadFile('first.hex', makeMicroPythonHex('radio.send("one")'))] } });
    await waitFor(() => expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(input, { target: { files: [makeUploadFile('second.hex', makeMicroPythonHex('radio.send("two")'))] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument();
    expect(screen.queryByText('Assigned: second.hex')).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('allows one successful upload to a locked device, then hides code inspection and overwrite UI', async () => {
    render(<SwarmCanvasPanel />);

    addLockedDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mystery.hex', makeMicroPythonHex('radio.send("mystery")'))] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mystery.hex')).toBeInTheDocument());
    expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit code' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Load code onto Node 2/)).not.toBeInTheDocument();
    expect(screen.getByText('Locked after first code upload.')).toBeInTheDocument();
    expect(screen.getByText('Source is hidden and this device cannot be overwritten.')).toBeInTheDocument();
  });

  it('blocks later overwrite attempts on locked devices through sidebar drop', async () => {
    render(<SwarmCanvasPanel />);

    addLockedDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('first.hex', makeMicroPythonHex('radio.send("one")'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument());

    fireEvent.drop(screen.getByLabelText('Canvas controls and selection details'), {
      dataTransfer: {
        files: [makeUploadFile('second.hex', makeMicroPythonHex('radio.send("two")'))],
        types: ['Files'],
      },
    });

    await waitFor(() =>
      expect(screen.getByText('Node 2 is locked after its first successful code upload.')).toBeInTheDocument(),
    );
    expect(screen.getByText('Assigned: first.hex')).toBeInTheDocument();
    expect(screen.queryByText('Assigned: second.hex')).not.toBeInTheDocument();
  });

  it('deletes the selected device node from the canvas', () => {
    const { container } = render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(0);
  });

  it('keeps regular devices draggable while preventing movement on pinned locked devices', () => {
    const { container } = render(<SwarmCanvasPanel />);
    const canvas = container.querySelector('.swarm-canvas') as SVGElement;
    stubCanvasGeometry(canvas);

    const regularNode = container.querySelectorAll('.microbit-node')[0] as SVGGElement;
    fireEvent.click(screen.getByRole('button', { name: 'Pin device position' }));
    fireEvent.pointerDown(regularNode, { pointerId: 1, clientX: 430, clientY: 260 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 120, clientY: 120 });
    expect(regularNode).toHaveAttribute('transform', 'translate(430 260)');

    fireEvent.click(screen.getByRole('button', { name: 'Unpin device position' }));
    fireEvent.pointerDown(regularNode, { pointerId: 2, clientX: 430, clientY: 260 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 100, clientY: 100 });
    expect(regularNode).toHaveAttribute('transform', 'translate(100 100)');

    addLockedDeviceFromSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Pin device position permanently' }));

    const nodes = container.querySelectorAll('.microbit-node');
    const fixedLockedNode = nodes[1] as SVGGElement;
    const fixedLockedTransform = fixedLockedNode.getAttribute('transform');

    expect(fixedLockedTransform).toBeTruthy();
    fireEvent.pointerDown(fixedLockedNode, { pointerId: 3, clientX: 526, clientY: 260 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 160, clientY: 160 });

    expect(screen.getByRole('button', { name: 'Pinned device position permanently' })).toBeDisabled();
    expect(
      screen.getByText('This device is locked in place on the canvas and cannot be moved, renamed, or unlocked.'),
    ).toBeInTheDocument();
    expect(fixedLockedNode).toHaveAttribute('transform', fixedLockedTransform!);
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
      target: { files: [makeUploadFile('mp.hex', makeMicroPythonHex('radio.send("ping")'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());

    addDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mc_beacon.hex', makeMakeCodeHex({ 'main.ts': 'radio.sendString("ping")' }))] },
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

  it('redacts radio inspector payloads when the sender is a locked device', async () => {
    render(<SwarmCanvasPanel RuntimeHost={(props) => <LockedSenderRadioHost {...props} />} />);

    addLockedDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('locked.hex', makeMicroPythonHex('radio.send("hidden")'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: locked.hex')).toBeInTheDocument());

    const radioInspector = screen.getByLabelText('Radio message inspector');
    fireEvent.click(radioInspector.querySelector('summary') as HTMLElement);

    await waitFor(() => expect(screen.getByText('Broadcast hidden for locked device')).toBeInTheDocument());
    expect(screen.getByText(/Node 2 to 1 received/i)).toBeInTheDocument();
    expect(screen.queryByText('secret lesson')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));

    expect(screen.getByText('Broadcast hidden for locked device')).toBeInTheDocument();
    expect(screen.queryByText('secret lesson')).not.toBeInTheDocument();
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

  it('translates MakeCode packets into simplified MicroPython byte payloads', async () => {
    const cases = [
      { name: 'number packets', input: makeMakeCodeNumberPacket(123), expected: '123' },
      { name: 'value packets', input: makeMakeCodeValuePacket('light', 76), expected: 'light:76' },
      { name: 'string packets', input: makeMakeCodeStringPacket('ping'), expected: 'ping' },
      { name: 'double packets', input: makeMakeCodeDoublePacket(12.5), expected: '12.5' },
      { name: 'double value packets', input: makeMakeCodeDoubleValuePacket('temp', 23.75), expected: 'temp:23.75' },
      { name: 'ascii buffer packets', input: makeMakeCodeBufferPacket([...'pong'].map((char) => char.charCodeAt(0))), expected: 'pong' },
    ];

    for (const testCase of cases) {
      const translated = translateRuntimeRadioPacketForRecipient(
        { data: testCase.input },
        'makecode-pxt',
        'micropython',
      );
      expect(decodeMicroPythonRadioString(translated.data), testCase.name).toBe(testCase.expected);
    }
  });

  it('translates MicroPython text payloads into MakeCode packets when possible', async () => {
    const cases = [
      { name: 'prefixed MicroPython strings', input: encodeMicroPythonRadioString('ping'), expected: 'string:ping' },
      { name: 'plain numeric bytes', input: new TextEncoder().encode('123'), expected: 'number:123' },
      { name: 'plain key/value bytes', input: new TextEncoder().encode('sound:13'), expected: 'value:sound:13' },
      { name: 'plain floating-point bytes', input: new TextEncoder().encode('12.5'), expected: 'double:12.5' },
      { name: 'plain floating-point key/value bytes', input: new TextEncoder().encode('temp:23.75'), expected: 'double-value:temp:23.75' },
      {
        name: 'long key/value bytes fall back to string packets',
        input: new TextEncoder().encode('very_long_name:23'),
        expected: 'string:very_long_name:23',
      },
    ];

    for (const testCase of cases) {
      const translated = translateRuntimeRadioPacketForRecipient(
        { data: testCase.input },
        'micropython',
        'makecode-pxt',
      );
      expect(describeMakeCodePacket(translated.data), testCase.name).toBe(testCase.expected);
    }
  });

  it('passes through unsupported cross-platform radio payloads unchanged', async () => {
    const makeCodeBinary = makeMakeCodeBufferPacket([0xff, 0x00, 0x01]);
    const mcToMp = translateRuntimeRadioPacketForRecipient(
      { data: makeCodeBinary },
      'makecode-pxt',
      'micropython',
    );
    expect([...mcToMp.data]).toEqual([...makeCodeBinary]);

    const microPythonBinary = new Uint8Array([0xff, 0x00, 0x01]);
    const mpToMc = translateRuntimeRadioPacketForRecipient(
      { data: microPythonBinary },
      'micropython',
      'makecode-pxt',
    );
    expect([...mpToMc.data]).toEqual([...microPythonBinary]);

    const alreadyTypedMakeCodePacket = makeMakeCodeValuePacket('light', 22);
    const typedPassThrough = translateRuntimeRadioPacketForRecipient(
      { data: alreadyTypedMakeCodePacket },
      'micropython',
      'makecode-pxt',
    );
    expect([...typedPassThrough.data]).toEqual([...alreadyTypedMakeCodePacket]);
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
      target: { files: [makeUploadFile('mp.hex', makeMicroPythonHex('radio.send("ping")'))] },
    });
    await waitFor(() => expect(screen.getByText('Runtime source: micropython')).toBeInTheDocument());

    addDeviceFromSwarmTools();
    fireEvent.change(screen.getByLabelText(/Load code onto Node 2/), {
      target: { files: [makeUploadFile('mc_beacon.hex', makeMakeCodeHex({ 'main.ts': 'radio.sendString("ping")' }))] },
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
      target: { files: [makeUploadFile('mp.hex', makeMicroPythonHex('radio.send("ping")'))] },
    });
    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());

    await waitFor(() =>
      expect(container.querySelector('[data-runtime-state="device-1:error"]')).toBeInTheDocument(),
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /^Reset$/ })[0]!);
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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to browser' }));

    await waitFor(() => expect(promptSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load Layout one' })).toBeInTheDocument());

    addDeviceFromSwarmTools();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Load Layout one' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelectorAll('.microbit-node')).toHaveLength(1));
  });

  it('saves the current canvas for the next browser session and restores it on remount', async () => {
    const { container, unmount } = render(<SwarmCanvasPanel />);

    addDeviceFromSwarmTools();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);
    fireEvent.click(getSaveCanvasButton());

    await waitFor(() =>
      expect(getSaveCanvasButton()).toHaveTextContent('Saved'),
    );

    unmount();

    const rerendered = render(<SwarmCanvasPanel />);
    await waitFor(() => expect(rerendered.container.querySelectorAll('.microbit-node')).toHaveLength(2));
    await waitFor(() =>
      expect(getSaveCanvasButton()).toHaveTextContent('Saved'),
    );
  });

  it('restores saved custom instructions on remount and reopens the splash with them', async () => {
    const { unmount } = render(<SwarmCanvasPanel />);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    openSwarmTools();
    fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));
    fireEvent.change(screen.getByLabelText('Canvas instructions markdown'), {
      target: { value: '# Welcome back\n\n- Resume from node 2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    fireEvent.click(getSaveCanvasButton());

    await waitFor(() =>
      expect(getSaveCanvasButton()).toHaveTextContent('Saved'),
    );

    unmount();

    render(<SwarmCanvasPanel />);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show instructions' })).toBeInTheDocument();
  });

  it('falls back to the default quick start when loading a saved layout without custom instructions', async () => {
    const { container } = render(<SwarmCanvasPanel />);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    openSwarmTools();
    vi.spyOn(window, 'prompt').mockReturnValue('Default layout');
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save to browser' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Load Default layout' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));
    fireEvent.change(screen.getByLabelText('Canvas instructions markdown'), {
      target: { value: '# Teacher note\n\n- Keep radios on group 7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));
    fireEvent.change(screen.getByLabelText('Canvas instructions markdown'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(screen.queryByRole('button', { name: 'Show instructions' })).not.toBeInTheDocument();

    addDeviceFromSwarmTools();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Load Default layout' }));

    await waitFor(() => expect(container.querySelectorAll('.microbit-node')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show instructions' })).not.toBeInTheDocument();
  });

  it('saves the current canvas after code is loaded onto a device', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.change(screen.getByLabelText(/Load code onto Node 1/), {
      target: { files: [makeUploadFile('mp.hex', makeMicroPythonHex('radio.send("persist")'))] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());
    fireEvent.click(getSaveCanvasButton());

    await waitFor(() =>
      expect(getSaveCanvasButton()).toHaveTextContent('Saved'),
    );
  });

  it('keeps runtime-only reset actions from marking the canvas dirty', async () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(getSaveCanvasButton());
    await waitFor(() =>
      expect(getSaveCanvasButton()).toHaveTextContent('Saved'),
    );

    fireEvent.click(screen.getAllByRole('button', { name: /^Reset$/ })[0]!);

    expect(getSaveCanvasButton()).toHaveTextContent('Saved');
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

  it('shows custom instructions when importing a swarm bundle with them', async () => {
    render(<SwarmCanvasPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Swarm tools' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.change(screen.getByLabelText('Upload bundle'), {
      target: { files: [makeSwarmBundleFile(makeProjectWithInstructions('Imported lesson'))] },
    });

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Imported lesson' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show instructions' })).toBeInTheDocument();
  });

  it('selects the full node name when entering rename mode', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const renameInput = screen.getByLabelText('Edit node name') as HTMLInputElement;

    expect(renameInput.selectionStart).toBe(0);
    expect(renameInput.selectionEnd).toBe(renameInput.value.length);
  });

  it('guards global file drops outside allowed targets', () => {
    const allowedRoot = document.createElement('div');
    const allowedChild = document.createElement('button');
    allowedRoot.append(allowedChild);
    const outsideTarget = document.createElement('div');

    expect(
      shouldGuardGlobalFileDrop(
        {
          dataTransfer: { types: ['Files'] } as unknown as DataTransfer,
          target: allowedChild,
          composedPath: () => [allowedChild, allowedRoot],
        },
        [allowedRoot],
      ),
    ).toBe(false);

    expect(
      shouldGuardGlobalFileDrop(
        {
          dataTransfer: { types: ['Files'] } as unknown as DataTransfer,
          target: outsideTarget,
          composedPath: () => [outsideTarget],
        },
        [allowedRoot],
      ),
    ).toBe(true);

    expect(
      shouldGuardGlobalFileDrop(
        {
          dataTransfer: { types: ['text/plain'] } as unknown as DataTransfer,
          target: outsideTarget,
          composedPath: () => [outsideTarget],
        },
        [allowedRoot],
      ),
    ).toBe(false);
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

function LockedSenderRadioHost({ project, onRadioConfigHint, onRadioPacket }: MicroPythonRuntimeHostProps) {
  const emitted = useRef(false);
  useEffect(() => {
    const lockedDevice = project.devices.find((device) => device.id === 'device-2');
    if (emitted.current || !lockedDevice?.programArtifactId) {
      return;
    }
    emitted.current = true;
    const timerId = globalThis.setTimeout(() => {
      onRadioConfigHint?.('device-1', { group: 42 });
      onRadioConfigHint?.('device-2', { group: 42 });
      onRadioPacket('device-2', { data: new TextEncoder().encode('secret lesson'), signalStrength: 7 });
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

function makeMakeCodeHex(sourceFiles: Record<string, string>): string {
  const encoder = new TextEncoder();
  const metadata = encoder.encode('{}');
  const sourceText = encoder.encode(JSON.stringify(sourceFiles));
  const header = new Uint8Array(16);
  header.set([0x41, 0x14, 0x0e, 0x2f, 0xb8, 0x2f, 0xa2, 0xbb]);
  writeUInt16LE(header, 8, metadata.length);
  writeUInt32LE(header, 10, sourceText.length);

  return [
    makeHexRecord(0x0000, 0x0e, [...header]),
    ...chunkBytes(new Uint8Array([...metadata, ...sourceText]), 16).map((chunk, index) =>
      makeHexRecord(0x0010 + index * 16, 0x0e, [...chunk]),
    ),
    makeHexRecord(0x0000, 0x01, []),
  ].join('\n');
}

function makeMicroPythonHex(mainPy: string): string {
  const encoder = new TextEncoder();
  const filename = encoder.encode('main.py');
  const source = encoder.encode(mainPy);
  const chunk = new Uint8Array(128).fill(0xff);
  const dataStart = 3 + filename.length;
  chunk[0] = 0xfe;
  chunk[1] = dataStart + source.length - 1;
  chunk[2] = filename.length;
  chunk.set(filename, 3);
  chunk.set(source, dataStart);

  return [
    ...chunkBytes(chunk, 16).map((record, index) => makeHexRecord(index * 16, 0x00, [...record])),
    makeHexRecord(0, 0x01, []),
  ].join('\n');
}

function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function writeUInt16LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUInt32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function makeUploadFile(name: string, contents: string): File {
  return {
    name,
    text: async () => contents,
  } as File;
}

function makeSwarmBundleFile(project: SwarmProject): File {
  const bundleBytes = makeSwarmBundleBytes(project);
  const bundleBinary = Array.from(bundleBytes, (byte) => String.fromCharCode(byte)).join('');
  return new File([bundleBinary], `${project.name}.swarm`, {
    type: 'application/octet-stream',
  });
}

function makeSwarmBundleBytes(project: SwarmProject): Uint8Array {
  const payload = new TextEncoder().encode(serializeProject(project));
  const bytes = new Uint8Array(7 + payload.length);
  bytes.set([0x53, 0x57, 0x41, 0x52, 0x4d, 0x02, 0x00], 0);
  bytes.set(payload, 7);
  return bytes;
}

function makeProjectWithInstructions(heading: string): SwarmProject {
  const now = '2026-06-06T01:20:00.000Z';
  return {
    ...createBlankProject({ id: 'bundle-instructions', name: 'Bundle instructions', now }),
    instructionsMarkdown: `# ${heading}\n\n- Follow the note\n- Press \`A\``,
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 430, y: 260 },
      },
    ],
    artifacts: [],
    environmentSources: [],
  };
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

function makeMakeCodeNumberPacket(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0; // PACKET_TYPE_NUMBER
  new DataView(bytes.buffer).setInt32(9, value, true);
  return bytes;
}

function makeMakeCodeDoublePacket(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 4; // PACKET_TYPE_DOUBLE
  new DataView(bytes.buffer).setFloat64(9, value, true);
  return bytes;
}

function makeMakeCodeDoubleValuePacket(name: string, value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 5; // PACKET_TYPE_DOUBLE_VALUE
  const view = new DataView(bytes.buffer);
  view.setFloat64(9, value, true);
  const encodedName = new TextEncoder().encode(name.slice(0, 8));
  bytes[17] = encodedName.length;
  bytes.set(encodedName, 18);
  return bytes;
}

function makeMakeCodeStringPacket(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 2; // PACKET_TYPE_STRING
  const encoded = new TextEncoder().encode(value);
  bytes[9] = Math.min(encoded.length, 19);
  bytes.set(encoded.slice(0, bytes[9]), 10);
  return bytes;
}

function makeMakeCodeBufferPacket(data: number[]): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 3; // PACKET_TYPE_BUFFER
  bytes[9] = Math.min(data.length, 19);
  bytes.set(data.slice(0, bytes[9]), 10);
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

function describeMakeCodePacket(data: Uint8Array): string {
  if (data.length < 10) {
    return 'raw';
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (data[0]) {
    case 0:
      return data.length >= 13 ? `number:${view.getInt32(9, true)}` : 'raw';
    case 1:
      return describeMakeCodeValuePacket(data);
    case 2: {
      const length = Math.max(0, Math.min(data[9] ?? 0, 19, data.length - 10));
      return `string:${new TextDecoder().decode(data.slice(10, 10 + length))}`;
    }
    case 4:
      return data.length >= 17 ? `double:${formatMakeCodePacketNumber(view.getFloat64(9, true))}` : 'raw';
    case 5: {
      if (data.length < 18) {
        return 'raw';
      }
      const length = Math.max(0, Math.min(data[17] ?? 0, 8, data.length - 18));
      const name = new TextDecoder().decode(data.slice(18, 18 + length));
      return `double-value:${name}:${formatMakeCodePacketNumber(view.getFloat64(9, true))}`;
    }
    default:
      return 'raw';
  }
}

function formatMakeCodePacketNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(3).replace(/\.?0+$/, '');
}

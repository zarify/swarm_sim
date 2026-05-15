import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SwarmCanvasPanel } from './SwarmCanvasPanel';

describe('SwarmCanvasPanel', () => {
  it('renders the spatial canvas and updates simulation controls', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    expect(screen.getByText(/1 nodes \//)).toBeInTheDocument();
    expect(screen.getByLabelText('MicroPython runtime host')).toBeInTheDocument();
    expect(screen.queryByText('Artifact execution gate')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('running')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('paused')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('adds devices without bypassing engine-derived telemetry', () => {
    const { container } = render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/3 nodes \//)).toBeInTheDocument();
    expect(screen.getByText('Node 3')).toBeInTheDocument();
    expect(container.querySelectorAll('.microbit-node')).toHaveLength(3);
  });

  it('keeps device interaction honest and inspection panels compact', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.queryByRole('button', { name: /Press A|Press B|Send ping/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Event log for Alpha')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Radio message inspector')).not.toHaveAttribute('open');
  });

  it('assigns uploaded code to the selected device and then shows its MicroPython runtime frame', async () => {
    render(<SwarmCanvasPanel />);

    const file = new File([makeHexWithAscii('MicroPython')], 'mp.hex', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/Load code onto Alpha/), {
      target: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText('Assigned: mp.hex')).toBeInTheDocument());
    expect(screen.getByTitle('MicroPython simulator for Alpha')).toBeInTheDocument();
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

  it('keeps runtime host mounted when topology changes', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/2 nodes \//)).toBeInTheDocument();
    expect(screen.getByLabelText('MicroPython runtime host')).toBeInTheDocument();
  });
});

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

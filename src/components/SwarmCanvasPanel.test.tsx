import { fireEvent, render, screen } from '@testing-library/react';
import { SwarmCanvasPanel } from './SwarmCanvasPanel';

describe('SwarmCanvasPanel', () => {
  it('renders the spatial canvas and updates simulation controls', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    expect(screen.getByText(/4 nodes \//)).toBeInTheDocument();
    expect(screen.getByLabelText('MicroPython runtime host')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('running')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('paused')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('adds devices without bypassing engine-derived telemetry', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/5 nodes \//)).toBeInTheDocument();
  });

  it('shows selected-device controls, logs, and radio inspector events', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Press A' }));
    expect(screen.getByRole('button', { name: 'Release A' })).toBeInTheDocument();
    expect(screen.getByText(/Button A pressed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send ping' }));

    expect(screen.getByText('ping')).toBeInTheDocument();
    expect(screen.getByText(/device-alpha to 1 received/)).toBeInTheDocument();
    expect(screen.getByText(/Sent radio packet to 1 recipient/)).toBeInTheDocument();
  });

  it('shows MicroPython runtime frames for assigned demo devices', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByTitle('MicroPython simulator for Alpha')).toBeInTheDocument();
    expect(screen.getByTitle('MicroPython simulator for Beta')).toBeInTheDocument();
  });

  it('preserves logs and radio inspector history when topology changes', () => {
    render(<SwarmCanvasPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Send ping' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

    expect(screen.getByText(/5 nodes \//)).toBeInTheDocument();
    expect(screen.getByText('ping')).toBeInTheDocument();
    expect(screen.getByText(/Sent radio packet to 1 recipient/)).toBeInTheDocument();
  });
});

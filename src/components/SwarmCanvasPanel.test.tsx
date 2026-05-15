import { fireEvent, render, screen } from '@testing-library/react';
import { SwarmCanvasPanel } from './SwarmCanvasPanel';

describe('SwarmCanvasPanel', () => {
  it('renders the spatial canvas and updates simulation controls', () => {
    render(<SwarmCanvasPanel />);

    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    expect(screen.getByText(/4 nodes \//)).toBeInTheDocument();

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
});

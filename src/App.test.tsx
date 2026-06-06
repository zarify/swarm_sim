import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('opens directly on the swarm canvas without the marketing hero pane', async () => {
    render(<App />);

    expect(screen.queryByRole('heading', { name: 'Micro:bit Swarm Simulator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Spatial radio bench' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Simulator instructions' })).toBeInTheDocument(),
    );
  });
});

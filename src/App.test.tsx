import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('opens directly on the swarm bench without the marketing hero pane', () => {
    render(<App />);

    expect(screen.queryByRole('heading', { name: 'Micro:bit Swarm Simulator' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spatial radio bench' })).toBeInTheDocument();
  });
});

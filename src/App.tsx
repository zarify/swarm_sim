import { SwarmCanvasPanel } from './components/SwarmCanvasPanel';

export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">Local-first / compiled-artifact spike</p>
          <h1 id="page-title">Micro:bit Swarm Simulator</h1>
          <p className="lede">
            A focused lab bench for selecting a virtual micro:bit, loading editor
            artifacts onto it, and watching spatial radio behaviour without noise
            from unrelated panels.
          </p>
        </div>
        <div className="signal-card" aria-label="Simulation target summary">
          <span className="signal-card__label">v1 target</span>
          <strong>6-10</strong>
          <span>virtual micro:bits</span>
        </div>
      </section>

      <SwarmCanvasPanel />
    </main>
  );
}

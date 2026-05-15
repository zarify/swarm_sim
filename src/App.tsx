import { RuntimeSpikePanel } from './components/RuntimeSpikePanel';

export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">Local-first / compiled-artifact spike</p>
          <h1 id="page-title">Micro:bit Swarm Simulator</h1>
          <p className="lede">
            A browser lab bench for proving the hard part first: whether uploaded
            MakeCode and MicroPython artifacts can drive trustworthy virtual
            micro:bits before the swarm canvas is built around them.
          </p>
        </div>
        <div className="signal-card" aria-label="Simulation target summary">
          <span className="signal-card__label">v1 target</span>
          <strong>6-10</strong>
          <span>virtual micro:bits</span>
        </div>
      </section>

      <RuntimeSpikePanel />
    </main>
  );
}

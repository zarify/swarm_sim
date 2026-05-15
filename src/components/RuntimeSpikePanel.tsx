import { useMemo, useState } from 'react';
import {
  ARTIFACT_EXTENSION_HINT,
  evaluateArtifactRuntimeReadiness,
} from '../runtime/artifactReadiness';

const defaultArtifactName = 'swarm-radio-demo.hex';

export function RuntimeSpikePanel() {
  const [artifactName, setArtifactName] = useState(defaultArtifactName);
  const readiness = useMemo(
    () => evaluateArtifactRuntimeReadiness(artifactName),
    [artifactName],
  );

  const statusTone = readiness.canExecuteNow ? 'ready' : 'blocked';

  return (
    <section className="runtime-panel" aria-labelledby="runtime-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Runtime spike</p>
          <h2 id="runtime-title">Artifact execution gate</h2>
        </div>
        <span className={`status-pill status-pill--${statusTone}`}>
          {readiness.canExecuteNow ? 'Executable' : 'Blocked'}
        </span>
      </div>

      <label className="artifact-field">
        Artifact filename
        <input
          value={artifactName}
          onChange={(event) => setArtifactName(event.target.value)}
          spellCheck={false}
          aria-describedby="artifact-hint"
        />
      </label>
      <p id="artifact-hint" className="hint">
        {ARTIFACT_EXTENSION_HINT}
      </p>

      <div className="readiness-grid">
        <article>
          <span className="metric-label">Detected format</span>
          <strong>{readiness.artifactKind}</strong>
        </article>
        <article>
          <span className="metric-label">Runtime source</span>
          <strong>{readiness.runtimeSource}</strong>
        </article>
        <article>
          <span className="metric-label">Spike verdict</span>
          <strong>{readiness.verdict}</strong>
        </article>
      </div>

      <div className="capability-list" aria-label="Required runtime hooks">
        {readiness.capabilities.map((capability) => (
          <div className="capability-row" key={capability.name}>
            <span>{capability.name}</span>
            <strong data-state={capability.state}>{capability.state}</strong>
          </div>
        ))}
      </div>

      <div className="format-strip" aria-label="Spike input format">
        <span>micro:bit .hex</span>
        <span>MakeCode/MicroPython detection deferred to bytes</span>
      </div>
    </section>
  );
}

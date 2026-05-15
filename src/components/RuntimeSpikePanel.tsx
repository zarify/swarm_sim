import { useMemo, useRef, useState } from 'react';
import {
  ARTIFACT_EXTENSION_HINT,
  evaluateArtifactRuntimeReadiness,
} from '../runtime/artifactReadiness';
import {
  candidateForRuntimeSource,
  missingRequiredCapabilities,
} from '../runtime/simulatorCandidates';

const defaultArtifactName = 'swarm-radio-demo.hex';

export function RuntimeSpikePanel() {
  const [artifactName, setArtifactName] = useState(defaultArtifactName);
  const [artifactBytes, setArtifactBytes] = useState<Uint8Array>();
  const [readError, setReadError] = useState<string | null>(null);
  const fileReadToken = useRef(0);
  const readiness = useMemo(
    () => evaluateArtifactRuntimeReadiness(artifactName, artifactBytes),
    [artifactName, artifactBytes],
  );
  const simulatorCandidate = candidateForRuntimeSource(readiness.runtimeSource);
  const missingCapabilities = simulatorCandidate
    ? missingRequiredCapabilities(simulatorCandidate)
    : [];

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
          onChange={(event) => {
            fileReadToken.current += 1;
            setArtifactName(event.target.value);
            setArtifactBytes(undefined);
            setReadError(null);
          }}
          spellCheck={false}
          aria-describedby="artifact-hint"
        />
      </label>
      <label className="artifact-field">
        Fixture or artifact file
        <input
          type="file"
          accept=".hex"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const token = fileReadToken.current + 1;
            fileReadToken.current = token;

            if (!file) {
              setArtifactBytes(undefined);
              return;
            }

            setArtifactName(file.name);
            file
              .arrayBuffer()
              .then((buffer) => {
                if (fileReadToken.current !== token) {
                  return;
                }

                setArtifactBytes(new Uint8Array(buffer));
                setReadError(null);
              })
              .catch((error: unknown) => {
                if (fileReadToken.current !== token) {
                  return;
                }

                setArtifactBytes(undefined);
                setReadError(error instanceof Error ? error.message : 'Unable to read file');
              });
          }}
        />
      </label>
      <p id="artifact-hint" className="hint">
        {ARTIFACT_EXTENSION_HINT}
      </p>
      {readError ? <p className="hint hint--error">{readError}</p> : null}

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
        {readiness.sourceEvidence.length > 0 ? (
          <article>
            <span className="metric-label">Source evidence</span>
            <strong>{readiness.sourceEvidence.join(', ')}</strong>
          </article>
        ) : null}
        {readiness.diagnostic ? (
          <article>
            <span className="metric-label">Diagnostic</span>
            <strong>{readiness.diagnostic}</strong>
          </article>
        ) : null}
      </div>

      <div className="capability-list" aria-label="Required runtime hooks">
        {readiness.capabilities.map((capability) => (
          <div className="capability-row" key={capability.name}>
            <span>{capability.name}</span>
            <strong data-state={capability.state}>{capability.state}</strong>
          </div>
        ))}
      </div>

      {simulatorCandidate ? (
        <div className="simulator-card" aria-label="Recommended simulator adapter">
          <span className="metric-label">Recommended adapter</span>
          <strong>{simulatorCandidate.name}</strong>
          <p>{simulatorCandidate.loadPath}</p>
          <p>
            Missing proof:{' '}
            {missingCapabilities.length > 0 ? missingCapabilities.join(', ') : 'none'}
          </p>
        </div>
      ) : null}

      <div className="format-strip" aria-label="Spike input format">
        <span>micro:bit .hex</span>
        <span>MakeCode/MicroPython detection deferred to bytes</span>
      </div>
    </section>
  );
}

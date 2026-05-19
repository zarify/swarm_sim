import { useEffect, useMemo, useState } from 'react';
import { MicroPythonRuntimeHost, type MicroPythonRuntimeHostProps } from './MicroPythonRuntimeHost';
import { MakeCodeRuntimeHost } from './MakeCodeRuntimeHost';
import type { DeviceProgramLoadResult } from '../runtime/programLoader';
import type { RuntimeHostState } from './runtimeHostControls';

export function SwarmRuntimeHosts({
  onLoadResultsChange,
  headless,
  resetRequest,
  showHostCard = false,
  ...props
}: MicroPythonRuntimeHostProps) {
  const [microPythonResults, setMicroPythonResults] = useState<DeviceProgramLoadResult[]>([]);
  const [makeCodeResults, setMakeCodeResults] = useState<DeviceProgramLoadResult[]>([]);
  const [microPythonHostState, setMicroPythonHostState] = useState<RuntimeHostState>({
    allFramesReady: false,
    isLoading: false,
  });
  const [makeCodeHostState, setMakeCodeHostState] = useState<RuntimeHostState>({
    allFramesReady: false,
    isLoading: false,
  });
  const artifactById = useMemo(
    () => new Map(props.project.artifacts.map((artifact) => [artifact.id, artifact])),
    [props.project.artifacts],
  );
  const hasMicroPythonAssignments = useMemo(
    () =>
      props.project.devices.some((device) => {
        const artifact = device.programArtifactId ? artifactById.get(device.programArtifactId) : undefined;
        return artifact?.runtimeSource === 'micropython';
      }),
    [artifactById, props.project.devices],
  );
  const hasMakeCodeAssignments = useMemo(
    () =>
      props.project.devices.some((device) => {
        const artifact = device.programArtifactId ? artifactById.get(device.programArtifactId) : undefined;
        return artifact?.runtimeSource === 'makecode-pxt';
      }),
    [artifactById, props.project.devices],
  );
  const showMicroPythonHost = hasMicroPythonAssignments;
  const showMakeCodeHost = hasMakeCodeAssignments;
  const combinedResults = useMemo(
    () => [...microPythonResults, ...makeCodeResults],
    [microPythonResults, makeCodeResults],
  );

  useEffect(() => {
    if (!showMicroPythonHost && microPythonResults.length > 0) {
      setMicroPythonResults([]);
    }
    if (!showMicroPythonHost && (microPythonHostState.allFramesReady || microPythonHostState.isLoading)) {
      setMicroPythonHostState({
        allFramesReady: false,
        isLoading: false,
      });
    }
    if (!showMakeCodeHost && makeCodeResults.length > 0) {
      setMakeCodeResults([]);
    }
    if (!showMakeCodeHost && (makeCodeHostState.allFramesReady || makeCodeHostState.isLoading)) {
      setMakeCodeHostState({
        allFramesReady: false,
        isLoading: false,
      });
    }
  }, [
    showMicroPythonHost,
    showMakeCodeHost,
    microPythonResults.length,
    makeCodeResults.length,
    microPythonHostState.allFramesReady,
    microPythonHostState.isLoading,
    makeCodeHostState.allFramesReady,
    makeCodeHostState.isLoading,
  ]);

  useEffect(() => {
    onLoadResultsChange?.(combinedResults);
  }, [combinedResults, onLoadResultsChange]);

  const allRuntimeHostsReady =
    (!showMicroPythonHost || microPythonHostState.allFramesReady) &&
    (!showMakeCodeHost || makeCodeHostState.allFramesReady);

  return (
    <>
      {showMicroPythonHost ? (
        <MicroPythonRuntimeHost
          {...props}
          headless={headless}
          resetRequest={resetRequest}
          autoPrepare
          prepareEnabled={allRuntimeHostsReady}
          showSimulatorFrames={false}
          showHostCard={showHostCard}
          onRuntimeHostStateChange={setMicroPythonHostState}
          onLoadResultsChange={setMicroPythonResults}
        />
      ) : null}
      {showMakeCodeHost ? (
        <MakeCodeRuntimeHost
          project={props.project}
          selectedDeviceId={props.selectedDeviceId}
          resetRequest={resetRequest}
          deviceRuntimeStates={props.deviceRuntimeStates}
          scenarioResetSignal={props.scenarioResetSignal}
          headless={headless}
          autoPrepare
          prepareEnabled={allRuntimeHostsReady}
          showHostCard={showHostCard}
          showSimulatorFrames={false}
          onRadioPacket={props.onRadioPacket}
          onRuntimeLog={props.onRuntimeLog}
          onDisplayChange={props.onDisplayChange}
          onSoundOutput={props.onSoundOutput}
          onRadioConfigHint={props.onRadioConfigHint}
          onRuntimeHostStateChange={setMakeCodeHostState}
          onLoadResultsChange={setMakeCodeResults}
        />
      ) : null}
    </>
  );
}

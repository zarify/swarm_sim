import type { MakeCodeRuntimeProgram, MicroPythonRuntimeProgram } from './runtimeAdapter';

const encoder = new TextEncoder();

describe('runtime adapter contract', () => {
  it('represents the MicroPython simulator filesystem flash shape', () => {
    const program = {
      source: 'micropython',
      filesystem: {
        'main.py': encoder.encode('from microbit import *'),
      },
      artifact: {
        filename: 'mp_beacon.hex',
        bytes: encoder.encode(':00000001FF'),
      },
    } satisfies MicroPythonRuntimeProgram;

    expect(program.filesystem['main.py']?.byteLength).toBeGreaterThan(0);
  });

  it('represents MakeCode simulator/project inputs without pretending HEX execution is enough', () => {
    const program = {
      source: 'makecode-pxt',
      simulatorJavaScript: 'pxsim.basic.showString("ok")',
      sourceFiles: {
        'main.ts': 'basic.showString("ok")',
      },
      projectMetadata: {
        target: 'microbit',
      },
      artifact: {
        filename: 'mc_beacon.hex',
        bytes: encoder.encode(':00000001FF'),
      },
    } satisfies MakeCodeRuntimeProgram;

    expect(program.simulatorJavaScript).toContain('pxsim');
  });
});

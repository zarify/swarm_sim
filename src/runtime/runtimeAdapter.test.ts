import type { MakeCodeRuntimeProgram, MicroPythonRuntimeProgram } from './runtimeAdapter';

describe('runtime adapter contract', () => {
  it('represents the MicroPython simulator filesystem flash shape', () => {
    const program = {
      source: 'micropython',
      filesystem: {
        'main.py': new TextEncoder().encode('from microbit import *'),
      },
      artifact: {
        filename: 'mp_beacon.hex',
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
      },
    } satisfies MakeCodeRuntimeProgram;

    expect(program.simulatorJavaScript).toContain('pxsim');
  });
});

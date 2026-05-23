import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { resolveBuildFeatureFlags } from '../../featureFlags.config';

const microPythonFixture = path.resolve(process.cwd(), 'hex_files/mp_beacon.hex');
const microPythonDataLogFixture = path.resolve(process.cwd(), 'hex_files/mp_datalog.hex');
const makeCodeBeaconFixture = path.resolve(process.cwd(), 'hex_files/mc_beacon.hex');
const makeCodeDataLogFixture = path.resolve(process.cwd(), 'hex_files/mc_datalog.hex');
const featureFlags = resolveBuildFeatureFlags(process.env);

async function gotoCanvas(page: Page) {
  await page.goto('/');
  await dismissSplash(page);
}

async function openSwarmTools(page: Page) {
  if ((await page.getByRole('button', { name: 'Add device' }).count()) === 0) {
    await page.getByRole('button', { name: 'Swarm tools' }).click();
  }
}

async function addDeviceFromSwarmTools(page: Page) {
  await openSwarmTools(page);
  await page.getByRole('button', { name: 'Add device' }).click();
}

async function addLightFromSwarmTools(page: Page) {
  await openSwarmTools(page);
  await page.getByRole('button', { name: 'Add light' }).click();
}

async function addMagnetFromSwarmTools(page: Page) {
  await openSwarmTools(page);
  await page.getByRole('button', { name: 'Add magnet' }).click();
}

async function readMakeCodeMagneticReadings(page: Page): Promise<{
  x: number;
  y: number;
  z: number;
  strength: number;
}> {
  return page.evaluate(() => {
    const runnerFrame = Array.from(document.querySelectorAll('iframe')).find((element) =>
      (element as HTMLIFrameElement).src.includes('/makecode-patched-runner.html'),
    ) as HTMLIFrameElement | undefined;
    const simulatorWindow = runnerFrame?.contentWindow?.document?.querySelector('#simulators iframe')
      ?.contentWindow as
      | (Window & {
          pxsim?: {
            input?: {
              magneticForce?: (dimension: number) => number;
            };
          };
        })
      | undefined;
    const magneticForce = simulatorWindow?.pxsim?.input?.magneticForce;
    if (typeof magneticForce !== 'function') {
      throw new Error('MakeCode magneticForce API is not ready');
    }
    return {
      x: Number(magneticForce(0)),
      y: Number(magneticForce(1)),
      z: Number(magneticForce(2)),
      strength: Number(magneticForce(3)),
    };
  });
}

async function dismissSplash(page: Page) {
  const splash = page.getByRole('dialog', { name: 'Simulator instructions' });
  await expect(splash).toBeVisible();
  await splash.click();
  await expect(splash).toHaveCount(0);
}

test.describe('core canvas workflows', () => {
  test('shows startup instructions and boots into the canvas after dismiss', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('dialog', { name: 'Simulator instructions' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Simulator instructions' })).toHaveCount(0);

    await expect(page.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeVisible();
    await expect(page.locator('.microbit-node')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toHaveCount(0);
  });

  test('adds a device and updates telemetry count', async ({ page }) => {
    await gotoCanvas(page);

    await addDeviceFromSwarmTools(page);

    await expect(page.locator('.microbit-node')).toHaveCount(2);
  });

  test('adds a magnet source and shows magnetic readings on devices', async ({ page }) => {
    await gotoCanvas(page);

    if (!featureFlags.magnetEnabled) {
      await openSwarmTools(page);
      await expect(page.getByRole('button', { name: 'Add magnet' })).toHaveCount(0);
      await page.locator('.microbit-node').first().click();
      await expect(page.getByText('Mag strength')).toHaveCount(0);
      return;
    }

    await addMagnetFromSwarmTools(page);

    await expect(page.locator('.source-node--magnet')).toHaveCount(1);
    await expect(page.getByText('Magnet source')).toBeVisible();
    await expect(page.getByLabel('Angle')).toBeVisible();
    await expect(page.getByLabel('Strength (µT, microtesla)')).toBeVisible();

    await page.locator('.microbit-node').first().click();
    await expect(page.getByText('Mag strength')).toBeVisible();
    await expect(page.getByText(/µT/).first()).toBeVisible();
  });

  test('updates MakeCode magnetic dimensions when magnet settings change', async ({ page }) => {
    await gotoCanvas(page);
    if (!featureFlags.magnetEnabled) {
      await openSwarmTools(page);
      await expect(page.getByRole('button', { name: 'Add magnet' })).toHaveCount(0);
      return;
    }
    await addMagnetFromSwarmTools(page);
    await page.locator('.microbit-node').first().click();

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/makecode-patched-simulator.html')))
      .toBe(true);
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    const setRangeValue = async (label: 'Angle' | 'Strength (µT, microtesla)', value: number) => {
      const slider = page.getByLabel(label);
      await slider.evaluate((element, nextValue) => {
        const input = element as HTMLInputElement;
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(input, String(nextValue));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await expect(slider).toHaveValue(String(value));
    };

    await page.locator('.source-node--magnet').first().click();
    await setRangeValue('Strength (µT, microtesla)', 2000);
    await expect
      .poll(async () => (await readMakeCodeMagneticReadings(page)).strength, { timeout: 5_000 })
      .toBeGreaterThan(100);
    const boostedReadings = await readMakeCodeMagneticReadings(page);
    expect(boostedReadings).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number),
      strength: expect.any(Number),
    });

    await setRangeValue('Angle', 90);
    await expect
      .poll(async () => (await readMakeCodeMagneticReadings(page)).x, { timeout: 5_000 })
      .not.toBe(boostedReadings.x);
    const rotatedReadings = await readMakeCodeMagneticReadings(page);

    await setRangeValue('Strength (µT, microtesla)', 0);
    await expect
      .poll(async () => (await readMakeCodeMagneticReadings(page)).strength, { timeout: 5_000 })
      .toBeGreaterThan(0);
    const ambientReadings = await readMakeCodeMagneticReadings(page);

    expect(boostedReadings.strength).toBeGreaterThan(ambientReadings.strength);
    expect(
      boostedReadings.x !== rotatedReadings.x ||
        boostedReadings.y !== rotatedReadings.y ||
        boostedReadings.z !== rotatedReadings.z,
    ).toBe(true);
    expect(boostedReadings.strength).toBeGreaterThan(0);
    expect(boostedReadings.strength).toBeGreaterThanOrEqual(Math.abs(boostedReadings.x));
    expect(boostedReadings.strength).toBeGreaterThanOrEqual(Math.abs(boostedReadings.y));
  });

  test('keeps telemetry behind the debug modal until opened', async ({ page }) => {
    await gotoCanvas(page);

    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByText(/1 nodes \//)).toBeVisible();
    await page.getByRole('button', { name: 'Close debug tools' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toHaveCount(0);
  });

  test('saves layout to browser state and can load it back', async ({ page }) => {
    const saveName = 'E2E Layout One';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
    }, saveName);

    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    const saveButton = page.getByRole('button', { name: 'Save to browser' });
    await expect(saveButton).toBeVisible();

    await saveButton.click({ force: true });

    const loadLayoutButton = page.getByRole('button', { name: `Load ${saveName}` });
    await expect(loadLayoutButton).toBeVisible();

    await addDeviceFromSwarmTools(page);
    await expect(page.locator('.microbit-node')).toHaveCount(2);

    await loadLayoutButton.click();
    await expect(page.locator('.microbit-node')).toHaveCount(1);
  });

  test('deletes an individual saved layout from browser state', async ({ page }) => {
    const saveName = 'E2E Layout Delete';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
      window.confirm = () => true;
    }, saveName);

    await gotoCanvas(page);

    await openSwarmTools(page);
    await page.getByRole('button', { name: 'Save to browser' }).click({ force: true });

    const loadLayoutButton = page.getByRole('button', { name: `Load ${saveName}` });
    const deleteLayoutButton = page.getByRole('button', { name: `Delete ${saveName}` });
    await expect(loadLayoutButton).toBeVisible();
    await expect(deleteLayoutButton).toBeVisible();

    await deleteLayoutButton.click({ force: true });
    await expect(loadLayoutButton).toHaveCount(0);
    await expect(page.getByText('No saved layouts yet.')).toBeVisible();
  });

  test('enables log archive download when runtime logs are present', async ({ page }) => {
    await gotoCanvas(page);
    await openSwarmTools(page);
    const downloadLogsButton = page.getByRole('button', { name: 'Download log files' });
    await expect(downloadLogsButton).toBeDisabled();

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();

    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage(
        {
          kind: 'log_output',
          headings: ['time', 'temp'],
          data: ['1', '22'],
        },
        window.location.origin,
      );
    });

    await expect(downloadLogsButton).toBeEnabled({ timeout: 5_000 });
    const downloadPromise = page.waitForEvent('download');
    await downloadLogsButton.click({ force: true });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-device-logs\.zip$/);
  });

  test('loads MicroPython datalog fixture without extraction failure', async ({ page }) => {
    await gotoCanvas(page);
    await addDeviceFromSwarmTools(page);
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(microPythonDataLogFixture);

    await expect(page.getByText('Assigned: mp_datalog.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    const runtimeResults = page.getByLabel('Runtime load results');
    await expect(runtimeResults).toContainText(/loaded|prepared/i, { timeout: 15_000 });
    await expect(runtimeResults).not.toContainText('failed device-2');
    await expect(runtimeResults).not.toContainText('No embedded MicroPython or MakeCode source found');
    await page.getByRole('button', { name: 'Close debug tools' }).click();
  });

  test('keeps MakeCode datalog download enabled after stopping logging', async ({ page }) => {
    await gotoCanvas(page);
    await openSwarmTools(page);
    const downloadLogsButton = page.getByRole('button', { name: 'Download log files' });
    await expect(downloadLogsButton).toBeDisabled();

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeDataLogFixture);
    await expect(page.getByText('Assigned: mc_datalog.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    const buttonA = page.locator('[data-testid="device-button-device-1-A"]');
    const buttonB = page.locator('[data-testid="device-button-device-1-B"]');
    await buttonA.click();
    await expect(downloadLogsButton).toBeEnabled({ timeout: 15_000 });

    await buttonB.click();
    await expect(downloadLogsButton).toBeEnabled({ timeout: 5_000 });
  });

  test('clear canvas respects confirmation dialog', async ({ page }) => {
    await page.addInitScript(() => {
      const responses = [false, true];
      window.confirm = () => responses.shift() ?? true;
    });

    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    const clearButton = page.getByRole('button', { name: 'Clear canvas' });
    await expect(clearButton).toBeVisible();

    await clearButton.click({ force: true });
    await expect(page.locator('.microbit-node')).toHaveCount(1);

    await clearButton.click({ force: true });
    await expect(page.locator('.microbit-node')).toHaveCount(0);
  });

  test('rejects legacy JSON files in bundle uploader', async ({ page }) => {
    await page.addInitScript(() => {
      window.confirm = () => true;
    });
    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    await page.getByLabel('Upload bundle').setInputFiles({
      name: 'legacy.swarm',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('{"schemaVersion":1}', 'utf-8'),
    });

    await expect(page.getByText('Unsupported canvas bundle format')).toBeVisible();
  });

  test('uploads MicroPython fixture for selected device', async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        runtimeErrors.push(message.text());
      }
    });

    await gotoCanvas(page);

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);

    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[aria-label="MicroPython runtime host"]')).toHaveCount(0);
    await expect
      .poll(
        () =>
          runtimeErrors.filter((error) =>
            /Failed to instantiate WASM|failed to match magic number|Context must be pre-created from a user event|NetworkError when attempting to fetch resource|Cross-Origin Request Blocked|Access-Control-Allow-Origin/i.test(
              error,
            ),
          ),
        { timeout: 3_000 },
      )
      .toEqual([]);
  });

  test('delivers radio packets and shows renamed sender names in radio inspector', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByRole('button', { name: 'Rename selected node' }).click();
    await page.getByLabel('Edit node name').fill('Sensors');
    await page.getByLabel('Edit node name').press('Enter');

    await page.getByLabel(/Load code onto Sensors/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });

    await addDeviceFromSwarmTools(page);
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(microPythonFixture);
    await expect(page.locator('.microbit-node')).toHaveCount(2);

    const radioInspector = page.locator('details[aria-label="Radio message inspector"]');
    await radioInspector.locator('summary').click();

    await expect
      .poll(
        async () => {
          const metaLines = await page.locator('.radio-event__meta').allTextContents();
          return metaLines.some((line) => /sensors\s+to\s+1\s+received/i.test(line));
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('keeps MakeCode inbound radio group from source hints after Reset all', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });

    await addDeviceFromSwarmTools(page);
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    const makeCodeRunner = page.frames().find((frame) => frame.url().includes('/makecode-patched-runner.html'));
    expect(makeCodeRunner).toBeTruthy();
    await makeCodeRunner!.evaluate(() => {
      const scopedWindow = window as unknown as {
        __swarmInboundRadioGroups?: number[];
      };
      scopedWindow.__swarmInboundRadioGroups = [];
      window.addEventListener('message', (event) => {
        if (
          event.origin === window.location.origin &&
          event.data?.type === 'swarm-radio-input' &&
          typeof event.data?.packet?.group === 'number'
        ) {
          scopedWindow.__swarmInboundRadioGroups?.push(event.data.packet.group);
        }
      });
    });

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const microPythonSimulator = page.frames().find((frame) =>
      frame.url().includes('/micropython-patched-simulator.html'),
    );
    expect(microPythonSimulator).toBeTruthy();
    await microPythonSimulator!.evaluate(() => {
      const payload = Array.from(new TextEncoder().encode('light:77'));
      window.parent.postMessage(
        { kind: 'radio_output', data: [0x01, 0x00, 0x01, ...payload] },
        window.location.origin,
      );
    });

    await expect
      .poll(
        () =>
          makeCodeRunner!.evaluate(
            () =>
              (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups ??
              [],
          ),
        { timeout: 15_000 },
      )
      .toContain(42);

    await makeCodeRunner!.evaluate(() => {
      (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups = [];
    });

    await page.getByRole('button', { name: 'Reset all', exact: true }).click();
    await microPythonSimulator!.evaluate(() => {
      const payload = Array.from(new TextEncoder().encode('light:77'));
      window.parent.postMessage(
        { kind: 'radio_output', data: [0x01, 0x00, 0x01, ...payload] },
        window.location.origin,
      );
    });

    await expect
      .poll(
        () => makeCodeRunner!.evaluate(() => (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups ?? []),
        { timeout: 15_000 },
      )
      .toContain(42);

    const postResetGroups = await makeCodeRunner!.evaluate(
      () => (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups ?? [],
    );
    expect(postResetGroups[0]).toBe(42);
    expect(postResetGroups).not.toContain(0);
  });

  test('keeps runtime radio delivery working after opening and closing debug tools', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });

    await addDeviceFromSwarmTools(page);
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    const makeCodeRunner = page.frames().find((frame) => frame.url().includes('/makecode-patched-runner.html'));
    expect(makeCodeRunner).toBeTruthy();
    await makeCodeRunner!.evaluate(() => {
      const scopedWindow = window as unknown as {
        __swarmInboundRadioGroups?: number[];
      };
      scopedWindow.__swarmInboundRadioGroups = [];
      window.addEventListener('message', (event) => {
        if (
          event.origin === window.location.origin &&
          event.data?.type === 'swarm-radio-input' &&
          typeof event.data?.packet?.group === 'number'
        ) {
          scopedWindow.__swarmInboundRadioGroups?.push(event.data.packet.group);
        }
      });
    });

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const microPythonSimulator = page.frames().find((frame) =>
      frame.url().includes('/micropython-patched-simulator.html'),
    );
    expect(microPythonSimulator).toBeTruthy();
    const emitMicroPythonRadioOutput = async () => {
      await microPythonSimulator!.evaluate(() => {
        const payload = Array.from(new TextEncoder().encode('light:77'));
        window.parent.postMessage(
          { kind: 'radio_output', data: [0x01, 0x00, 0x01, ...payload] },
          window.location.origin,
        );
      });
    };

    await emitMicroPythonRadioOutput();
    await expect
      .poll(
        () =>
          makeCodeRunner!.evaluate(
            () =>
              (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups ??
              [],
          ),
        { timeout: 15_000 },
      )
      .toContain(42);

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await page.getByRole('button', { name: 'Close debug tools' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toHaveCount(0);

    await makeCodeRunner!.evaluate(() => {
      (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups = [];
    });
    await emitMicroPythonRadioOutput();

    await expect
      .poll(
        () =>
          makeCodeRunner!.evaluate(
            () =>
              (window as unknown as { __swarmInboundRadioGroups?: number[] }).__swarmInboundRadioGroups ??
              [],
          ),
        { timeout: 15_000 },
      )
      .toContain(42);
  });

  test('coalesces fragmented MicroPython serial output into one runtime log line', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-1:ready"]')).toBeVisible({ timeout: 15_000 });

    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();

    await expect.poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html'))).toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();
    await page.evaluate(() => {
      const frame = document.querySelector('iframe[title="MicroPython simulator for Node 1"]') as HTMLIFrameElement | null;
      frame?.contentWindow?.postMessage({ kind: 'stop' }, window.location.origin);
    });
    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage({ kind: 'serial_output', data: 'b' }, window.location.origin);
      window.parent.postMessage({ kind: 'serial_output', data: "'light:101'" }, window.location.origin);
      window.parent.postMessage({ kind: 'serial_output', data: '\n' }, window.location.origin);
    });

    await expect(page.locator('.device-log__line', { hasText: 'light:101' })).toHaveCount(1);
    await expect(page.locator('.device-log__line', { hasText: "b'light:101'" })).toHaveCount(0);
  });

  test('shows per-device sound feedback for MicroPython runtime sound markers', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-1:ready"]')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();
    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage({ kind: 'serial_output', data: '\x1eSWARM_SOUND:180\n' }, window.location.origin);
    });

    await expect(page.locator('[data-runtime-sound-indicator="device-1"]')).toBeVisible();
    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    const soundLine = page.locator('.device-log__line', { hasText: 'Sound output started' });
    await expect(soundLine).toHaveCount(1);
    await expect(soundLine.locator('.device-log__type')).toHaveText('snd');
  });

  test('shows per-device sound feedback for MakeCode runtime sound events', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/makecode-patched-simulator.html')))
      .toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/makecode-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();

    await simulatorFrame!.evaluate(() => {
      const displayPixels = Array.from({ length: 25 }, () => 0);
      window.parent.postMessage(
        { type: 'swarm-simulator-state', displayPixels, soundLevel: 180 },
        window.location.origin,
      );
      window.parent.postMessage(
        { type: 'swarm-simulator-state', displayPixels, soundLevel: 120 },
        window.location.origin,
      );
      window.parent.postMessage(
        { type: 'swarm-simulator-state', displayPixels, soundLevel: 0 },
        window.location.origin,
      );
    });

    await expect(page.locator('[data-runtime-sound-indicator="device-1"]')).toBeVisible();
    await page.getByRole('button', { name: 'Close debug tools' }).click();
    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    const soundLine = page.locator('.device-log__line', { hasText: 'Sound output started' });
    await expect(soundLine).toHaveCount(1);
    await expect(soundLine.locator('.device-log__type')).toHaveText('snd');
  });

  test('surfaces runtime internal errors as device error state and clears on reset', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-1:ready"]')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();
    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage(
        { kind: 'internal_error', error: 'Synthetic runtime failure for e2e' },
        window.location.origin,
      );
    });

    await expect(page.locator('[data-runtime-state="device-1:error"]')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /^Reset$/ }).click();
    await expect(page.locator('[data-runtime-state="device-1:error"]')).toHaveCount(0);
  });

  test('persists MicroPython assignment across browser save/load workflow', async ({ page }) => {
    const saveName = 'MicroPython Persisted Layout';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
    }, saveName);

    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    await page.getByRole('button', { name: 'Save to browser' }).click({ force: true });
    const loadButton = page.getByRole('button', { name: `Load ${saveName}` });
    await expect(loadButton).toBeVisible();

    await addDeviceFromSwarmTools(page);
    await expect(page.locator('.microbit-node')).toHaveCount(2);

    await loadButton.click();
    await expect(page.locator('.microbit-node')).toHaveCount(1);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
  });

  test('supports permanent A+B canvas button control with linked indicator lines', async ({ page }) => {
    await gotoCanvas(page);

    const abButton = page.locator('[data-testid="device-button-device-1-AB"]');
    await expect(abButton).toBeVisible();
    await expect(page.locator('[data-device-button-combo-link="device-1"]')).toBeVisible();

    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    await abButton.click();

    await expect(page.locator('.device-log__line', { hasText: 'Button A pressed' })).toHaveCount(1);
    await expect(page.locator('.device-log__line', { hasText: 'Button B pressed' })).toHaveCount(1);
  });

  test('sends one MakeCode AB click event per canvas A+B press', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Debug' }).click();
    await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
    await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close debug tools' }).click();

    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const runnerFrame = Array.from(document.querySelectorAll('iframe')).find((element) =>
        (element as HTMLIFrameElement).src.includes('/makecode-patched-runner.html'),
      ) as HTMLIFrameElement | undefined;
      if (!runnerFrame?.contentWindow) {
        throw new Error('MakeCode runner iframe not found');
      }
      const runnerWindow = runnerFrame.contentWindow as Window & { document?: Document };

      let simulatorWindow: (Window & Record<string, unknown>) | undefined;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const simulatorFrame = runnerWindow.document?.querySelector('#simulators iframe') as
          | HTMLIFrameElement
          | null;
        simulatorWindow = simulatorFrame?.contentWindow as (Window & Record<string, unknown>) | undefined;
        if (simulatorWindow?.pxsim?.board) {
          break;
        }
        await sleep(100);
      }

      const board = simulatorWindow?.pxsim?.board?.() as
        | { bus?: { queue: (id: number, eventId: number) => unknown }; buttonPairState?: { abBtn?: { id?: number } } }
        | undefined;
      const bus = board?.bus;
      const abId = board?.buttonPairState?.abBtn?.id;
      if (!simulatorWindow || !bus || typeof abId !== 'number') {
        throw new Error('MakeCode simulator runtime bus not ready');
      }

      if (!simulatorWindow.__swarmOriginalBusQueue) {
        simulatorWindow.__swarmOriginalBusQueue = bus.queue.bind(bus) as (
          id: number,
          eventId: number,
        ) => unknown;
        simulatorWindow.__swarmAbButtonId = abId;
        bus.queue = (id: number, eventId: number) => {
          if (id === simulatorWindow.__swarmAbButtonId && eventId === 3) {
            simulatorWindow.__swarmAbClickEvents = (simulatorWindow.__swarmAbClickEvents as number) + 1;
          }
          return simulatorWindow.__swarmOriginalBusQueue(id, eventId);
        };
      }
      simulatorWindow.__swarmAbClickEvents = 0;
    });

    await page.locator('[data-testid="device-button-device-1-AB"]').click();
    await page.waitForTimeout(800);

    const abClickEvents = await page.evaluate(() => {
      const runnerFrame = Array.from(document.querySelectorAll('iframe')).find((element) =>
        (element as HTMLIFrameElement).src.includes('/makecode-patched-runner.html'),
      ) as HTMLIFrameElement | undefined;
      const simulatorWindow = runnerFrame?.contentWindow?.document?.querySelector('#simulators iframe')
        ?.contentWindow as (Window & Record<string, unknown>) | undefined;
      return Number(simulatorWindow?.__swarmAbClickEvents ?? 0);
    });

    expect(abClickEvents).toBe(1);
  });

  test('renames selected nodes from the side panel for both devices and sources', async ({ page }) => {
    await gotoCanvas(page);

    const longDeviceName = 'Device name that is intentionally too long for compact labels';
    await page.getByRole('button', { name: 'Rename selected node' }).click();
    await page.getByLabel('Edit node name').fill(longDeviceName);
    await page.getByLabel('Edit node name').press('Enter');

    const sidebarName = page.locator('.selection-name').first();
    await expect(sidebarName).toHaveAttribute('title', longDeviceName);
    await expect(sidebarName).toContainText(/…$/);
    await expect(page.locator('.node-label').first()).toContainText(/…$/);

    await addLightFromSwarmTools(page);
    await page.locator('g.source-node--light').first().click();
    await page.getByRole('button', { name: 'Rename selected node' }).click();
    await page.getByLabel('Edit node name').fill('Ambient source');
    await page.getByLabel('Edit node name').press('Enter');

    await expect(page.locator('.selection-name').first()).toHaveAttribute('title', 'Ambient source');
  });
});

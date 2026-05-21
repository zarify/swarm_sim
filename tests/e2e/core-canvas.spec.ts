import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const microPythonFixture = path.resolve(process.cwd(), 'hex_files/mp_beacon.hex');
const makeCodeBeaconFixture = path.resolve(process.cwd(), 'hex_files/mc_beacon.hex');

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

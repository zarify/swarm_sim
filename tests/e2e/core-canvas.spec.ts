import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const microPythonFixture = path.resolve(process.cwd(), 'hex_files/mp_beacon.hex');

async function gotoCanvas(page: Page) {
  await page.goto('/');
  await dismissSplash(page);
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
    await expect(page.getByText(/1 nodes \//)).toBeVisible();
  });

  test('adds a device and updates telemetry count', async ({ page }) => {
    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Add device' }).click();

    await expect(page.getByText(/2 nodes \//)).toBeVisible();
  });

  test('saves layout to browser state and can load it back', async ({ page }) => {
    const saveName = 'E2E Layout One';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
    }, saveName);

    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Canvas state' }).click();
    const saveButton = page.getByRole('button', { name: 'Save to browser' });
    await expect(saveButton).toBeVisible();

    await saveButton.click({ force: true });

    const loadLayoutButton = page.getByRole('button', { name: `Load ${saveName}` });
    await expect(loadLayoutButton).toBeVisible();

    await page.getByRole('button', { name: 'Add device' }).click();
    await expect(page.getByText(/2 nodes \//)).toBeVisible();

    await loadLayoutButton.click();
    await expect(page.getByText(/1 nodes \//)).toBeVisible();
  });

  test('clear canvas respects confirmation dialog', async ({ page }) => {
    await page.addInitScript(() => {
      const responses = [false, true];
      window.confirm = () => responses.shift() ?? true;
    });

    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Canvas state' }).click();
    const clearButton = page.getByRole('button', { name: 'Clear canvas' });
    await expect(clearButton).toBeVisible();

    await clearButton.click({ force: true });
    await expect(page.getByText(/1 nodes \//)).toBeVisible();

    await clearButton.click({ force: true });
    await expect(page.getByText(/0 nodes \//)).toBeVisible();
  });

  test('rejects legacy JSON files in bundle uploader', async ({ page }) => {
    await page.addInitScript(() => {
      window.confirm = () => true;
    });
    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Canvas state' }).click();
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

    await page.getByLabel(/Load code onto Alpha/).setInputFiles(microPythonFixture);

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

    await page.getByRole('button', { name: 'Add device' }).click();
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(microPythonFixture);
    await expect(page.getByText(/2 nodes \//)).toBeVisible();

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

  test('coalesces fragmented MicroPython serial output into one runtime log line', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Alpha/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-alpha:ready"]')).toBeVisible({ timeout: 15_000 });

    const eventLog = page.getByLabel('Event log for Alpha');
    await eventLog.locator('summary').click();

    await expect.poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html'))).toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();
    await page.evaluate(() => {
      const frame = document.querySelector('iframe[title="MicroPython simulator for Alpha"]') as HTMLIFrameElement | null;
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

  test('surfaces runtime internal errors as device error state and clears on reset', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Alpha/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-alpha:ready"]')).toBeVisible({ timeout: 15_000 });

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

    await expect(page.locator('[data-runtime-state="device-alpha:error"]')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Reset selected' }).click();
    await expect(page.locator('[data-runtime-state="device-alpha:error"]')).toHaveCount(0);
  });

  test('persists MicroPython assignment across browser save/load workflow', async ({ page }) => {
    const saveName = 'MicroPython Persisted Layout';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
    }, saveName);

    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Alpha/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Canvas state' }).click();
    await page.getByRole('button', { name: 'Save to browser' }).click({ force: true });
    const loadButton = page.getByRole('button', { name: `Load ${saveName}` });
    await expect(loadButton).toBeVisible();

    await page.getByRole('button', { name: 'Add device' }).click();
    await expect(page.getByText(/2 nodes \//)).toBeVisible();

    await loadButton.click();
    await expect(page.getByText(/1 nodes \//)).toBeVisible();
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
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

    await page.getByRole('button', { name: 'Add light' }).click();
    await page.locator('g.source-node--light').first().click();
    await page.getByRole('button', { name: 'Rename selected node' }).click();
    await page.getByLabel('Edit node name').fill('Ambient source');
    await page.getByLabel('Edit node name').press('Enter');

    await expect(page.locator('.selection-name').first()).toHaveAttribute('title', 'Ambient source');
  });
});

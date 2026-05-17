import path from 'node:path';
import { expect, test } from '@playwright/test';

const microPythonFixture = path.resolve(process.cwd(), 'hex_files/mp_beacon.hex');

test.describe('core canvas workflows', () => {
  test('boots into spatial radio bench and shows the canvas', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Spatial radio bench' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Draggable micro:bit swarm canvas' })).toBeVisible();
    await expect(page.getByText(/1 nodes \//)).toBeVisible();
  });

  test('adds a device and updates telemetry count', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Add device' }).click();

    await expect(page.getByText(/2 nodes \//)).toBeVisible();
  });

  test('saves layout to browser state and can load it back', async ({ page }) => {
    const saveName = 'E2E Layout One';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
    }, saveName);

    await page.goto('/');

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

    await page.goto('/');

    await page.getByRole('button', { name: 'Canvas state' }).click();
    const clearButton = page.getByRole('button', { name: 'Clear canvas' });
    await expect(clearButton).toBeVisible();

    await clearButton.click({ force: true });
    await expect(page.getByText(/1 nodes \//)).toBeVisible();

    await clearButton.click({ force: true });
    await expect(page.getByText(/0 nodes \//)).toBeVisible();
  });

  test('uploads MicroPython fixture for selected device', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel(/Load code onto Alpha/).setInputFiles(microPythonFixture);

    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
  });
});

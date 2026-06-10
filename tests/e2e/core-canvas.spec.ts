import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { resolveBuildFeatureFlags } from '../../featureFlags.config';
import { createBlankProject, type SwarmProject } from '../../src/domain/project';
import { serializeProject } from '../../src/domain/projectSerialization';

const microPythonFixture = path.resolve(process.cwd(), 'hex_files/mp_beacon.hex');
const microPythonDataLogFixture = path.resolve(process.cwd(), 'hex_files/mp_datalog.hex');
const makeCodeBeaconFixture = path.resolve(process.cwd(), 'hex_files/mc_beacon.hex');
const makeCodeDataLogFixture = path.resolve(process.cwd(), 'hex_files/mc_datalog.hex');
const makeCodeContinuousSoundProgram = `input.onButtonPressed(Button.A, function () {
    basic.showArrow(ArrowNames.North)
    music.play(music.tonePlayable(262, music.beat(BeatFraction.Breve)), music.PlaybackMode.UntilDone)
    basic.clearScreen()
})
input.onButtonPressed(Button.AB, function () {
    music.stopAllSounds()
    basic.showIcon(IconNames.No)
})
input.onButtonPressed(Button.B, function () {
    basic.showLeds(\`
        . # . # .
        # . . . #
        # . # . #
        # . . . #
        . # . # .
        \`)
    music.ringTone(262)
})
music.setVolume(127)
basic.forever(function () {
    if (input.soundLevel() > 0) {
        led.plotBarGraph(
        input.soundLevel(),
        255
        )
    }
})`;
const makeCodeMutedContinuousSoundProgram = `input.onButtonPressed(Button.B, function () {
    music.ringTone(262)
})
music.setVolume(0)`;
const featureFlags = resolveBuildFeatureFlags(process.env);
const makeCodeUpstreamHosts = new Set([
  'makecode.microbit.org',
  'cdn.makecode.com',
  'trg-microbit.userpxt.io',
  'gc.zgo.at',
]);

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

async function selectDeviceNode(page: Page, index: number) {
  await page.locator('.microbit-node').nth(index).click();
}

async function updateSelectedMakeCodeSource(page: Page, deviceName: string, source: string) {
  await page.getByRole('button', { name: 'Edit code' }).click();
  await expect(page.getByRole('dialog', { name: `Code editor for ${deviceName}` })).toBeVisible();
  const sourceField = page.getByLabel(`Editing main.ts for ${deviceName}`);
  await expect(sourceField).toBeVisible();
  await sourceField.fill(source);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Editable source:/)).toContainText('saved changes ready');
}

async function waitForMakeCodeRuntimeReady(page: Page) {
  await page.getByRole('button', { name: 'Debug' }).click();
  await expect(page.getByRole('dialog', { name: 'Debug tools' })).toBeVisible();
  await expect(page.getByLabel('Runtime load results')).toContainText(/loaded|prepared/i, {
    timeout: 15_000,
  });
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/makecode-patched-simulator.html')))
    .toBe(true);
  await page.getByRole('button', { name: 'Close debug tools' }).click();
}

function selectedSoundMetric(page: Page) {
  return page
    .locator('.radio-summary div')
    .filter({ has: page.locator('dt', { hasText: 'Sound' }) })
    .locator('dd');
}

async function dragDeviceNodeBy(page: Page, index: number, delta: { x: number; y: number }) {
  const body = page.locator('.microbit-node .microbit-body').nth(index);
  const box = await body.boundingBox();
  if (!box) {
    throw new Error(`Device ${index} body not found`);
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + delta.x, startY + delta.y, { steps: 8 });
  await page.mouse.up();
}

async function setAddLockedMode(page: Page, enabled: boolean) {
  await openSwarmTools(page);
  const checkbox = page.getByRole('checkbox', { name: 'Add locked' });
  if ((await checkbox.isChecked()) !== enabled) {
    await checkbox.click();
  }
}

async function addLockedDeviceFromSwarmTools(page: Page) {
  await setAddLockedMode(page, true);
  await page.getByRole('button', { name: 'Add device' }).click();
  await setAddLockedMode(page, false);
}

async function addLightFromSwarmTools(page: Page) {
  await openSwarmTools(page);
  await page.getByRole('button', { name: 'Add light' }).click();
}

async function addMagnetFromSwarmTools(page: Page) {
  await openSwarmTools(page);
  await page.getByRole('button', { name: 'Add magnet' }).click();
}

function getSaveCanvasButton(page: Page) {
  return page.getByRole('button', { name: /Save canvas/i });
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
  await page.keyboard.press('Escape');
  await expect(splash).toHaveCount(0);
}

function makeBundleWithInstructions(heading: string): Buffer {
  const now = '2026-06-06T01:20:00.000Z';
  const project: SwarmProject = {
    ...createBlankProject({ id: 'instructions-bundle', name: 'Instructions bundle', now }),
    instructionsMarkdown: `# ${heading}\n\n- Open the swarm tools\n- Press \`A\` on Node 1`,
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 430, y: 260 },
      },
    ],
    artifacts: [],
    environmentSources: [],
  };
  const payload = Buffer.from(serializeProject(project), 'utf-8');
  return Buffer.concat([Buffer.from([0x53, 0x57, 0x41, 0x52, 0x4d, 0x02, 0x00]), payload]);
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

  test('creates a locked device that hides code inspection and further uploads after first assignment', async ({ page }) => {
    await gotoCanvas(page);

    await addLockedDeviceFromSwarmTools(page);
    await expect(page.locator('.selection-name-badge')).toContainText('Locked');
    await expect(
      page.getByText('The first successful code upload will be its only assignment.'),
    ).toBeVisible();

    await page.getByLabel(/Load code onto Node 2/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Locked after first code upload.')).toBeVisible();
    await expect(page.getByText('Source is hidden and this device cannot be overwritten.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit code' })).toHaveCount(0);
    await expect(page.getByLabel(/Load code onto Node 2/)).toHaveCount(0);
  });

  test('lets locked devices be fixed in place permanently from device configuration', async ({ page }) => {
    await gotoCanvas(page);

    await addLockedDeviceFromSwarmTools(page);
    await expect(page.getByRole('button', { name: 'Rename selected node' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pin device position permanently' })).toBeVisible();

    await page.getByRole('button', { name: 'Pin device position permanently' }).click();

    await expect(page.getByRole('button', { name: 'Pinned device position permanently' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Rename selected node' })).toBeDisabled();
    await expect(
      page.getByText('This device is locked in place on the canvas and cannot be moved, renamed, or unlocked.'),
    ).toBeVisible();
  });

  test('locks locked light-source controls after permanent pinning', async ({ page }) => {
    await gotoCanvas(page);
    await setAddLockedMode(page, true);
    await page.getByRole('button', { name: 'Add light' }).click();
    await setAddLockedMode(page, false);

    await expect(page.getByRole('button', { name: 'Rename selected node' })).toBeEnabled();
    await expect(page.getByLabel('Radius')).toBeEnabled();
    await expect(page.getByLabel('Peak level (micro:bit scale)')).toBeEnabled();

    await page.getByRole('button', { name: 'Pin node position permanently' }).click();

    await expect(page.getByRole('button', { name: 'Pinned node position permanently' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Rename selected node' })).toBeDisabled();
    await expect(page.getByLabel('Radius')).toBeDisabled();
    await expect(page.getByLabel('Peak level (micro:bit scale)')).toBeDisabled();
    await expect(page.getByText('This node is locked in place and its properties cannot be changed.')).toBeVisible();
  });

  test('keeps the canvas size stable when switching between locked and unlocked devices', async ({ page }) => {
    await gotoCanvas(page);

    await addLockedDeviceFromSwarmTools(page);
    const canvas = page.locator('.swarm-canvas');
    const initialBox = await canvas.boundingBox();
    expect(initialBox).not.toBeNull();

    await page.locator('.microbit-node').first().click();
    const unlockedBox = await canvas.boundingBox();

    await page.locator('.microbit-node').nth(1).click();
    const lockedBox = await canvas.boundingBox();

    expect(unlockedBox?.width).toBe(initialBox?.width);
    expect(unlockedBox?.height).toBe(initialBox?.height);
    expect(lockedBox?.width).toBe(initialBox?.width);
    expect(lockedBox?.height).toBe(initialBox?.height);
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

  test('loads MakeCode runtime without upstream network requests', async ({ page }) => {
    const upstreamRequests = new Set<string>();
    page.on('request', (request) => {
      const requestUrl = request.url();
      let hostname = '';
      try {
        hostname = new URL(requestUrl).hostname;
      } catch {
        return;
      }
      if (makeCodeUpstreamHosts.has(hostname)) {
        upstreamRequests.add(requestUrl);
      }
    });

    await gotoCanvas(page);
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

    expect([...upstreamRequests]).toEqual([]);
  });

  test('edits uploaded MicroPython code and keeps the saved source in the editor', async ({ page }) => {
    await gotoCanvas(page);

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Edit code' })).toBeEnabled();

    await page.getByRole('button', { name: 'Edit code' }).click();
    await expect(page.getByRole('dialog', { name: 'Code editor for Node 1' })).toBeVisible();
    const sourceField = page.getByLabel('Editing main.py for Node 1');
    await expect(sourceField).toBeVisible();
    await sourceField.fill('from microbit import *\ndisplay.scroll("edited")\n');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText(/Editable source:/)).toContainText('saved changes ready');
    await page.getByRole('button', { name: 'Edit code' }).click();
    await expect(page.getByLabel('Editing main.py for Node 1')).toHaveValue(
      'from microbit import *\ndisplay.scroll("edited")\n',
    );
    await page.getByRole('button', { name: 'Close code editor' }).click();
  });

  test('keeps scrolled editor clicks aligned with the visible code line', async ({ page }) => {
    await gotoCanvas(page);

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Edit code' }).click();

    const sourceField = page.getByLabel('Editing main.py for Node 1');
    const longSource = Array.from({ length: 80 }, (_, index) => `line_${index + 1}`).join('\n');
    await sourceField.fill(longSource);

    const clickTarget = await sourceField.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const lineHeight = Number.parseFloat(style.lineHeight);
      const paddingTop = Number.parseFloat(style.paddingTop);
      element.scrollTop = lineHeight * 29;
      return {
        x: rect.x + 56,
        y: rect.y + paddingTop + lineHeight / 2,
      };
    });

    await page.mouse.click(clickTarget.x, clickTarget.y);
    await page.keyboard.type('EDIT_');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await page.getByRole('button', { name: 'Edit code' }).click();
    const editedLines = (await sourceField.inputValue()).split('\n');
    expect(editedLines[29]).toContain('EDIT_');
    expect(editedLines[30]).toBe('line_31');
    await page.getByRole('button', { name: 'Close code editor' }).click();
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
      window.confirm = () => true;
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

  test('restores the explicitly saved current canvas with pinned and view state after a page reload', async ({ page }) => {
    await gotoCanvas(page);

    await addDeviceFromSwarmTools(page);
    await expect(page.locator('.microbit-node')).toHaveCount(2);

    await page.locator('.microbit-node').first().click();
    await openSwarmTools(page);
    await page.getByRole('checkbox', { name: 'Radio range overlay' }).uncheck();
    await expect(page.locator('.radio-radius')).toHaveCount(0);
    await page.getByRole('button', { name: 'Pin device position' }).click();
    await expect(page.getByRole('button', { name: 'Unpin device position' })).toBeVisible();

    await getSaveCanvasButton(page).click();
    await expect(getSaveCanvasButton(page)).toContainText('Saved');

    await page.reload();
    await dismissSplash(page);

    await expect(page.locator('.microbit-node')).toHaveCount(2);
    await expect(getSaveCanvasButton(page)).toContainText('Saved');
    await openSwarmTools(page);
    await expect(page.getByRole('checkbox', { name: 'Radio range overlay' })).not.toBeChecked();
    await expect(page.locator('.radio-radius')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unpin device position' })).toBeVisible();
  });

  test('shows saved custom instructions again after reload and exposes the header info button', async ({ page }) => {
    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    await page.getByRole('button', { name: 'Edit instructions' }).click();
    await page.getByLabel('Canvas instructions markdown').fill(
      '# Lesson launch\n\n- Load code onto Node 1\n- Press `A` to begin',
    );
    await page.getByRole('button', { name: 'Save instructions' }).click();
    await expect(page.getByRole('button', { name: 'Show instructions' })).toBeVisible();

    await getSaveCanvasButton(page).click();
    await expect(getSaveCanvasButton(page)).toContainText('Saved');
    await page.reload();

    const splash = page.getByRole('dialog', { name: 'Simulator instructions' });
    await expect(splash).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show instructions' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show instructions' }).click();
    await expect(page.getByRole('heading', { name: 'Lesson launch' })).toBeVisible();
  });

  test('saves the current canvas after code is loaded and restores it after reload', async ({ page }) => {
    await gotoCanvas(page);

    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });

    await getSaveCanvasButton(page).click();
    await expect(getSaveCanvasButton(page)).toContainText('Saved');

    await page.reload();

    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(getSaveCanvasButton(page)).toContainText('Saved');
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

  test('shows custom instructions when importing a swarm bundle', async ({ page }) => {
    await page.addInitScript(() => {
      window.confirm = () => true;
    });
    await gotoCanvas(page);

    await page.getByRole('button', { name: 'Swarm tools' }).click();
    await page.getByLabel('Upload bundle').setInputFiles({
      name: 'lesson.swarm',
      mimeType: 'application/octet-stream',
      buffer: makeBundleWithInstructions('Bundle lesson'),
    });

    await expect(page.getByRole('dialog', { name: 'Simulator instructions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bundle lesson' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show instructions' })).toBeVisible();
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

    await page.getByRole('button', { name: 'Reset', exact: true }).first().click();
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

  test('logs a later MicroPython sound marker again after the transient window expires', async ({ page }) => {
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

    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    await expect(page.locator('.device-log__line', { hasText: 'Sound output started (level 180)' })).toHaveCount(1);

    await page.waitForTimeout(800);
    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage({ kind: 'serial_output', data: '\x1eSWARM_SOUND:180\n' }, window.location.origin);
    });

    await expect(page.locator('.device-log__line', { hasText: 'Sound output started (level 180)' })).toHaveCount(2);
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

  test('loads MakeCode targetconfig through the JSON rewrite path', async ({ page }) => {
    const targetconfigRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/config/microbit/targetconfig/')) {
        targetconfigRequests.push(request.url());
      }
    });

    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });
    await waitForMakeCodeRuntimeReady(page);

    expect(
      targetconfigRequests.some((url) => url.endsWith('/api/config/microbit/targetconfig/v8.0.22.json')),
    ).toBe(true);
    expect(
      targetconfigRequests.some((url) => url.endsWith('/api/config/microbit/targetconfig/v8.0.22')),
    ).toBe(false);
  });

  test('keeps MakeCode continuous sound active at the configured volume until stopAllSounds', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await addDeviceFromSwarmTools(page);
    await page.getByLabel(/Load code onto Node 2/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await selectDeviceNode(page, 0);
    await updateSelectedMakeCodeSource(page, 'Node 1', makeCodeContinuousSoundProgram);
    await selectDeviceNode(page, 1);
    await updateSelectedMakeCodeSource(page, 'Node 2', makeCodeContinuousSoundProgram);
    await waitForMakeCodeRuntimeReady(page);

    await selectDeviceNode(page, 1);
    await page.locator('[data-testid="device-button-device-1-B"]').click();

    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toBeVisible();
    await expect(selectedSoundMetric(page)).toHaveText('33');
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toBeVisible();

    await selectDeviceNode(page, 0);
    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    await expect(page.locator('.device-log__line', { hasText: 'Sound output started (level 127)' })).toHaveCount(1);

    await selectDeviceNode(page, 1);
    await dragDeviceNodeBy(page, 1, { x: 220, y: 0 });
    await expect(selectedSoundMetric(page)).toHaveText('0');
    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toBeVisible();

    await page.locator('[data-testid="device-button-device-1-AB"]').click();
    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toHaveCount(0, { timeout: 2_000 });
  });

  test('keeps muted MakeCode sound from emitting runtime sound activity', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(makeCodeBeaconFixture);
    await expect(page.getByText('Assigned: mc_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: makecode-pxt')).toBeVisible({ timeout: 15_000 });

    await updateSelectedMakeCodeSource(page, 'Node 1', makeCodeMutedContinuousSoundProgram);
    await waitForMakeCodeRuntimeReady(page);

    await page.locator('[data-testid="device-button-device-1-B"]').click();
    await page.waitForTimeout(800);
    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toHaveCount(0);

    const eventLog = page.getByLabel('Event log for Node 1');
    await eventLog.locator('summary').click();
    await expect(page.locator('.device-log__line', { hasText: 'Sound output started' })).toHaveCount(0);
  });

  test('lets nearby devices pick up transient runtime sound from another micro:bit', async ({ page }) => {
    await gotoCanvas(page);
    await page.getByLabel(/Load code onto Node 1/).setInputFiles(microPythonFixture);
    await expect(page.getByText('Assigned: mp_beacon.hex')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Runtime source: micropython')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-runtime-state="device-1:ready"]')).toBeVisible({ timeout: 15_000 });

    await addDeviceFromSwarmTools(page);

    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('/micropython-patched-simulator.html')))
      .toBe(true);
    const simulatorFrame = page.frames().find((frame) => frame.url().includes('/micropython-patched-simulator.html'));
    expect(simulatorFrame).toBeTruthy();
    await simulatorFrame!.evaluate(() => {
      window.parent.postMessage({ kind: 'serial_output', data: '\x1eSWARM_SOUND:255\n' }, window.location.origin);
    });

    await expect(page.locator('[data-runtime-sound-radius="device-1"]')).toBeVisible();
    const nearbySoundValue = page
      .locator('.radio-summary div', { has: page.locator('dt', { hasText: 'Sound' }) })
      .locator('dd');
    await expect(nearbySoundValue).toHaveText('144');
    await expect(nearbySoundValue).toHaveText('0', { timeout: 2_000 });
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

    await page.getByRole('button', { name: /^Reset$/ }).first().click();
    await expect(page.locator('[data-runtime-state="device-1:error"]')).toHaveCount(0);
  });

  test('persists MicroPython assignment across browser save/load workflow', async ({ page }) => {
    const saveName = 'MicroPython Persisted Layout';
    await page.addInitScript((layoutName) => {
      window.prompt = () => layoutName;
      window.confirm = () => true;
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

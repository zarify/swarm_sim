export const MICROBIT_LED_PIXEL_COUNT = 25;
export const MICROBIT_LED_BRIGHTNESS_MIN = 0;
export const MICROBIT_LED_BRIGHTNESS_MAX = 9;

export function normalizeRuntimeDisplayPixels(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== MICROBIT_LED_PIXEL_COUNT) {
    return undefined;
  }

  const normalized: number[] = [];
  for (const entry of value) {
    const numeric = Number(entry);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    normalized.push(clampDisplayBrightness(numeric));
  }

  return normalized;
}

function clampDisplayBrightness(value: number): number {
  return Math.max(
    MICROBIT_LED_BRIGHTNESS_MIN,
    Math.min(MICROBIT_LED_BRIGHTNESS_MAX, Math.round(value)),
  );
}

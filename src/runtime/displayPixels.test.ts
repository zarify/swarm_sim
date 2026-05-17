import { describe, expect, it } from 'vitest';
import { normalizeRuntimeDisplayPixels } from './displayPixels';

describe('normalizeRuntimeDisplayPixels', () => {
  it('normalizes a 25-pixel frame and clamps values to 0-9', () => {
    const normalized = normalizeRuntimeDisplayPixels([
      -1, 0, 1.2, 8.6, 10,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]);

    expect(normalized).toEqual([
      0, 0, 1, 9, 9,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ]);
  });

  it('returns undefined for non-array, wrong-size, or non-finite frames', () => {
    expect(normalizeRuntimeDisplayPixels('bad')).toBeUndefined();
    expect(normalizeRuntimeDisplayPixels([1, 2, 3])).toBeUndefined();
    expect(normalizeRuntimeDisplayPixels(Array.from({ length: 25 }, () => NaN))).toBeUndefined();
  });
});

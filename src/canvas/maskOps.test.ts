import { describe, expect, it } from 'vitest';
import { composeFinal, computeRefined, gaussianBlur, morph, softThresholdLut } from './maskOps';

const grid = (w: number, h: number, fn: (x: number, y: number) => number) => {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
  return a;
};

describe('softThresholdLut', () => {
  it('keeps hard 0 and 255 at every threshold', () => {
    for (const t of [0, 25, 50, 75, 100]) {
      const lut = softThresholdLut(t);
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
    }
  });
  it('is monotonic and stricter for higher thresholds', () => {
    const lo = softThresholdLut(20);
    const hi = softThresholdLut(80);
    for (let v = 1; v < 256; v++) expect(lo[v]!).toBeGreaterThanOrEqual(lo[v - 1]!);
    expect(hi[128]!).toBeLessThan(lo[128]!);
  });
});

describe('morph', () => {
  const square = grid(21, 21, (x, y) => (x >= 8 && x <= 12 && y >= 8 && y <= 12 ? 255 : 0));
  const count = (m: Uint8Array) => m.reduce((n, v) => n + (v === 255 ? 1 : 0), 0);

  it('dilate grows a 5x5 square to 9x9 with radius 2', () => {
    expect(count(morph(square, 21, 21, 2, true))).toBe(81);
  });
  it('erode shrinks a 5x5 square to 1x1 with radius 2', () => {
    expect(count(morph(square, 21, 21, 2, false))).toBe(1);
  });
  it('radius 0 is a copy', () => {
    const out = morph(square, 21, 21, 0, true);
    expect(out).toEqual(square);
    expect(out).not.toBe(square);
  });
});

describe('gaussianBlur', () => {
  it('preserves a constant field and conserves rough mass', () => {
    const flat = new Uint8Array(30 * 30).fill(200);
    expect(gaussianBlur(flat, 30, 30, 3).every((v) => v === 200)).toBe(true);
    const spot = grid(31, 31, (x, y) => (x === 15 && y === 15 ? 255 : 0));
    const blurred = gaussianBlur(spot, 31, 31, 2);
    const sum = blurred.reduce((s, v) => s + v, 0);
    expect(Math.abs(sum - 255)).toBeLessThan(40);
    expect(blurred[15 * 31 + 15]).toBeLessThan(255);
  });
  it('sub-pixel sigma is a no-op', () => {
    const m = grid(5, 5, (x) => x * 50);
    expect(gaussianBlur(m, 5, 5, 0.2)).toEqual(m);
  });
});

describe('computeRefined', () => {
  const base = grid(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? 255 : 0));

  it('does not mutate the base mask', () => {
    const copy = base.slice();
    computeRefined(base, 40, 40, { threshold: 70, feather: 4, edgeShift: 3 }, 1);
    expect(base).toEqual(copy);
  });
  it('positive edge shift grows, negative shrinks', () => {
    const area = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);
    const grown = computeRefined(base, 40, 40, { threshold: 50, feather: 0, edgeShift: 3 }, 1);
    const shrunk = computeRefined(base, 40, 40, { threshold: 50, feather: 0, edgeShift: -3 }, 1);
    expect(area(grown)).toBeGreaterThan(area(base));
    expect(area(shrunk)).toBeLessThan(area(base));
  });
  it('scales units with the work/source ratio', () => {
    // 4 source px at scale 0.5 = 2 work px
    const half = computeRefined(base, 40, 40, { threshold: 50, feather: 0, edgeShift: 4 }, 0.5);
    const direct = computeRefined(base, 40, 40, { threshold: 50, feather: 0, edgeShift: 2 }, 1);
    expect(half).toEqual(direct);
  });
  it('feather softens the edge', () => {
    const out = computeRefined(base, 40, 40, { threshold: 50, feather: 4, edgeShift: 0 }, 1);
    const edge = out[20 * 40 + 10]!;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
});

describe('composeFinal', () => {
  it('clamps refined + delta to 0..255', () => {
    const refined = Uint8Array.from([0, 100, 250, 255]);
    const delta = Int16Array.from([-50, 50, 50, -300]);
    const out = new Uint8Array(4);
    composeFinal(refined, delta, out);
    expect(Array.from(out)).toEqual([0, 150, 255, 0]);
  });
});

import { describe, expect, it } from 'vitest';
import { fitRect } from './compositor';

describe('fitRect', () => {
  it('stretch fills the target', () => {
    expect(fitRect('stretch', 100, 50, 10, 20, 200, 200)).toEqual({ x: 10, y: 20, w: 200, h: 200 });
  });
  it('cover fills the target and overflows the short side, centred', () => {
    const r = fitRect('cover', 100, 50, 0, 0, 200, 200);
    expect(r.h).toBe(200);
    expect(r.w).toBe(400);
    expect(r.x).toBe(-100);
  });
  it('contain fits inside the target, centred', () => {
    const r = fitRect('contain', 100, 50, 0, 0, 200, 200);
    expect(r.w).toBe(200);
    expect(r.h).toBe(100);
    expect(r.y).toBe(50);
  });
});

import { describe, expect, it } from 'vitest';
import { falloff, replayStrokes, stamp, StrokePainter, type Stroke } from './brush';

describe('falloff', () => {
  it('is 1 in the core and 0 at the rim', () => {
    expect(falloff(0, 10, 50)).toBe(1);
    expect(falloff(5, 10, 50)).toBe(1);
    expect(falloff(10, 10, 50)).toBe(0);
    expect(falloff(7.5, 10, 50)).toBeGreaterThan(0);
    expect(falloff(7.5, 10, 50)).toBeLessThan(1);
  });
  it('hardness 100 is a hard disc', () => {
    expect(falloff(9.9, 10, 100)).toBe(1);
  });
});

describe('stamp', () => {
  it('keep raises, erase lowers, and later opposite dabs override', () => {
    const d = new Int16Array(20 * 20);
    stamp(d, 20, 20, 10, 10, 4, 100, 'keep');
    expect(d[10 * 20 + 10]).toBe(255);
    stamp(d, 20, 20, 10, 10, 4, 100, 'erase');
    expect(d[10 * 20 + 10]).toBe(-255);
    stamp(d, 20, 20, 10, 10, 4, 100, 'keep');
    expect(d[10 * 20 + 10]).toBe(255);
  });
  it('clips at the buffer edge and reports a clipped rect', () => {
    const d = new Int16Array(10 * 10);
    const r = stamp(d, 10, 10, 0, 0, 5, 100, 'keep')!;
    expect(r.x0).toBe(0);
    expect(r.y0).toBe(0);
    expect(stamp(d, 10, 10, 500, 500, 5, 100, 'keep')).toBeNull();
  });
});

describe('StrokePainter / replay', () => {
  const stroke: Stroke = {
    mode: 'keep',
    size: 6,
    hardness: 80,
    points: [
      [5, 5, 1],
      [30, 12, 1],
      [50, 40, 0.6],
    ],
  };

  it('paints a continuous line (no gaps along the path)', () => {
    const d = new Int16Array(60 * 60);
    replayStrokes(d, 60, 60, 1, [stroke]);
    for (let t = 0; t <= 1; t += 0.05) {
      const x = Math.round(5 + 25 * t);
      const y = Math.round(5 + 7 * t);
      expect(d[y * 60 + x]).toBeGreaterThan(200);
    }
  });

  it('live incremental painting equals replay (deterministic undo)', () => {
    const live = new Int16Array(60 * 60);
    const p = new StrokePainter(live, 60, 60, 1, stroke.mode, stroke.size, stroke.hardness);
    for (const [x, y, pr] of stroke.points) p.add(x, y, pr);
    const replayed = new Int16Array(60 * 60);
    replayStrokes(replayed, 60, 60, 1, [stroke]);
    expect(live).toEqual(replayed);
  });

  it('replaying an empty list clears the layer', () => {
    const d = new Int16Array(16).fill(7);
    replayStrokes(d, 4, 4, 1, []);
    expect(d.every((v) => v === 0)).toBe(true);
  });

  it('scales radius with work/source ratio', () => {
    const d = new Int16Array(100 * 100);
    replayStrokes(d, 100, 100, 0.5, [
      { mode: 'keep', size: 40, hardness: 100, points: [[100, 100, 1]] },
    ]);
    // source (100,100) -> work (50,50), radius 10 work px
    expect(d[50 * 100 + 50]).toBe(255);
    expect(d[50 * 100 + 65]).toBe(0);
    expect(d[50 * 100 + 58]).toBe(255);
  });
});

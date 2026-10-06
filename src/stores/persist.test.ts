import { describe, expect, it } from 'vitest';
import { newImageState } from './editorStore';
import { fromPersisted, toPersisted } from './persist';

describe('persisted editor state', () => {
  it('round-trips a realistic state', () => {
    const s = newImageState(400, 300);
    s.refine = { threshold: 70, feather: 5, edgeShift: -3 };
    s.background = { kind: 'solid', color: '#112233', image: null, fit: 'contain' };
    s.strokes = [
      {
        mode: 'erase',
        size: 30,
        hardness: 60,
        points: [
          [1, 2, 0.5],
          [3, 4, 1],
        ],
      },
    ];
    s.split = 0.3;
    const back = fromPersisted(JSON.parse(JSON.stringify(toPersisted(s))), 400, 300);
    expect(back.refine).toEqual(s.refine);
    expect(back.background).toEqual(s.background);
    expect(back.strokes).toEqual(s.strokes);
    expect(back.split).toBe(0.3);
  });

  it('does not persist history, viewport or live-drag bookkeeping', () => {
    const keys = Object.keys(toPersisted(newImageState(1, 1)));
    expect(keys.sort()).toEqual(['background', 'output', 'refine', 'split', 'strokes']);
  });

  it('survives garbage without throwing and falls back to defaults', () => {
    for (const junk of [
      null,
      undefined,
      5,
      'x',
      [],
      { refine: 'no', strokes: 'no', background: 7 },
    ]) {
      const s = fromPersisted(junk, 100, 50);
      expect(s.refine).toEqual({ threshold: 50, feather: 2, edgeShift: 0 });
      expect(s.strokes).toEqual([]);
      expect(s.output).toMatchObject({ width: 100, height: 50 });
    }
  });

  it('clamps out-of-range values and drops malformed strokes', () => {
    const s = fromPersisted(
      {
        refine: { threshold: 500, feather: -4, edgeShift: 'NaN' },
        output: { width: -5, height: 1e9 },
        split: 9,
        strokes: [
          {
            mode: 'keep',
            size: 99999,
            hardness: -1,
            points: [
              [1, 2, 7],
              ['a', 2],
              [NaN, 1],
            ],
          },
          { mode: 'paint', points: [[1, 1]] },
          { mode: 'erase', points: [] },
        ],
      },
      100,
      50,
    );
    expect(s.refine).toEqual({ threshold: 100, feather: 0, edgeShift: 0 });
    expect(s.output.width).toBe(1);
    expect(s.output.height).toBe(100000);
    expect(s.split).toBe(1);
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]).toMatchObject({ size: 150, hardness: 0, points: [[1, 2, 1]] });
  });

  it('refuses an image background without a usable image', () => {
    const s = fromPersisted({ background: { kind: 'image', image: { cachePath: 3 } } }, 10, 10);
    expect(s.background.kind).toBe('transparent');
  });
});

/**
 * Cross-implementation parity: the same inputs go through the TypeScript preview maths and the
 * Rust export maths. This test writes/validates `src-tauri/tests/fixtures/mask_parity.json`;
 * the Rust side (`src/tests/parity.rs`) checks its own output against the same file.
 *
 * Regenerate after an intentional change:  UPDATE_FIXTURES=1 npx vitest run src/canvas/parity
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayStrokes, type Stroke } from './brush';
import { composeFinal, computeRefined, type RefineParams } from './maskOps';

const W = 64;
const H = 48;
const FIXTURE = resolve(process.cwd(), 'src-tauri/tests/fixtures/mask_parity.json');

/** Deterministic pseudo-"model mask": a soft disc plus blocky noise. */
function baseMask(): number[] {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 30, y - 24);
      let v = d < 14 ? 255 : d < 18 ? Math.round(255 * (1 - (d - 14) / 4)) : 0;
      if (rnd() < 0.04) v = Math.round(rnd() * 255);
      out.push(v);
    }
  }
  return out;
}

const strokes: Stroke[] = [
  {
    mode: 'erase',
    size: 14,
    hardness: 40,
    points: [
      [10, 10, 1],
      [30, 14, 1],
      [50, 30, 0.6],
    ],
  },
  {
    mode: 'keep',
    size: 9,
    hardness: 90,
    points: [
      [5, 40, 1],
      [20, 42, 0.5],
      [40, 40, 1],
    ],
  },
  { mode: 'erase', size: 20, hardness: 100, points: [[32, 24, 1]] },
];

interface Case {
  name: string;
  params: RefineParams;
  scale: number;
  strokes: Stroke[];
}

const cases: Case[] = [
  { name: 'defaults', params: { threshold: 50, feather: 2, edgeShift: 0 }, scale: 1, strokes: [] },
  {
    name: 'strict+grow+soft',
    params: { threshold: 70, feather: 4, edgeShift: 3 },
    scale: 1,
    strokes: [],
  },
  {
    name: 'shrink at half scale',
    params: { threshold: 30, feather: 8, edgeShift: -5 },
    scale: 0.5,
    strokes: [],
  },
  { name: 'no refine', params: { threshold: 0, feather: 0, edgeShift: 0 }, scale: 1, strokes: [] },
  { name: 'strokes', params: { threshold: 50, feather: 2, edgeShift: 0 }, scale: 1, strokes },
  {
    name: 'strokes+refine',
    params: { threshold: 60, feather: 3, edgeShift: -2 },
    scale: 1,
    strokes,
  },
];

function run(c: Case, base: number[]) {
  const baseArr = Uint8Array.from(base);
  const refined = computeRefined(baseArr, W, H, c.params, c.scale);
  const delta = new Int16Array(W * H);
  replayStrokes(delta, W, H, c.scale, c.strokes);
  const out = new Uint8Array(W * H);
  composeFinal(refined, delta, out);
  return Array.from(out);
}

describe('TS <-> Rust mask parity fixture', () => {
  const base = baseMask();
  const generated = {
    width: W,
    height: H,
    base,
    cases: cases.map((c) => ({ ...c, expected: run(c, base) })),
  };

  it('matches the committed fixture (so the Rust test checks current behaviour)', () => {
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(generated));
    }
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(generated)));
  });

  it('cases actually exercise the maths', () => {
    const [defaults, , , raw] = generated.cases;
    expect(defaults!.expected).not.toEqual(base);
    expect(raw!.expected).toBeDefined();
    const withStrokes = generated.cases[4]!.expected;
    expect(withStrokes).not.toEqual(generated.cases[0]!.expected);
  });
});

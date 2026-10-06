export type BrushMode = 'keep' | 'erase';

/** One brush stroke in SOURCE-image coordinates. `points` are [x, y, pressure 0..1]. */
export interface Stroke {
  mode: BrushMode;
  /** Diameter in source px. */
  size: number;
  /** 0..100. 100 = hard edge. */
  hardness: number;
  points: [number, number, number][];
}

export const BRUSH_LIMITS = {
  size: { min: 1, max: 150 },
  hardness: { min: 0, max: 100 },
} as const;
export const DEFAULT_BRUSH = { size: 40, hardness: 70 };

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

export const unionRect = (a: Rect | null, b: Rect | null): Rect | null =>
  !a
    ? b
    : !b
      ? a
      : {
          x0: Math.min(a.x0, b.x0),
          y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1),
          y1: Math.max(a.y1, b.y1),
        };

/** Falloff: 1 inside the hard core, smoothly to 0 at the radius. */
export function falloff(d: number, radius: number, hardness: number): number {
  const core = radius * (hardness / 100);
  if (d <= core) return 1;
  if (d >= radius) return 0;
  const t = (d - core) / (radius - core);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Stamp one dab into the delta layer (keep raises toward +, erase lowers toward -).
 * Returns the touched rectangle (clipped to the buffer) or null.
 */
export function stamp(
  delta: Int16Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  hardness: number,
  mode: BrushMode,
): Rect | null {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(w, Math.ceil(cx + r) + 1);
  const y1 = Math.min(h, Math.ceil(cy + r) + 1);
  if (x0 >= x1 || y0 >= y1) return null;
  const keep = mode === 'keep';
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const a = falloff(Math.sqrt(dx * dx + dy * dy), r, hardness);
      if (a <= 0) continue;
      const v = Math.round(a * 255);
      const i = y * w + x;
      if (keep) {
        if (v > delta[i]!) delta[i] = v;
      } else if (-v < delta[i]!) delta[i] = -v;
    }
  }
  return { x0, y0, x1, y1 };
}

const SPACING = 0.2; // fraction of the diameter between dabs

/**
 * Paints a stroke incrementally with evenly spaced dabs. Live painting and replay (undo, export)
 * use this same class, so both give identical results.
 */
export class StrokePainter {
  private last: [number, number, number] | null = null;
  private carry = 0;

  constructor(
    private readonly delta: Int16Array,
    private readonly w: number,
    private readonly h: number,
    /** work px per source px */
    private readonly scale: number,
    private readonly mode: BrushMode,
    private readonly size: number,
    private readonly hardness: number,
  ) {}

  private dab(x: number, y: number, p: number): Rect | null {
    const radius = (this.size / 2) * Math.max(0.2, p) * this.scale;
    return stamp(
      this.delta,
      this.w,
      this.h,
      x * this.scale,
      y * this.scale,
      radius,
      this.hardness,
      this.mode,
    );
  }

  /** Add a point (source coords). Returns the dirty rect in buffer coords. */
  add(x: number, y: number, p = 1): Rect | null {
    if (!this.last) {
      this.last = [x, y, p];
      return this.dab(x, y, p);
    }
    const [lx, ly, lp] = this.last;
    const dist = Math.hypot(x - lx, y - ly);
    const step = Math.max(0.5 / this.scale, this.size * SPACING * Math.max(0.2, p));
    let dirty: Rect | null = null;
    let travelled = step - this.carry;
    while (travelled <= dist) {
      const t = dist === 0 ? 1 : travelled / dist;
      dirty = unionRect(dirty, this.dab(lx + (x - lx) * t, ly + (y - ly) * t, lp + (p - lp) * t));
      travelled += step;
    }
    this.carry = dist - (travelled - step);
    this.last = [x, y, p];
    return dirty;
  }
}

/** Replay stored strokes into a fresh/cleared delta buffer. */
export function replayStrokes(
  delta: Int16Array,
  w: number,
  h: number,
  scale: number,
  strokes: readonly Stroke[],
) {
  delta.fill(0);
  for (const s of strokes) {
    const painter = new StrokePainter(delta, w, h, scale, s.mode, s.size, s.hardness);
    for (const [x, y, p] of s.points) painter.add(x, y, p);
  }
}

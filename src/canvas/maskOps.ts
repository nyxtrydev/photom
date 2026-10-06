/**
 * Mask maths shared (conceptually) with the Rust exporter. All buffers are 8-bit, row-major.
 * Refine units (feather, edge shift) are SOURCE pixels; `scale` converts them to the buffer's
 * resolution (work / source) so previews match full-resolution export.
 */
export interface RefineParams {
  /** 0..100. Higher keeps less (stricter). */
  threshold: number;
  /** 0..20 source px of Gaussian softening. */
  feather: number;
  /** -20..20 source px. Positive grows the subject, negative shrinks it. */
  edgeShift: number;
}

export const DEFAULT_REFINE: RefineParams = { threshold: 50, feather: 2, edgeShift: 0 };
export const REFINE_LIMITS = {
  threshold: { min: 0, max: 100 },
  feather: { min: 0, max: 20 },
  edgeShift: { min: -20, max: 20 },
} as const;

const SOFT_WIDTH = 32;

/** Soft threshold lookup table: a linear ramp of width 2*SOFT_WIDTH around the cut-off. */
export function softThresholdLut(threshold: number): Uint8Array {
  const t = Math.min(100, Math.max(0, threshold)) / 100;
  const centre = SOFT_WIDTH + t * (255 - 2 * SOFT_WIDTH);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = (v - (centre - SOFT_WIDTH)) / (2 * SOFT_WIDTH);
    lut[v] = Math.round(255 * Math.min(1, Math.max(0, x)));
  }
  return lut;
}

/** Sliding-window min/max along one row using a monotonic deque (O(n)). */
function slideRow(
  src: Uint8Array,
  dst: Uint8Array,
  start: number,
  n: number,
  radius: number,
  isMax: boolean,
  deque: Int32Array,
) {
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + radius);
    while (next <= hi) {
      const v = src[start + next]!;
      while (tail > head) {
        const last = src[start + deque[tail - 1]!]!;
        if (isMax ? last <= v : last >= v) tail--;
        else break;
      }
      deque[tail++] = next++;
    }
    while (deque[head]! < i - radius) head++;
    dst[start + i] = src[start + deque[head]!]!;
  }
}

/** Cache-friendly blocked transpose (w x h -> h x w). */
function transpose(src: Uint8Array, dst: Uint8Array, w: number, h: number) {
  const B = 32;
  for (let by = 0; by < h; by += B) {
    for (let bx = 0; bx < w; bx += B) {
      const ye = Math.min(h, by + B);
      const xe = Math.min(w, bx + B);
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) dst[x * h + y] = src[y * w + x]!;
      }
    }
  }
}

/** Square-structuring-element dilate (max) or erode (min) with the given radius in pixels. */
export function morph(
  src: Uint8Array,
  w: number,
  h: number,
  radius: number,
  dilate: boolean,
): Uint8Array {
  const r = Math.round(radius);
  if (r <= 0) return src.slice();
  const a = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  const deque = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) slideRow(src, a, y * w, w, r, dilate, deque);
  transpose(a, b, w, h); // columns become rows
  for (let x = 0; x < w; x++) slideRow(b, a, x * h, h, r, dilate, deque);
  transpose(a, b, h, w);
  return b;
}

/** Box sizes whose successive application approximates a Gaussian of the given sigma. */
function boxSizes(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** value -> rounded (value / div) lookup, avoids a division per pixel. */
function roundTable(div: number): Uint8Array {
  const t = new Uint8Array(255 * div + 1);
  const half = div >> 1;
  for (let v = 0; v < t.length; v++) t[v] = Math.floor((v + half) / div);
  return t;
}

/** Horizontal box blur with edge replication. Window for output x covers [x - r, x + r]. */
function boxBlurH(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const tbl = roundTable(2 * r + 1);
  const safeR = Math.min(r, Math.floor((w - 1) / 2));
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = (r + 1) * src[o]!;
    for (let j = 1; j <= r; j++) acc += src[o + Math.min(j, w - 1)]!;
    let x = 0;
    // left edge: outgoing sample is replicated src[o]
    for (; x <= safeR && x < w; x++) {
      dst[o + x] = tbl[acc]!;
      acc += src[o + Math.min(x + r + 1, w - 1)]! - src[o]!;
    }
    // interior: no clamping needed
    const interiorEnd = w - r - 1;
    for (; x < interiorEnd; x++) {
      dst[o + x] = tbl[acc]!;
      acc += src[o + x + r + 1]! - src[o + x - r]!;
    }
    // right edge: incoming sample is replicated src[o + w - 1]
    const last = src[o + w - 1]!;
    for (; x < w; x++) {
      dst[o + x] = tbl[acc]!;
      acc += last - src[o + Math.max(x - r, 0)]!;
    }
  }
}

/** Vertical box blur, swept row-by-row so memory access stays contiguous. */
function boxBlurV(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const tbl = roundTable(2 * r + 1);
  const acc = new Int32Array(w);
  for (let x = 0; x < w; x++) acc[x] = (r + 1) * src[x]!;
  for (let j = 1; j <= r; j++) {
    const o = Math.min(j, h - 1) * w;
    for (let x = 0; x < w; x++) acc[x]! += src[o + x]!;
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const addO = Math.min(y + r + 1, h - 1) * w;
    const subO = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) {
      const a = acc[x]!;
      dst[o + x] = tbl[a]!;
      acc[x] = a + src[addO + x]! - src[subO + x]!;
    }
  }
}

/** Gaussian blur approximated by three box blurs. */
export function gaussianBlur(src: Uint8Array, w: number, h: number, sigma: number): Uint8Array {
  if (sigma < 0.5) return src.slice();
  const a: Uint8Array = src.slice();
  const b: Uint8Array = new Uint8Array(w * h);
  for (const size of boxSizes(sigma, 3)) {
    const r = Math.max(1, (size - 1) / 2);
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return a;
}

/**
 * Non-destructive refinement of the raw model mask: soft threshold, then edge shift, then feather.
 * Never mutates `base`.
 */
export function computeRefined(
  base: Uint8Array,
  w: number,
  h: number,
  params: RefineParams,
  scale: number,
): Uint8Array {
  const lut = softThresholdLut(params.threshold);
  let m: Uint8Array = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) m[i] = lut[base[i]!]!;

  const shift = Math.abs(params.edgeShift) * scale;
  if (Math.round(shift) >= 1) m = morph(m, w, h, shift, params.edgeShift > 0);

  const sigma = params.feather * scale;
  if (sigma >= 0.5) m = gaussianBlur(m, w, h, sigma);
  return m;
}

/** final = clamp(refined + delta), where delta holds keep (+) and erase (-) edits. */
export function composeFinal(refined: Uint8Array, delta: Int16Array, out: Uint8Array) {
  for (let i = 0; i < refined.length; i++) {
    const v = refined[i]! + delta[i]!;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

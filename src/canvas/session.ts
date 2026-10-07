import { replayStrokes, StrokePainter, type BrushMode, type Rect, type Stroke } from './brush';
import { computeRefined, type RefineParams } from './maskOps';

export interface SessionInit {
  workWidth: number;
  workHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  preview: ImageBitmap;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Working-resolution mask state for ONE image: raw model mask, refined mask, keep/erase edit
 * layer and the composited "after" bitmap. Lives outside React/zustand so brush strokes can
 * update it at frame rate. Buffers are released with `dispose()` when the image is switched away.
 */
export class MaskSession {
  readonly w: number;
  readonly h: number;
  readonly srcW: number;
  readonly srcH: number;
  /** work px per source px */
  readonly scale: number;
  readonly originalCanvas: HTMLCanvasElement;
  readonly afterCanvas: HTMLCanvasElement;

  private readonly afterCtx: CanvasRenderingContext2D;
  private readonly afterData: ImageData;
  private base: Uint8Array | null = null;
  private refined: Uint8Array | null = null;
  private readonly delta: Int16Array;
  private params: RefineParams;
  /** Bumped whenever the composited alpha changes (so dependants like the shadow can cache). */
  private rev = 0;

  constructor(init: SessionInit, params: RefineParams) {
    this.w = init.workWidth;
    this.h = init.workHeight;
    this.srcW = init.sourceWidth;
    this.srcH = init.sourceHeight;
    this.scale = this.w / this.srcW;
    this.params = params;
    this.delta = new Int16Array(this.w * this.h);

    this.originalCanvas = makeCanvas(this.w, this.h);
    const octx = this.originalCanvas.getContext('2d', { willReadFrequently: true })!;
    octx.drawImage(init.preview, 0, 0, this.w, this.h);
    const pixels = octx.getImageData(0, 0, this.w, this.h);

    this.afterCanvas = makeCanvas(this.w, this.h);
    this.afterCtx = this.afterCanvas.getContext('2d', { willReadFrequently: true })!;
    this.afterData = pixels; // same RGB; alpha is rewritten from the mask
    this.composeAll();
  }

  get alphaRev(): number {
    return this.rev;
  }

  /**
   * The composited subject alpha (model mask, refine and brush edits) averaged down to
   * `scale` proxy pixels per source pixel (never above the working resolution).
   */
  alphaAt(scale: number): { data: Uint8Array; w: number; h: number; scale: number } {
    const sc = Math.min(Math.max(scale, 1e-4), this.scale);
    const w = Math.max(1, Math.round(this.srcW * sc));
    const h = Math.max(1, Math.round(this.srcH * sc));
    const src = this.afterData.data;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor((y * this.h) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * this.h) / h));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * this.w) / w);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * this.w) / w));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * this.w;
          for (let xx = x0; xx < x1; xx++) sum += src[(row + xx) * 4 + 3]!;
        }
        out[y * w + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
    return { data: out, w, h, scale: w / this.srcW };
  }

  /**
   * The subject's colours at the same size as `alphaAt(scale)` (straight RGBA, colours averaged
   * weighted by alpha so transparent pixels do not darken the edges). Used by reflections.
   */
  rgbaAt(scale: number): { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
    const sc = Math.min(Math.max(scale, 1e-4), this.scale);
    const w = Math.max(1, Math.round(this.srcW * sc));
    const h = Math.max(1, Math.round(this.srcH * sc));
    const src = this.afterData.data;
    const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor((y * this.h) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * this.h) / h));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * this.w) / w);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * this.w) / w));
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * this.w;
          for (let xx = x0; xx < x1; xx++) {
            const i = (row + xx) * 4;
            const pa = src[i + 3]!;
            a += pa;
            r += src[i]! * pa;
            g += src[i + 1]! * pa;
            b += src[i + 2]! * pa;
          }
        }
        const o = (y * w + x) * 4;
        if (a > 0) {
          out[o] = r / a;
          out[o + 1] = g / a;
          out[o + 2] = b / a;
        }
        out[o + 3] = a / ((y1 - y0) * (x1 - x0));
      }
    }
    return { data: out, w, h };
  }

  get hasMask(): boolean {
    return this.base !== null;
  }

  /** Load/replace the raw model mask (working size) or clear it with `null`. */
  setBase(mask: ImageBitmap | null) {
    if (!mask) {
      this.base = null;
      this.refined = null;
    } else {
      const c = makeCanvas(this.w, this.h);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(mask, 0, 0, this.w, this.h);
      const rgba = ctx.getImageData(0, 0, this.w, this.h).data;
      const gray = new Uint8Array(this.w * this.h);
      for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4]!;
      this.base = gray;
      this.refined = computeRefined(gray, this.w, this.h, this.params, this.scale);
    }
    this.composeAll();
  }

  setRefine(params: RefineParams) {
    this.params = params;
    if (this.base) this.refined = computeRefined(this.base, this.w, this.h, params, this.scale);
    this.composeAll();
  }

  /** Rebuild the edit layer from stored strokes (undo/redo/clear). */
  rebuild(strokes: readonly Stroke[]) {
    replayStrokes(this.delta, this.w, this.h, this.scale, strokes);
    this.composeAll();
  }

  beginStroke(mode: BrushMode, size: number, hardness: number) {
    return new StrokePainter(this.delta, this.w, this.h, this.scale, mode, size, hardness);
  }

  /** Re-composite a dirty rectangle after painting. */
  update(rect: Rect | null) {
    if (!rect) return;
    this.rev++;
    this.compose(rect);
    this.afterCtx.putImageData(
      this.afterData,
      0,
      0,
      rect.x0,
      rect.y0,
      rect.x1 - rect.x0,
      rect.y1 - rect.y0,
    );
  }

  private compose(r: Rect) {
    const data = this.afterData.data;
    const { refined, delta, w } = this;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = y * w + x;
        const v = refined ? refined[i]! + delta[i]! : 255;
        data[i * 4 + 3] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  private composeAll() {
    this.rev++;
    this.compose({ x0: 0, y0: 0, x1: this.w, y1: this.h });
    this.afterCtx.putImageData(this.afterData, 0, 0);
  }

  /** Release pixel buffers (call when switching images). */
  dispose() {
    this.originalCanvas.width = 0;
    this.afterCanvas.width = 0;
    this.base = null;
    this.refined = null;
  }
}

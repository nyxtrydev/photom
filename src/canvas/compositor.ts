import type { BackgroundKind, CompareMode, FitMode } from '@/stores/editorStore';
import type { MaskSession } from './session';
import type { FrameRect, Viewport } from './viewport';

export interface RenderColors {
  checkerA: string;
  checkerB: string;
  border: string;
}

export interface RenderOptions {
  width: number;
  height: number;
  dpr: number;
  vp: Viewport;
  session: MaskSession | null;
  /** Source size; the image is always laid out in source pixels. */
  srcW: number;
  srcH: number;
  /** The editing frame in source px (the image plus any shadow margin). */
  frame: FrameRect;
  /** Shadow bitmap covering `frame`, drawn under the subject. */
  shadow: HTMLCanvasElement | null;
  /** Debug view: only the shadow, on a neutral grey (no subject, no background, no Before/After). */
  shadowOnly?: boolean;
  split: number;
  compare: CompareMode;
  showChecker: boolean;
  background: { kind: BackgroundKind; color: string; image: ImageBitmap | null; fit: FitMode };
  colors: RenderColors;
}

/** The shadow-only view sits on mid-light grey so both dark and light shadows read clearly. */
export const SHADOW_ONLY_BACKDROP = '#d4d4d4';

let patternCache: { key: string; pattern: CanvasPattern } | null = null;

function checkerPattern(ctx: CanvasRenderingContext2D, colors: RenderColors, dpr: number) {
  const key = `${colors.checkerA}|${colors.checkerB}|${dpr}`;
  if (patternCache?.key === key) return patternCache.pattern;
  const size = Math.max(1, Math.round(8 * dpr));
  const tile = document.createElement('canvas');
  tile.width = size * 2;
  tile.height = size * 2;
  const t = tile.getContext('2d')!;
  t.fillStyle = colors.checkerA;
  t.fillRect(0, 0, size * 2, size * 2);
  t.fillStyle = colors.checkerB;
  t.fillRect(size, 0, size, size);
  t.fillRect(0, size, size, size);
  const pattern = ctx.createPattern(tile, 'repeat')!;
  pattern.setTransform(new DOMMatrix().scale(1 / dpr));
  patternCache = { key, pattern };
  return pattern;
}

/** Destination rect for a background picture inside the image rect. */
export function fitRect(
  mode: FitMode,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (mode === 'stretch') return { x, y, w, h };
  const s = mode === 'cover' ? Math.max(w / imgW, h / imgH) : Math.min(w / imgW, h / imgH);
  const dw = imgW * s;
  const dh = imgH * s;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  o: RenderOptions,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const bg = o.background;
  if (bg.kind === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(x, y, w, h);
  } else if (bg.kind === 'image' && bg.image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const r = fitRect(bg.fit, bg.image.width, bg.image.height, x, y, w, h);
    ctx.drawImage(bg.image, r.x, r.y, r.w, r.h);
    ctx.restore();
  } else if (o.showChecker) {
    ctx.fillStyle = checkerPattern(ctx, o.colors, o.dpr);
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = o.colors.checkerA;
    ctx.fillRect(x, y, w, h);
  }
}

/** Draw the viewport: background, Before/After split and the cut-out. Pure canvas, no DOM reads. */
export function render(ctx: CanvasRenderingContext2D, o: RenderOptions) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width * o.dpr, o.height * o.dpr);
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Source pixel (0,0) sits at (panX, panY); the frame may extend to negative source coordinates.
  const x = o.vp.panX;
  const y = o.vp.panY;
  const w = o.srcW * o.vp.zoom;
  const h = o.srcH * o.vp.zoom;
  const fx = x + o.frame.x * o.vp.zoom;
  const fy = y + o.frame.y * o.vp.zoom;
  const fw = o.frame.w * o.vp.zoom;
  const fh = o.frame.h * o.vp.zoom;
  const splitX = fx + fw * o.split;

  const region = (x0: number, x1: number, draw: () => void) => {
    if (x1 <= x0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, fy, x1 - x0, fh);
    ctx.clip();
    draw();
    ctx.restore();
  };

  if (o.shadowOnly) {
    region(fx, fx + fw, () => {
      ctx.fillStyle = SHADOW_ONLY_BACKDROP;
      ctx.fillRect(fx, fy, fw, fh);
      if (o.shadow) ctx.drawImage(o.shadow, fx, fy, fw, fh);
    });
    ctx.strokeStyle = o.colors.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(fx - 0.5, fy - 0.5, fw + 1, fh + 1);
    return;
  }

  const s = o.session;
  const afterStart = o.compare === 'after' ? fx : splitX;
  region(afterStart, fx + fw, () => {
    drawBackground(ctx, o, fx, fy, fw, fh);
    if (o.shadow) ctx.drawImage(o.shadow, fx, fy, fw, fh);
    if (s) ctx.drawImage(s.afterCanvas, x, y, w, h);
  });
  if (o.compare === 'split' && s) {
    region(fx, splitX, () => ctx.drawImage(s.originalCanvas, x, y, w, h));
  }

  ctx.strokeStyle = o.colors.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(fx - 0.5, fy - 0.5, fw + 1, fh + 1);
}

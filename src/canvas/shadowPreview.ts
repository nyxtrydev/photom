import {
  alphaBounds,
  groundLine,
  renderShadow,
  shadowActive,
  shadowBounds,
  type Frame,
  type ShadowState,
} from './shadow';
import type { MaskSession } from './session';

/** Longest side of the proxy the shadow is computed at (keeps slider drags interactive). */
const PROXY_MAX_SIDE = 640;
/** Longest side of the coarse mask used only to find the subject's bounding box. */
const COARSE_SIDE = 256;

export interface ShadowPreviewResult {
  /** The editing frame: the image plus any margin the shadow needs. */
  frame: Frame;
  /** The shadow covering `frame`, or null when there is nothing to draw. */
  canvas: HTMLCanvasElement | null;
  /** The subject's box in source px, and where the shadows stand (ground line, source px). */
  subject: Frame | null;
  ground: number | null;
}

/** Everything that changes the picture; layer ids and the preset label do not. */
const rectKey = (s: ShadowState) =>
  JSON.stringify([
    s.enabled,
    s.autoExpand,
    s.groundY,
    s.layers.map((l) => {
      const { id: _id, ...rest } = l;
      void _id;
      return rest;
    }),
  ]);

/**
 * Turns the live mask plus the shadow settings into a ready-to-draw shadow bitmap and the frame
 * that holds it. Results are cached per (mask revision, settings), so redraws that change neither
 * (pan, zoom) cost nothing. Everything is computed on a downscaled proxy; the full-resolution
 * render for export happens in Rust.
 */
export class ShadowPreview {
  private canvas: HTMLCanvasElement | null = null;
  private key = '';
  private result: ShadowPreviewResult | null = null;
  private coarseRev = -1;
  private subject: Frame | null = null;

  sync(
    session: MaskSession | null,
    shadow: ShadowState | null,
    srcW: number,
    srcH: number,
  ): ShadowPreviewResult {
    const plain: ShadowPreviewResult = {
      frame: { x: 0, y: 0, w: srcW, h: srcH },
      canvas: null,
      subject: null,
      ground: null,
    };
    // Without a cut-out there is no subject to cast a shadow.
    if (!session || !session.hasMask || !shadowActive(shadow)) return plain;

    const key = `${session.alphaRev}|${srcW}x${srcH}|${rectKey(shadow)}`;
    if (this.result && key === this.key) return this.result;

    // 1. Where is the subject? (coarse, cached until the mask changes)
    if (this.coarseRev !== session.alphaRev) {
      const coarse = session.alphaAt(COARSE_SIDE / Math.max(srcW, srcH));
      const b = alphaBounds(coarse.data, coarse.w, coarse.h);
      this.subject = b && {
        x: Math.floor(b.x0 / coarse.scale),
        y: Math.floor(b.y0 / coarse.scale),
        w: Math.ceil((b.x1 - b.x0) / coarse.scale) + 1,
        h: Math.ceil((b.y1 - b.y0) / coarse.scale) + 1,
      };
      this.coarseRev = session.alphaRev;
    }
    if (!this.subject) return plain;

    // 2. How big must the canvas be, and at what resolution do we draw into it?
    const frame = shadowBounds(this.subject, srcW, srcH, shadow);
    const scale = Math.min(1, PROXY_MAX_SIDE / Math.max(frame.w, frame.h));
    const proxy = session.alphaAt(scale);
    // The coarse box only sizes the canvas; the ground line needs the subject's real lowest pixel.
    const pb = alphaBounds(proxy.data, proxy.w, proxy.h);
    const subject: Frame | null = pb && {
      x: pb.x0 / proxy.scale,
      y: pb.y0 / proxy.scale,
      w: (pb.x1 - pb.x0) / proxy.scale,
      h: (pb.y1 - pb.y0) / proxy.scale,
    };
    const ground = groundLine(subject, srcH, shadow);
    const geom = subject && ground !== null ? { subject, ground } : null;
    const needsColour = shadow.layers.some((l) => l.type === 'reflection' && l.visible);
    const rgba = needsColour ? session.rgbaAt(scale) : null;
    const bitmap = renderShadow(
      proxy.data,
      proxy.w,
      proxy.h,
      proxy.scale,
      shadow,
      frame,
      geom,
      rgba,
    );

    const canvas = this.canvas ?? (this.canvas = document.createElement('canvas'));
    canvas.width = bitmap.w;
    canvas.height = bitmap.h;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(bitmap.data, bitmap.w, bitmap.h), 0, 0);

    this.key = key;
    this.result = { frame, canvas, subject, ground };
    return this.result;
  }

  /** The most recent result (for handles that need the current ground line). */
  last() {
    return this.result;
  }

  dispose() {
    if (this.canvas) this.canvas.width = 0;
    this.canvas = null;
    this.result = null;
    this.key = '';
  }
}

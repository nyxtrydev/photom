import { ChevronsLeftRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCacheBitmapScaled, prepareWorkingSet, loadCacheBitmap } from '@/api/image';
import { upscaleLoupe } from '@/api/upscale';
import { discardResult, keepUpscale } from '@/app/upscaleActions';
import { strings } from '@/i18n/strings';
import type { PendingUpscale } from '@/types/upscale';

const t = strings.upscale;

/** Longest side of the pictures drawn on screen (the loupe shows the real pixels). */
const DISPLAY_SIDE = 2048;
const LOUPE = 128;

const primary =
  'rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-contrast hover:bg-primary-hover';
const secondary =
  'rounded-md border border-border bg-muted px-4 py-2 text-sm font-medium hover:bg-border';

/**
 * Compare the original with the upscaled result: a Before/After divider, and a 100 % detail view
 * of the pixels under the pointer. Replaces the canvas while a result waits for Keep or Discard.
 */
export function UpscaleReview({ imageId, pending }: { imageId: string; pending: PendingUpscale }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const bitmaps = useRef<{ before: ImageBitmap; after: ImageBitmap } | null>(null);
  const [split, setSplit] = useState(0.5);
  const [ready, setReady] = useState(false);
  const [box, setBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [reticle, setReticle] = useState<{ x: number; y: number } | null>(null);
  const loupeBusy = useRef(false);
  const loupeNext = useRef<{ x: number; y: number } | null>(null);

  // Load both pictures. The "before" is the working preview of the original.
  useEffect(() => {
    let stale = false;
    void (async () => {
      const ws = await prepareWorkingSet(imageId);
      const [before, after] = await Promise.all([
        loadCacheBitmap(ws.previewPath),
        loadCacheBitmapScaled(pending.path, DISPLAY_SIDE),
      ]);
      if (stale) {
        before.close();
        after.close();
        return;
      }
      bitmaps.current?.before.close();
      bitmaps.current?.after.close();
      bitmaps.current = { before, after };
      setReady(true);
    })();
    return () => {
      stale = true;
    };
  }, [imageId, pending.path]);

  useEffect(
    () => () => {
      bitmaps.current?.before.close();
      bitmaps.current?.after.close();
      bitmaps.current = null;
    },
    [],
  );

  // Fit the picture in the host, keeping the result's proportions.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => {
      const r = host.getBoundingClientRect();
      const k = Math.min(r.width / pending.width, r.height / pending.height);
      const w = Math.max(1, Math.floor(pending.width * k));
      const h = Math.max(1, Math.floor(pending.height * k));
      setBox({ x: Math.floor((r.width - w) / 2), y: Math.floor((r.height - h) / 2), w, h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [pending.width, pending.height]);

  // Paint: original on the left of the divider, result on the right.
  useEffect(() => {
    const c = canvasRef.current;
    const b = bitmaps.current;
    if (!c || !b || !ready || box.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    const cut = Math.round(c.width * split);
    ctx.drawImage(b.after, 0, 0, c.width, c.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cut, c.height);
    ctx.clip();
    ctx.drawImage(b.before, 0, 0, c.width, c.height);
    ctx.restore();
  }, [ready, box, split]);

  // The detail view: ask the backend for the real pixels under the pointer. One request runs at a
  // time; while it runs, only the latest wanted position is remembered.
  const showLoupe = useCallback(
    async (at: { x: number; y: number }) => {
      loupeNext.current = at;
      if (loupeBusy.current) return;
      loupeBusy.current = true;
      try {
        while (loupeNext.current) {
          const want = loupeNext.current;
          loupeNext.current = null;
          try {
            const bytes = await upscaleLoupe(imageId, want.x, want.y, LOUPE);
            const bmp = await createImageBitmap(new Blob([bytes]));
            const c = loupeRef.current;
            const ctx = c?.getContext('2d');
            if (c && ctx) {
              c.width = bmp.width;
              c.height = bmp.height;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(bmp, 0, 0);
            }
            bmp.close();
          } catch {
            /* the loupe is a convenience: ignore a missed frame */
          }
        }
      } finally {
        loupeBusy.current = false;
      }
    },
    [imageId],
  );

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    setReticle({ x: fx, y: fy });
    void showLoupe({ x: Math.round(fx * pending.width), y: Math.round(fy * pending.height) });
  };

  const dragHandle = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const host = hostRef.current?.getBoundingClientRect();
    if (!host) return;
    setSplit(Math.min(1, Math.max(0, (e.clientX - host.left - box.x) / box.w)));
  };

  const pct = Math.round(split * 100);

  return (
    <div className="flex h-full w-full flex-col bg-app" data-testid="upscale-review">
      <div className="flex items-center gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{t.reviewTitle}</h2>
          <p className="truncate text-xs text-fg-muted">
            {t.resultSize(pending.width, pending.height)} · {t.reviewHint}
          </p>
        </div>
        <button type="button" className={primary} onClick={() => void keepUpscale(imageId)}>
          {t.keep}
        </button>
        <button type="button" className={secondary} onClick={() => void discardResult(imageId)}>
          {t.discard}
        </button>
      </div>

      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden" onPointerMove={onMove}>
        <div className="absolute" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t.compare}
            className="h-full w-full"
            style={{ visibility: ready ? 'visible' : 'hidden' }}
          />
          {ready && (
            <>
              <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-black/55 px-2 py-0.5 text-sm font-medium text-white">
                {t.before}
              </span>
              <span className="pointer-events-none absolute right-2 top-2 rounded-sm bg-black/55 px-2 py-0.5 text-sm font-medium text-white">
                {t.after}
              </span>
              {reticle && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute border-2 border-primary"
                  style={{
                    width: Math.max(8, (LOUPE / pending.width) * box.w),
                    height: Math.max(8, (LOUPE / pending.height) * box.h),
                    left: reticle.x * box.w - Math.max(8, (LOUPE / pending.width) * box.w) / 2,
                    top: reticle.y * box.h - Math.max(8, (LOUPE / pending.height) * box.h) / 2,
                  }}
                />
              )}
              <div
                data-testid="upscale-compare-handle"
                role="slider"
                aria-label={t.compare}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={`${pct}% ${t.before}, ${100 - pct}% ${t.after}`}
                aria-orientation="horizontal"
                tabIndex={0}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={dragHandle}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0, s - 0.02));
                  if (e.key === 'ArrowRight') setSplit((s) => Math.min(1, s + 0.02));
                }}
                className="absolute top-0 h-full w-0 cursor-ew-resize"
                style={{ left: `${split * 100}%`, touchAction: 'none' }}
              >
                <div className="absolute -left-px top-0 h-full w-0.5 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
                <div className="absolute -left-[22px] top-1/2 -mt-[22px] flex h-11 w-11 items-center justify-center rounded-full bg-white text-primary shadow-card">
                  <ChevronsLeftRight size={20} aria-hidden />
                </div>
              </div>
            </>
          )}
        </div>

        <figure
          className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-border bg-surface p-2 shadow-card"
          aria-label={t.loupe}
        >
          <canvas
            ref={loupeRef}
            width={LOUPE * 2}
            height={LOUPE}
            className="block bg-muted"
            style={{ width: LOUPE * 2, height: LOUPE, imageRendering: 'pixelated' }}
            data-testid="upscale-loupe"
          />
          <figcaption className="mt-1 flex justify-between text-xs text-fg-muted">
            <span>{t.loupeBefore}</span>
            <span>{t.loupeAfter}</span>
          </figcaption>
        </figure>
      </div>
    </div>
  );
}

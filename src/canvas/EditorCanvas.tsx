import { ChevronsLeftRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCacheBitmap, prepareWorkingSet } from '@/api/image';
import { reportError } from '@/app/errors';
import { fitView } from '@/app/viewActions';
import { strings } from '@/i18n/strings';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import type { ImageMeta } from '@/types/dto';
import type { Stroke } from './brush';
import type { RefineParams } from './maskOps';
import { render, type RenderColors } from './compositor';
import { MaskSession } from './session';
import { clampPan, clampZoom, screenToImage, zoomAt, type Viewport } from './viewport';

interface Props {
  image: ImageMeta;
}

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const readColors = (): RenderColors => ({
  checkerA: cssVar('--checker-a'),
  checkerB: cssVar('--checker-b'),
  border: cssVar('--border'),
});

/**
 * The editing viewport. Rendering, pointer input, the Before/After handle and the brush cursor
 * are driven imperatively (refs + requestAnimationFrame) so pan, zoom and brushing never go
 * through React renders.
 */
export function EditorCanvas({ image }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const beforeLabelRef = useRef<HTMLSpanElement>(null);
  const afterLabelRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const innerCursorRef = useRef<HTMLDivElement>(null);

  const sessionRef = useRef<MaskSession | null>(null);
  const bgRef = useRef<{ path: string; bitmap: ImageBitmap } | null>(null);
  const colorsRef = useRef<RenderColors>(readColors());
  const rafRef = useRef(0);
  // Refine updates are coalesced to one recompute per frame while a slider is dragged.
  const pendingRefineRef = useRef<RefineParams | null>(null);
  const pointerRef = useRef<{ x: number; y: number; inside: boolean }>({
    x: 0,
    y: 0,
    inside: false,
  });
  const spaceRef = useRef(false);
  // The component is keyed by image id, so it starts in the loading state for every image.
  const [loading, setLoading] = useState(true);
  const [hasMask, setHasMask] = useState(false);

  const id = image.id;

  // ---- imperative render --------------------------------------------------------------
  const draw = useCallback(() => {
    rafRef.current = 0;
    if (pendingRefineRef.current && sessionRef.current) {
      sessionRef.current.setRefine(pendingRefineRef.current);
      pendingRefineRef.current = null;
    }
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const st = useEditorStore.getState();
    const s = st.states[id];
    const vp = s?.viewport;
    if (!s || !vp) return;
    const { width, height } = st.viewSize;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bg = s.background;
    render(ctx, {
      width,
      height,
      dpr,
      vp,
      session: sessionRef.current,
      srcW: s.source.width,
      srcH: s.source.height,
      split: s.split,
      compare: st.compare,
      showChecker: st.showChecker,
      background: {
        kind: bg.kind,
        color: bg.color,
        fit: bg.fit,
        image: bg.image && bgRef.current?.path === bg.image.cachePath ? bgRef.current.bitmap : null,
      },
      colors: colorsRef.current,
    });

    // Before/After handle + labels, positioned in screen space so they are correct at any zoom.
    const w = s.source.width * vp.zoom;
    const h = s.source.height * vp.zoom;
    const splitX = vp.panX + w * s.split;
    const showSplit = st.compare === 'split' && !!sessionRef.current;
    const top = Math.max(0, vp.panY);
    const bottom = Math.min(height, vp.panY + h);
    const handle = handleRef.current;
    if (handle) {
      const visible = showSplit && splitX >= -20 && splitX <= width + 20 && bottom > top;
      handle.style.display = visible ? 'block' : 'none';
      handle.style.transform = `translateX(${splitX}px)`;
      handle.style.top = `${top}px`;
      handle.style.height = `${Math.max(0, bottom - top)}px`;
      // Keep the slider's accessible value in step with the (imperatively positioned) handle.
      const pct = Math.round(s.split * 100);
      handle.setAttribute('aria-valuenow', String(pct));
      handle.setAttribute('aria-valuetext', `${pct}% Before, ${100 - pct}% After`);
    }
    const left = Math.max(0, vp.panX);
    const right = Math.min(width, vp.panX + w);
    const place = (el: HTMLSpanElement | null, x: number, show: boolean) => {
      if (!el) return;
      el.style.display = show ? 'block' : 'none';
      el.style.transform = `translate(${x}px, ${top + 12}px)`;
    };
    place(beforeLabelRef.current, left + 12, showSplit && splitX - left > 90);
    const aLabelW = 70;
    place(
      afterLabelRef.current,
      right - aLabelW - 12,
      !!sessionRef.current && (!showSplit || right - splitX > 110),
    );

    // Brush cursor.
    const cur = cursorRef.current;
    if (cur) {
      const brushTool = st.tool === 'keep' || st.tool === 'erase';
      const p = pointerRef.current;
      const d = Math.max(2, st.brush.size * vp.zoom);
      cur.style.display = brushTool && p.inside && !spaceRef.current ? 'block' : 'none';
      cur.style.width = cur.style.height = `${d}px`;
      cur.style.transform = `translate(${p.x - d / 2}px, ${p.y - d / 2}px)`;
      cur.style.borderColor = st.tool === 'keep' ? 'var(--success)' : 'var(--danger)';
      const inner = innerCursorRef.current;
      if (inner) {
        const di = d * (st.brush.hardness / 100);
        inner.style.width = inner.style.height = `${di}px`;
        inner.style.display = st.brush.hardness < 100 && di > 4 ? 'block' : 'none';
      }
    }
  }, [id]);

  const requestDraw = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // ---- session loading ------------------------------------------------------------------
  const loadBase = useCallback(
    async (session: MaskSession, token: { stale: boolean }) => {
      const ws = await prepareWorkingSet(id);
      const mask = ws.maskPath ? await loadCacheBitmap(ws.maskPath) : null;
      if (token.stale) return;
      session.setBase(mask);
      mask?.close();
      session.rebuild(useEditorStore.getState().states[id]?.strokes ?? []);
    },
    [id],
  );

  useEffect(() => {
    const token = { stale: false };
    void (async () => {
      try {
        const ws = await prepareWorkingSet(id);
        const preview = await loadCacheBitmap(ws.previewPath);
        if (token.stale) return preview.close();
        const st = useEditorStore.getState().states[id];
        if (!st) return;
        const session = new MaskSession(
          {
            workWidth: ws.workWidth,
            workHeight: ws.workHeight,
            sourceWidth: ws.sourceWidth,
            sourceHeight: ws.sourceHeight,
            preview,
          },
          st.refine,
        );
        preview.close();
        const mask = ws.maskPath ? await loadCacheBitmap(ws.maskPath) : null;
        if (token.stale) {
          session.dispose();
          return;
        }
        session.setBase(mask);
        mask?.close();
        session.rebuild(st.strokes);
        sessionRef.current = session;
        setHasMask(session.hasMask);
        setLoading(false);
        const cur = useEditorStore.getState().states[id];
        if (cur && (!cur.viewport || cur.fit)) fitView();
        requestDraw();
      } catch (e) {
        if (token.stale) return;
        setLoading(false);
        reportError(e);
      }
    })();
    return () => {
      token.stale = true;
      sessionRef.current?.dispose(); // release buffers when switching images
      sessionRef.current = null;
    };
  }, [id, requestDraw]);

  // ---- store subscription: refine, edits, mask, background, view ------------------------
  useEffect(() => {
    let prev = useEditorStore.getState();
    const unsub = useEditorStore.subscribe((st) => {
      const a = prev.states[id];
      const b = st.states[id];
      const session = sessionRef.current;
      if (a && b && session) {
        if (a.refine !== b.refine) pendingRefineRef.current = b.refine;
        if (a.editRev !== b.editRev) session.rebuild(b.strokes);
        if (a.maskRev !== b.maskRev) {
          const token = { stale: false };
          void loadBase(session, token).then(() => {
            setHasMask(session.hasMask);
            requestDraw();
          });
        }
      }
      if (b?.background.image && bgRef.current?.path !== b.background.image.cachePath) {
        const path = b.background.image.cachePath;
        void loadCacheBitmap(path).then((bitmap) => {
          bgRef.current?.bitmap.close();
          bgRef.current = { path, bitmap };
          requestDraw();
        });
      }
      prev = st;
      requestDraw();
    });
    // Theme changes alter the checker colours.
    const mo = new MutationObserver(() => {
      colorsRef.current = readColors();
      requestDraw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      unsub();
      mo.disconnect();
    };
  }, [id, loadBase, requestDraw]);

  // ---- size ----------------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const st = useEditorStore.getState();
      st.setViewSize(r.width, r.height);
      const s = st.states[id];
      if (s && (!s.viewport || s.fit)) fitView();
      requestDraw();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [id, requestDraw]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ---- keyboard: hold Space to pan ------------------------------------------------------
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing(e)) {
        spaceRef.current = true;
        e.preventDefault();
        requestDraw();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        requestDraw();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [requestDraw]);

  // ---- wheel: Ctrl/Cmd zooms at the cursor, plain wheel pans ---------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useEditorStore.getState();
      const s = st.states[id];
      if (!s?.viewport) return;
      const r = host.getBoundingClientRect();
      const { width, height } = s.source;
      let next: Viewport;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        next = zoomAt(
          s.viewport,
          clampZoom(s.viewport.zoom * factor),
          e.clientX - r.left,
          e.clientY - r.top,
        );
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        next = { ...s.viewport, panX: s.viewport.panX - dx, panY: s.viewport.panY - dy };
      }
      next = clampPan(next, width, height, st.viewSize.width, st.viewSize.height);
      st.setViewport(id, next);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [id]);

  // ---- pointer input -----------------------------------------------------------------------
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; vp: Viewport }
    | { kind: 'paint'; painter: ReturnType<MaskSession['beginStroke']>; stroke: Stroke }
    | null
  >(null);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const paintAt = (
    e: PointerEvent | React.PointerEvent,
    g: Extract<NonNullable<typeof gesture.current>, { kind: 'paint' }>,
  ) => {
    const st = useEditorStore.getState();
    const vp = st.states[id]?.viewport;
    const session = sessionRef.current;
    if (!vp || !session) return;
    const p = localPoint(e);
    const img = screenToImage(vp, p.x, p.y);
    const pressure = e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 1;
    g.stroke.points.push([img.x, img.y, pressure]);
    session.update(g.painter.add(img.x, img.y, pressure));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = useEditorStore.getState();
    const s = st.states[id];
    const session = sessionRef.current;
    if (!s?.viewport || !session) return;
    const p = localPoint(e);
    const panning = e.button === 1 || spaceRef.current || st.tool === 'pan';

    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (panning) {
      gesture.current = { kind: 'pan', startX: p.x, startY: p.y, vp: s.viewport };
      return;
    }
    if (st.tool === 'zoom') {
      const factor = e.altKey ? 1 / 1.5 : 1.5;
      const next = zoomAt(s.viewport, clampZoom(s.viewport.zoom * factor), p.x, p.y);
      st.setViewport(
        id,
        clampPan(next, s.source.width, s.source.height, st.viewSize.width, st.viewSize.height),
      );
      return;
    }
    if ((st.tool === 'keep' || st.tool === 'erase') && session.hasMask) {
      const stroke: Stroke = {
        mode: st.tool,
        size: st.brush.size,
        hardness: st.brush.hardness,
        points: [],
      };
      const g = {
        kind: 'paint' as const,
        painter: session.beginStroke(stroke.mode, stroke.size, stroke.hardness),
        stroke,
      };
      gesture.current = g;
      paintAt(e, g);
      requestDraw();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = localPoint(e);
    pointerRef.current = { x: p.x, y: p.y, inside: true };
    const g = gesture.current;
    const st = useEditorStore.getState();
    const s = st.states[id];
    if (g?.kind === 'pan' && s) {
      const next = {
        ...g.vp,
        panX: g.vp.panX + (p.x - g.startX),
        panY: g.vp.panY + (p.y - g.startY),
      };
      st.setViewport(
        id,
        clampPan(next, s.source.width, s.source.height, st.viewSize.width, st.viewSize.height),
      );
    } else if (g?.kind === 'paint') {
      const native = e.nativeEvent;
      const events = native.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [native]) paintAt(ce, g);
    }
    requestDraw();
  };

  const endGesture = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === 'paint' && g.stroke.points.length > 0) {
      useEditorStore.getState().addStroke(id, g.stroke);
    }
  };

  const onPointerLeave = () => {
    pointerRef.current.inside = false;
    requestDraw();
  };

  // ---- Before/After handle ---------------------------------------------------------------
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const st = useEditorStore.getState();
    const s = st.states[id];
    if (!s?.viewport) return;
    const x = localPoint(e).x;
    st.setSplit(id, (x - s.viewport.panX) / (s.source.width * s.viewport.zoom));
  };

  const tool = useEditorStore((s) => s.tool);
  const removing = useProjectStore((s) => s.processing[id] === true);
  const cursor =
    tool === 'pan' ? 'grab' : tool === 'zoom' ? 'zoom-in' : tool === 'move' ? 'default' : 'none';

  return (
    <div
      ref={hostRef}
      className="checkerboard-free relative h-full w-full touch-none select-none overflow-hidden bg-app"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={onPointerLeave}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        aria-label={image.name}
        role="img"
      />

      <span
        ref={beforeLabelRef}
        className="pointer-events-none absolute left-0 top-0 hidden rounded-sm bg-black/55 px-3 py-1 text-sm font-medium text-white"
      >
        {strings.editor.before}
      </span>
      <span
        ref={afterLabelRef}
        className="pointer-events-none absolute left-0 top-0 hidden rounded-sm bg-black/55 px-3 py-1 text-sm font-medium text-white"
      >
        {strings.editor.after}
      </span>

      <div
        ref={handleRef}
        data-testid="compare-handle"
        role="slider"
        aria-label={strings.editor.compareHandle}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={50}
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onKeyDown={(e) => {
          const st = useEditorStore.getState();
          const s = st.states[id];
          if (!s) return;
          if (e.key === 'ArrowLeft') st.setSplit(id, s.split - 0.02);
          if (e.key === 'ArrowRight') st.setSplit(id, s.split + 0.02);
        }}
        className="absolute left-0 top-0 hidden w-0 cursor-ew-resize"
        style={{ touchAction: 'none' }}
      >
        <div className="absolute -left-px top-0 h-full w-0.5 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
        <div className="absolute -left-[22px] top-1/2 -mt-[22px] flex h-11 w-11 items-center justify-center rounded-full bg-white text-primary shadow-card">
          <ChevronsLeftRight size={20} aria-hidden />
        </div>
      </div>

      <div
        ref={cursorRef}
        className="pointer-events-none absolute left-0 top-0 hidden rounded-full border-2"
        aria-hidden
      >
        <div
          ref={innerCursorRef}
          className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/80"
        />
      </div>

      {loading && (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center gap-3 bg-app/70 text-fg-muted"
        >
          <Loader2 className="animate-spin" aria-hidden />
          {strings.editor.loadingImage}
        </div>
      )}
      {removing && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-app/40"
        >
          <span className="flex items-center gap-3 rounded-md bg-surface px-5 py-3 text-sm font-medium shadow-card">
            <Loader2 className="animate-spin text-primary" aria-hidden />
            {strings.editor.toolbar.processing}
          </span>
        </div>
      )}
      {!loading && !hasMask && !removing && (
        <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-surface/90 px-4 py-2 text-sm shadow-card">
          {strings.editor.noMaskHint}
        </p>
      )}
    </div>
  );
}

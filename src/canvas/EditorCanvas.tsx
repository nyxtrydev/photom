import { ChevronsLeftRight, Loader2, Sun } from 'lucide-react';
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
import { lightAngle, shadowActive, usesGround, withLightAngle, type ShadowState } from './shadow';
import { ShadowPreview } from './shadowPreview';
import { MaskSession } from './session';
import { clampPanToRect, clampZoom, screenToImage, zoomAt, type Viewport } from './viewport';

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
  const groundRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLButtonElement>(null);
  const innerCursorRef = useRef<HTMLDivElement>(null);

  const sessionRef = useRef<MaskSession | null>(null);
  const shadowRef = useRef(new ShadowPreview());
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
  const lightCenterRef = useRef({ x: 0, y: 0 });
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
    // The shadow decides how big the frame is; adopt it before drawing so both agree.
    const shadow = shadowRef.current.sync(
      sessionRef.current,
      s.shadow,
      s.source.width,
      s.source.height,
    );
    const f = s.frame;
    if (
      f.x !== shadow.frame.x ||
      f.y !== shadow.frame.y ||
      f.w !== shadow.frame.w ||
      f.h !== shadow.frame.h
    ) {
      st.setFrame(id, shadow.frame);
      // Keep the whole result in view, but not while a slider is still being dragged.
      if (s.fit && !s.pendingShadow) queueMicrotask(fitView);
    }
    render(ctx, {
      width,
      height,
      dpr,
      vp,
      session: sessionRef.current,
      srcW: s.source.width,
      srcH: s.source.height,
      frame: shadow.frame,
      shadow: shadow.canvas,
      shadowOnly: st.shadowOnly && shadowActive(s.shadow) && !!shadow.canvas,
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
    const fr = shadow.frame;
    const w = fr.w * vp.zoom;
    const h = fr.h * vp.zoom;
    const frameLeft = vp.panX + fr.x * vp.zoom;
    const frameTop = vp.panY + fr.y * vp.zoom;
    const splitX = frameLeft + w * s.split;
    const showSplit = st.compare === 'split' && !!sessionRef.current;
    const top = Math.max(0, frameTop);
    const bottom = Math.min(height, frameTop + h);
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
    const left = Math.max(0, frameLeft);
    const right = Math.min(width, frameLeft + w);
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

    // Shadow guides: the ground line and the light direction handle.
    const guides =
      st.propsTab === 'shadow' &&
      st.showShadowGuides &&
      shadowActive(s.shadow) &&
      !!shadow.subject &&
      shadow.ground !== null;
    const gh = groundRef.current;
    if (gh) {
      const gy = vp.panY + (shadow.ground ?? 0) * vp.zoom;
      const show = guides && s.shadow!.layers.some((l) => l.visible && usesGround(l));
      gh.style.display = show && right > left ? 'block' : 'none';
      gh.style.transform = `translate(${left}px, ${gy - 12}px)`;
      gh.style.width = `${Math.max(0, right - left)}px`;
      const pct = Math.round(((shadow.ground ?? 0) / s.source.height) * 100);
      gh.setAttribute('aria-valuenow', String(pct));
      gh.setAttribute('aria-valuetext', `${pct}% of the image height`);
    }
    const lh = lightRef.current;
    if (lh) {
      const ang = lightAngle(s.shadow);
      const sub = shadow.subject;
      const show = guides && ang !== null && !!sub;
      lh.style.display = show ? 'flex' : 'none';
      if (show && sub && ang !== null) {
        const a = (ang * Math.PI) / 180;
        const cx = vp.panX + (sub.x + sub.w / 2) * vp.zoom;
        const cy = vp.panY + (sub.y + sub.h / 2) * vp.zoom;
        const R = Math.max(56, Math.min(sub.w, sub.h) * vp.zoom * 0.5 + 32);
        const x = Math.min(width - 24, Math.max(24, cx + Math.cos(a) * R));
        const y = Math.min(height - 24, Math.max(24, cy - Math.sin(a) * R));
        lh.style.transform = `translate(${x - 18}px, ${y - 18}px)`;
        lh.setAttribute('aria-valuenow', String(Math.round(ang)));
        lh.setAttribute('aria-valuetext', `${Math.round(ang)} degrees`);
        lightCenterRef.current = { x: cx, y: cy };
      }
    }

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
    const shadowPreview = shadowRef.current;
    void (async () => {
      try {
        const ws = await prepareWorkingSet(id);
        const previewImage = await loadCacheBitmap(ws.previewPath);
        if (token.stale) return previewImage.close();
        const st = useEditorStore.getState().states[id];
        if (!st) return;
        const session = new MaskSession(
          {
            workWidth: ws.workWidth,
            workHeight: ws.workHeight,
            sourceWidth: ws.sourceWidth,
            sourceHeight: ws.sourceHeight,
            preview: previewImage,
          },
          st.refine,
        );
        previewImage.close();
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
      shadowPreview.dispose();
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
      next = clampPanToRect(next, s.frame, st.viewSize.width, st.viewSize.height);
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
      st.setViewport(id, clampPanToRect(next, s.frame, st.viewSize.width, st.viewSize.height));
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
      st.setViewport(id, clampPanToRect(next, s.frame, st.viewSize.width, st.viewSize.height));
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
    const left = s.viewport.panX + s.frame.x * s.viewport.zoom;
    st.setSplit(id, (x - left) / (s.frame.w * s.viewport.zoom));
  };

  // ---- Shadow guides: ground line + light direction ------------------------------------
  const currentShadow = () => useEditorStore.getState().states[id]?.shadow ?? null;
  const editShadow = (update: (cur: ShadowState) => ShadowState) =>
    useEditorStore.getState().setShadow(id, (cur) => (cur ? update(cur) : cur), true);
  const commitShadow = () => useEditorStore.getState().commitShadow(id);
  const setGround = (y: number) => {
    const h = useEditorStore.getState().states[id]?.source.height ?? 1;
    editShadow((cur) => ({ ...cur, presetId: null, groundY: Math.min(1, Math.max(0, y / h)) }));
  };
  const onGroundDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGroundMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const vp = useEditorStore.getState().states[id]?.viewport;
    if (vp) setGround((localPoint(e).y - vp.panY) / vp.zoom);
  };
  const onGroundKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const st = useEditorStore.getState();
    const s = st.states[id];
    // Rapid key presses outrun the redraw, so continue from the stored line when there is one.
    const g =
      s?.shadow?.groundY != null
        ? s.shadow.groundY * s.source.height
        : shadowRef.current.last()?.ground;
    if (s && g != null) setGround(g + dir * step);
  };
  const onLightDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onLightMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const p = localPoint(e);
    const c = lightCenterRef.current;
    const deg = (Math.atan2(-(p.y - c.y), p.x - c.x) * 180) / Math.PI;
    editShadow((cur) => withLightAngle(cur, deg));
  };
  const onLightKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 15 : 1;
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = lightAngle(currentShadow());
    if (cur !== null) editShadow((s) => withLightAngle(s, cur + dir * step));
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
        ref={groundRef}
        data-testid="ground-handle"
        role="slider"
        aria-label={strings.shadow.groundHandle}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={90}
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={onGroundDown}
        onPointerMove={onGroundMove}
        onPointerUp={commitShadow}
        onPointerCancel={commitShadow}
        onKeyDown={onGroundKey}
        onKeyUp={commitShadow}
        className="absolute left-0 top-0 hidden h-6 cursor-ns-resize"
        style={{ touchAction: 'none' }}
      >
        <div className="absolute left-0 top-1/2 h-0 w-full border-t-2 border-dashed border-primary" />
        <span className="absolute left-3 top-0 rounded-sm bg-primary px-2 text-xs font-medium text-primary-contrast">
          {strings.shadow.ground}
        </span>
      </div>
      <button
        ref={lightRef}
        type="button"
        data-testid="light-handle"
        role="slider"
        aria-label={strings.shadow.lightHandle}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={135}
        onPointerDown={onLightDown}
        onPointerMove={onLightMove}
        onPointerUp={commitShadow}
        onPointerCancel={commitShadow}
        onKeyDown={onLightKey}
        onKeyUp={commitShadow}
        className="absolute left-0 top-0 hidden h-9 w-9 cursor-grab items-center justify-center rounded-full bg-white text-primary shadow-card"
        style={{ touchAction: 'none' }}
      >
        <Sun size={20} aria-hidden />
      </button>

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

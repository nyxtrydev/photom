import { clampPan, clampZoom, fitViewport, stepZoom, zoomAt } from '@/canvas/viewport';
import { useEditorStore } from '@/stores/editorStore';

function ctx() {
  const { activeId, states, viewSize, setViewport } = useEditorStore.getState();
  const s = activeId ? states[activeId] : undefined;
  if (!activeId || !s || viewSize.width === 0) return null;
  return { id: activeId, s, viewSize, setViewport };
}

export function fitView() {
  const c = ctx();
  if (!c) return;
  const { width, height } = c.s.source;
  c.setViewport(c.id, fitViewport(width, height, c.viewSize.width, c.viewSize.height), true);
}

/** Zoom keeping the view centre fixed. */
export function setZoom(zoom: number) {
  const c = ctx();
  if (!c?.s.viewport) return;
  const { width, height } = c.s.source;
  const next = zoomAt(c.s.viewport, clampZoom(zoom), c.viewSize.width / 2, c.viewSize.height / 2);
  c.setViewport(c.id, clampPan(next, width, height, c.viewSize.width, c.viewSize.height));
}

export function zoomStep(direction: 1 | -1) {
  const c = ctx();
  if (c?.s.viewport) setZoom(stepZoom(c.s.viewport.zoom, direction));
}

export const actualSize = () => setZoom(1);

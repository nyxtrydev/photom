export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom that fits the whole image inside the view, centred. */
export function fitViewport(
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  padding = 24,
): Viewport {
  const availW = Math.max(1, viewW - padding * 2);
  const availH = Math.max(1, viewH - padding * 2);
  const zoom = clampZoom(Math.min(availW / imgW, availH / imgH));
  return centred(zoom, imgW, imgH, viewW, viewH);
}

export function centred(
  zoom: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): Viewport {
  return { zoom, panX: (viewW - imgW * zoom) / 2, panY: (viewH - imgH * zoom) / 2 };
}

/** Change zoom while keeping the image point under (anchorX, anchorY) fixed on screen. */
export function zoomAt(vp: Viewport, newZoom: number, anchorX: number, anchorY: number): Viewport {
  const zoom = clampZoom(newZoom);
  const ix = (anchorX - vp.panX) / vp.zoom;
  const iy = (anchorY - vp.panY) / vp.zoom;
  return { zoom, panX: anchorX - ix * zoom, panY: anchorY - iy * zoom };
}

/** Keep at least `keep` px of the image inside the view so it can't be lost off-screen. */
export function clampPan(
  vp: Viewport,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  keep = 80,
): Viewport {
  const w = imgW * vp.zoom;
  const h = imgH * vp.zoom;
  const panX = Math.min(viewW - keep, Math.max(keep - w, vp.panX));
  const panY = Math.min(viewH - keep, Math.max(keep - h, vp.panY));
  return { ...vp, panX, panY };
}

export const screenToImage = (vp: Viewport, x: number, y: number) => ({
  x: (x - vp.panX) / vp.zoom,
  y: (y - vp.panY) / vp.zoom,
});

export const imageToScreen = (vp: Viewport, x: number, y: number) => ({
  x: x * vp.zoom + vp.panX,
  y: y * vp.zoom + vp.panY,
});

/** Zoom steps used by the +/- buttons and keyboard. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(direction === 1 ? zoom * 1.25 : zoom / 1.25);
}

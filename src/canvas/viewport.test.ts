import { describe, expect, it } from 'vitest';
import { clampPan, clampZoom, fitViewport, imageToScreen, screenToImage, zoomAt } from './viewport';

describe('viewport', () => {
  it('fits and centres an image', () => {
    const vp = fitViewport(4000, 2000, 1000, 800, 0);
    expect(vp.zoom).toBeCloseTo(0.25);
    expect(vp.panX).toBeCloseTo(0);
    expect(vp.panY).toBeCloseTo(150);
  });

  it('clamps zoom to 25%..800%', () => {
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(99)).toBe(8);
  });

  it('keeps the anchor point fixed while zooming', () => {
    const vp = { zoom: 1, panX: 40, panY: 30 };
    const before = screenToImage(vp, 300, 200);
    const next = zoomAt(vp, 3, 300, 200);
    const after = imageToScreen(next, before.x, before.y);
    expect(after.x).toBeCloseTo(300);
    expect(after.y).toBeCloseTo(200);
  });

  it('never lets the image leave the view entirely', () => {
    const vp = clampPan({ zoom: 1, panX: -99999, panY: 99999 }, 500, 500, 800, 600, 80);
    expect(vp.panX).toBe(-420);
    expect(vp.panY).toBe(520);
  });
});

import { BRUSH_LIMITS, type Stroke } from '@/canvas/brush';
import { DEFAULT_REFINE, REFINE_LIMITS, type RefineParams } from '@/canvas/maskOps';
import type { BackgroundImage } from '@/types/dto';
import {
  DEFAULT_BACKGROUND,
  newImageState,
  type BackgroundState,
  type FitMode,
  type ImageEditState,
  type OutputState,
} from './editorStore';

const MAX_STROKES = 5000;
const MAX_POINTS = 20000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const HEX = /^#[0-9a-fA-F]{6}$/;

function sanitizeRefine(v: unknown): RefineParams {
  const o = isObj(v) ? v : {};
  return {
    threshold: num(
      o.threshold,
      DEFAULT_REFINE.threshold,
      REFINE_LIMITS.threshold.min,
      REFINE_LIMITS.threshold.max,
    ),
    feather: num(
      o.feather,
      DEFAULT_REFINE.feather,
      REFINE_LIMITS.feather.min,
      REFINE_LIMITS.feather.max,
    ),
    edgeShift: num(
      o.edgeShift,
      DEFAULT_REFINE.edgeShift,
      REFINE_LIMITS.edgeShift.min,
      REFINE_LIMITS.edgeShift.max,
    ),
  };
}

function sanitizeBackgroundImage(v: unknown): BackgroundImage | null {
  if (!isObj(v) || typeof v.cachePath !== 'string' || typeof v.sourcePath !== 'string') return null;
  return {
    cachePath: v.cachePath,
    sourcePath: v.sourcePath,
    width: num(v.width, 1, 1, 1e6),
    height: num(v.height, 1, 1, 1e6),
  };
}

function sanitizeBackground(v: unknown): BackgroundState {
  const o = isObj(v) ? v : {};
  const image = sanitizeBackgroundImage(o.image);
  const kind =
    o.kind === 'solid' || o.kind === 'image' || o.kind === 'transparent' ? o.kind : 'transparent';
  return {
    kind: kind === 'image' && !image ? 'transparent' : kind,
    color: typeof o.color === 'string' && HEX.test(o.color) ? o.color : DEFAULT_BACKGROUND.color,
    image,
    fit: (['cover', 'contain', 'stretch'] as FitMode[]).includes(o.fit as FitMode)
      ? (o.fit as FitMode)
      : 'cover',
  };
}

function sanitizeOutput(v: unknown, width: number, height: number): OutputState {
  const o = isObj(v) ? v : {};
  return {
    width: Math.round(num(o.width, width, 1, 100000)),
    height: Math.round(num(o.height, height, 1, 100000)),
    lockRatio: o.lockRatio !== false,
    cropToSubject: o.cropToSubject === true,
  };
}

function sanitizeStrokes(v: unknown): Stroke[] {
  if (!Array.isArray(v)) return [];
  const out: Stroke[] = [];
  for (const s of v.slice(0, MAX_STROKES)) {
    if (!isObj(s) || (s.mode !== 'keep' && s.mode !== 'erase') || !Array.isArray(s.points))
      continue;
    const points: [number, number, number][] = [];
    for (const p of s.points.slice(0, MAX_POINTS)) {
      if (
        Array.isArray(p) &&
        p.length >= 2 &&
        typeof p[0] === 'number' &&
        typeof p[1] === 'number' &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
      ) {
        points.push([p[0], p[1], num(p[2], 1, 0, 1)]);
      }
    }
    if (points.length === 0) continue;
    out.push({
      mode: s.mode,
      size: num(s.size, 40, BRUSH_LIMITS.size.min, BRUSH_LIMITS.size.max),
      hardness: num(s.hardness, 70, BRUSH_LIMITS.hardness.min, BRUSH_LIMITS.hardness.max),
      points,
    });
  }
  return out;
}

/** The subset of an image's editor state that is written to `state.json`. */
export function toPersisted(s: ImageEditState) {
  return {
    refine: s.refine,
    background: s.background,
    output: s.output,
    strokes: s.strokes,
    split: s.split,
  };
}

/** Rebuild an editor state from untrusted saved JSON. Anything invalid falls back to defaults. */
export function fromPersisted(saved: unknown, width: number, height: number): ImageEditState {
  const base = newImageState(width, height);
  if (!isObj(saved)) return base;
  return {
    ...base,
    refine: sanitizeRefine(saved.refine),
    background: sanitizeBackground(saved.background),
    output: sanitizeOutput(saved.output, width, height),
    strokes: sanitizeStrokes(saved.strokes),
    split: num(saved.split, 0.5, 0, 1),
  };
}

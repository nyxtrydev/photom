// Procedural shadows built from the subject's alpha mask. Pure functions: no DOM, so the maths is
// unit-tested and can be mirrored exactly by the Rust export renderer (src-tauri/src/services/shadow.rs).
import { gaussianBlur, morph } from './maskOps';

/** A rectangle in SOURCE pixels. Origin (0,0) is the top-left of the source image. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayerBase {
  /** Stable key for React and the undo history; not persisted. */
  id: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
}

export interface DropLayer extends LayerBase {
  type: 'drop';
  color: string;
  /** Light direction in degrees (135 = light from the upper left, so the shadow falls lower right). */
  angle: number;
  /** Source pixels. */
  distance: number;
  /** Source pixels; the Gaussian sigma is blur / 2. */
  blur: number;
  /** Source pixels. Positive grows the shadow, negative shrinks it. */
  spread: number;
}

/** A tight, dark shadow where the subject touches the ground; fades quickly with height. */
export interface ContactLayer extends LayerBase {
  type: 'contact';
  color: string;
  /** Source px of the subject's base (above the ground line) the shadow is taken from. */
  size: number;
  /** Source px of blur. */
  softness: number;
  /** Source px; moves the shadow down (+) or up (-) from the ground line. */
  groundOffset: number;
}

/** The subject projected along the light onto the floor, with falloff and growing blur. */
export interface CastLayer extends LayerBase {
  type: 'cast';
  color: string;
  /** Light direction in degrees, same convention as the drop shadow. */
  angle: number;
  /** Light height above the floor in degrees; low = long shadow. */
  elevation: number;
  /** Multiplier on the physical length, 0.1..2. */
  length: number;
  /** Vertical squash of the floor plane (perspective), 0.1..1. */
  squash: number;
  /** 0..1: how much of the opacity is lost at the shadow's far end. */
  falloff: number;
  /** Source px of blur at the contact point. */
  blur: number;
  /** Source px of blur added at the far end. */
  blurGrowth: number;
}

/** A flipped, faded, slightly blurred copy of the subject under it. Uses the subject's colours. */
export interface ReflectionLayer extends LayerBase {
  type: 'reflection';
  /** Source px between the ground line and the start of the reflection. */
  gap: number;
  /** Source px of the subject (measured up from the ground line) that is reflected; it fades to nothing. */
  fade: number;
  /** Source px of blur. */
  blur: number;
}

export type ShadowLayer = DropLayer | ContactLayer | CastLayer | ReflectionLayer;
export type LayerType = ShadowLayer['type'];

export interface ShadowState {
  enabled: boolean;
  /** Grow the output canvas so the shadow is never clipped. */
  autoExpand: boolean;
  /** Blend the layers' colours in linear light instead of on the gamma-encoded values. */
  linearLight: boolean;
  /** Ground line as a fraction of the image height; null = the subject's lowest pixel. */
  groundY: number | null;
  presetId: string | null;
  layers: ShadowLayer[];
}

export const SHADOW_LIMITS = {
  angle: { min: 0, max: 360 },
  distance: { min: 0, max: 500 },
  blur: { min: 0, max: 200 },
  spread: { min: -50, max: 100 },
  opacity: { min: 0, max: 1 },
  size: { min: 2, max: 300 },
  softness: { min: 0, max: 100 },
  groundOffset: { min: -50, max: 100 },
  elevation: { min: 5, max: 85 },
  length: { min: 0.1, max: 2 },
  squash: { min: 0.1, max: 1 },
  falloff: { min: 0, max: 1 },
  castBlur: { min: 0, max: 100 },
  blurGrowth: { min: 0, max: 150 },
  gap: { min: 0, max: 100 },
  fade: { min: 10, max: 1000 },
  reflectionBlur: { min: 0, max: 50 },
  maxLayers: 8,
} as const;

/** A cast shadow never grows longer than this many subject heights. */
export const MAX_CAST_LENGTH = 6;
/** The contact shadow is the base band flattened to this fraction of its height. */
export const CONTACT_SQUASH = 0.25;
/** Blur levels a cast shadow is rendered at; rows blend between neighbouring levels. */
const CAST_LEVELS = 4;

export const DEFAULT_SHADOW_COLOR = '#2b1a10'; // warm black
const HEX = /^#[0-9a-fA-F]{6}$/;

let seq = 0;
const nextId = () => `shadow-${++seq}`;

export const DEFAULT_DROP = {
  type: 'drop',
  visible: true,
  angle: 135,
  distance: 24,
  blur: 32,
  spread: 0,
  opacity: 0.45,
  color: DEFAULT_SHADOW_COLOR,
} as const;

export const DEFAULT_CONTACT = {
  type: 'contact',
  visible: true,
  size: 40,
  softness: 12,
  groundOffset: 0,
  opacity: 0.6,
  color: DEFAULT_SHADOW_COLOR,
} as const;

export const DEFAULT_CAST = {
  type: 'cast',
  visible: true,
  angle: 135,
  elevation: 40,
  length: 1,
  squash: 0.5,
  falloff: 0.7,
  blur: 6,
  blurGrowth: 40,
  opacity: 0.4,
  color: DEFAULT_SHADOW_COLOR,
} as const;

export const DEFAULT_REFLECTION = {
  type: 'reflection',
  visible: true,
  gap: 4,
  fade: 200,
  blur: 3,
  opacity: 0.35,
} as const;

export function newDropLayer(over: Partial<Omit<DropLayer, 'id' | 'type'>> = {}): DropLayer {
  return { ...DEFAULT_DROP, ...over, id: nextId() };
}
export function newContactLayer(over: Partial<Omit<ContactLayer, 'id' | 'type'>> = {}) {
  return { ...DEFAULT_CONTACT, ...over, id: nextId() } as ContactLayer;
}
export function newCastLayer(over: Partial<Omit<CastLayer, 'id' | 'type'>> = {}) {
  return { ...DEFAULT_CAST, ...over, id: nextId() } as CastLayer;
}
export function newReflectionLayer(over: Partial<Omit<ReflectionLayer, 'id' | 'type'>> = {}) {
  return { ...DEFAULT_REFLECTION, ...over, id: nextId() } as ReflectionLayer;
}
export function newLayer(type: LayerType): ShadowLayer {
  return type === 'drop'
    ? newDropLayer()
    : type === 'contact'
      ? newContactLayer()
      : type === 'cast'
        ? newCastLayer()
        : newReflectionLayer();
}

/** What "Enable" creates the first time. */
export function defaultShadow(): ShadowState {
  return {
    enabled: true,
    autoExpand: true,
    linearLight: false,
    groundY: null,
    presetId: null,
    layers: [newDropLayer()],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const colour = (c: unknown) =>
  typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : DEFAULT_SHADOW_COLOR;

export function clampLayer<T extends ShadowLayer>(l: T): T {
  const L = SHADOW_LIMITS;
  const fallback = { drop: 0.45, contact: 0.6, cast: 0.4, reflection: 0.35 }[l.type];
  const opacity = num(l.opacity, fallback, L.opacity.min, L.opacity.max);
  if (l.type === 'reflection') {
    return {
      ...l,
      opacity,
      gap: num(l.gap, 4, L.gap.min, L.gap.max),
      fade: num(l.fade, 200, L.fade.min, L.fade.max),
      blur: num(l.blur, 3, L.reflectionBlur.min, L.reflectionBlur.max),
    };
  }
  const base = { opacity, color: colour(l.color) };
  if (l.type === 'drop') {
    return {
      ...l,
      ...base,
      angle: num(l.angle, 135, L.angle.min, L.angle.max),
      distance: num(l.distance, 24, L.distance.min, L.distance.max),
      blur: num(l.blur, 32, L.blur.min, L.blur.max),
      spread: num(l.spread, 0, L.spread.min, L.spread.max),
    };
  }
  if (l.type === 'contact') {
    return {
      ...l,
      ...base,
      size: num(l.size, 40, L.size.min, L.size.max),
      softness: num(l.softness, 12, L.softness.min, L.softness.max),
      groundOffset: num(l.groundOffset, 0, L.groundOffset.min, L.groundOffset.max),
    };
  }
  return {
    ...l,
    ...base,
    angle: num(l.angle, 135, L.angle.min, L.angle.max),
    elevation: num(l.elevation, 40, L.elevation.min, L.elevation.max),
    length: num(l.length, 1, L.length.min, L.length.max),
    squash: num(l.squash, 0.5, L.squash.min, L.squash.max),
    falloff: num(l.falloff, 0.7, L.falloff.min, L.falloff.max),
    blur: num(l.blur, 6, L.castBlur.min, L.castBlur.max),
    blurGrowth: num(l.blurGrowth, 40, L.blurGrowth.min, L.blurGrowth.max),
  };
}

/** Rebuild shadow settings from untrusted saved JSON. Null when nothing usable was saved. */
export function sanitizeShadow(v: unknown): ShadowState | null {
  if (!isObj(v)) return null;
  const layers: ShadowLayer[] = [];
  if (Array.isArray(v.layers)) {
    for (const raw of v.layers.slice(0, SHADOW_LIMITS.maxLayers)) {
      // Layer types this version does not know (from a newer app) are skipped, not guessed at.
      if (!isObj(raw)) continue;
      const base = { id: nextId(), visible: raw.visible !== false };
      if (raw.type === 'drop') {
        layers.push(clampLayer({ ...DEFAULT_DROP, ...base, ...pick(raw, DROP_KEYS) } as DropLayer));
      } else if (raw.type === 'contact') {
        layers.push(
          clampLayer({ ...DEFAULT_CONTACT, ...base, ...pick(raw, CONTACT_KEYS) } as ContactLayer),
        );
      } else if (raw.type === 'cast') {
        layers.push(clampLayer({ ...DEFAULT_CAST, ...base, ...pick(raw, CAST_KEYS) } as CastLayer));
      } else if (raw.type === 'reflection') {
        layers.push(
          clampLayer({
            ...DEFAULT_REFLECTION,
            ...base,
            ...pick(raw, REFLECTION_KEYS),
          } as ReflectionLayer),
        );
      }
    }
  }
  return {
    enabled: v.enabled === true,
    autoExpand: v.autoExpand !== false,
    linearLight: v.linearLight === true,
    groundY: v.groundY === null || v.groundY === undefined ? null : num(v.groundY, 0, 0, 1),
    presetId: typeof v.presetId === 'string' && v.presetId.length <= 60 ? v.presetId : null,
    layers,
  };
}

const DROP_KEYS = ['angle', 'distance', 'blur', 'spread', 'opacity', 'color'] as const;
const CONTACT_KEYS = ['size', 'softness', 'groundOffset', 'opacity', 'color'] as const;
const REFLECTION_KEYS = ['gap', 'fade', 'blur', 'opacity'] as const;
const CAST_KEYS = [
  'angle',
  'elevation',
  'length',
  'squash',
  'falloff',
  'blur',
  'blurGrowth',
  'opacity',
  'color',
] as const;

/** Copy the listed keys that are present; clampLayer repairs wrong types and ranges. */
function pick(raw: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in raw) out[k] = raw[k];
  return out;
}

/** The saved form: layer ids are in-memory only. */
export function shadowToPersisted(s: ShadowState | null) {
  if (!s) return null;
  return {
    enabled: s.enabled,
    autoExpand: s.autoExpand,
    linearLight: s.linearLight,
    groundY: s.groundY,
    presetId: s.presetId,
    layers: s.layers.map((l) => {
      const { id: _id, ...rest } = l;
      void _id;
      return rest;
    }),
  };
}

/** Offset of a layer in source px. Light from `angle`, shadow falls the opposite way (y is down). */
export function layerOffset(l: { angle: number; distance: number }) {
  const a = (l.angle * Math.PI) / 180;
  return { dx: -Math.cos(a) * l.distance, dy: Math.sin(a) * l.distance };
}

/** Gaussian sigma of a blur radius in source px. */
export const layerSigma = (l: { blur: number }) => l.blur / 2;

const drawable = (l: ShadowLayer) => l.visible && l.opacity > 0;

/** True when the shadow would be drawn at all. */
export function shadowActive(s: ShadowState | null): s is ShadowState {
  return !!s && s.enabled && s.layers.some(drawable);
}

/** Layers that have a light direction. */
export const hasLight = (l: ShadowLayer): l is DropLayer | CastLayer =>
  l.type === 'drop' || l.type === 'cast';

/** The light direction the canvas handle shows: the first visible layer that has one. */
export function lightAngle(s: ShadowState | null): number | null {
  const l = s?.layers.find((x) => hasLight(x) && x.visible);
  return l && hasLight(l) ? l.angle : null;
}

/** Point every layer's light at `angle` (degrees, wrapped into 0..360). */
export function withLightAngle(s: ShadowState, angle: number): ShadowState {
  const a = ((Math.round(angle) % 360) + 360) % 360;
  return {
    ...s,
    presetId: null,
    layers: s.layers.map((l) => (hasLight(l) ? { ...l, angle: a } : l)),
  };
}

/** True when a layer needs the ground line (everything except the plain drop shadow). */
export const usesGround = (l: ShadowLayer) => l.type !== 'drop';

/** Where the subject stands, in source px: the manual ground line, else its lowest pixel. */
export function groundLine(
  subject: Frame | null,
  srcH: number,
  shadow: Pick<ShadowState, 'groundY'> | null,
): number | null {
  if (shadow && shadow.groundY !== null) return shadow.groundY * srcH;
  return subject ? subject.y + subject.h : null;
}

/** The cast shadow's floor direction per source px of subject height: (sx, sy). */
export function castVector(l: CastLayer) {
  const a = (l.angle * Math.PI) / 180;
  const len = Math.min(MAX_CAST_LENGTH, l.length / Math.tan((l.elevation * Math.PI) / 180) || 0);
  return { sx: -Math.cos(a) * len, sy: Math.sin(a) * len * l.squash };
}

/** Blur sigmas (source px) of the levels a cast shadow is rendered at, near to far. */
export function castSigmas(l: CastLayer): number[] {
  if (l.blurGrowth <= 0) return [l.blur / 2];
  return Array.from(
    { length: CAST_LEVELS },
    (_, i) => (l.blur + (l.blurGrowth * i) / (CAST_LEVELS - 1)) / 2,
  );
}

/** Bounding box of the pixels whose alpha exceeds `threshold`, in proxy pixels (x1/y1 exclusive). */
export function alphaBounds(alpha: Uint8Array, w: number, h: number, threshold = 8) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The output canvas needed to hold the image and every visible shadow: the source rectangle
 * unioned with each layer's shadow footprint, rounded outward, never larger than one extra image
 * size on any side. `subject` is the subject's box in source px; without one nothing is added.
 * Footprints: drop = subject box moved by the offset, grown by spread and three sigma of blur;
 * contact = the subject's width, from the ground line down to the flattened band; cast = the
 * subject's width plus the full shadow vector, from the ground line; reflection = the subject's
 * width, from the ground line plus the gap down by the reflected height.
 */
export function shadowBounds(
  subject: Frame | null,
  srcW: number,
  srcH: number,
  shadow: ShadowState | null,
): Frame {
  const base: Frame = { x: 0, y: 0, w: srcW, h: srcH };
  if (!shadowActive(shadow) || !shadow.autoExpand || !subject) return base;
  const ground = groundLine(subject, srcH, shadow) ?? subject.y + subject.h;
  const height = Math.max(1, ground - subject.y);
  let x0 = 0;
  let y0 = 0;
  let x1 = srcW;
  let y1 = srcH;
  const grow = (l: { x0: number; y0: number; x1: number; y1: number }) => {
    x0 = Math.min(x0, l.x0);
    y0 = Math.min(y0, l.y0);
    x1 = Math.max(x1, l.x1);
    y1 = Math.max(y1, l.y1);
  };
  const sx0 = subject.x;
  const sx1 = subject.x + subject.w;
  for (const l of shadow.layers) {
    if (!drawable(l)) continue;
    if (l.type === 'drop') {
      const { dx, dy } = layerOffset(l);
      const g = Math.max(0, l.spread) + 3 * layerSigma(l);
      grow({
        x0: sx0 + dx - g,
        y0: subject.y + dy - g,
        x1: sx1 + dx + g,
        y1: subject.y + subject.h + dy + g,
      });
    } else if (l.type === 'contact') {
      const g = 3 * layerSigma({ blur: l.softness });
      const top = ground + l.groundOffset;
      grow({
        x0: sx0 - g,
        y0: top - g,
        x1: sx1 + g,
        y1: top + l.size * CONTACT_SQUASH + g,
      });
    } else if (l.type === 'reflection') {
      const g = 3 * layerSigma(l);
      const top = ground + l.gap;
      grow({
        x0: sx0 - g,
        y0: top - g,
        x1: sx1 + g,
        y1: top + Math.min(l.fade, height) + g,
      });
    } else {
      const { sx, sy } = castVector(l);
      const g = 3 * Math.max(...castSigmas(l));
      grow({
        x0: sx0 + Math.min(0, sx * height) - g,
        y0: ground + Math.min(0, sy * height) - g,
        x1: sx1 + Math.max(0, sx * height) + g,
        y1: ground + Math.max(0, sy * height) + g,
      });
    }
  }
  const cap = Math.max(srcW, srcH);
  x0 = Math.max(-cap, Math.floor(x0));
  y0 = Math.max(-cap, Math.floor(y0));
  x1 = Math.min(srcW + cap, Math.ceil(x1));
  y1 = Math.min(srcH + cap, Math.ceil(y1));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface ShadowBitmap {
  /** Straight (non-premultiplied) RGBA. */
  data: Uint8ClampedArray<ArrayBuffer>;
  w: number;
  h: number;
}

/** The subject's box and the ground line in source px; what contact and cast shadows hang from. */
export interface ShadowGeometry {
  subject: Frame;
  ground: number;
}

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** 4 x 4 ordered-dither thresholds (0..15). The same table is used by the Rust renderer. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** sRGB value (0..255) -> linear light on the same 0..255 scale, and back. */
export function toLinear(c: number): number {
  const v = Math.min(255, Math.max(0, c)) / 255;
  return 255 * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
}
export function fromLinear(c: number): number {
  const v = Math.min(255, Math.max(0, c)) / 255;
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
}

interface Plane {
  w: number;
  h: number;
  /** Frame-pixel position of source pixel (0,0). */
  originX: number;
  originY: number;
  scale: number;
}

/** The drop shadow's plane: the mask moved, grown and blurred. */
function dropPlane(alpha: Uint8Array, aw: number, ah: number, P: Plane, l: DropLayer) {
  const { w: fw, h: fh, scale } = P;
  const { dx, dy } = layerOffset(l);
  let plane: Uint8Array = new Uint8Array(fw * fh);
  const px = P.originX + Math.round(dx * scale);
  const py = P.originY + Math.round(dy * scale);
  for (let y = 0; y < ah; y++) {
    const ty = y + py;
    if (ty < 0 || ty >= fh) continue;
    for (let x = 0; x < aw; x++) {
      const tx = x + px;
      if (tx >= 0 && tx < fw) plane[ty * fw + tx] = alpha[y * aw + x]!;
    }
  }
  const spreadPx = Math.round(Math.abs(l.spread) * scale);
  if (spreadPx > 0) plane = morph(plane, fw, fh, spreadPx, l.spread > 0);
  const sigma = layerSigma(l) * scale;
  return sigma >= 0.5 ? gaussianBlur(plane, fw, fh, sigma) : plane;
}

/**
 * The base of the subject (the `size` px above the ground line) flattened onto the floor just
 * below the ground line, brightest where it touches and fading with height.
 */
function contactPlane(
  alpha: Uint8Array,
  aw: number,
  ah: number,
  P: Plane,
  l: ContactLayer,
  geom: ShadowGeometry,
) {
  const { w: fw, h: fh, scale } = P;
  let plane: Uint8Array = new Uint8Array(fw * fh);
  const groundP = geom.ground * scale;
  const band = Math.max(1, l.size * scale);
  const offset = l.groundOffset * scale;
  for (let y = Math.max(0, Math.floor(groundP - band)); y < Math.min(ah, Math.ceil(groundP)); y++) {
    const h = groundP - (y + 0.5);
    if (h <= 0 || h > band) continue;
    const weight = 1 - h / band;
    const ty = P.originY + Math.round(groundP + offset + h * CONTACT_SQUASH);
    if (ty < 0 || ty >= fh) continue;
    for (let x = 0; x < aw; x++) {
      const v = Math.round(alpha[y * aw + x]! * weight);
      const tx = x + P.originX;
      if (v > 0 && tx >= 0 && tx < fw && v > plane[ty * fw + tx]!) plane[ty * fw + tx] = v;
    }
  }
  const sigma = layerSigma({ blur: l.softness }) * scale;
  if (sigma >= 0.5) plane = gaussianBlur(plane, fw, fh, sigma);
  return plane;
}

/**
 * The subject projected onto the floor along the light. A pixel `h` above the ground line lands
 * at (x + sx*h, ground + sy*h). Rows are mapped forward in sub-steps so that steep or long
 * projections stay solid, and weighted by how far along the shadow they are (falloff). The
 * shadow is built at several blur levels, each holding the rows that belong to it, so the blur
 * grows with distance from the subject.
 */
function castPlane(
  alpha: Uint8Array,
  aw: number,
  ah: number,
  P: Plane,
  l: CastLayer,
  geom: ShadowGeometry,
) {
  const { w: fw, h: fh, scale } = P;
  const sigmas = castSigmas(l);
  const levels = sigmas.length;
  const planes = sigmas.map(() => new Uint8Array(fw * fh));
  const { sx, sy } = castVector(l);
  const groundP = geom.ground * scale;
  const height = Math.max(1, geom.ground - geom.subject.y) * scale;
  for (
    let y = Math.max(0, Math.floor(groundP - height));
    y < Math.min(ah, Math.ceil(groundP));
    y++
  ) {
    const h0 = groundP - (y + 1);
    const h1 = groundP - y;
    if (h1 <= 0) continue;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(sx), Math.abs(sy)) * (h1 - h0)));
    for (let k = 0; k < steps; k++) {
      const h = Math.max(0, h0 + ((k + 0.5) / steps) * (h1 - h0));
      const t = Math.min(1, h / height);
      const weight = 1 - l.falloff * t;
      const ty = P.originY + Math.round(groundP + sy * h);
      if (ty < 0 || ty >= fh) continue;
      const shift = P.originX + Math.round(sx * h);
      const pos = t * (levels - 1);
      const i0 = Math.min(levels - 1, Math.floor(pos));
      const frac = pos - i0;
      for (let x = 0; x < aw; x++) {
        const a = alpha[y * aw + x]!;
        const tx = x + shift;
        if (a === 0 || tx < 0 || tx >= fw) continue;
        const idx = ty * fw + tx;
        const lo = Math.round(a * weight * (levels === 1 ? 1 : 1 - frac));
        if (lo > planes[i0]![idx]!) planes[i0]![idx] = lo;
        if (levels > 1 && frac > 0) {
          const hi = Math.round(a * weight * frac);
          if (hi > planes[i0 + 1]![idx]!) planes[i0 + 1]![idx] = hi;
        }
      }
    }
  }
  const out = new Uint8Array(fw * fh);
  planes.forEach((plane, i) => {
    const sigma = sigmas[i]! * scale;
    const blurred = sigma >= 0.5 ? gaussianBlur(plane, fw, fh, sigma) : plane;
    for (let j = 0; j < out.length; j++) out[j] = Math.min(255, out[j]! + blurred[j]!);
  });
  return out;
}

interface Reflection {
  /** Premultiplied colour planes and alpha, 0..255. */
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  a: Uint8Array;
}
type Planes = { [K in keyof Reflection]: Uint8Array };

/** The subject at the proxy scale in straight RGBA (same size as the alpha plane). */
export interface SubjectPixels {
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * The part of the subject within `fade` px of the ground line, flipped about it and moved down by
 * `gap`, fading linearly to nothing at `fade`, then blurred. Colours are blurred premultiplied so
 * the edges do not pick up dark fringes.
 */
function reflectionPlanes(
  alpha: Uint8Array,
  rgba: SubjectPixels,
  aw: number,
  ah: number,
  P: Plane,
  l: ReflectionLayer,
  geom: ShadowGeometry,
): Reflection {
  const { w: fw, h: fh, scale } = P;
  const n = fw * fh;
  const out: Planes = {
    r: new Uint8Array(n),
    g: new Uint8Array(n),
    b: new Uint8Array(n),
    a: new Uint8Array(n),
  };
  const groundP = geom.ground * scale;
  const fade = Math.max(1, l.fade * scale);
  const gap = l.gap * scale;
  for (let y = Math.max(0, Math.floor(groundP - fade)); y < Math.min(ah, Math.ceil(groundP)); y++) {
    const h = groundP - (y + 0.5);
    if (h <= 0 || h > fade) continue;
    const weight = 1 - h / fade;
    const ty = P.originY + Math.round(groundP + gap + h);
    if (ty < 0 || ty >= fh) continue;
    for (let x = 0; x < aw; x++) {
      const i = y * aw + x;
      const a = Math.round(alpha[i]! * weight);
      const tx = x + P.originX;
      if (a === 0 || tx < 0 || tx >= fw) continue;
      const j = ty * fw + tx;
      out.a[j] = a;
      out.r[j] = Math.round((rgba.data[i * 4]! * a) / 255);
      out.g[j] = Math.round((rgba.data[i * 4 + 1]! * a) / 255);
      out.b[j] = Math.round((rgba.data[i * 4 + 2]! * a) / 255);
    }
  }
  const sigma = layerSigma(l) * scale;
  if (sigma >= 0.5) {
    out.a = gaussianBlur(out.a, fw, fh, sigma);
    out.r = gaussianBlur(out.r, fw, fh, sigma);
    out.g = gaussianBlur(out.g, fw, fh, sigma);
    out.b = gaussianBlur(out.b, fw, fh, sigma);
  }
  return out;
}

/**
 * Render the visible layers into a bitmap covering `frame`.
 * `alpha` is the subject mask at `scale` proxy pixels per source pixel (size aw x ah). Each layer
 * becomes a plane (drop, contact or cast, see above), is tinted and multiplied by its opacity,
 * then composited over the layers below it (list order = bottom to top) with straight-alpha
 * "over". `geom` locates the subject and ground line; without it only drop layers are drawn.
 * Reflection layers also need `rgba`, the subject's colours at the same size as `alpha`.
 */
export function renderShadow(
  alpha: Uint8Array,
  aw: number,
  ah: number,
  scale: number,
  shadow: ShadowState,
  frame: Frame,
  geom?: ShadowGeometry | null,
  rgba?: SubjectPixels | null,
): ShadowBitmap {
  const fw = Math.max(1, Math.ceil(frame.w * scale));
  const fh = Math.max(1, Math.ceil(frame.h * scale));
  const n = fw * fh;
  const oa = new Float32Array(n);
  const or = new Float32Array(n);
  const og = new Float32Array(n);
  const ob = new Float32Array(n);
  const P: Plane = {
    w: fw,
    h: fh,
    originX: Math.round(-frame.x * scale),
    originY: Math.round(-frame.y * scale),
    scale,
  };

  const linear = shadow.linearLight;
  for (const l of shadow.layers) {
    if (!drawable(l)) continue;
    if (l.type === 'reflection') {
      if (!geom || !rgba) continue;
      const R = reflectionPlanes(alpha, rgba, aw, ah, P, l, geom);
      const lin = linear ? toLinear : (c: number) => c;
      for (let i = 0; i < n; i++) {
        const pa = R.a[i]!;
        if (pa === 0) continue;
        const a = (pa / 255) * l.opacity;
        const keep = 1 - a;
        // premultiplied colour / alpha = straight colour
        or[i] = lin((R.r[i]! * 255) / pa) * a + or[i]! * keep;
        og[i] = lin((R.g[i]! * 255) / pa) * a + og[i]! * keep;
        ob[i] = lin((R.b[i]! * 255) / pa) * a + ob[i]! * keep;
        oa[i] = a + oa[i]! * keep;
      }
      continue;
    }
    let plane: Uint8Array;
    if (l.type === 'drop') plane = dropPlane(alpha, aw, ah, P, l);
    else if (!geom) continue;
    else if (l.type === 'contact') plane = contactPlane(alpha, aw, ah, P, l, geom);
    else plane = castPlane(alpha, aw, ah, P, l, geom);

    const [r0, g0, b0] = hexRgb(l.color);
    const [r, g, b] = linear ? [toLinear(r0), toLinear(g0), toLinear(b0)] : [r0, g0, b0];
    for (let i = 0; i < n; i++) {
      const a = (plane[i]! / 255) * l.opacity;
      if (a <= 0) continue;
      const keep = 1 - a;
      or[i] = r * a + or[i]! * keep;
      og[i] = g * a + og[i]! * keep;
      ob[i] = b * a + ob[i]! * keep;
      oa[i] = a + oa[i]! * keep;
    }
  }

  const data = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  const out = linear ? fromLinear : (c: number) => c;
  for (let i = 0; i < n; i++) {
    const a = oa[i]!;
    if (a <= 0) continue;
    data[i * 4] = out(or[i]! / a);
    data[i * 4 + 1] = out(og[i]! / a);
    data[i * 4 + 2] = out(ob[i]! / a);
    // Ordered dither on the alpha so long soft gradients do not band at 8 bits.
    const t = (BAYER4[((Math.floor(i / fw) & 3) << 2) | ((i % fw) & 3)]! + 0.5) / 16;
    data[i * 4 + 3] = Math.floor(a * 255 + t);
  }
  return { data, w: fw, h: fh };
}

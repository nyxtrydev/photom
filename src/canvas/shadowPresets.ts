// Shadow presets: named sets of layers. Distances are stored for a 1500 px image and scaled to
// the image they are applied to, so one preset looks the same on a 1000 px and a 6000 px photo.
import {
  sanitizeShadow,
  shadowToPersisted,
  SHADOW_LIMITS,
  type ShadowLayer,
  type ShadowState,
} from './shadow';

/** The longest side the stored pixel values are relative to. */
export const PRESET_REF_SIDE = 1500;

type Persisted = NonNullable<ReturnType<typeof shadowToPersisted>>;
export type PresetLayer = Persisted['layers'][number];

export interface ShadowPreset {
  id: string;
  name: string;
  /** Longest image side the layer pixel values were authored for. */
  refSide: number;
  autoExpand: boolean;
  layers: PresetLayer[];
  builtIn?: boolean;
}

/** Layer fields measured in source pixels (they scale with the image). */
const PIXEL_FIELDS = [
  'distance',
  'blur',
  'spread',
  'size',
  'softness',
  'groundOffset',
  'blurGrowth',
  'gap',
  'fade',
] as const;

const DARK = '#2b1a10';

export const BUILT_IN_SHADOW_PRESETS: ShadowPreset[] = [
  {
    id: 'product',
    name: 'Product',
    builtIn: true,
    refSide: PRESET_REF_SIDE,
    autoExpand: true,
    layers: [
      {
        type: 'drop',
        visible: true,
        angle: 135,
        distance: 14,
        blur: 26,
        spread: 0,
        opacity: 0.3,
        color: DARK,
      },
      {
        type: 'contact',
        visible: true,
        size: 30,
        softness: 8,
        groundOffset: 0,
        opacity: 0.55,
        color: DARK,
      },
    ],
  },
  {
    id: 'floating',
    name: 'Floating',
    builtIn: true,
    refSide: PRESET_REF_SIDE,
    autoExpand: true,
    layers: [
      {
        type: 'drop',
        visible: true,
        angle: 90,
        distance: 80,
        blur: 70,
        spread: -10,
        opacity: 0.28,
        color: DARK,
      },
    ],
  },
  {
    id: 'grounded',
    name: 'Grounded',
    builtIn: true,
    refSide: PRESET_REF_SIDE,
    autoExpand: true,
    layers: [
      {
        type: 'contact',
        visible: true,
        size: 50,
        softness: 14,
        groundOffset: 0,
        opacity: 0.65,
        color: DARK,
      },
      {
        type: 'cast',
        visible: true,
        angle: 160,
        elevation: 45,
        length: 0.7,
        squash: 0.35,
        falloff: 0.8,
        blur: 8,
        blurGrowth: 40,
        opacity: 0.35,
        color: DARK,
      },
    ],
  },
  {
    id: 'soft-studio',
    name: 'Soft studio',
    builtIn: true,
    refSide: PRESET_REF_SIDE,
    autoExpand: true,
    layers: [
      { type: 'reflection', visible: true, gap: 2, fade: 140, blur: 3, opacity: 0.18 },
      {
        type: 'drop',
        visible: true,
        angle: 90,
        distance: 22,
        blur: 120,
        spread: 0,
        opacity: 0.22,
        color: DARK,
      },
      {
        type: 'contact',
        visible: true,
        size: 24,
        softness: 10,
        groundOffset: 0,
        opacity: 0.4,
        color: DARK,
      },
    ],
  },
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Narrow an unknown settings entry to a usable custom preset. */
export function isShadowPreset(v: unknown): v is ShadowPreset {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    Array.isArray(v.layers) &&
    v.layers.length > 0
  );
}

export function allShadowPresets(custom: unknown[]): ShadowPreset[] {
  return [...BUILT_IN_SHADOW_PRESETS, ...custom.filter(isShadowPreset)];
}

const scaleLayer = (l: PresetLayer, f: number): PresetLayer => {
  const out: Record<string, unknown> = { ...l };
  for (const k of PIXEL_FIELDS) {
    if (typeof out[k] === 'number') out[k] = (out[k] as number) * f;
  }
  return out as PresetLayer;
};

/** The longest side of the image the shadow is for. */
export const longestSide = (src: { width: number; height: number }) =>
  Math.max(1, src.width, src.height);

/**
 * The shadow settings a preset produces for an image: its layers scaled to the image, enabled,
 * keeping the image's own ground line. Values are re-clamped, so an edited preset cannot exceed
 * the limits.
 */
export function shadowFromPreset(
  preset: ShadowPreset,
  imageLongestSide: number,
  current: ShadowState | null,
): ShadowState {
  const f = imageLongestSide / Math.max(1, preset.refSide || PRESET_REF_SIDE);
  const built = sanitizeShadow({
    enabled: true,
    autoExpand: preset.autoExpand,
    linearLight: current?.linearLight ?? false,
    groundY: current?.groundY ?? null,
    presetId: preset.id,
    layers: preset.layers.slice(0, SHADOW_LIMITS.maxLayers).map((l) => scaleLayer(l, f)),
  });
  return (
    built ?? {
      enabled: true,
      autoExpand: true,
      linearLight: false,
      groundY: null,
      presetId: preset.id,
      layers: [],
    }
  );
}

/** Capture the current shadow as a preset, normalised to the reference size. */
export function presetFromShadow(
  name: string,
  shadow: ShadowState,
  imageLongestSide: number,
  id = '',
): ShadowPreset {
  const persisted = shadowToPersisted(shadow)!;
  const f = PRESET_REF_SIDE / Math.max(1, imageLongestSide);
  return {
    id,
    name,
    refSide: PRESET_REF_SIDE,
    autoExpand: shadow.autoExpand,
    layers: persisted.layers.map((l) => scaleLayer(l, f)),
  };
}

export type { ShadowLayer };

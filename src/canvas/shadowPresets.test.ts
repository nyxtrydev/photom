import { describe, expect, it } from 'vitest';
import {
  defaultShadow,
  newCastLayer,
  newContactLayer,
  newDropLayer,
  sanitizeShadow,
  shadowToPersisted,
  SHADOW_LIMITS,
  type ShadowState,
} from './shadow';
import {
  allShadowPresets,
  BUILT_IN_SHADOW_PRESETS,
  isShadowPreset,
  longestSide,
  presetFromShadow,
  PRESET_REF_SIDE,
  shadowFromPreset,
} from './shadowPresets';

describe('built-in presets', () => {
  it('are the four named in the spec, each with valid in-range layers', () => {
    expect(BUILT_IN_SHADOW_PRESETS.map((p) => p.name)).toEqual([
      'Product',
      'Floating',
      'Grounded',
      'Soft studio',
    ]);
    for (const p of BUILT_IN_SHADOW_PRESETS) {
      const s = shadowFromPreset(p, PRESET_REF_SIDE, null);
      expect(s.layers.length, p.name).toBe(p.layers.length);
      expect(s.layers.length).toBeLessThanOrEqual(SHADOW_LIMITS.maxLayers);
      // Nothing was clamped: what is written is what is used.
      expect(shadowToPersisted(s)!.layers, p.name).toEqual(p.layers);
      expect(s).toMatchObject({ enabled: true, presetId: p.id });
    }
  });

  it('use different shadow types between them', () => {
    const types = new Set(BUILT_IN_SHADOW_PRESETS.flatMap((p) => p.layers.map((l) => l.type)));
    expect([...types].sort()).toEqual(['cast', 'contact', 'drop', 'reflection']);
  });
});

describe('applying a preset', () => {
  const product = BUILT_IN_SHADOW_PRESETS[0]!;

  it('scales pixel values with the image so it looks the same on any size', () => {
    const small = shadowFromPreset(product, 750, null).layers[0]!;
    const big = shadowFromPreset(product, 3000, null).layers[0]!;
    expect(small).toMatchObject({ distance: 7, blur: 13 });
    expect(big).toMatchObject({ distance: 28, blur: 52 });
    // angles and opacities do not scale
    expect(big).toMatchObject({ angle: 135, opacity: 0.3 });
  });

  it('keeps the image’s own ground line and clamps anything out of range', () => {
    const cur: ShadowState = { ...defaultShadow(), groundY: 0.8 };
    expect(shadowFromPreset(product, 1500, cur).groundY).toBe(0.8);
    const huge = shadowFromPreset(product, 150000, null).layers[0]!;
    expect(huge).toMatchObject({ distance: 500, blur: 200 });
  });

  it('gives fresh layer ids every time', () => {
    const a = shadowFromPreset(product, 1500, null);
    const b = shadowFromPreset(product, 1500, null);
    expect(a.layers[0]!.id).not.toBe(b.layers[0]!.id);
  });
});

describe('custom presets', () => {
  const shadow: ShadowState = {
    ...defaultShadow(),
    autoExpand: false,
    layers: [newDropLayer({ distance: 60, blur: 80 }), newContactLayer(), newCastLayer()],
  };

  it('are stored relative to the reference size and restore exactly on the same image', () => {
    const p = presetFromShadow('Mine', shadow, 3000);
    expect(p).toMatchObject({ name: 'Mine', refSide: PRESET_REF_SIDE, autoExpand: false });
    expect(p.layers[0]).toMatchObject({ distance: 30, blur: 40 }); // 3000 -> 1500
    const back = shadowFromPreset({ ...p, id: 'x' }, 3000, null);
    expect(shadowToPersisted(back)!.layers).toEqual(shadowToPersisted(shadow)!.layers);
    expect(back.autoExpand).toBe(false);
  });

  it('survive JSON, and junk entries are ignored', () => {
    const p = { ...presetFromShadow('Mine', shadow, 1500), id: 'c1' };
    const list = allShadowPresets([
      JSON.parse(JSON.stringify(p)),
      null,
      'x',
      { id: 1 },
      { id: 'z', name: 'n', layers: [] },
    ]);
    expect(list.map((x) => x.id)).toEqual(['product', 'floating', 'grounded', 'soft-studio', 'c1']);
    expect(isShadowPreset(p)).toBe(true);
  });

  it('cannot smuggle in bad values: an edited preset is clamped on apply', () => {
    const p = {
      id: 'evil',
      name: 'x',
      refSide: 1500,
      autoExpand: true,
      layers: [
        { type: 'drop', distance: 1e9, color: 'javascript:1', opacity: 9 },
        { type: 'nope' },
      ],
    } as never;
    const s = shadowFromPreset(p, 1500, null);
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0]).toMatchObject({ distance: 500, opacity: 1, color: '#2b1a10' });
    expect(sanitizeShadow(shadowToPersisted(s))!.layers).toHaveLength(1);
  });

  it('longestSide never returns zero', () => {
    expect(longestSide({ width: 0, height: 0 })).toBe(1);
    expect(longestSide({ width: 400, height: 900 })).toBe(900);
  });
});

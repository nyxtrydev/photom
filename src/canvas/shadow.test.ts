import { describe, expect, it } from 'vitest';
import fixtureText from '../../src-tauri/tests/fixtures/shadow_bounds.json?raw';
import renderFixtureText from '../../src-tauri/tests/fixtures/shadow_render.json?raw';
import {
  alphaBounds,
  clampLayer,
  defaultShadow,
  layerOffset,
  newCastLayer,
  newContactLayer,
  newDropLayer,
  newReflectionLayer,
  groundLine,
  lightAngle,
  usesGround,
  withLightAngle,
  castVector,
  fromLinear,
  toLinear,
  renderShadow,
  sanitizeShadow,
  SHADOW_LIMITS,
  shadowActive,
  shadowBounds,
  shadowToPersisted,
  type ShadowLayer,
  type ShadowState,
} from './shadow';

const withLayers = (layers: ShadowLayer[], over: Partial<ShadowState> = {}) =>
  ({ ...defaultShadow(), layers, ...over }) as ShadowState;

/** A filled square on an otherwise empty w x h mask. */
function square(w: number, h: number, x0: number, y0: number, size: number) {
  const a = new Uint8Array(w * h);
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) a[y * w + x] = 255;
  return a;
}
const px = (
  b: { data: Uint8ClampedArray; w: number },
  x: number,
  y: number,
): [number, number, number, number] => {
  const i = (y * b.w + x) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!, b.data[i + 3]!];
};

describe('layerOffset', () => {
  it('light from the upper left casts the shadow to the lower right', () => {
    const { dx, dy } = layerOffset({ angle: 135, distance: 100 });
    expect(dx).toBeCloseTo(70.71, 1);
    expect(dy).toBeCloseTo(70.71, 1);
  });
  it('covers the four axes', () => {
    const near = (o: { dx: number; dy: number }, dx: number, dy: number) => {
      expect(o.dx).toBeCloseTo(dx, 5);
      expect(o.dy).toBeCloseTo(dy, 5);
    };
    near(layerOffset({ angle: 0, distance: 10 }), -10, 0);
    near(layerOffset({ angle: 90, distance: 10 }), 0, 10);
    near(layerOffset({ angle: 180, distance: 10 }), 10, 0);
    near(layerOffset({ angle: 270, distance: 10 }), 0, -10);
    near(layerOffset({ angle: 77, distance: 0 }), 0, 0);
  });
});

describe('parameters', () => {
  it('clamps everything into range and repairs a bad colour', () => {
    const l = clampLayer({
      ...newDropLayer(),
      angle: 999,
      distance: -5,
      blur: 1e9,
      spread: -1e9,
      opacity: 7,
      color: 'red',
    });
    expect(l.angle).toBe(SHADOW_LIMITS.angle.max);
    expect(l.distance).toBe(0);
    expect(l.blur).toBe(SHADOW_LIMITS.blur.max);
    expect(l.spread).toBe(SHADOW_LIMITS.spread.min);
    expect(l.opacity).toBe(1);
    expect(l.color).toBe('#2b1a10');
    expect(clampLayer({ ...newDropLayer(), angle: NaN }).angle).toBe(135);
  });

  it('every new layer gets its own id', () => {
    expect(newDropLayer().id).not.toBe(newDropLayer().id);
  });

  it('shadowActive needs enabled, a visible layer and some opacity', () => {
    expect(shadowActive(null)).toBe(false);
    expect(shadowActive(defaultShadow())).toBe(true);
    expect(shadowActive({ ...defaultShadow(), enabled: false })).toBe(false);
    expect(shadowActive(withLayers([newDropLayer({ visible: false })]))).toBe(false);
    expect(shadowActive(withLayers([newDropLayer({ opacity: 0 })]))).toBe(false);
    expect(shadowActive(withLayers([]))).toBe(false);
  });
});

describe('saving and loading', () => {
  it('round-trips without layer ids', () => {
    const s = withLayers([newDropLayer({ distance: 40, color: '#112233' }), newDropLayer()], {
      presetId: 'product',
      groundY: 0.9,
    });
    const saved = shadowToPersisted(s)!;
    expect(JSON.stringify(saved)).not.toContain('"id"');
    const back = sanitizeShadow(JSON.parse(JSON.stringify(saved)))!;
    expect(back.layers).toHaveLength(2);
    expect(back.layers[0]).toMatchObject({ distance: 40, color: '#112233', type: 'drop' });
    expect(back).toMatchObject({
      enabled: true,
      autoExpand: true,
      presetId: 'product',
      groundY: 0.9,
    });
    expect(back.layers[0]!.id).not.toBe(back.layers[1]!.id);
  });

  it('missing or junk data means no shadow, never a crash', () => {
    for (const v of [undefined, null, 5, 'x', [], true]) expect(sanitizeShadow(v)).toBeNull();
    expect(shadowToPersisted(null)).toBeNull();
  });

  it('hostile values are repaired or dropped', () => {
    const s = sanitizeShadow({
      enabled: 'yes',
      autoExpand: 0,
      groundY: 'low',
      presetId: 'x'.repeat(500),
      layers: [
        {
          type: 'drop',
          distance: 'far',
          blur: Infinity,
          opacity: -3,
          color: '#zzzzzz',
          visible: 1,
        },
        { type: 'hologram' },
        'junk',
        null,
        ...Array.from({ length: 30 }, () => ({ type: 'drop' })),
      ],
    })!;
    expect(s.enabled).toBe(false);
    expect(s.autoExpand).toBe(true);
    expect(s.groundY).toBe(0);
    expect(s.presetId).toBeNull();
    expect(s.layers.length).toBeLessThanOrEqual(SHADOW_LIMITS.maxLayers);
    expect(s.layers[0]).toMatchObject({ distance: 24, opacity: 0, color: '#2b1a10' });
    expect(s.layers.every((l) => l.type === 'drop')).toBe(true);
  });
});

describe('alphaBounds', () => {
  it('finds the box of the subject and ignores faint noise', () => {
    const a = square(50, 40, 10, 5, 8);
    a[0] = 5; // below the threshold
    expect(alphaBounds(a, 50, 40)).toEqual({ x0: 10, y0: 5, x1: 18, y1: 13 });
  });
  it('is null for an empty mask', () => {
    expect(alphaBounds(new Uint8Array(100), 10, 10)).toBeNull();
  });
});

describe('shadowBounds', () => {
  const subject = { x: 800, y: 600, w: 200, h: 200 };

  it('adds nothing when the shadow is off, fixed-size, or there is no subject', () => {
    const base = { x: 0, y: 0, w: 1000, h: 800 };
    expect(shadowBounds(subject, 1000, 800, null)).toEqual(base);
    expect(shadowBounds(subject, 1000, 800, { ...defaultShadow(), enabled: false })).toEqual(base);
    expect(shadowBounds(subject, 1000, 800, { ...defaultShadow(), autoExpand: false })).toEqual(
      base,
    );
    expect(shadowBounds(null, 1000, 800, defaultShadow())).toEqual(base);
  });

  it('stays the source size while the shadow fits inside the image', () => {
    const s = withLayers([newDropLayer({ distance: 20, blur: 20 })]);
    expect(shadowBounds({ x: 300, y: 300, w: 200, h: 200 }, 1000, 800, s)).toEqual({
      x: 0,
      y: 0,
      w: 1000,
      h: 800,
    });
  });

  it('grows to hold a shadow that falls off the edge (offset plus three sigma of blur)', () => {
    const s = withLayers([newDropLayer({ angle: 135, distance: 100, blur: 40 })]);
    const f = shadowBounds(subject, 1000, 800, s);
    // right edge: 1000 + 70.71 + 3*20 = 1130.71 -> 1131 ; bottom: 800 + 70.71 + 60 -> 931
    expect(f).toEqual({ x: 0, y: 0, w: 1131, h: 931 });
  });

  it('grows on the other sides for other angles', () => {
    const s = withLayers([newDropLayer({ angle: 315, distance: 100, blur: 0 })]);
    const f = shadowBounds({ x: 0, y: 0, w: 200, h: 200 }, 1000, 800, s);
    expect(f.x).toBe(-71);
    expect(f.y).toBe(-71);
    expect(f.w).toBe(1071);
    expect(f.h).toBe(871);
  });

  it('counts positive spread but not negative', () => {
    const grow = (spread: number) =>
      shadowBounds(
        { x: 900, y: 700, w: 100, h: 100 },
        1000,
        800,
        withLayers([newDropLayer({ distance: 0, blur: 0, spread })]),
      ).w;
    expect(grow(30)).toBe(1030);
    expect(grow(-30)).toBe(1000);
  });

  it('unions several layers and ignores hidden ones', () => {
    const s = withLayers([
      newDropLayer({ angle: 135, distance: 50, blur: 0 }),
      newDropLayer({ angle: 315, distance: 80, blur: 0 }),
      newDropLayer({ angle: 0, distance: 500, blur: 0, visible: false }),
    ]);
    const f = shadowBounds({ x: 0, y: 0, w: 1000, h: 800 }, 1000, 800, s);
    expect(f.x).toBe(-57);
    expect(f.y).toBe(-57);
    expect(f.w).toBe(1000 + 57 + 36);
  });

  it('never grows by more than one image size per side', () => {
    const s = withLayers([newDropLayer({ distance: 500, blur: 200, spread: 100 })]);
    const f = shadowBounds({ x: 0, y: 0, w: 100, h: 100 }, 100, 100, s);
    expect(f.x).toBeGreaterThanOrEqual(-100);
    expect(f.x + f.w).toBeLessThanOrEqual(200);
    expect(f.y + f.h).toBeLessThanOrEqual(200);
  });
});

describe('renderShadow', () => {
  const frame = { x: 0, y: 0, w: 60, h: 60 };

  it('draws the mask in the layer colour at the layer opacity', () => {
    const a = square(60, 60, 20, 20, 20);
    const layer = newDropLayer({ distance: 0, blur: 0, opacity: 0.5, color: '#ff0000' });
    const b = renderShadow(a, 60, 60, 1, withLayers([layer]), frame);
    const [r, g, bl, alphaOut] = px(b, 30, 30);
    expect([r, g, bl]).toEqual([255, 0, 0]);
    expect(Math.abs(alphaOut - 127.5)).toBeLessThanOrEqual(1); // dithered between 127 and 128
    expect(px(b, 5, 5)[3]).toBe(0);
  });

  it('moves the shadow by the offset', () => {
    const a = square(60, 60, 10, 10, 10);
    const layer = newDropLayer({ angle: 135, distance: 10, blur: 0, opacity: 1 });
    const b = renderShadow(a, 60, 60, 1, withLayers([layer]), frame);
    // 10 * cos45 = 7.07 -> 7 px right and down
    expect(px(b, 12, 12)[3]).toBe(0);
    expect(px(b, 18, 18)[3]).toBe(255);
    expect(px(b, 28, 28)[3]).toBe(0); // the square now spans 17..26
  });

  it('places the shadow correctly when the frame starts left of and above the image', () => {
    const a = square(40, 40, 0, 0, 10);
    const layer = newDropLayer({ distance: 0, blur: 0, opacity: 1 });
    const big = { x: -10, y: -10, w: 60, h: 60 };
    const b = renderShadow(a, 40, 40, 1, withLayers([layer]), big);
    expect(px(b, 12, 12)[3]).toBe(255); // image (2,2)
    expect(px(b, 5, 5)[3]).toBe(0); // the margin
  });

  it('a shadow cast past the image edge is not clipped when the frame is large enough', () => {
    const a = square(40, 40, 28, 28, 12); // touches the bottom right
    const layer = newDropLayer({ angle: 135, distance: 20, blur: 0, opacity: 1 });
    const s = withLayers([layer]);
    const f = shadowBounds({ x: 28, y: 28, w: 12, h: 12 }, 40, 40, s);
    const b = renderShadow(a, 40, 40, 1, s, f);
    expect(f.w).toBeGreaterThan(40);
    const x = Math.round(36 + layerOffset(layer).dx) - f.x;
    expect(px(b, x, x)[3]).toBe(255);
  });

  it('blur softens edges but keeps the total amount of shadow', () => {
    const a = square(80, 80, 30, 30, 20);
    const hard = renderShadow(
      a,
      80,
      80,
      1,
      withLayers([newDropLayer({ distance: 0, blur: 0, opacity: 1 })]),
      { x: 0, y: 0, w: 80, h: 80 },
    );
    const soft = renderShadow(
      a,
      80,
      80,
      1,
      withLayers([newDropLayer({ distance: 0, blur: 16, opacity: 1 })]),
      { x: 0, y: 0, w: 80, h: 80 },
    );
    const sum = (b: { data: Uint8ClampedArray }) => {
      let t = 0;
      for (let i = 3; i < b.data.length; i += 4) t += b.data[i]!;
      return t;
    };
    expect(Math.abs(sum(soft) - sum(hard)) / sum(hard)).toBeLessThan(0.03);
    expect(px(soft, 29, 40)[3]).toBeGreaterThan(0); // spilled outside the square
    expect(px(soft, 29, 40)[3]).toBeLessThan(255);
    expect(px(soft, 40, 40)[3]).toBeGreaterThan(100);
  });

  it('spread grows and shrinks the shadow', () => {
    const a = square(80, 80, 30, 30, 20);
    const area = (spread: number) => {
      const b = renderShadow(
        a,
        80,
        80,
        1,
        withLayers([newDropLayer({ distance: 0, blur: 0, opacity: 1, spread })]),
        { x: 0, y: 0, w: 80, h: 80 },
      );
      let n = 0;
      for (let i = 3; i < b.data.length; i += 4) if (b.data[i]! > 0) n++;
      return n;
    };
    expect(area(0)).toBe(400);
    expect(area(5)).toBe(900); // a 20 px square grows to 30 px
    expect(area(-5)).toBe(100); // and shrinks to 10 px
  });

  it('stacks layers bottom to top with straight-alpha compositing', () => {
    const a = square(40, 40, 10, 10, 20);
    const b = renderShadow(
      a,
      40,
      40,
      1,
      withLayers([
        newDropLayer({ distance: 0, blur: 0, opacity: 0.5, color: '#ff0000' }),
        newDropLayer({ distance: 0, blur: 0, opacity: 0.5, color: '#0000ff' }),
      ]),
      { x: 0, y: 0, w: 40, h: 40 },
    );
    const [r, g, bl, al] = px(b, 20, 20);
    expect(al).toBe(191); // 1 - 0.5 * 0.5
    expect(g).toBe(0);
    expect(bl).toBeGreaterThan(r!); // the upper (blue) layer dominates
    expect(r).toBeGreaterThan(0);
  });

  it('hidden and fully transparent layers draw nothing', () => {
    const a = square(40, 40, 10, 10, 20);
    const b = renderShadow(
      a,
      40,
      40,
      1,
      withLayers([newDropLayer({ visible: false }), newDropLayer({ opacity: 0 })]),
      { x: 0, y: 0, w: 40, h: 40 },
    );
    expect([...b.data].every((v) => v === 0)).toBe(true);
  });

  it('works at a reduced proxy scale', () => {
    // A 20 px square in source px, rendered at half scale: 10 px in the proxy.
    const a = square(30, 30, 5, 5, 10);
    const b = renderShadow(
      a,
      30,
      30,
      0.5,
      withLayers([newDropLayer({ distance: 0, blur: 0, opacity: 1 })]),
      { x: 0, y: 0, w: 60, h: 60 },
    );
    expect(b.w).toBe(30);
    expect(px(b, 10, 10)[3]).toBe(255);
    expect(px(b, 2, 2)[3]).toBe(0);
  });
});

describe('contact and cast shadows', () => {
  const frame = { x: 0, y: 0, w: 80, h: 80 };
  const subject = { x: 20, y: 20, w: 20, h: 20 };
  const geom = { subject, ground: 40 };
  const mask = () => square(80, 80, 20, 20, 20);
  const run = (layers: ShadowLayer[], g = geom) =>
    renderShadow(mask(), 80, 80, 1, withLayers(layers), frame, g);

  it('the contact shadow sits just below the ground line, darkest where it touches', () => {
    const b = run([newContactLayer({ size: 10, softness: 0, opacity: 1 })]);
    expect(px(b, 30, 40)[3]).toBeGreaterThan(200);
    expect(px(b, 30, 42)[3]).toBeLessThan(px(b, 30, 40)[3]);
    expect(px(b, 30, 36)[3]).toBe(0); // nothing above the ground line
    expect(px(b, 30, 46)[3]).toBe(0); // and it is flat
    expect(px(b, 10, 40)[3]).toBe(0); // beside the subject
  });

  it('the contact shadow follows a manual ground line and the ground offset', () => {
    const up = run([newContactLayer({ size: 8, softness: 0, opacity: 1 })], {
      subject,
      ground: 30,
    });
    expect(px(up, 30, 30)[3]).toBeGreaterThan(200);
    expect(px(up, 30, 40)[3]).toBe(0);
    const down = run([newContactLayer({ size: 8, softness: 0, opacity: 1, groundOffset: 6 })]);
    expect(px(down, 30, 40)[3]).toBe(0);
    expect(px(down, 30, 46)[3]).toBeGreaterThan(200);
  });

  it('a cast shadow is the subject projected along the light', () => {
    // Light from the left (180 deg): the shadow runs right along the floor, as long as the subject is tall.
    const b = run([
      newCastLayer({
        angle: 180,
        elevation: 45,
        length: 1,
        squash: 1,
        falloff: 0,
        blur: 0,
        blurGrowth: 0,
        opacity: 1,
      }),
    ]);
    expect(px(b, 55, 40)[3]).toBe(255);
    expect(px(b, 62, 40)[3]).toBe(0);
    expect(px(b, 10, 40)[3]).toBe(0); // nothing on the light side
  });

  it('squash flattens the floor plane', () => {
    const cast = (squash: number) =>
      run([
        newCastLayer({
          angle: 90,
          elevation: 45,
          length: 1,
          squash,
          falloff: 0,
          blur: 0,
          blurGrowth: 0,
          opacity: 1,
        }),
      ]);
    expect(px(cast(0.5), 30, 45)[3]).toBe(255); // 20 px of subject -> 10 px of floor
    expect(px(cast(0.5), 30, 52)[3]).toBe(0);
    expect(px(cast(1), 30, 55)[3]).toBe(255);
  });

  it('falloff fades the far end; blur growth softens it', () => {
    const base = { angle: 180, elevation: 45, length: 1, squash: 1, blur: 0, opacity: 1 };
    const flat = run([newCastLayer({ ...base, falloff: 0, blurGrowth: 0 })]);
    const faded = run([newCastLayer({ ...base, falloff: 1, blurGrowth: 0 })]);
    expect(px(faded, 25, 40)[3]).toBeGreaterThan(px(faded, 55, 40)[3]);
    expect(px(flat, 55, 40)[3]).toBe(255);
    // The far end of a growing blur reaches beyond the hard edge of a sharp one.
    const sharp = run([newCastLayer({ ...base, falloff: 0, blurGrowth: 0 })]);
    const soft = run([newCastLayer({ ...base, falloff: 0, blurGrowth: 60 })]);
    expect(px(soft, 64, 40)[3]).toBeGreaterThan(px(sharp, 64, 40)[3]);
    // ... while the base stays as sharp as its own blur.
    expect(px(soft, 5, 40)[3]).toBe(0);
  });

  it('long, steep projections stay solid (no gaps between rows)', () => {
    const thin = new Uint8Array(80 * 80); // a 2 px wide pole, 30 tall
    for (let y = 10; y < 40; y++) for (let x = 30; x < 32; x++) thin[y * 80 + x] = 255;
    const b = renderShadow(
      thin,
      80,
      80,
      1,
      withLayers([
        newCastLayer({
          angle: 150,
          elevation: 20,
          length: 1,
          squash: 0.2,
          falloff: 0,
          blur: 0,
          blurGrowth: 0,
          opacity: 1,
        }),
      ]),
      { x: 0, y: 0, w: 80, h: 80 },
      { subject: { x: 30, y: 10, w: 2, h: 30 }, ground: 40 },
    );
    // Follow the shadow along the ground and make sure there is no break.
    const { sx, sy } = castVector(
      newCastLayer({ angle: 150, elevation: 20, length: 1, squash: 0.2 }),
    );
    let last = -1;
    for (let h = 1; h < 29; h++) {
      const x = Math.round(30 + sx * h);
      const y = Math.round(40 + sy * h);
      if (x >= 0 && x < 80 && y < 80) expect(px(b, x, y)[3], `h=${h}`).toBe(255);
      last = x;
    }
    expect(last).toBeGreaterThan(30);
  });

  it('without a ground line only the drop shadow is drawn', () => {
    const b = renderShadow(
      mask(),
      80,
      80,
      1,
      withLayers([newContactLayer(), newCastLayer()]),
      frame,
    );
    expect(b.data.every((v) => v === 0)).toBe(true);
  });

  it('layers composite bottom to top', () => {
    const red = newDropLayer({ distance: 0, blur: 0, opacity: 1, color: '#ff0000' });
    const blue = newDropLayer({ distance: 0, blur: 0, opacity: 1, color: '#0000ff' });
    const a = renderShadow(mask(), 80, 80, 1, withLayers([red, blue]), frame);
    const b = renderShadow(mask(), 80, 80, 1, withLayers([blue, red]), frame);
    expect(px(a, 30, 30)).toEqual([0, 0, 255, 255]);
    expect(px(b, 30, 30)).toEqual([255, 0, 0, 255]);
  });

  it('stacked soft layers never produce out-of-range or dark-fringed pixels', () => {
    const b = run([
      newContactLayer({ opacity: 1 }),
      newCastLayer({ opacity: 1, color: '#ff8800' }),
    ]);
    for (let i = 0; i < b.data.length; i += 4) {
      const a = b.data[i + 3]!;
      if (a === 0) expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([0, 0, 0]);
      else expect(b.data[i]).toBeGreaterThanOrEqual(0x2b - 1); // never darker than the darkest layer colour
    }
  });
});

describe('ground line, light and layer types', () => {
  it('detects the ground from the subject unless one is set', () => {
    const sub = { x: 0, y: 100, w: 50, h: 200 };
    expect(groundLine(sub, 1000, { groundY: null })).toBe(300);
    expect(groundLine(sub, 1000, { groundY: 0.92 })).toBe(920);
    expect(groundLine(null, 1000, { groundY: null })).toBeNull();
  });

  it('contact and cast need the ground; drop does not', () => {
    expect([newDropLayer(), newContactLayer(), newCastLayer()].map(usesGround)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('one light direction drives every layer that has one', () => {
    const s = withLayers([newDropLayer(), newContactLayer(), newCastLayer()], { presetId: 'x' });
    expect(lightAngle(s)).toBe(135);
    const t = withLightAngle(s, -45);
    expect(t.layers.map((l) => ('angle' in l ? l.angle : null))).toEqual([315, null, 315]);
    expect(t.presetId).toBeNull();
    expect(withLightAngle(s, 725).layers[0]).toMatchObject({ angle: 5 });
    expect(lightAngle(withLayers([newContactLayer()]))).toBeNull();
  });

  it('hidden layers do not set the light', () => {
    const s = withLayers([
      newDropLayer({ visible: false, angle: 10 }),
      newCastLayer({ angle: 200 }),
    ]);
    expect(lightAngle(s)).toBe(200);
  });

  it('cast length is limited so a grazing light cannot make an endless shadow', () => {
    const { sx } = castVector(newCastLayer({ angle: 180, elevation: 5, length: 2 }));
    expect(sx).toBeCloseTo(6, 5);
  });

  it('contact and cast layers survive a save and load, and are clamped', () => {
    const s = withLayers([newContactLayer({ size: 70 }), newCastLayer({ falloff: 0.2 })]);
    const saved = JSON.parse(JSON.stringify(shadowToPersisted(s)));
    const back = sanitizeShadow(saved)!;
    expect(shadowToPersisted(back)).toEqual(shadowToPersisted(s));
    const bad = sanitizeShadow({
      enabled: true,
      layers: [
        { type: 'contact', size: 1e9, softness: -4, groundOffset: 'x', opacity: 7, color: 'no' },
        {
          type: 'cast',
          elevation: 0,
          length: 99,
          squash: 0,
          falloff: 5,
          blur: 1e3,
          blurGrowth: NaN,
        },
      ],
    })!;
    expect(bad.layers[0]).toMatchObject({ size: 300, softness: 0, groundOffset: 0, opacity: 1 });
    expect(bad.layers[1]).toMatchObject({
      elevation: 5,
      length: 2,
      squash: 0.1,
      falloff: 1,
      blur: 100,
      blurGrowth: 40,
    });
  });

  it('cast and contact footprints grow the frame', () => {
    const subject = { x: 20, y: 20, w: 20, h: 20 };
    const cast = withLayers([
      newCastLayer({ angle: 180, elevation: 45, length: 1, squash: 1, blur: 0, blurGrowth: 0 }),
    ]);
    const f = shadowBounds(subject, 50, 50, cast);
    expect(f).toMatchObject({ x: 0, w: 60 });
    const contact = withLayers([newContactLayer({ size: 100, softness: 0, groundOffset: 20 })]);
    // ground 40 + offset 20 + 100 * 0.25 = 85
    expect(shadowBounds(subject, 50, 50, contact).h).toBe(85);
    // A manual ground line moves the footprint with it.
    const low = shadowBounds(subject, 50, 50, { ...contact, groundY: 0.9 });
    expect(low.h).toBe(45 + 20 + 25);
  });
});

describe('reflection', () => {
  const frame = { x: 0, y: 0, w: 60, h: 100 };
  const subject = { x: 20, y: 10, w: 20, h: 30 };
  const geom = { subject, ground: 40 };
  const alpha = () => {
    const a = new Uint8Array(60 * 100); // a 20 x 30 block standing on the ground line (y = 40)
    for (let y = 10; y < 40; y++) for (let x = 20; x < 40; x++) a[y * 60 + x] = 255;
    return a;
  };
  // a 20 x 30 block; its colour is red above, so a flipped copy is visibly red
  const rgba = () => {
    const d = new Uint8ClampedArray(60 * 100 * 4);
    for (let i = 0; i < 60 * 100; i++) d.set([200, 40, 40, 255], i * 4);
    return { data: d };
  };
  const run = (layer: ReturnType<typeof newReflectionLayer>, g: typeof geom | null = geom) =>
    renderShadow(alpha(), 60, 100, 1, withLayers([layer]), frame, g, rgba());

  it('is the subject flipped under the ground line, in its own colours, fading out', () => {
    const b = run(newReflectionLayer({ gap: 4, fade: 20, blur: 0, opacity: 1 }));
    expect(px(b, 30, 40)[3]).toBe(0); // the gap
    const near = px(b, 30, 46);
    expect(near[3]).toBeGreaterThan(230);
    expect([near[0], near[1], near[2]]).toEqual([200, 40, 40]);
    expect(px(b, 30, 60)[3]).toBeLessThan(near[3] / 4); // fading
    expect(px(b, 30, 66)[3]).toBe(0); // beyond the fade length
    expect(px(b, 5, 46)[3]).toBe(0);
  });

  it('opacity scales it and blur softens the edges without fringes', () => {
    const half = run(newReflectionLayer({ gap: 0, fade: 20, blur: 0, opacity: 0.5 }));
    expect(px(half, 30, 41)[3]).toBeLessThan(135);
    const soft = run(newReflectionLayer({ gap: 0, fade: 20, blur: 8, opacity: 1 }));
    const edge = px(soft, 20, 43); // left edge of the reflection
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(200);
    // Not darkened: within rounding of the subject's colour.
    expect(Math.abs(edge[0] - 200)).toBeLessThanOrEqual(4);
    expect(Math.abs(edge[1] - 40)).toBeLessThanOrEqual(4);
  });

  it('needs the subject colours and a ground line', () => {
    const layer = newReflectionLayer();
    const none = renderShadow(alpha(), 60, 100, 1, withLayers([layer]), frame, geom, null);
    expect(none.data.every((v) => v === 0)).toBe(true);
    const noGround = renderShadow(alpha(), 60, 100, 1, withLayers([layer]), frame, null, rgba());
    expect(noGround.data.every((v) => v === 0)).toBe(true);
  });

  it('is clamped, saved and loaded, and grows the frame', () => {
    const bad = sanitizeShadow({
      enabled: true,
      layers: [{ type: 'reflection', gap: -3, fade: 1e9, blur: 'x', opacity: 4, color: 'ignored' }],
    })!;
    expect(bad.layers[0]).toMatchObject({ gap: 0, fade: 1000, blur: 3, opacity: 1 });
    expect(bad.layers[0]).not.toHaveProperty('color');
    const s = withLayers([newReflectionLayer({ gap: 10, fade: 100, blur: 0 })]);
    const back = sanitizeShadow(JSON.parse(JSON.stringify(shadowToPersisted(s))))!;
    expect(shadowToPersisted(back)).toEqual(shadowToPersisted(s));
    // subject 20..40 x 10..40 (ground 40) in a 60 x 50 image: gap 10 + min(fade, height 30)
    const f = shadowBounds(subject, 60, 50, s);
    expect(f.h).toBe(80);
    expect(usesGround(s.layers[0]!)).toBe(true);
    expect(lightAngle(s)).toBeNull();
  });
});

describe('linear light and dither', () => {
  const frame = { x: 0, y: 0, w: 40, h: 40 };
  const a = () => square(40, 40, 10, 10, 20);

  it('blends overlapping coloured layers in linear light when asked', () => {
    const red = newDropLayer({ distance: 0, blur: 0, opacity: 0.5, color: '#ff0000' });
    const blue = newDropLayer({ distance: 0, blur: 0, opacity: 0.5, color: '#0000ff' });
    const gamma = renderShadow(a(), 40, 40, 1, withLayers([red, blue]), frame);
    const lin = renderShadow(a(), 40, 40, 1, withLayers([red, blue], { linearLight: true }), frame);
    // Same coverage either way; only the colour mix differs, and linear is the brighter mix.
    expect(px(lin, 20, 20)[3]).toBe(px(gamma, 20, 20)[3]);
    expect(px(lin, 20, 20)[0]).toBeGreaterThan(px(gamma, 20, 20)[0]);
    // A single layer is unchanged by the colour space.
    const one = withLayers([red], { linearLight: true });
    expect(px(renderShadow(a(), 40, 40, 1, one, frame), 20, 20).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('toLinear and fromLinear are inverses and keep the ends', () => {
    expect(toLinear(0)).toBe(0);
    expect(toLinear(255)).toBeCloseTo(255, 6);
    for (const v of [1, 17, 64, 128, 200, 254]) expect(fromLinear(toLinear(v))).toBeCloseTo(v, 4);
    expect(toLinear(128)).toBeLessThan(128); // mid grey is darker in linear light
  });

  it('dither keeps the average of a flat soft shadow and breaks up banding', () => {
    // A constant 30% shadow over a big area: 76.5 never fits in 8 bits, the dither alternates.
    const big = new Uint8Array(64 * 64).fill(255);
    const l = newDropLayer({ distance: 0, blur: 0, opacity: 0.3 });
    const out = renderShadow(big, 64, 64, 1, withLayers([l]), { x: 0, y: 0, w: 64, h: 64 });
    const alphas = new Set<number>();
    let sum = 0;
    for (let i = 3; i < out.data.length; i += 4) {
      alphas.add(out.data[i]!);
      sum += out.data[i]!;
    }
    expect([...alphas].sort()).toEqual([76, 77]);
    expect(sum / 4096).toBeCloseTo(76.5, 0);
  });

  it('dither never changes fully clear or fully solid pixels', () => {
    const b = renderShadow(
      a(),
      40,
      40,
      1,
      withLayers([newDropLayer({ distance: 0, blur: 0, opacity: 1 })]),
      frame,
    );
    expect(px(b, 20, 20)[3]).toBe(255);
    expect(px(b, 2, 2)[3]).toBe(0);
  });

  it('is saved and loaded', () => {
    const s = withLayers([newDropLayer()], { linearLight: true });
    expect(sanitizeShadow(JSON.parse(JSON.stringify(shadowToPersisted(s))))!.linearLight).toBe(
      true,
    );
    expect(sanitizeShadow({ enabled: true, layers: [] })!.linearLight).toBe(false);
    expect(sanitizeShadow({ enabled: true, linearLight: 'yes', layers: [] })!.linearLight).toBe(
      false,
    );
  });
});

/** The same cases run in src-tauri/src/services/shadow_tests.rs: preview and export agree. */
describe('shadowBounds matches the shared fixture', () => {
  const cases = JSON.parse(fixtureText) as {
    name: string;
    src: [number, number];
    subject: { x: number; y: number; w: number; h: number } | null;
    shadow: unknown;
    expected: { x: number; y: number; w: number; h: number };
  }[];

  it('has the expected number of cases', () => expect(cases.length).toBeGreaterThanOrEqual(10));

  for (const c of cases) {
    it(c.name, () => {
      const shadow = sanitizeShadow(c.shadow);
      expect(shadowBounds(c.subject, c.src[0], c.src[1], shadow)).toEqual(c.expected);
    });
  }
});

/**
 * The pixel fixture: the Rust export renderer draws the same cases and must land within one
 * level of these bytes (src-tauri/src/services/shadow_render_tests.rs).
 * Regenerate with `UPDATE_SHADOW_FIXTURE=1 npx vitest run src/canvas/shadow.test.ts`.
 */
describe('renderShadow matches the shared pixel fixture', () => {
  interface Case {
    name: string;
    size: [number, number];
    shape:
      | { kind: 'rect'; x: number; y: number; w: number; h: number }
      | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };
    shadow: unknown;
    expected?: string;
    frame?: { x: number; y: number; w: number; h: number };
  }
  const cases = JSON.parse(renderFixtureText) as Case[];

  /** The subject colours: a repeatable pattern so reflections have something to show. */
  const colourAt = (x: number, y: number) => [(x * 5) % 256, (y * 7) % 256, 128];

  function draw(c: Case) {
    const [w, h] = c.size;
    const alpha = new Uint8Array(w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = c.shape;
        const inside =
          s.kind === 'rect'
            ? x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
            : ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1;
        const i = y * w + x;
        alpha[i] = inside ? 255 : 0;
        const [r, g, b] = colourAt(x, y);
        rgba.set([r!, g!, b!, alpha[i]!], i * 4);
      }
    }
    const shadow = sanitizeShadow(c.shadow)!;
    const b = alphaBounds(alpha, w, h)!;
    const subject = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
    const frame = shadowBounds(subject, w, h, shadow);
    const ground = groundLine(subject, h, shadow)!;
    const out = renderShadow(alpha, w, h, 1, shadow, frame, { subject, ground }, { data: rgba });
    return { frame, out };
  }

  const b64 = (d: Uint8ClampedArray) =>
    Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('base64');

  if (process.env.UPDATE_SHADOW_FIXTURE) {
    it('writes the fixture', async () => {
      const { writeFileSync } = await import('node:fs');
      for (const c of cases) {
        const { frame, out } = draw(c);
        c.frame = frame;
        c.expected = b64(out.data);
      }
      writeFileSync(
        'src-tauri/tests/fixtures/shadow_render.json',
        JSON.stringify(cases, null, 2) + '\n',
      );
    });
    return;
  }

  for (const c of cases) {
    it(c.name, () => {
      const { frame, out } = draw(c);
      expect(frame).toEqual(c.frame);
      expect(b64(out.data)).toBe(c.expected);
      expect(out.data.some((v) => v !== 0)).toBe(true);
    });
  }
});

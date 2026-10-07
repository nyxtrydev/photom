//! Pixel renderer for shadows, a line-for-line mirror of `renderShadow` in `src/canvas/shadow.ts`.
//!
//! The editor draws on a downscaled proxy; export runs this at scale 1.0 on the full-resolution
//! alpha. Both use the same integer blur and morphology (`maskops`), the same rounding (JS
//! `Math.round`) and the same layer maths, and `tests/fixtures/shadow_render.json` keeps them
//! within one level of each other.

use rayon::prelude::*;

use super::maskops::{gaussian_blur, js_round, morph};
use super::shadow::{
    CastLayer, ContactLayer, DropLayer, Frame, Layer, ReflectionLayer, ShadowParams, CONTACT_SQUASH,
};
use crate::models::error::{AppError, AppResult};

/// Largest shadow canvas we will render (pixels). Keeps memory bounded on huge images.
pub const MAX_FRAME_PIXELS: u64 = 160_000_000;

/// The subject's box and the ground line in source px.
#[derive(Debug, Clone, Copy)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub ground: f64,
}

/// Straight (non-premultiplied) RGBA covering the frame.
pub struct Bitmap {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

/// 4 x 4 ordered-dither thresholds, identical to the editor's table.
const BAYER4: [u8; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/// sRGB (0..255) -> linear light on the same scale, and back (mirrors `toLinear`/`fromLinear`).
fn to_linear(c: f64) -> f64 {
    let v = c.clamp(0.0, 255.0) / 255.0;
    255.0
        * if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
}

fn from_linear(c: f64) -> f64 {
    let v = c.clamp(0.0, 255.0) / 255.0;
    255.0
        * if v <= 0.003_130_8 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
}

struct Plane {
    w: usize,
    h: usize,
    origin_x: i64,
    origin_y: i64,
    scale: f64,
}

fn rnd(v: f64) -> i64 {
    js_round(v) as i64
}

fn drop_plane(alpha: &[u8], aw: usize, ah: usize, p: &Plane, l: &DropLayer) -> Vec<u8> {
    let (fw, fh) = (p.w as i64, p.h as i64);
    let (dx, dy) = l.offset();
    let mut plane = vec![0u8; p.w * p.h];
    let px = p.origin_x + rnd(dx * p.scale);
    let py = p.origin_y + rnd(dy * p.scale);
    for y in 0..ah as i64 {
        let ty = y + py;
        if ty < 0 || ty >= fh {
            continue;
        }
        for x in 0..aw as i64 {
            let tx = x + px;
            if tx >= 0 && tx < fw {
                plane[(ty * fw + tx) as usize] = alpha[y as usize * aw + x as usize];
            }
        }
    }
    let spread_px = rnd(l.spread.abs() * p.scale);
    if spread_px > 0 {
        plane = morph(&plane, p.w, p.h, spread_px as f64, l.spread > 0.0);
    }
    let sigma = l.sigma() * p.scale;
    if sigma >= 0.5 {
        plane = gaussian_blur(&plane, p.w, p.h, sigma);
    }
    plane
}

fn contact_plane(
    alpha: &[u8],
    aw: usize,
    ah: usize,
    p: &Plane,
    l: &ContactLayer,
    g: &Geometry,
) -> Vec<u8> {
    let (fw, fh) = (p.w as i64, p.h as i64);
    let mut plane = vec![0u8; p.w * p.h];
    let ground_p = g.ground * p.scale;
    let band = (l.size * p.scale).max(1.0);
    let offset = l.ground_offset * p.scale;
    let y0 = ((ground_p - band).floor() as i64).max(0);
    let y1 = (ah as i64).min(ground_p.ceil() as i64);
    for y in y0..y1 {
        let h = ground_p - (y as f64 + 0.5);
        if h <= 0.0 || h > band {
            continue;
        }
        let weight = 1.0 - h / band;
        let ty = p.origin_y + rnd(ground_p + offset + h * CONTACT_SQUASH);
        if ty < 0 || ty >= fh {
            continue;
        }
        for x in 0..aw {
            let v = rnd(alpha[y as usize * aw + x] as f64 * weight) as u8;
            let tx = x as i64 + p.origin_x;
            if v > 0 && tx >= 0 && tx < fw {
                let idx = (ty * fw + tx) as usize;
                if v > plane[idx] {
                    plane[idx] = v;
                }
            }
        }
    }
    let sigma = (l.softness / 2.0) * p.scale;
    if sigma >= 0.5 {
        plane = gaussian_blur(&plane, p.w, p.h, sigma);
    }
    plane
}

fn cast_plane(
    alpha: &[u8],
    aw: usize,
    ah: usize,
    p: &Plane,
    l: &CastLayer,
    g: &Geometry,
) -> Vec<u8> {
    let (fw, fh) = (p.w as i64, p.h as i64);
    let sigmas = l.sigmas();
    let levels = sigmas.len();
    let mut planes: Vec<Vec<u8>> = sigmas.iter().map(|_| vec![0u8; p.w * p.h]).collect();
    let (sx, sy) = l.vector();
    let ground_p = g.ground * p.scale;
    let height = (g.ground - g.y).max(1.0) * p.scale;
    let y0 = ((ground_p - height).floor() as i64).max(0);
    let y1 = (ah as i64).min(ground_p.ceil() as i64);
    for y in y0..y1 {
        let h0 = ground_p - (y as f64 + 1.0);
        let h1 = ground_p - y as f64;
        if h1 <= 0.0 {
            continue;
        }
        let steps = ((sx.abs().max(sy.abs()) * (h1 - h0)).ceil() as i64).max(1);
        for k in 0..steps {
            let h = (h0 + ((k as f64 + 0.5) / steps as f64) * (h1 - h0)).max(0.0);
            let t = (h / height).min(1.0);
            let weight = 1.0 - l.falloff * t;
            let ty = p.origin_y + rnd(ground_p + sy * h);
            if ty < 0 || ty >= fh {
                continue;
            }
            let shift = p.origin_x + rnd(sx * h);
            let pos = t * (levels - 1) as f64;
            let i0 = (levels - 1).min(pos.floor() as usize);
            let frac = pos - i0 as f64;
            for x in 0..aw {
                let a = alpha[y as usize * aw + x];
                let tx = x as i64 + shift;
                if a == 0 || tx < 0 || tx >= fw {
                    continue;
                }
                let idx = (ty * fw + tx) as usize;
                let lo_w = if levels == 1 { 1.0 } else { 1.0 - frac };
                let lo = rnd(a as f64 * weight * lo_w) as u8;
                if lo > planes[i0][idx] {
                    planes[i0][idx] = lo;
                }
                if levels > 1 && frac > 0.0 {
                    let hi = rnd(a as f64 * weight * frac) as u8;
                    if hi > planes[i0 + 1][idx] {
                        planes[i0 + 1][idx] = hi;
                    }
                }
            }
        }
    }
    // The levels are independent, so they are blurred in parallel and then summed.
    let blurred: Vec<Vec<u8>> = planes
        .into_par_iter()
        .zip(sigmas)
        .map(|(plane, sigma)| {
            let sigma = sigma * p.scale;
            if sigma >= 0.5 {
                gaussian_blur(&plane, p.w, p.h, sigma)
            } else {
                plane
            }
        })
        .collect();
    let mut out = vec![0u8; p.w * p.h];
    for b in blurred {
        out.par_iter_mut()
            .zip(b.par_iter())
            .for_each(|(o, b)| *o = o.saturating_add(*b));
    }
    out
}

/// Premultiplied colour planes and alpha of a reflection.
struct Reflection {
    r: Vec<u8>,
    g: Vec<u8>,
    b: Vec<u8>,
    a: Vec<u8>,
}

fn reflection_planes(
    alpha: &[u8],
    rgba: &[u8],
    aw: usize,
    ah: usize,
    p: &Plane,
    l: &ReflectionLayer,
    g: &Geometry,
) -> Reflection {
    let (fw, fh) = (p.w as i64, p.h as i64);
    let n = p.w * p.h;
    let mut out = Reflection {
        r: vec![0; n],
        g: vec![0; n],
        b: vec![0; n],
        a: vec![0; n],
    };
    let ground_p = g.ground * p.scale;
    let fade = (l.fade * p.scale).max(1.0);
    let gap = l.gap * p.scale;
    let y0 = ((ground_p - fade).floor() as i64).max(0);
    let y1 = (ah as i64).min(ground_p.ceil() as i64);
    for y in y0..y1 {
        let h = ground_p - (y as f64 + 0.5);
        if h <= 0.0 || h > fade {
            continue;
        }
        let weight = 1.0 - h / fade;
        let ty = p.origin_y + rnd(ground_p + gap + h);
        if ty < 0 || ty >= fh {
            continue;
        }
        for x in 0..aw {
            let i = y as usize * aw + x;
            let a = rnd(alpha[i] as f64 * weight) as u8;
            let tx = x as i64 + p.origin_x;
            if a == 0 || tx < 0 || tx >= fw {
                continue;
            }
            let j = (ty * fw + tx) as usize;
            out.a[j] = a;
            let pm = |c: u8| rnd(c as f64 * a as f64 / 255.0) as u8;
            out.r[j] = pm(rgba[i * 4]);
            out.g[j] = pm(rgba[i * 4 + 1]);
            out.b[j] = pm(rgba[i * 4 + 2]);
        }
    }
    let sigma = l.sigma() * p.scale;
    if sigma >= 0.5 {
        let (w, h) = (p.w, p.h);
        let blur = |v: &Vec<u8>| gaussian_blur(v, w, h, sigma);
        let ((a, r), (g, b)) = rayon::join(
            || rayon::join(|| blur(&out.a), || blur(&out.r)),
            || rayon::join(|| blur(&out.g), || blur(&out.b)),
        );
        out = Reflection { r, g, b, a };
    }
    out
}

/// Render the visible layers into straight RGBA covering `frame`.
///
/// `alpha` is the subject mask at `scale` pixels per source pixel (`aw` x `ah`); `rgba` is the
/// subject's colours at the same size (only reflections read it). Without `geom` only drop layers
/// are drawn. Layers composite bottom to top with straight-alpha "over".
#[allow(clippy::too_many_arguments)]
pub fn render(
    alpha: &[u8],
    aw: usize,
    ah: usize,
    scale: f64,
    params: &ShadowParams,
    frame: Frame,
    geom: Option<&Geometry>,
    rgba: Option<&[u8]>,
) -> AppResult<Bitmap> {
    let fw = ((frame.w as f64 * scale).ceil() as usize).max(1);
    let fh = ((frame.h as f64 * scale).ceil() as usize).max(1);
    if (fw as u64) * (fh as u64) > MAX_FRAME_PIXELS {
        return Err(AppError::ExportFailed(
            "The shadow makes this image too large to render. Reduce the shadow size, or turn off Auto expand canvas."
                .into(),
        ));
    }
    let n = fw * fh;
    let mut oa = vec![0f32; n];
    let mut or = vec![0f32; n];
    let mut og = vec![0f32; n];
    let mut ob = vec![0f32; n];
    let p = Plane {
        w: fw,
        h: fh,
        origin_x: rnd(-(frame.x as f64) * scale),
        origin_y: rnd(-(frame.y as f64) * scale),
        scale,
    };

    let linear = params.linear_light;
    let lin = |c: f64| if linear { to_linear(c) } else { c };
    for layer in params.layers.iter().filter(|l| l.drawable()) {
        if let Layer::Reflection(l) = layer {
            let (Some(g), Some(px)) = (geom, rgba) else {
                continue;
            };
            let r = reflection_planes(alpha, px, aw, ah, &p, l, g);
            let opacity = l.opacity as f32;
            oa.par_iter_mut()
                .zip(or.par_iter_mut())
                .zip(og.par_iter_mut())
                .zip(ob.par_iter_mut())
                .enumerate()
                .for_each(|(i, (((oa, or), og), ob))| {
                    let pa = r.a[i];
                    if pa == 0 {
                        return;
                    }
                    let a = (pa as f32 / 255.0) * opacity;
                    let keep = 1.0 - a;
                    let pa = pa as f64;
                    let c = |v: u8| lin(v as f64 * 255.0 / pa) as f32;
                    *or = c(r.r[i]) * a + *or * keep;
                    *og = c(r.g[i]) * a + *og * keep;
                    *ob = c(r.b[i]) * a + *ob * keep;
                    *oa = a + *oa * keep;
                });
            continue;
        }
        let (plane, [r, g, b], opacity) = match layer {
            Layer::Drop(l) => (drop_plane(alpha, aw, ah, &p, l), l.rgb(), l.opacity),
            Layer::Contact(l) => match geom {
                Some(gm) => (contact_plane(alpha, aw, ah, &p, l, gm), l.rgb(), l.opacity),
                None => continue,
            },
            Layer::Cast(l) => match geom {
                Some(gm) => (cast_plane(alpha, aw, ah, &p, l, gm), l.rgb(), l.opacity),
                None => continue,
            },
            Layer::Reflection(_) => continue,
        };
        let (r, g, b) = (
            lin(r as f64) as f32,
            lin(g as f64) as f32,
            lin(b as f64) as f32,
        );
        let opacity = opacity as f32;
        oa.par_iter_mut()
            .zip(or.par_iter_mut())
            .zip(og.par_iter_mut())
            .zip(ob.par_iter_mut())
            .zip(plane.par_iter())
            .for_each(|((((oa, or), og), ob), pl)| {
                let a = (*pl as f32 / 255.0) * opacity;
                if a <= 0.0 {
                    return;
                }
                let keep = 1.0 - a;
                *or = r * a + *or * keep;
                *og = g * a + *og * keep;
                *ob = b * a + *ob * keep;
                *oa = a + *oa * keep;
            });
    }

    // Straight colour, back to sRGB, and the alpha dithered so soft gradients do not band.
    let mut data = vec![0u8; n * 4];
    data.par_chunks_mut(4).enumerate().for_each(|(i, px)| {
        let a = oa[i];
        if a <= 0.0 {
            return;
        }
        let out = |c: f32| {
            let v = c as f64 / a as f64;
            (if linear { from_linear(v) } else { v })
                .round()
                .clamp(0.0, 255.0) as u8
        };
        px[0] = out(or[i]);
        px[1] = out(og[i]);
        px[2] = out(ob[i]);
        let t = (BAYER4[(((i / fw) & 3) << 2) | ((i % fw) & 3)] as f32 + 0.5) / 16.0;
        px[3] = (a * 255.0 + t).floor().clamp(0.0, 255.0) as u8;
    });
    Ok(Bitmap { w: fw, h: fh, data })
}

/// Box of the pixels with alpha above `threshold` (the editor uses 8), or `None`.
pub fn alpha_bounds(alpha: &[u8], w: usize, h: usize, threshold: u8) -> Option<Frame> {
    let (mut x0, mut y0, mut x1, mut y1) = (w as i64, h as i64, -1i64, -1i64);
    for y in 0..h {
        let row = &alpha[y * w..(y + 1) * w];
        if let Some(first) = row.iter().position(|&a| a > threshold) {
            let last = row.iter().rposition(|&a| a > threshold).unwrap_or(first);
            x0 = x0.min(first as i64);
            x1 = x1.max(last as i64);
            y0 = y0.min(y as i64);
            y1 = y1.max(y as i64);
        }
    }
    (x1 >= 0).then_some(Frame {
        x: x0,
        y: y0,
        w: x1 + 1 - x0,
        h: y1 + 1 - y0,
    })
}

#[cfg(test)]
#[path = "shadow_render_tests.rs"]
mod tests;

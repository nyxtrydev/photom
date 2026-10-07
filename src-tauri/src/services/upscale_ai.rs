//! AI upscaling by tiles. The model takes a fixed square tile; the image is cut into overlapping
//! tiles, each is upscaled, and the results are blended with a feathered weight so no seam shows.
//!
//! The tiling and blending know nothing about ONNX: they take the model as a closure, so they are
//! tested with a stand-in "model" (nearest-neighbour enlargement) and no model file.

use image::{Rgba, RgbaImage};

use super::exporter::resize_rgba;
use crate::models::error::{AppError, AppResult};

/// Side of the square the model takes (matches the catalog's `inputSize`).
pub const TILE: u32 = 256;
/// Input pixels shared by neighbouring tiles; the blend ramp spans exactly this many.
pub const OVERLAP: u32 = 16;
/// Mirror padding around the whole image so its borders get context too (input pixels).
pub const PAD: u32 = 8;

/// Bytes per model-scale output pixel while tiles are blended: three f32 sums plus one f32 weight.
pub const ACCUM_BYTES_PER_PX: f64 = 16.0;
/// Seconds one tile takes on the CPU is about this times scale squared (measured with the bundled
/// models on a loaded Apple-silicon Mac: 3.7 s at 2x, 12 s at 4x; a GPU or a quiet machine is faster).
pub const SECONDS_PER_TILE_PER_SCALE_SQ: f64 = 0.8;

/// Start of every tile along an axis of `len` input pixels (after padding): tiles `tile` wide,
/// neighbours overlapping by at least `overlap`, the last one clamped to end exactly at the edge.
pub fn tile_starts(len: u32, tile: u32, overlap: u32) -> Vec<u32> {
    if len <= tile {
        return vec![0];
    }
    let step = tile.saturating_sub(overlap).max(1);
    let last = len - tile;
    let mut v: Vec<u32> = (0..).map(|i| i * step).take_while(|s| *s < last).collect();
    v.push(last);
    v
}

/// Number of tiles an image needs (for progress and the time estimate).
pub fn tile_count(w: u32, h: u32) -> u32 {
    let n = |l: u32| tile_starts(l + 2 * PAD, TILE, OVERLAP).len() as u32;
    n(w) * n(h)
}

/// Blend weight along one axis of an upscaled tile: a ramp up over the overlap on a side that has
/// a neighbour, flat 1 on a side that is the edge of the image. Never zero, so every pixel is
/// covered by at least one positive weight.
pub fn axis_weights(size: u32, ramp: u32, has_before: bool, has_after: bool) -> Vec<f32> {
    (0..size)
        .map(|u| {
            let mut w = 1.0f32;
            if has_before && u < ramp {
                w = w.min((u as f32 + 0.5) / ramp as f32);
            }
            if has_after && size - 1 - u < ramp {
                w = w.min(((size - 1 - u) as f32 + 0.5) / ramp as f32);
            }
            w
        })
        .collect()
}

/// Mirror an index into `0..len` (edge pixel not repeated), for any distance outside.
fn reflect(i: i64, len: u32) -> u32 {
    if len <= 1 {
        return 0;
    }
    let period = 2 * (i64::from(len) - 1);
    let m = i.rem_euclid(period);
    (if m < i64::from(len) { m } else { period - m }) as u32
}

pub struct TileHooks<'a> {
    /// True once the user cancelled; checked before every tile.
    pub cancelled: &'a dyn Fn() -> bool,
    /// Called after each tile with (done, total).
    pub progress: &'a dyn Fn(u32, u32),
}

/// Upscale the colour of `src` by `scale` through `model`. `model` gets a `3 x TILE x TILE` tile
/// (channel-first, 0..1) and returns `3 x TILE*scale x TILE*scale` (0..1). The result is opaque.
pub fn upscale_tiled(
    src: &RgbaImage,
    scale: u32,
    model: &mut dyn FnMut(&[f32]) -> AppResult<Vec<f32>>,
    hooks: &TileHooks,
) -> AppResult<RgbaImage> {
    let (w, h) = src.dimensions();
    let (ow, oh) = (w * scale, h * scale);
    let (tw, th) = (TILE as usize, TILE as usize);
    let out_tile = (TILE * scale) as usize;
    let xs = tile_starts(w + 2 * PAD, TILE, OVERLAP);
    let ys = tile_starts(h + 2 * PAD, TILE, OVERLAP);
    let total = (xs.len() * ys.len()) as u32;
    let ramp = OVERLAP * scale;

    let n_out = ow as usize * oh as usize;
    let mut acc = vec![0f32; n_out * 3];
    let mut wsum = vec![0f32; n_out];
    let mut input = vec![0f32; 3 * tw * th];
    let mut done = 0u32;

    for (yi, &y0) in ys.iter().enumerate() {
        let wy = axis_weights(out_tile as u32, ramp, yi > 0, yi + 1 < ys.len());
        for (xi, &x0) in xs.iter().enumerate() {
            if (hooks.cancelled)() {
                return Err(AppError::Cancelled);
            }
            for ty in 0..th {
                let sy = reflect(i64::from(y0) + ty as i64 - i64::from(PAD), h);
                for tx in 0..tw {
                    let sx = reflect(i64::from(x0) + tx as i64 - i64::from(PAD), w);
                    let p = src.get_pixel(sx, sy);
                    for c in 0..3 {
                        input[c * tw * th + ty * tw + tx] = f32::from(p[c]) / 255.0;
                    }
                }
            }
            let out = model(&input)?;
            if out.len() != 3 * out_tile * out_tile {
                return Err(AppError::Inference(format!(
                    "the model returned {} values for a {scale}x tile, expected {}",
                    out.len(),
                    3 * out_tile * out_tile
                )));
            }
            let wx = axis_weights(out_tile as u32, ramp, xi > 0, xi + 1 < xs.len());
            // Output coordinates of this tile's origin in the padded, upscaled image.
            let ox0 = i64::from(x0) * i64::from(scale) - i64::from(PAD * scale);
            let oy0 = i64::from(y0) * i64::from(scale) - i64::from(PAD * scale);
            for uy in 0..out_tile {
                let gy = oy0 + uy as i64;
                if gy < 0 || gy >= i64::from(oh) {
                    continue;
                }
                for ux in 0..out_tile {
                    let gx = ox0 + ux as i64;
                    if gx < 0 || gx >= i64::from(ow) {
                        continue;
                    }
                    let wgt = wx[ux] * wy[uy];
                    let o = gy as usize * ow as usize + gx as usize;
                    for c in 0..3 {
                        acc[o * 3 + c] += out[c * out_tile * out_tile + uy * out_tile + ux] * wgt;
                    }
                    wsum[o] += wgt;
                }
            }
            done += 1;
            (hooks.progress)(done, total);
        }
    }

    let mut img = RgbaImage::new(ow, oh);
    for (i, p) in img.pixels_mut().enumerate() {
        let wt = wsum[i].max(f32::MIN_POSITIVE);
        let q = |c: usize| ((acc[i * 3 + c] / wt).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        *p = Rgba([q(0), q(1), q(2), 255]);
    }
    Ok(img)
}

/// The whole AI path for one image: transparency is kept out of the model (it only sees colour),
/// the colour is upscaled by tiles, then resized to the exact target when that differs from the
/// model's scale, and the alpha is resized on its own and put back.
pub fn upscale_ai(
    src: &RgbaImage,
    out: (u32, u32),
    scale: u32,
    model: &mut dyn FnMut(&[f32]) -> AppResult<Vec<f32>>,
    hooks: &TileHooks,
) -> AppResult<RgbaImage> {
    let has_alpha = src.pixels().any(|p| p[3] != 255);
    let colour = if has_alpha {
        let mut c = super::upscale::extend_edge_colours(src);
        c.pixels_mut().for_each(|p| p[3] = 255);
        c
    } else {
        src.clone()
    };
    let mut big = upscale_tiled(&colour, scale, model, hooks)?;
    drop(colour);
    if big.dimensions() != out {
        big = resize_rgba(&big, out)?;
    }
    if has_alpha {
        let mut alpha = RgbaImage::new(src.width(), src.height());
        for (a, s) in alpha.pixels_mut().zip(src.pixels()) {
            *a = Rgba([s[3], s[3], s[3], 255]);
        }
        let alpha = resize_rgba(&alpha, out)?;
        for (p, a) in big.pixels_mut().zip(alpha.pixels()) {
            p[3] = a[0];
            if a[0] == 0 {
                *p = Rgba([0, 0, 0, 0]);
            }
        }
    }
    Ok(big)
}

/// Peak memory (MB) the AI path needs for `src` -> `out` at model scale `scale`.
pub fn memory_mb(src: (u32, u32), out: (u32, u32), scale: u32) -> u64 {
    let model_px = f64::from(src.0 * scale) * f64::from(src.1 * scale);
    let out_px = f64::from(out.0) * f64::from(out.1);
    let in_px = f64::from(src.0) * f64::from(src.1);
    // accumulators, the model-scale RGBA copy, the resized/final RGBA, and the source copies
    ((model_px * (ACCUM_BYTES_PER_PX + 4.0) + out_px * 8.0 + in_px * 12.0) / 1_000_000.0).ceil()
        as u64
}

/// Refuse a run that would not fit in the memory the machine has free. `None` = unknown (then the
/// pixel limit is the only guard).
pub fn check_memory(needed_mb: u64, available_mb: Option<u64>) -> AppResult<()> {
    match available_mb {
        Some(avail) if needed_mb * 10 > avail * 8 => Err(AppError::OutOfMemory(format!(
            "This upscale needs about {needed_mb} MB but only {avail} MB is free. Choose a smaller scale or target, or close other apps."
        ))),
        _ => Ok(()),
    }
}

/// Memory the machine has available, in MB, where the platform tells us cheaply.
pub fn available_memory_mb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = s
            .lines()
            .find(|l| l.starts_with("MemAvailable:"))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        return Some(kb / 1024);
    }
    #[cfg(target_os = "macos")]
    {
        // Total memory: macOS reclaims cache freely, so this is the honest upper bound.
        let o = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&o.stdout).trim().parse().ok()?;
        return Some(bytes / 1_000_000);
    }
    #[allow(unreachable_code)]
    None
}

/// Run one tile through an ONNX session.
pub fn run_session(session: &mut ort::session::Session, tile: &[f32]) -> AppResult<Vec<f32>> {
    let err = |e: ort::Error| AppError::Inference(e.to_string());
    let name = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or_else(|| AppError::Inference("model has no inputs".into()))?;
    let s = TILE as usize;
    let input = ort::value::Tensor::from_array(([1usize, 3, s, s], tile.to_vec())).map_err(err)?;
    let outputs = session
        .run(ort::inputs![name.as_str() => input])
        .map_err(err)?;
    let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(err)?;
    Ok(data.to_vec())
}

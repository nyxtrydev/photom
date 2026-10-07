//! Image upscaling: output-size and estimate maths, the no-AI "Standard" upscaler, and the
//! store that keeps a result until the user decides to keep or discard it.
//!
//! Standard = Lanczos3 on premultiplied colour (so transparent edges stay clean) followed by a
//! mild unsharp mask. It needs no model. The AI path arrives in a later phase and reuses
//! `output_size` / `estimate` unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use super::exporter::resize_rgba;
use super::maskops::gaussian_blur;
use crate::models::error::{AppError, AppResult};

/// Scales the AI models provide (`upscale-x2`, `upscale-x4`).
pub const SCALES: [u32; 2] = [2, 4];
/// Longest side of any output.
pub const MAX_SIDE: u32 = 32_768;
/// An input at least this big on its longest side (or this many pixels) is "already high resolution".
pub const LARGE_SIDE: u32 = 3000;
pub const LARGE_PIXELS: u64 = 8_000_000;
/// Inputs smaller than this on a side are very small (results are mostly guesswork).
pub const TINY_SIDE: u32 = 64;

/// Seconds per output megapixel of the Standard path (resize + unsharp) on a typical laptop CPU.
const STANDARD_SECONDS_PER_MP: f64 = 0.07;
/// Bytes of working memory per output pixel for the Standard path (RGBA output, premultiplied
/// copy, and three blurred channel planes), and per input pixel.
const STANDARD_BYTES_PER_OUT_PX: f64 = 4.0 + 4.0 + 3.0 * 2.0;
const STANDARD_BYTES_PER_IN_PX: f64 = 8.0;

/// Unsharp mask of the Standard path: gentle, because Lanczos output is already crisp.
const SHARPEN_SIGMA: f64 = 1.0;
const SHARPEN_AMOUNT: f64 = 0.4;
/// Pixels fainter than this (of 255) are not sharpened.
const MIN_SHARPEN_ALPHA: u8 = 32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    /// Lanczos + unsharp, no model.
    #[default]
    Standard,
    /// Real-ESRGAN-class model from the Model Hub (not available yet).
    Ai,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetSize {
    pub width: u32,
    pub height: u32,
}

/// What the user asked for: a fixed scale, or an exact target size.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpscaleParams {
    pub scale: Option<u32>,
    pub target: Option<TargetSize>,
    pub engine: Engine,
    /// "Reduce artefacts": a light edge-preserving denoise before enlarging (JPEG blocking).
    pub pre_denoise: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    /// Stable id the UI can match on.
    pub code: String,
    pub message: String,
    /// A blocking warning means "Upscale" is refused.
    pub blocking: bool,
}

fn warn(code: &str, message: impl Into<String>, blocking: bool) -> Warning {
    Warning {
        code: code.into(),
        message: message.into(),
        blocking,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub out_w: u32,
    pub out_h: u32,
    pub megapixels: f64,
    pub eta_seconds: f64,
    pub memory_mb: u64,
    pub warnings: Vec<Warning>,
}

/// The exact output size for `src` under `params`. This is the one place the size is decided: the
/// estimate shows it and the upscaler produces it, so they cannot disagree.
pub fn output_size(src: (u32, u32), params: &UpscaleParams) -> AppResult<(u32, u32)> {
    if src.0 == 0 || src.1 == 0 {
        return Err(AppError::InvalidInput("the image has no pixels".into()));
    }
    let (w, h) = match (params.scale, params.target) {
        (_, Some(t)) => {
            if t.width == 0 || t.height == 0 {
                return Err(AppError::InvalidInput(
                    "The target size must be at least 1 x 1.".into(),
                ));
            }
            if t.width <= src.0 && t.height <= src.1 {
                return Err(AppError::InvalidInput(
                    "The target size must be larger than the image.".into(),
                ));
            }
            (t.width, t.height)
        }
        (Some(s), None) if SCALES.contains(&s) => {
            (src.0.saturating_mul(s), src.1.saturating_mul(s))
        }
        (Some(s), None) => {
            return Err(AppError::InvalidInput(format!(
                "Choose 2x or 4x (got {s}x)."
            )))
        }
        (None, None) => {
            return Err(AppError::InvalidInput(
                "Choose a scale or a target size.".into(),
            ))
        }
    };
    if w > MAX_SIDE || h > MAX_SIDE {
        return Err(AppError::InvalidInput(format!(
            "The result would be {w} x {h}; the longest side is limited to {MAX_SIDE} pixels."
        )));
    }
    Ok((w, h))
}

/// The scale the AI models would run at to reach `out` from `src`: the smallest of 2x / 4x that
/// covers the result (a later resize trims it to the exact size).
pub fn model_scale(src: (u32, u32), out: (u32, u32)) -> u32 {
    let need = (f64::from(out.0) / f64::from(src.0)).max(f64::from(out.1) / f64::from(src.1));
    if need <= 2.0 {
        2
    } else {
        4
    }
}

/// Output size, time and memory for a request, with the warnings the UI shows. `cap_mp` is the
/// largest result allowed (megapixels).
pub fn estimate(src: (u32, u32), params: &UpscaleParams, cap_mp: u32) -> AppResult<Estimate> {
    let mut warnings = Vec::new();
    let (out_w, out_h) = match output_size(src, params) {
        Ok(s) => s,
        // An oversized result is still reported, as a blocking warning with the size it would be.
        Err(AppError::InvalidInput(m)) if m.contains("longest side") => {
            warnings.push(warn("too-large-side", m, true));
            let s = params.scale.unwrap_or(2);
            let (w, h) = params
                .target
                .map(|t| (t.width, t.height))
                .unwrap_or((src.0.saturating_mul(s), src.1.saturating_mul(s)));
            (w, h)
        }
        Err(e) => return Err(e),
    };
    let out_px = u64::from(out_w) * u64::from(out_h);
    let in_px = u64::from(src.0) * u64::from(src.1);
    let megapixels = out_px as f64 / 1_000_000.0;
    let cap_px = u64::from(cap_mp) * 1_000_000;

    if out_px > cap_px {
        warnings.push(warn(
            "too-large",
            format!(
                "The result would be {megapixels:.1} MP; the limit is {cap_mp} MP. Choose a smaller scale or target, or raise the limit in Settings."
            ),
            true,
        ));
    } else if out_px * 2 > cap_px {
        warnings.push(warn(
            "large",
            format!("The result will be big ({megapixels:.1} MP) and may take a while."),
            false,
        ));
    }
    if src.0.max(src.1) >= LARGE_SIDE || in_px >= LARGE_PIXELS {
        warnings.push(warn(
            "already-large",
            "This image is already high resolution. Upscale anyway?",
            false,
        ));
    }
    if src.0.min(src.1) < TINY_SIDE {
        warnings.push(warn(
            "tiny",
            format!("This image is very small (under {TINY_SIDE} px on a side); the result will be soft."),
            false,
        ));
    }

    let memory_mb = ((out_px as f64 * STANDARD_BYTES_PER_OUT_PX
        + in_px as f64 * STANDARD_BYTES_PER_IN_PX)
        / 1_000_000.0)
        .ceil() as u64;
    let (memory_mb, eta_seconds) = if params.engine == Engine::Ai {
        let scale = model_scale(src, (out_w, out_h));
        (
            super::upscale_ai::memory_mb(src, (out_w, out_h), scale),
            (f64::from(super::upscale_ai::tile_count(src.0, src.1))
                * super::upscale_ai::SECONDS_PER_TILE_PER_SCALE_SQ
                * f64::from(scale * scale))
            .ceil(),
        )
    } else {
        (
            memory_mb,
            (megapixels * STANDARD_SECONDS_PER_MP * 10.0).ceil() / 10.0,
        )
    };
    Ok(Estimate {
        out_w,
        out_h,
        megapixels,
        eta_seconds,
        memory_mb,
        warnings,
    })
}

/// Refuse a request the estimate marks as blocking.
pub fn check_allowed(
    src: (u32, u32),
    params: &UpscaleParams,
    cap_mp: u32,
) -> AppResult<(u32, u32)> {
    let e = estimate(src, params, cap_mp)?;
    if let Some(w) = e.warnings.iter().find(|w| w.blocking) {
        return Err(AppError::InvalidInput(w.message.clone()));
    }
    Ok((e.out_w, e.out_h))
}

/// Unsharp mask on the colour channels: `c + amount * (c - blur(c))`, alpha untouched.
///
/// With transparency the blur must not mix in the colour hidden under clear pixels, or edges
/// overshoot to white/black. So the blur is taken on alpha-weighted colour and divided by the
/// blurred alpha (the colour the neighbourhood actually shows).
fn sharpen(img: &mut RgbaImage, sigma: f64, amount: f64) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let n = w * h;
    let raw = img.as_raw();
    let opaque = raw.chunks_exact(4).all(|p| p[3] == 255);
    let plane = |c: usize| -> Vec<u8> {
        (0..n)
            .map(|i| {
                let v = raw[i * 4 + c];
                if opaque {
                    v
                } else {
                    (u32::from(v) * u32::from(raw[i * 4 + 3]) / 255) as u8
                }
            })
            .collect()
    };
    let (r, g, b) = (plane(0), plane(1), plane(2));
    let alpha: Vec<u8> = (0..n).map(|i| raw[i * 4 + 3]).collect();
    let blur = |p: &Vec<u8>| gaussian_blur(p, w, h, sigma);
    let (((br, bg), bb), ba) = rayon::join(
        || rayon::join(|| rayon::join(|| blur(&r), || blur(&g)), || blur(&b)),
        || if opaque { Vec::new() } else { blur(&alpha) },
    );
    let blurred = [br, bg, bb];
    let data: &mut [u8] = img;
    for i in 0..n {
        let a = data[i * 4 + 3];
        // Faint edge pixels carry too little information in 8 bits to sharpen reliably, and
        // are nearly invisible anyway; leave them as the resize made them.
        if a < MIN_SHARPEN_ALPHA {
            continue;
        }
        for (c, plane) in blurred.iter().enumerate() {
            let o = f64::from(data[i * 4 + c]);
            // The colour the surroundings show at this pixel.
            let around = if opaque {
                f64::from(plane[i])
            } else if ba[i] == 0 {
                o
            } else {
                (f64::from(plane[i]) * 255.0 / f64::from(ba[i])).min(255.0)
            };
            let v = o + amount * (o - around);
            data[i * 4 + c] = v.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Rings of neighbours the edge colour is spread outward before resizing (Lanczos3 reads three
/// pixels either side, so four rings cover everything it can touch).
const EXTEND_RINGS: usize = 4;

/// Copy of `src` where fully clear pixels near the subject take the colour of their visible
/// neighbours, so a resize never mixes in whatever colour happened to be hidden there.
pub(crate) fn extend_edge_colours(src: &RgbaImage) -> RgbaImage {
    let (w, h) = (src.width() as usize, src.height() as usize);
    let mut out = src.clone();
    let mut known: Vec<bool> = src.pixels().map(|p| p[3] > 0).collect();
    for _ in 0..EXTEND_RINGS {
        let mut grew = Vec::new();
        for y in 0..h {
            for x in 0..w {
                if known[y * w + x] {
                    continue;
                }
                let (mut sum, mut n) = ([0u32; 3], 0u32);
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                            continue;
                        }
                        let i = ny as usize * w + nx as usize;
                        if known[i] {
                            let p = out.get_pixel(nx as u32, ny as u32);
                            for c in 0..3 {
                                sum[c] += u32::from(p[c]);
                            }
                            n += 1;
                        }
                    }
                }
                if let Some(r) = sum[0].checked_div(n) {
                    let g = sum[1].checked_div(n).unwrap_or(0);
                    let b = sum[2].checked_div(n).unwrap_or(0);
                    grew.push((x, y, [r as u8, g as u8, b as u8]));
                }
            }
        }
        if grew.is_empty() {
            break;
        }
        for (x, y, c) in grew {
            out.put_pixel(x as u32, y as u32, Rgba([c[0], c[1], c[2], 0]));
            known[y * w + x] = true;
        }
    }
    out
}

/// Resize an image that has transparency: the colour and the alpha are resized separately.
/// Colour is resized as an opaque picture whose clear pixels were first filled with their
/// neighbours' colour (no halo, no division by a tiny alpha); alpha is resized on its own.
fn resize_with_alpha(src: &RgbaImage, out: (u32, u32)) -> AppResult<RgbaImage> {
    let mut colour = extend_edge_colours(src);
    for p in colour.pixels_mut() {
        p[3] = 255;
    }
    let mut alpha = RgbaImage::new(src.width(), src.height());
    for (a, s) in alpha.pixels_mut().zip(src.pixels()) {
        *a = Rgba([s[3], s[3], s[3], 255]);
    }
    let mut big = resize_rgba(&colour, out)?;
    let big_alpha = resize_rgba(&alpha, out)?;
    for (p, a) in big.pixels_mut().zip(big_alpha.pixels()) {
        p[3] = a[0];
        if a[0] == 0 {
            *p = Rgba([0, 0, 0, 0]);
        }
    }
    Ok(big)
}

/// Range sigma (0..255 colour distance) of the pre-denoise: differences well above this are edges
/// and stay; the small differences of noise and block borders are smoothed.
const DENOISE_RANGE: f32 = 18.0;

/// Light edge-preserving denoise (3x3 bilateral on the colour channels, alpha untouched). Meant to
/// take the edge off JPEG blocking and noise before a model enlarges them into texture.
pub fn denoise_light(src: &RgbaImage) -> RgbaImage {
    use rayon::prelude::*;
    let (w, h) = (src.width() as usize, src.height() as usize);
    let raw = src.as_raw();
    let mut out = raw.clone();
    // Spatial weights for the 8 neighbours (sigma 1) and the centre.
    let spatial = |dx: i64, dy: i64| (-((dx * dx + dy * dy) as f32) / 2.0).exp();
    out.par_chunks_mut(w * 4).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let c = (y * w + x) * 4;
            if raw[c + 3] == 0 {
                continue;
            }
            let (mut sum, mut wsum) = ([0f32; 3], 0f32);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let n = (ny as usize * w + nx as usize) * 4;
                    if raw[n + 3] == 0 {
                        continue;
                    }
                    let d: f32 = (0..3)
                        .map(|k| (f32::from(raw[n + k]) - f32::from(raw[c + k])).powi(2))
                        .sum();
                    let wt = spatial(dx, dy) * (-d / (2.0 * DENOISE_RANGE * DENOISE_RANGE)).exp();
                    for k in 0..3 {
                        sum[k] += wt * f32::from(raw[n + k]);
                    }
                    wsum += wt;
                }
            }
            for k in 0..3 {
                row[x * 4 + k] = (sum[k] / wsum + 0.5) as u8;
            }
        }
    });
    RgbaImage::from_raw(src.width(), src.height(), out).unwrap_or_else(|| src.clone())
}

/// The Standard upscaler: Lanczos3 (premultiplied, so cut-out edges have no halo) then a mild
/// unsharp mask. Produces exactly `out`.
pub fn upscale_standard(src: &RgbaImage, out: (u32, u32)) -> AppResult<RgbaImage> {
    if out.0 < src.width() || out.1 < src.height() {
        return Err(AppError::InvalidInput(
            "Upscaling cannot make an image smaller.".into(),
        ));
    }
    let has_alpha = src.pixels().any(|p| p[3] != 255);
    let mut big = if has_alpha {
        resize_with_alpha(src, out)?
    } else {
        resize_rgba(src, out)?
    };
    sharpen(&mut big, SHARPEN_SIGMA, SHARPEN_AMOUNT);
    Ok(big)
}

// ---- results waiting for a decision, and kept results ---------------------------------------

/// A finished upscale that the user has not kept or discarded yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingResult {
    pub id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub scale: Option<u32>,
    pub engine: Engine,
}

/// A kept upscale: the derived asset stored with the image (and in the project).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeptUpscale {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub scale: Option<u32>,
    pub engine: Engine,
}

/// Results by image id, plus where files live. Cheap to clone.
#[derive(Clone, Default)]
pub struct UpscaleStore {
    pending: Arc<Mutex<HashMap<String, PendingResult>>>,
    /// Images whose running upscale the user cancelled (checked between tiles).
    cancelled: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl UpscaleStore {
    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, PendingResult>>> {
        self.pending
            .lock()
            .map_err(|_| AppError::Internal("upscale store poisoned".into()))
    }

    pub fn request_cancel(&self, id: &str) {
        if let Ok(mut c) = self.cancelled.lock() {
            c.insert(id.to_string());
        }
    }

    pub fn clear_cancel(&self, id: &str) {
        if let Ok(mut c) = self.cancelled.lock() {
            c.remove(id);
        }
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|c| c.contains(id))
            .unwrap_or(false)
    }

    pub fn dir(cache: &Path, id: &str) -> PathBuf {
        cache.join("upscale").join(id)
    }

    /// Remember a finished result (replacing, and deleting, an older unreviewed one).
    pub fn set_pending(&self, r: PendingResult) -> AppResult<()> {
        let old = self.lock()?.insert(r.id.clone(), r);
        if let Some(old) = old {
            let _ = std::fs::remove_file(old.path);
        }
        Ok(())
    }

    pub fn pending(&self, id: &str) -> AppResult<Option<PendingResult>> {
        Ok(self.lock()?.get(id).cloned())
    }

    pub fn take_pending(&self, id: &str) -> AppResult<Option<PendingResult>> {
        Ok(self.lock()?.remove(id))
    }

    pub fn clear(&self) -> AppResult<()> {
        self.lock()?.clear();
        Ok(())
    }
}

/// Make the waiting result the image's kept upscaled version, replacing an older kept one.
pub fn keep(
    images: &super::import::ImageRegistry,
    store: &UpscaleStore,
    cache: &Path,
    id: &str,
) -> AppResult<KeptUpscale> {
    let pending = store
        .take_pending(id)?
        .ok_or_else(|| AppError::InvalidInput("There is no upscaled result to keep.".into()))?;
    let kept_path = UpscaleStore::dir(cache, id).join(match pending.scale {
        Some(s) => format!("kept_{s}x.png"),
        None => "kept_custom.png".to_string(),
    });
    if let Some(old) = images.upscaled(id)? {
        if old.path != kept_path {
            let _ = std::fs::remove_file(&old.path);
        }
    }
    std::fs::rename(&pending.path, &kept_path)
        .or_else(|_| std::fs::copy(&pending.path, &kept_path).map(|_| ()))?;
    let _ = std::fs::remove_file(&pending.path);
    let kept = KeptUpscale {
        path: kept_path,
        width: pending.width,
        height: pending.height,
        scale: pending.scale,
        engine: pending.engine,
    };
    images.set_upscaled(id, Some(kept.clone()))?;
    Ok(kept)
}

/// The record and state to render an image from its kept upscaled version: the kept picture is
/// the source, and every size in the state (original pixels) is multiplied by the upscale factor.
/// Without a kept version (or when its file is gone) the inputs come back unchanged.
pub fn with_kept(
    rec: &super::import::ImageRecord,
    kept: Option<KeptUpscale>,
    state: &super::exporter::ItemState,
) -> (super::import::ImageRecord, super::exporter::ItemState) {
    let (mut rec2, mut state2) = (rec.clone(), state.clone());
    if let Some(k) = kept.filter(|k| k.path.is_file() && rec.meta.width > 0) {
        state2.detail_scale = f64::from(k.width) / f64::from(rec.meta.width);
        rec2.source = k.path;
    }
    (rec2, state2)
}

/// Throw away the waiting result. With `include_kept` the kept version goes too (back to the
/// original); without it an earlier kept version survives a rejected re-run.
pub fn discard(
    images: &super::import::ImageRegistry,
    store: &UpscaleStore,
    id: &str,
    include_kept: bool,
) -> AppResult<()> {
    if let Some(p) = store.take_pending(id)? {
        let _ = std::fs::remove_file(p.path);
    }
    if include_kept {
        if let Some(k) = images.upscaled(id)? {
            let _ = std::fs::remove_file(k.path);
        }
        images.set_upscaled(id, None)?;
    }
    Ok(())
}

/// Save a result PNG (fast compression; the user is waiting).
pub fn save_png(img: &RgbaImage, path: &Path) -> AppResult<()> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("png.tmp");
    let file = std::fs::File::create(&tmp)?;
    let enc = PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        CompressionType::Fast,
        FilterType::Adaptive,
    );
    let opaque = img.pixels().all(|p| p[3] == 255);
    let res = if opaque {
        let rgb: Vec<u8> = img.pixels().flat_map(|p| [p[0], p[1], p[2]]).collect();
        enc.write_image(
            &rgb,
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
    } else {
        enc.write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
    };
    res.map_err(|e| AppError::ExportFailed(e.to_string()))?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Side-by-side crop for the detail loupe: the original (enlarged to the result's scale with
/// bilinear sampling, as a viewer would show it) on the left, the result on the right, `size`
/// pixels square each, centred on `(cx, cy)` in result coordinates. Edges are clamped.
pub fn loupe_crop(
    original: &RgbaImage,
    result: &RgbaImage,
    cx: u32,
    cy: u32,
    size: u32,
) -> AppResult<RgbaImage> {
    let size = size.clamp(16, 512);
    let (rw, rh) = result.dimensions();
    if size > rw || size > rh {
        return Err(AppError::InvalidInput(
            "The result is smaller than the loupe.".into(),
        ));
    }
    let x0 = cx.saturating_sub(size / 2).min(rw - size);
    let y0 = cy.saturating_sub(size / 2).min(rh - size);
    let mut out = RgbaImage::new(size * 2, size);
    let (ow, oh) = original.dimensions();
    let (fx, fy) = (f64::from(ow) / f64::from(rw), f64::from(oh) / f64::from(rh));
    for y in 0..size {
        for x in 0..size {
            out.put_pixel(size + x, y, *result.get_pixel(x0 + x, y0 + y));
            // Bilinear sample of the original at the matching position.
            let sx = ((f64::from(x0 + x) + 0.5) * fx - 0.5).clamp(0.0, f64::from(ow - 1));
            let sy = ((f64::from(y0 + y) + 0.5) * fy - 0.5).clamp(0.0, f64::from(oh - 1));
            let (ix, iy) = (sx.floor() as u32, sy.floor() as u32);
            let (tx, ty) = (sx - f64::from(ix), sy - f64::from(iy));
            let at = |x: u32, y: u32| original.get_pixel(x.min(ow - 1), y.min(oh - 1)).0;
            let (p00, p10, p01, p11) = (
                at(ix, iy),
                at(ix + 1, iy),
                at(ix, iy + 1),
                at(ix + 1, iy + 1),
            );
            let mut px = [0u8; 4];
            for c in 0..4 {
                let top = f64::from(p00[c]) * (1.0 - tx) + f64::from(p10[c]) * tx;
                let bot = f64::from(p01[c]) * (1.0 - tx) + f64::from(p11[c]) * tx;
                px[c] = (top * (1.0 - ty) + bot * ty).round() as u8;
            }
            out.put_pixel(x, y, Rgba(px));
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "upscale_tests.rs"]
mod tests;

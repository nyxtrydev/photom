//! Full-resolution export: refine + edit layer -> alpha, crop to subject, resize, background,
//! PNG encode, and safe file naming. Pure functions where possible so everything is unit-tested.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use fast_image_resize::images::Image as FrImage;
use fast_image_resize::{FilterType, MulDiv, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{GrayImage, ImageEncoder, RgbImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use super::brush::{replay_strokes, sanitize, Stroke};
use super::image_io;
use super::import::ImageRecord;
use super::maskops::{compose_final, compute_refined, RefineParams};
use super::shadow::{Frame, ShadowParams};
use super::shadow_render::{self, Geometry};
use crate::models::error::{AppError, AppResult};

/// Mask values at or above this count as "subject" when finding the crop box.
pub const SUBJECT_THRESHOLD: u8 = 10;
const MAX_SIDE: u32 = 32_768;
const MAX_PIXELS: u64 = 400_000_000;

// ---- request types (sent by the frontend; every field is validated) -----------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BgKind {
    #[default]
    Transparent,
    Solid,
    Image,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    #[default]
    Cover,
    Contain,
    Stretch,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BgImageRef {
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundState {
    pub kind: BgKind,
    pub color: String,
    pub fit: FitMode,
    pub image: Option<BgImageRef>,
}

impl Default for BackgroundState {
    fn default() -> Self {
        Self {
            kind: BgKind::Transparent,
            color: "#ffffff".into(),
            fit: FitMode::Cover,
            image: None,
        }
    }
}

/// The per-image editor state that affects the exported pixels.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemState {
    pub refine: RefineParams,
    pub strokes: Vec<Stroke>,
    pub background: BackgroundState,
    /// The editor's `shadow` object (see `services::shadow`); `None` = no shadow.
    pub shadow: Option<serde_json::Value>,
    /// Pixels per original pixel when the item is rendered from its kept upscaled version: every
    /// size in the state (brush, feather, shadow) is in original pixels and is multiplied by this.
    /// Set by the backend, never read from the editor. 0 and 1 both mean "not upscaled".
    #[serde(skip)]
    pub detail_scale: f64,
}

impl ItemState {
    pub fn scale(&self) -> f64 {
        if self.detail_scale.is_finite() && self.detail_scale > 1.0 {
            self.detail_scale
        } else {
            1.0
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundMode {
    /// Always export a transparent PNG.
    #[default]
    Transparent,
    /// Composite over the background chosen in the editor (solid colour / picture).
    KeepSelected,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeMode {
    #[default]
    Original,
    Custom,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SizeOptions {
    pub mode: SizeMode,
    pub width: u32,
    pub height: u32,
    /// Optional cap on the longest side (never upscales). Used by presets such as "Web".
    pub max_side: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CropOptions {
    pub enabled: bool,
    pub padding: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub background: BackgroundMode,
    pub size: SizeOptions,
    pub crop: CropOptions,
    /// 0 (fastest, largest) to 9 (smallest).
    pub compression: u8,
    pub filename_template: String,
    pub folder: String,
    /// Bake the shadow into the exported picture (when the image has one enabled).
    pub include_shadow: bool,
    /// Also write the shadow alone, on its own transparent canvas (`name-photom-shadow.png`),
    /// aligned with the main picture so designers can place it on a separate layer.
    pub shadow_layer: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            background: BackgroundMode::Transparent,
            size: SizeOptions::default(),
            crop: CropOptions::default(),
            compression: 6,
            filename_template: DEFAULT_TEMPLATE.into(),
            folder: String::new(),
            include_shadow: true,
            shadow_layer: false,
        }
    }
}

pub const DEFAULT_TEMPLATE: &str = "{name}-photom.png";

// ---- rendering ----------------------------------------------------------------------------

pub struct RenderInput<'a> {
    pub source: &'a RgbaImage,
    /// Raw model mask at source resolution. `None` means background removal has not run.
    pub mask: Option<&'a GrayImage>,
    pub state: &'a ItemState,
    pub bg_image: Option<&'a RgbImage>,
}

/// Final alpha mask at source resolution: refine(base) + edit layer, times any alpha the source had.
pub fn final_alpha(input: &RenderInput) -> AppResult<Vec<u8>> {
    let base = input.mask.ok_or_else(|| {
        AppError::ExportFailed("Remove the background of this image before exporting it.".into())
    })?;
    let (w, h) = input.source.dimensions();
    if base.dimensions() != (w, h) {
        return Err(AppError::ExportFailed(
            "The mask does not match the image size.".into(),
        ));
    }
    let (w, h) = (w as usize, h as usize);
    let k = input.state.scale();
    let refined = compute_refined(base.as_raw(), w, h, input.state.refine, k);
    let mut delta = vec![0i16; w * h];
    replay_strokes(&mut delta, w, h, k, &sanitize(input.state.strokes.clone()));
    let mut out = vec![0u8; w * h];
    compose_final(&refined, &delta, &mut out);
    for (a, px) in out.iter_mut().zip(input.source.pixels()) {
        if px[3] != 255 {
            *a = ((*a as u32 * px[3] as u32 + 127) / 255) as u8;
        }
    }
    Ok(out)
}

/// Crop rectangle around the subject with exact padding. The origin may be negative / the rect may
/// extend past the image so that the padding is always exactly `padding` pixels.
pub fn crop_rect(alpha: &[u8], w: u32, h: u32, padding: u32) -> Option<(i64, i64, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (w as i64, h as i64, -1i64, -1i64);
    for y in 0..h as usize {
        let row = &alpha[y * w as usize..(y + 1) * w as usize];
        if let Some(first) = row.iter().position(|&a| a >= SUBJECT_THRESHOLD) {
            let last = row
                .iter()
                .rposition(|&a| a >= SUBJECT_THRESHOLD)
                .unwrap_or(first);
            x0 = x0.min(first as i64);
            x1 = x1.max(last as i64);
            y0 = y0.min(y as i64);
            y1 = y1.max(y as i64);
        }
    }
    if x1 < 0 {
        return None;
    }
    let p = padding as i64;
    Some((
        x0 - p,
        y0 - p,
        (x1 - x0 + 1 + 2 * p) as u32,
        (y1 - y0 + 1 + 2 * p) as u32,
    ))
}

/// Output size after crop: custom exact size, or the cropped size optionally capped by `max_side`.
pub fn target_size(size: &SizeOptions, cropped: (u32, u32)) -> AppResult<(u32, u32)> {
    let (tw, th) = match size.mode {
        SizeMode::Custom => (size.width, size.height),
        SizeMode::Original => match size.max_side {
            Some(m) if m > 0 && cropped.0.max(cropped.1) > m => {
                let s = f64::from(m) / f64::from(cropped.0.max(cropped.1));
                (
                    ((f64::from(cropped.0) * s).round() as u32).max(1),
                    ((f64::from(cropped.1) * s).round() as u32).max(1),
                )
            }
            _ => cropped,
        },
    };
    if tw == 0
        || th == 0
        || tw > MAX_SIDE
        || th > MAX_SIDE
        || u64::from(tw) * u64::from(th) > MAX_PIXELS
    {
        return Err(AppError::InvalidInput(format!(
            "output size {tw} x {th} is not allowed"
        )));
    }
    Ok((tw, th))
}

pub(crate) fn resize_rgba(img: &RgbaImage, to: (u32, u32)) -> AppResult<RgbaImage> {
    if img.dimensions() == to {
        return Ok(img.clone());
    }
    let src = FrImage::from_vec_u8(
        img.width(),
        img.height(),
        img.as_raw().clone(),
        PixelType::U8x4,
    )
    .map_err(|e| AppError::Internal(format!("resize source: {e}")))?;
    let mut src = src;
    let md = MulDiv::default();
    // Resize premultiplied so transparent pixels don't bleed colour into edges.
    md.multiply_alpha_inplace(&mut src)
        .map_err(|e| AppError::Internal(format!("premultiply: {e}")))?;
    let mut dst = FrImage::new(to.0, to.1, PixelType::U8x4);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| AppError::Internal(format!("resize: {e}")))?;
    md.divide_alpha_inplace(&mut dst)
        .map_err(|e| AppError::Internal(format!("unpremultiply: {e}")))?;
    RgbaImage::from_raw(to.0, to.1, dst.into_vec())
        .ok_or_else(|| AppError::Internal("resize buffer mismatch".into()))
}

pub fn parse_hex(color: &str) -> Option<[u8; 3]> {
    let c = color.strip_prefix('#')?;
    if c.len() != 6 || !c.is_ascii() {
        return None;
    }
    let v = u32::from_str_radix(c, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

/// Destination rect of a background picture inside the output (mirrors `fitRect` in compositor.ts).
pub fn fit_rect(mode: FitMode, iw: f64, ih: f64, w: f64, h: f64) -> (f64, f64, f64, f64) {
    if mode == FitMode::Stretch {
        return (0.0, 0.0, w, h);
    }
    let s = if mode == FitMode::Cover {
        (w / iw).max(h / ih)
    } else {
        (w / iw).min(h / ih)
    };
    let (dw, dh) = (iw * s, ih * s);
    ((w - dw) / 2.0, (h - dh) / 2.0, dw, dh)
}

fn background_layer(
    state: &BackgroundState,
    bg_image: Option<&RgbImage>,
    size: (u32, u32),
) -> AppResult<Option<RgbaImage>> {
    match state.kind {
        BgKind::Transparent => Ok(None),
        BgKind::Solid => {
            let [r, g, b] = parse_hex(&state.color).unwrap_or([255, 255, 255]);
            Ok(Some(RgbaImage::from_pixel(
                size.0,
                size.1,
                Rgba([r, g, b, 255]),
            )))
        }
        BgKind::Image => {
            let Some(pic) = bg_image else { return Ok(None) };
            let (dx, dy, dw, dh) = fit_rect(
                state.fit,
                f64::from(pic.width()),
                f64::from(pic.height()),
                f64::from(size.0),
                f64::from(size.1),
            );
            let (rw, rh) = ((dw.round() as u32).max(1), (dh.round() as u32).max(1));
            let rgba = image::DynamicImage::ImageRgb8(pic.clone()).to_rgba8();
            let scaled = resize_rgba(&rgba, (rw, rh))?;
            let mut layer = RgbaImage::new(size.0, size.1);
            image::imageops::overlay(&mut layer, &scaled, dx.round() as i64, dy.round() as i64);
            Ok(Some(layer))
        }
    }
}

/// "Over" compositing of straight-alpha pixels.
fn over(fg: &RgbaImage, bg: &RgbaImage) -> RgbaImage {
    let mut out = bg.clone();
    for (o, f) in out.pixels_mut().zip(fg.pixels()) {
        let fa = f[3] as u32;
        if fa == 0 {
            continue;
        }
        let ba = o[3] as u32;
        let oa = fa * 255 + ba * (255 - fa);
        if oa == 0 {
            continue;
        }
        for c in 0..3 {
            let v = (f[c] as u32 * fa * 255 + o[c] as u32 * ba * (255 - fa)) / oa;
            o[c] = v.min(255) as u8;
        }
        o[3] = ((oa + 127) / 255).min(255) as u8;
    }
    out
}

/// "Over" for one straight-alpha pixel (same maths as `over`).
fn over_px(f: [u8; 4], b: [u8; 4]) -> [u8; 4] {
    let fa = f[3] as u32;
    if fa == 0 {
        return b;
    }
    let ba = b[3] as u32;
    let oa = fa * 255 + ba * (255 - fa);
    if oa == 0 {
        return b;
    }
    let mut o = b;
    for c in 0..3 {
        let v = (f[c] as u32 * fa * 255 + b[c] as u32 * ba * (255 - fa)) / oa;
        o[c] = v.min(255) as u8;
    }
    o[3] = ((oa + 127) / 255).min(255) as u8;
    o
}

/// What one item renders to: the picture, and the shadow alone when a separate layer was asked for.
pub struct Rendered {
    pub image: RgbaImage,
    pub shadow: Option<RgbaImage>,
}

/// The shadow for this item at full resolution, positioned in frame coordinates.
struct FrameShadow {
    frame: Frame,
    bitmap: shadow_render::Bitmap,
}

fn full_res_shadow(
    input: &RenderInput,
    alpha: &[u8],
    options: &ExportOptions,
) -> AppResult<Option<FrameShadow>> {
    if !options.include_shadow && !options.shadow_layer {
        return Ok(None);
    }
    let Some(params) = input
        .state
        .shadow
        .as_ref()
        .and_then(ShadowParams::from_value)
    else {
        return Ok(None);
    };
    if !params.active() {
        return Ok(None);
    }
    let (w, h) = input.source.dimensions();
    let k = input.state.scale();
    let Some(layout) = shadow_layout(&params, alpha, w, h, k) else {
        return Ok(None);
    };
    let bitmap = shadow_render::render(
        alpha,
        w as usize,
        h as usize,
        k,
        &params,
        layout.frame,
        Some(&layout.geom),
        Some(input.source.as_raw()),
    )?;
    // The frame in output pixels, as the compositor needs it.
    let frame = Frame {
        x: layout.out.x,
        y: layout.out.y,
        w: bitmap.w as i64,
        h: bitmap.h as i64,
    };
    Ok(Some(FrameShadow { frame, bitmap }))
}

/// Where a shadow goes. The shadow settings are in ORIGINAL pixels, so the subject found in the
/// (possibly upscaled) alpha is converted back to them: `frame` and `geom` are original pixels,
/// `out` is the frame's origin in output pixels. With `k == 1` everything is the same number.
struct ShadowLayout {
    frame: Frame,
    geom: Geometry,
    out: Frame,
}

fn shadow_layout(
    params: &ShadowParams,
    alpha: &[u8],
    w: u32,
    h: u32,
    k: f64,
) -> Option<ShadowLayout> {
    let s = shadow_render::alpha_bounds(alpha, w as usize, h as usize, 8)?;
    let (ow, oh) = (
        (f64::from(w) / k).round() as i64,
        (f64::from(h) / k).round() as i64,
    );
    let subject = if k == 1.0 {
        s
    } else {
        let (x0, y0) = (
            (s.x as f64 / k).floor() as i64,
            (s.y as f64 / k).floor() as i64,
        );
        let (x1, y1) = (
            ((s.x + s.w) as f64 / k).ceil() as i64,
            ((s.y + s.h) as f64 / k).ceil() as i64,
        );
        Frame {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    };
    let frame = params.bounds(Some(subject), ow, oh);
    let ground = params.ground(Some(subject), oh)?;
    let geom = Geometry {
        x: subject.x as f64,
        y: subject.y as f64,
        w: subject.w as f64,
        h: subject.h as f64,
        ground,
    };
    let out = Frame {
        x: (frame.x as f64 * k).round() as i64,
        y: (frame.y as f64 * k).round() as i64,
        w: (frame.w as f64 * k).ceil() as i64,
        h: (frame.h as f64 * k).ceil() as i64,
    };
    Some(ShadowLayout { frame, geom, out })
}

/// Produce the final RGBA image for one item (and its separate shadow layer, if asked for).
pub fn render_layers(input: &RenderInput, options: &ExportOptions) -> AppResult<Rendered> {
    let alpha = final_alpha(input)?;
    let (w, h) = input.source.dimensions();
    let shadow = full_res_shadow(input, &alpha, options)?;

    // The canvas the picture lives on: the image, or the image plus the shadow's margin.
    let (fx, fy, fw, fh) = match &shadow {
        Some(s) => (s.frame.x, s.frame.y, s.bitmap.w as u32, s.bitmap.h as u32),
        None => (0, 0, w, h),
    };
    let shadow_px = |x: i64, y: i64| -> [u8; 4] {
        match &shadow {
            Some(s)
                if x >= 0 && y >= 0 && (x as usize) < s.bitmap.w && (y as usize) < s.bitmap.h =>
            {
                let i = (y as usize * s.bitmap.w + x as usize) * 4;
                [
                    s.bitmap.data[i],
                    s.bitmap.data[i + 1],
                    s.bitmap.data[i + 2],
                    s.bitmap.data[i + 3],
                ]
            }
            _ => [0; 4],
        }
    };
    let subject_alpha = |x: i64, y: i64| -> u8 {
        let (sx, sy) = (x + fx, y + fy);
        if sx < 0 || sy < 0 || sx >= i64::from(w) || sy >= i64::from(h) {
            0
        } else {
            alpha[sy as usize * w as usize + sx as usize]
        }
    };

    // Crop around everything visible: the subject and, if present, its shadow.
    let rect = if options.crop.enabled {
        let combined: std::borrow::Cow<[u8]> = if shadow.is_some() {
            let mut v = vec![0u8; fw as usize * fh as usize];
            for y in 0..i64::from(fh) {
                for x in 0..i64::from(fw) {
                    v[y as usize * fw as usize + x as usize] =
                        subject_alpha(x, y).max(shadow_px(x, y)[3]);
                }
            }
            std::borrow::Cow::Owned(v)
        } else {
            std::borrow::Cow::Borrowed(&alpha)
        };
        crop_rect(&combined, fw, fh, options.crop.padding.min(MAX_SIDE)).unwrap_or((0, 0, fw, fh))
    } else {
        (0, 0, fw, fh)
    };
    let (rx, ry, cw, ch) = rect;
    let target = target_size(&options.size, (cw, ch))?;
    if u64::from(cw) * u64::from(ch) > MAX_PIXELS {
        return Err(AppError::InvalidInput("cropped area is too large".into()));
    }

    // Canvas in crop space; pixels outside the source stay transparent.
    let mut canvas = RgbaImage::new(cw, ch);
    let mut shadow_canvas =
        (shadow.is_some() && options.shadow_layer).then(|| RgbaImage::new(cw, ch));
    for cy in 0..i64::from(ch) {
        let y = ry + cy;
        if y < -i64::from(fh) || y >= i64::from(fh) * 2 {
            continue;
        }
        for cx in 0..i64::from(cw) {
            let x = rx + cx;
            let (sx, sy) = (x + fx, y + fy);
            let inside = sx >= 0 && sy >= 0 && sx < i64::from(w) && sy < i64::from(h);
            let sub = if inside && x >= 0 && y >= 0 && x < i64::from(fw) && y < i64::from(fh) {
                let src = input.source.get_pixel(sx as u32, sy as u32);
                [
                    src[0],
                    src[1],
                    src[2],
                    alpha[sy as usize * w as usize + sx as usize],
                ]
            } else {
                [0; 4]
            };
            let sh = if x >= 0 && y >= 0 {
                shadow_px(x, y)
            } else {
                [0; 4]
            };
            if let Some(layer) = shadow_canvas.as_mut() {
                layer.put_pixel(cx as u32, cy as u32, Rgba(sh));
            }
            let px = if options.include_shadow {
                over_px(sub, sh)
            } else {
                sub
            };
            canvas.put_pixel(cx as u32, cy as u32, Rgba(px));
        }
    }

    let sized = resize_rgba(&canvas, target)?;
    let shadow_only = match shadow_canvas {
        Some(c) => Some(resize_rgba(&c, target)?),
        None => None,
    };
    if options.background == BackgroundMode::KeepSelected {
        if let Some(layer) = background_layer(&input.state.background, input.bg_image, target)? {
            return Ok(Rendered {
                image: over(&sized, &layer),
                shadow: shadow_only,
            });
        }
    }
    Ok(Rendered {
        image: sized,
        shadow: shadow_only,
    })
}

/// Produce the final RGBA image for one item.
pub fn render(input: &RenderInput, options: &ExportOptions) -> AppResult<RgbaImage> {
    render_layers(input, options).map(|r| r.image)
}

// ---- encoding & files ---------------------------------------------------------------------

fn compression_type(level: u8) -> CompressionType {
    CompressionType::Level(level.min(9))
}

/// PNG-encode; fully opaque images are stored as RGB (smaller), others as RGBA.
pub fn encode_png(img: &RgbaImage, level: u8) -> AppResult<Vec<u8>> {
    let opaque = img.pixels().all(|p| p[3] == 255);
    let mut out = Vec::new();
    let enc = PngEncoder::new_with_quality(&mut out, compression_type(level), PngFilter::Adaptive);
    if opaque {
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
    }
    .map_err(|e| AppError::ExportFailed(e.to_string()))?;
    Ok(out)
}

pub struct TemplateContext<'a> {
    pub name: &'a str,
    pub index: usize,
    pub total: usize,
    pub date: &'a str,
}

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Expand `{name}`, `{index}` (zero-padded to the batch size) and `{date}`; result always ends in `.png`.
pub fn expand_template(template: &str, ctx: &TemplateContext) -> String {
    let template = if template.trim().is_empty() {
        DEFAULT_TEMPLATE
    } else {
        template
    };
    let width = ctx.total.max(1).to_string().len().max(2);
    let expanded = template
        .replace("{name}", ctx.name)
        .replace("{index}", &format!("{:0width$}", ctx.index))
        .replace("{date}", ctx.date);
    let mut name = sanitize_file_name(&expanded);
    if !name.to_ascii_lowercase().ends_with(".png") {
        name.push_str(".png");
    }
    name
}

/// Remove path separators, control and reserved characters; avoid Windows device names.
pub fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut s = cleaned.trim().trim_matches('.').trim().to_string();
    if s.is_empty() {
        s = "photom".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    // Keep names reasonable (but never cut the extension off).
    if s.chars().count() > 150 {
        let ext = Path::new(&s)
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default();
        let keep: String = s.chars().take(140).collect();
        s = if ext.is_empty() {
            keep
        } else {
            format!("{keep}.{ext}")
        };
    }
    s
}

fn map_write_error(e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => AppError::Permission(
            "Photom cannot write to that folder. Choose another folder.".into(),
        ),
        _ => match e.raw_os_error() {
            Some(28) | Some(112) | Some(39) => AppError::ExportFailed(
                "There is not enough free disk space to save this file.".into(),
            ),
            _ => e.into(),
        },
    }
}

/// Make sure the output folder exists and is a directory.
pub fn ensure_folder(folder: &str) -> AppResult<PathBuf> {
    let p = Path::new(folder);
    if folder.trim().is_empty() || !p.is_absolute() {
        return Err(AppError::InvalidInput("Choose an output folder.".into()));
    }
    fs::create_dir_all(p).map_err(map_write_error)?;
    if !p.is_dir() {
        return Err(AppError::InvalidInput(
            "The output location is not a folder.".into(),
        ));
    }
    Ok(p.to_path_buf())
}

/// Write `bytes` as `<folder>/<file_name>`; if the name exists, use `name (2).png`, `(3)`, ...
/// A name is claimed with `create_new`, so an existing file is never replaced, even when two
/// exports race. Returns the final path.
pub fn write_unique(folder: &Path, file_name: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (file_name.to_string(), String::new()),
    };
    for n in 1..10_000u32 {
        let candidate = if n == 1 {
            file_name.to_string()
        } else {
            format!("{stem} ({n}){ext}")
        };
        let path = folder.join(&candidate);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let result = f.write_all(bytes).and_then(|_| f.sync_all());
                if let Err(e) = result {
                    drop(f);
                    let _ = fs::remove_file(&path);
                    return Err(map_write_error(e));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(map_write_error(e)),
        }
    }
    Err(AppError::ExportFailed(
        "Could not find a free file name.".into(),
    ))
}

// ---- end-to-end for one registered image ---------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedItem {
    pub id: String,
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// The separate shadow layer, when one was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_path: Option<String>,
}

pub struct ItemRequest<'a> {
    pub rec: &'a ImageRecord,
    pub state: &'a ItemState,
    pub options: &'a ExportOptions,
    pub index: usize,
    pub total: usize,
    pub date: &'a str,
    pub pixel_limit: u64,
}

/// Decode an item's source image and its saved mask (resized to the source if it differs).
fn load_source_and_mask(
    rec: &ImageRecord,
    pixel_limit: u64,
) -> AppResult<(RgbaImage, Option<GrayImage>)> {
    let source = image_io::decode_oriented(&rec.source, pixel_limit)?.to_rgba8();
    let mask = match &rec.mask_path {
        Some(p) if p.is_file() => {
            let m = image::open(p)?.to_luma8();
            Some(if m.dimensions() == source.dimensions() {
                m
            } else {
                super::working::resize_gray(&m, source.dimensions())?
            })
        }
        _ => None,
    };
    Ok((source, mask))
}

/// Load everything an item needs and render it (the picture, plus the separate shadow layer when
/// the options ask for one).
pub fn render_item(
    rec: &ImageRecord,
    state: &ItemState,
    options: &ExportOptions,
    pixel_limit: u64,
) -> AppResult<Rendered> {
    let (source, mask) = load_source_and_mask(rec, pixel_limit)?;
    let bg_image = match (
        &state.background.kind,
        &state.background.image,
        options.background,
    ) {
        (BgKind::Image, Some(r), BackgroundMode::KeepSelected) => {
            let p = image_io::validate_input_path(&r.source_path)?;
            Some(image_io::to_rgb_for_inference(&image_io::decode_oriented(
                &p,
                pixel_limit,
            )?))
        }
        _ => None,
    };
    render_layers(
        &RenderInput {
            source: &source,
            mask: mask.as_ref(),
            state,
            bg_image: bg_image.as_ref(),
        },
        options,
    )
}

/// `name-photom.png` -> `name-photom-shadow.png`.
pub fn shadow_file_name(main: &str) -> String {
    match main.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}-shadow.{ext}"),
        _ => format!("{main}-shadow.png"),
    }
}

pub fn export_item(req: &ItemRequest) -> AppResult<(ExportedItem, RgbaImage)> {
    let folder = ensure_folder(&req.options.folder)?;
    let Rendered { image: img, shadow } =
        render_item(req.rec, req.state, req.options, req.pixel_limit)?;
    let stem = Path::new(&req.rec.meta.name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let file_name = expand_template(
        &req.options.filename_template,
        &TemplateContext {
            name: &stem,
            index: req.index,
            total: req.total,
            date: req.date,
        },
    );
    let bytes = encode_png(&img, req.options.compression)?;
    let path = write_unique(&folder, &file_name, &bytes)?;
    let shadow_path = match shadow {
        Some(layer) => {
            let shadow_bytes = encode_png(&layer, req.options.compression)?;
            let name = shadow_file_name(
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&file_name),
            );
            Some(
                write_unique(&folder, &name, &shadow_bytes)?
                    .display()
                    .to_string(),
            )
        }
        None => None,
    };
    let item = ExportedItem {
        id: req.rec.meta.id.clone(),
        output_path: path.display().to_string(),
        width: img.width(),
        height: img.height(),
        bytes: bytes.len() as u64,
        shadow_path,
    };
    Ok((item, img))
}

#[cfg(test)]
#[path = "exporter_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "shadow_golden_tests.rs"]
mod golden_tests;

// ---- applying a shadow to many images ------------------------------------------------------

/// What a "check" of one image found: the canvas its shadow needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowCheck {
    pub id: String,
    pub applied: bool,
    pub frame: ShadowFrame,
    pub ground: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ShadowFrame {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// Validate a shadow against one image at full resolution without rendering it: the cut-out must
/// have a subject, and the canvas the shadow needs must be renderable. This is what "Apply to all
/// images" runs for every image before the settings are adopted.
pub fn shadow_check(
    rec: &ImageRecord,
    state: &ItemState,
    pixel_limit: u64,
) -> AppResult<ShadowCheck> {
    let (source, mask) = load_source_and_mask(rec, pixel_limit)?;
    let alpha = final_alpha(&RenderInput {
        source: &source,
        mask: mask.as_ref(),
        state,
        bg_image: None,
    })?;
    let params = state
        .shadow
        .as_ref()
        .and_then(ShadowParams::from_value)
        .filter(ShadowParams::active)
        .ok_or_else(|| AppError::InvalidInput("There is no shadow to apply.".into()))?;
    let (w, h) = source.dimensions();
    let subject = shadow_render::alpha_bounds(&alpha, w as usize, h as usize, 8)
        .ok_or_else(|| AppError::ExportFailed("No subject was found in this cut-out.".into()))?;
    let frame = params.bounds(Some(subject), i64::from(w), i64::from(h));
    if (frame.w as u64) * (frame.h as u64) > shadow_render::MAX_FRAME_PIXELS {
        return Err(AppError::ExportFailed(
            "The shadow makes this image too large to render. Reduce the shadow size, or turn off Auto expand canvas."
                .into(),
        ));
    }
    Ok(ShadowCheck {
        id: rec.meta.id.clone(),
        applied: true,
        frame: ShadowFrame {
            x: frame.x,
            y: frame.y,
            w: frame.w,
            h: frame.h,
        },
        ground: params.ground(Some(subject), i64::from(h)).unwrap_or(0.0),
    })
}

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
    let refined = compute_refined(base.as_raw(), w, h, input.state.refine, 1.0);
    let mut delta = vec![0i16; w * h];
    replay_strokes(
        &mut delta,
        w,
        h,
        1.0,
        &sanitize(input.state.strokes.clone()),
    );
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

fn resize_rgba(img: &RgbaImage, to: (u32, u32)) -> AppResult<RgbaImage> {
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

/// Produce the final RGBA image for one item.
pub fn render(input: &RenderInput, options: &ExportOptions) -> AppResult<RgbaImage> {
    let alpha = final_alpha(input)?;
    let (w, h) = input.source.dimensions();

    let rect = if options.crop.enabled {
        crop_rect(&alpha, w, h, options.crop.padding.min(MAX_SIDE)).unwrap_or((0, 0, w, h))
    } else {
        (0, 0, w, h)
    };
    let (rx, ry, cw, ch) = rect;
    let target = target_size(&options.size, (cw, ch))?;
    if u64::from(cw) * u64::from(ch) > MAX_PIXELS {
        return Err(AppError::InvalidInput("cropped area is too large".into()));
    }

    // Canvas in crop space; pixels outside the source stay transparent.
    let mut canvas = RgbaImage::new(cw, ch);
    for cy in 0..ch as i64 {
        let sy = ry + cy;
        if sy < 0 || sy >= h as i64 {
            continue;
        }
        for cx in 0..cw as i64 {
            let sx = rx + cx;
            if sx < 0 || sx >= w as i64 {
                continue;
            }
            let src = input.source.get_pixel(sx as u32, sy as u32);
            let a = alpha[(sy as usize) * w as usize + sx as usize];
            canvas.put_pixel(cx as u32, cy as u32, Rgba([src[0], src[1], src[2], a]));
        }
    }

    let sized = resize_rgba(&canvas, target)?;
    if options.background == BackgroundMode::KeepSelected {
        if let Some(layer) = background_layer(&input.state.background, input.bg_image, target)? {
            return Ok(over(&sized, &layer));
        }
    }
    Ok(sized)
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

/// Load everything an item needs, render it, and write the PNG. Returns the image too (for history
/// thumbnails and clipboard use) via `render_item`.
pub fn render_item(
    rec: &ImageRecord,
    state: &ItemState,
    options: &ExportOptions,
    pixel_limit: u64,
) -> AppResult<RgbaImage> {
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
    render(
        &RenderInput {
            source: &source,
            mask: mask.as_ref(),
            state,
            bg_image: bg_image.as_ref(),
        },
        options,
    )
}

pub fn export_item(req: &ItemRequest) -> AppResult<(ExportedItem, RgbaImage)> {
    let folder = ensure_folder(&req.options.folder)?;
    let img = render_item(req.rec, req.state, req.options, req.pixel_limit)?;
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
    let item = ExportedItem {
        id: req.rec.meta.id.clone(),
        output_path: path.display().to_string(),
        width: img.width(),
        height: img.height(),
        bytes: bytes.len() as u64,
    };
    Ok((item, img))
}

#[cfg(test)]
#[path = "exporter_tests.rs"]
mod tests;
